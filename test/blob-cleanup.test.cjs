const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { ConversationSync } = require('../conversation-sync.cjs');
const { hash, stateKey, blobGraceMs } = require('../sync-state.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-blob-cleanup-'));
  const database = new SharedScheduleDatabase(path.join(directory, 'shared.sqlite'));
  const clock = { now: Date.now() }, calls = [], machine = 'access:local';
  const request = (method, args = {}) => { calls.push(method); return database.request(method, args, 'test-device', clock.now).result; };
  const put = data => { const id = hash(data); request('blob-put', { hash: id, data: data.toString('base64') }); return id; };
  const shared = { enabled: true, key: 'test-server', online: async () => {}, bridge: { call: async (method, args) => request(method, args) } };
  const sync = new ConversationSync({ directory: path.join(directory, 'client'), shared, apply: async () => {}, changed() {} });
  sync.soon = () => {};
  const draft = (id, value, base = 0) => request('state-push', { operations: [{ kind: 'draft', machine, id, value, base, opId: 'op-' + clock.now + '-' + calls.length }] })[0];
  t.after(() => { sync.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, database, clock, calls, request, put, draft, sync, machine };
}
const image = id => ({ hash: id, name: 'image.png', mime: 'image/png' });

test('server keeps referenced images and young orphan uploads, then reclaims removed images during normal polling', t => {
  const f = fixture(t), referenced = f.put(Buffer.from('referenced image')), orphan = f.put(Buffer.from('unfinished upload'));
  const saved = f.draft('chat', { text: 'Keep this photo', images: [image(referenced)] });
  f.clock.now += blobGraceMs - 1;
  f.request('blob-prepare', { hashes: [] });
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM sync_blobs').get().count, 2);
  f.clock.now += 2;
  f.request('blob-prepare', { hashes: [] });
  assert.throws(() => f.request('blob-get', { hash: orphan }), /not found/);
  assert.ok(f.request('blob-get', { hash: referenced }).data);
  f.draft('chat', null, saved.revision);
  f.clock.now += blobGraceMs + 1;
  f.request('state-pull', { cursor: 0 });
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM sync_blobs').get().count, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM sync_blob_usage WHERE hash<>''").get().count, 0);
});

test('preparing a pending publication renews its image protection before expired orphan cleanup', t => {
  const f = fixture(t), id = f.put(Buffer.from('pending image'));
  f.clock.now += blobGraceMs + 1;
  assert.deepEqual(f.request('blob-prepare', { hashes: [id] }).missing, []);
  f.clock.now += blobGraceMs - 1;
  f.request('blob-prepare', { hashes: [] });
  f.draft('late-publication', { text: 'Uploaded earlier', images: [image(id)] });
  f.clock.now += 10 * blobGraceMs;
  f.request('blob-prepare', { hashes: [] });
  assert.ok(f.request('blob-get', { hash: id }).data);
  assert.throws(() => f.request('blob-prepare', { hashes: ['../unsafe'] }), /Invalid attachment/);
});

test('expired unreferenced data frees SQLite pages so a bounded database accepts later image uploads', t => {
  const f = fixture(t);
  f.database.db.exec('PRAGMA max_page_count=128');
  f.put(Buffer.alloc(256 * 1024, 1));
  assert.throws(() => f.put(Buffer.alloc(256 * 1024, 2)));
  f.clock.now += blobGraceMs + 1;
  const next = f.put(Buffer.alloc(256 * 1024, 2));
  assert.ok(f.request('blob-get', { hash: next }).data);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS count FROM sync_blobs').get().count, 1);
  assert.ok(f.database.db.prepare('PRAGMA page_count').get().page_count <= 128);
});

test('a client checks server presence, avoids redundant image uploads, and reuploads a collected image when reused', async t => {
  const f = fixture(t), data = Buffer.from('reused image'), id = f.sync.keepBlob(data);
  const value = { text: 'Photo', images: [image(id)] };
  f.sync.capture('draft', f.machine, 'chat', value); await f.sync.tick();
  f.sync.capture('draft', f.machine, 'chat', { ...value, text: 'Same photo, updated text' }); await f.sync.tick();
  assert.equal(f.calls.filter(method => method === 'blob-put').length, 1);
  f.sync.capture('draft', f.machine, 'chat', null); await f.sync.tick();
  f.clock.now += blobGraceMs + 1;
  f.request('blob-prepare', { hashes: [] });
  assert.throws(() => f.request('blob-get', { hash: id }), /not found/);
  f.sync.capture('draft', f.machine, 'chat', value); await f.sync.tick();
  assert.equal(f.calls.filter(method => method === 'blob-put').length, 2);
  assert.equal(f.database.state.get(stateKey('draft', f.machine, 'chat')).value.text, 'Photo');
  assert.equal(f.sync.conflicts().length, 0);
});

test('local cleanup preserves current, pending, conflicted and other-destination image refs while removing aged orphans', t => {
  const f = fixture(t), now = Date.now(); f.sync.load();
  const ids = Object.fromEntries(['current', 'pending', 'conflict', 'other', 'orphan', 'recent'].map(name => [name, f.sync.keepBlob(Buffer.from(name))]));
  for (const [name, id] of Object.entries(ids)) {
    const touched = (now - (name === 'recent' ? 1000 : 2 * blobGraceMs)) / 1000;
    fs.utimesSync(f.sync.blobFile(id), touched, touched);
  }
  f.sync.state.entries.current = { value: { images: [image(ids.current)] } };
  f.sync.state.pending = [{ value: { images: [image(ids.pending)] } }];
  f.sync.state.conflicts.conflict = { remote: { value: { images: [image(ids.conflict)] } } };
  f.sync.save();
  const other = path.join(f.sync.directory, hash('other-destination') + '.json.outbox');
  fs.writeFileSync(other, JSON.stringify({ pending: [{ value: { images: [image(ids.other)] } }] }));
  f.sync.pruneBlobs(now);
  for (const name of ['current', 'pending', 'conflict', 'other', 'recent']) assert.ok(fs.existsSync(f.sync.blobFile(ids[name])), name);
  assert.equal(fs.existsSync(f.sync.blobFile(ids.orphan)), false);
  f.sync.state.entries = {}; f.sync.state.pending = []; f.sync.state.conflicts = {};
  f.sync.save(); fs.unlinkSync(other);
  f.sync.pruneBlobs(now + 2 * blobGraceMs);
  for (const id of Object.values(ids)) assert.equal(fs.existsSync(f.sync.blobFile(id)), false);
});

test('a full legacy database can add cleanup metadata without copying its image rows or losing referenced data', t => {
  const { DatabaseSync } = require('node:sqlite');
  const { StateDatabase } = require('../sync-state.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-full-migration-'));
  const database = new DatabaseSync(path.join(directory, 'legacy.sqlite'));
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  database.exec(`CREATE TABLE sync_entries(key TEXT PRIMARY KEY,kind TEXT NOT NULL,machine TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,writer TEXT NOT NULL);
    CREATE INDEX sync_revision ON sync_entries(revision);
    CREATE TABLE sync_ops(id TEXT PRIMARY KEY,key TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE sync_blobs(hash TEXT PRIMARY KEY,data BLOB NOT NULL);`);
  const used = Buffer.from('Keep this legacy image'), unused = Buffer.from('Unreferenced legacy upload');
  const insert = database.prepare('INSERT INTO sync_blobs VALUES(?,?)'); insert.run(hash(used), used); insert.run(hash(unused), unused);
  const key = stateKey('draft', 'access:local', 'legacy-chat');
  database.prepare('INSERT INTO sync_entries VALUES(?,?,?,?,?,?,?)').run(key, 'draft', 'access:local', 'legacy-chat', 1, JSON.stringify({ text: 'Legacy draft', images: [image(hash(used))] }), 'old-client');
  const maximum = database.prepare('PRAGMA page_count').get().page_count;
  database.exec(`PRAGMA max_page_count=${maximum}`);
  assert.equal(database.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  const migrated = new StateDatabase(database);
  assert.ok(database.prepare('PRAGMA max_page_count').get().max_page_count <= maximum + 16);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_blob_usage').get().count, 1);
  const started = database.prepare("SELECT touched_at FROM sync_blob_usage WHERE hash=''").get().touched_at;
  migrated.collectBlobs(started + blobGraceMs - 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_blobs').get().count, 2);
  migrated.collectBlobs(started + blobGraceMs + 1);
  assert.deepEqual(Buffer.from(database.prepare('SELECT data FROM sync_blobs WHERE hash=?').get(hash(used)).data), used);
  assert.equal(database.prepare('SELECT data FROM sync_blobs WHERE hash=?').get(hash(unused)), undefined);
  assert.equal(migrated.get(key).value.text, 'Legacy draft');
});
