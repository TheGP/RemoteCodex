const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { ConversationSync } = require('../conversation-sync.cjs');
const { stateKey, hash } = require('../sync-state.cjs');

const machine = 'access:conversation-host:22';
const draft = text => ({ text, images: [], model: 'saved-model', effort: 'high', mode: 'default', access: 'read-only' });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-conversation-sync-'));
  const file = path.join(directory, 'shared.sqlite');
  const databases = [new SharedScheduleDatabase(file), new SharedScheduleDatabase(file)];
  const clients = databases.map((database, index) => {
    const local = new Map(), applied = [], calls = [], errors = [];
    const shared = { enabled: true, key: 'fixture-server:/shared', online: async () => {}, failed: error => errors.push(error), bridge: { call: async (method, args) => {
      const copy = structuredClone(args); calls.push({ method, args: copy });
      return database.request(method, copy, 'computer-' + index).result;
    } } };
    const client = { local, applied, calls, errors, shared, database };
    const make = () => {
      const sync = new ConversationSync({ directory: path.join(directory, 'computer-' + index), shared, apply: async (entry, sync) => {
        if (entry.value?.images?.length) await sync.images(entry.value, true);
        local.set(entry.key, structuredClone(entry.value)); applied.push(structuredClone(entry)); return true;
      } });
      sync.soon = () => {};
      return sync;
    };
    client.sync = make();
    client.edit = (kind, id, value, seed = false, selectedMachine = machine) => {
      local.set(stateKey(kind, selectedMachine, id), structuredClone(value));
      client.sync.capture(kind, selectedMachine, id, value, seed);
    };
    client.restart = () => { client.sync.close(); client.sync = make(); };
    return client;
  });
  t.after(() => { clients.forEach(client => client.sync.close()); databases.forEach(database => database.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, a: clients[0], b: clients[1] };
}
function operation(kind, id, value, opId = kind + '-' + id, base = 0) { return { kind, machine, id, value, opId, base }; }

test('conversation markers synchronize both ways and stay scoped to their machine and message', async t => {
  const { a, b } = fixture(t);
  const pin = stateKey('pin', machine, 'chat-a'), unread = stateKey('unread', machine, 'chat-a');
  const message = { itemId: 'item-a', turnId: 'turn-a', preview: 'Remember this response' };
  a.edit('pin', 'chat-a', true); a.edit('unread', 'chat-a', true);
  a.edit('completion', 'chat-a', 'completed'); a.edit('messagePin', 'chat-a:item-a', message);
  a.edit('pin', 'chat-a', false, false, 'access:another-host:22');
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(pin), true); assert.equal(b.local.get(unread), true);
  assert.equal(b.local.get(stateKey('completion', machine, 'chat-a')), 'completed');
  assert.deepEqual(b.local.get(stateKey('messagePin', machine, 'chat-a:item-a')), message);
  assert.equal(b.local.get(stateKey('pin', 'access:another-host:22', 'chat-a')), false);
  b.edit('pin', 'chat-a', false); b.edit('unread', 'chat-a', false); b.edit('messagePin', 'chat-a:item-a', null);
  await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(pin), false); assert.equal(a.local.get(unread), false);
  assert.equal(a.local.get(stateKey('messagePin', machine, 'chat-a:item-a')), null);
  assert.equal(a.sync.pending(), false); assert.equal(b.sync.pending(), false);
});

test('replayed sync mutations return their original receipt without overwriting a newer value', t => {
  const { a, b } = fixture(t);
  const original = operation('pin', 'chat-a', true, 'stable-operation');
  const first = a.database.request('state-push', { operations: [original] }, 'computer-a').result[0];
  const changed = b.database.request('state-push', { operations: [operation('pin', 'chat-a', false, 'newer-operation')] }, 'computer-b').result[0];
  const replayed = a.database.request('state-push', { operations: [original] }, 'computer-a').result[0];
  assert.equal(replayed.revision, first.revision);
  assert.equal(replayed.current.revision, changed.revision); assert.equal(replayed.current.value, false);
  const page = b.database.request('state-pull', { cursor: 0 }, 'computer-b').result;
  assert.equal(page.entries.length, 1); assert.equal(page.cursor, changed.revision);
  assert.throws(() => a.database.request('state-push', { operations: [operation('pin', 'chat-b', true, original.opId)] }, 'computer-a'), /identity was reused/);
  assert.equal(a.database.request('state-pull', { cursor: changed.revision }, 'computer-a').result.entries.length, 0);
});

test('stale read markers adopt newer remote unread and completion state without creating draft conflicts', async t => {
  const { a, b } = fixture(t);
  a.edit('unread', 'chat-a', true); a.edit('completion', 'chat-a', 'completed');
  await a.sync.tick(); await b.sync.tick();
  a.edit('unread', 'chat-a', false); a.edit('completion', 'chat-a', null);
  b.edit('unread', 'chat-a', false); b.edit('completion', 'chat-a', 'failed'); await b.sync.tick();
  b.edit('unread', 'chat-a', true); await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(stateKey('unread', machine, 'chat-a')), true);
  assert.equal(a.local.get(stateKey('completion', machine, 'chat-a')), 'failed');
  assert.equal(a.sync.pending(), false); assert.equal(a.sync.conflicts().length, 0);
});

test('concurrent draft edits preserve both versions until an explicit local or remote resolution', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  a.edit('draft', 'chat-a', draft('Starting draft')); await a.sync.tick(); await b.sync.tick();
  a.edit('draft', 'chat-a', draft('Typed on computer A'));
  b.edit('draft', 'chat-a', draft('Typed on computer B'));
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Typed on computer B');
  assert.equal(b.sync.conflicts()[0].local.text, 'Typed on computer B');
  assert.equal(b.sync.conflicts()[0].remote.value.text, 'Typed on computer A');
  b.restart(); await b.sync.hydrate();
  assert.equal(b.local.get(key).text, 'Typed on computer B');
  assert.equal(b.sync.conflicts().length, 1);
  await b.sync.resolve(key, 'local'); await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(key).text, 'Typed on computer B'); assert.equal(b.sync.conflicts().length, 0);
  a.edit('draft', 'chat-a', draft('Keep computer A'));
  b.edit('draft', 'chat-a', draft('Discard this conflicting edit'));
  await a.sync.tick(); await b.sync.tick(); await b.sync.resolve(key, 'remote');
  assert.equal(b.local.get(key).text, 'Keep computer A'); assert.equal(b.sync.pending(), false);
});

test('a stale draft clear cannot erase a newer remote draft without explicit conflict resolution', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  a.edit('draft', 'chat-a', draft('Original text')); await a.sync.tick(); await b.sync.tick();
  a.edit('draft', 'chat-a', null); b.edit('draft', 'chat-a', draft('New text on computer B'));
  await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(key), null); assert.equal(b.local.get(key).text, 'New text on computer B');
  const conflict = a.sync.conflicts()[0];
  assert.equal(conflict.local, null); assert.equal(conflict.remote.value.text, 'New text on computer B');
  await a.sync.resolve(key, 'local'); await a.sync.tick(); await b.sync.tick();
  assert.equal(a.local.get(key), null); assert.equal(b.local.get(key), null);
  assert.equal(b.sync.entries('draft', machine).length, 0);
});

test('a remote clear does not silently overwrite newer local typing', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  a.edit('draft', 'chat-a', draft('Original text')); await a.sync.tick(); await b.sync.tick();
  a.edit('draft', 'chat-a', null); b.edit('draft', 'chat-a', draft('Still typing locally'));
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Still typing locally');
  assert.equal(b.sync.conflicts()[0].remote.value, null);
  await b.sync.resolve(key, 'remote');
  assert.equal(b.local.get(key), null); assert.equal(b.sync.pending(), false);
});

test('seeding an older local draft preserves an existing shared draft as an explicit conflict', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  a.edit('draft', 'chat-a', draft('Already shared')); await a.sync.tick();
  b.edit('draft', 'chat-a', draft('Older unsynced local draft'), true); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Older unsynced local draft');
  assert.equal(b.sync.conflicts()[0].remote.value.text, 'Already shared');
  await b.sync.resolve(key, 'remote');
  assert.equal(b.local.get(key).text, 'Already shared'); assert.equal(b.sync.pending(), false);
});

test('lost mutation acknowledgements and subsequent typing survive restart without duplicate writes', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  const call = a.shared.bridge.call;
  a.shared.bridge.call = async (method, args) => { const result = await call(method, args); if (method === 'state-push') throw new Error('Acknowledgement lost'); return result; };
  a.edit('draft', 'chat-a', draft('Already committed remotely'));
  await assert.rejects(a.sync.tick(), /Acknowledgement lost/);
  const firstId = a.sync.state.pending[0].opId;
  a.edit('draft', 'chat-a', draft('Typed after the lost acknowledgement'));
  a.restart(); a.shared.bridge.call = call;
  assert.equal(a.sync.pending(), true); assert.equal(a.sync.state.pending[0].opId, firstId);
  await a.sync.tick();
  assert.equal(a.local.get(key).text, 'Typed after the lost acknowledgement');
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Typed after the lost acknowledgement');
  assert.equal(a.sync.pending(), false);
  const written = a.calls.filter(call => call.method === 'state-push').flatMap(call => call.args.operations.map(op => op.opId));
  assert.equal(written.length, 3); assert.equal(new Set(written).size, 2);
});

test('draft images require uploaded matching checksums and reach another client intact', async t => {
  const { a, b } = fixture(t), bytes = Buffer.from('Fixture image bytes 世界🙂'), digest = hash(bytes);
  const image = { hash: digest, name: 'fixture.png', mime: 'image/png' };
  const value = { ...draft('With an attachment'), images: [image] };
  assert.throws(() => a.database.request('state-push', { operations: [operation('draft', 'missing-attachment', value)] }, 'computer-a'), /Upload draft attachments/);
  assert.throws(() => a.database.request('blob-put', { hash: digest, data: Buffer.from('wrong data').toString('base64') }, 'computer-a'), /checksum/);
  assert.throws(() => a.database.request('blob-get', { hash: digest }, 'computer-a'), /not found/);
  assert.equal(a.sync.keepBlob(bytes), digest);
  a.edit('draft', 'chat-a', value); await a.sync.tick(); await b.sync.tick();
  const restored = await b.sync.images(value);
  assert.deepEqual(Buffer.from(restored[0].url.split(',')[1], 'base64'), bytes);
  assert.equal(restored[0].name, image.name);
  assert.ok(a.calls.findIndex(call => call.method === 'blob-put') < a.calls.findIndex(call => call.method === 'state-push'));
});

test('a corrupted attachment download cannot overwrite the receiving client\'s local state', async t => {
  const { a, b } = fixture(t), bytes = Buffer.from('Correct attachment'), digest = a.sync.keepBlob(bytes);
  const value = { ...draft('Remote attachment'), images: [{ hash: digest, mime: 'image/png', name: 'fixture.png' }] };
  a.edit('draft', 'chat-a', value); await a.sync.tick();
  const call = b.shared.bridge.call;
  b.shared.bridge.call = (method, args) => method === 'blob-get' ? Promise.resolve({ data: Buffer.from('Corrupted in transit').toString('base64') }) : call(method, args);
  await assert.rejects(b.sync.tick(), /checksum/);
  assert.equal(b.local.has(stateKey('draft', machine, 'chat-a')), false);
  assert.equal(fs.existsSync(b.sync.blobFile(digest)), false);
  b.shared.bridge.call = call; await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'chat-a')).text, value.text);
});

test('an existing cached attachment is checksum-verified before being applied', async t => {
  const { a, b } = fixture(t), bytes = Buffer.from('Original cached attachment'), digest = a.sync.keepBlob(bytes);
  const value = { ...draft('Remote attachment'), images: [{ hash: digest, mime: 'image/png', name: 'fixture.png' }] };
  a.edit('draft', 'chat-a', value); await a.sync.tick();
  fs.mkdirSync(path.dirname(b.sync.blobFile(digest)), { recursive: true });
  fs.writeFileSync(b.sync.blobFile(digest), 'Truncated cache contents');
  await assert.rejects(b.sync.tick(), /checksum/);
  assert.equal(b.local.has(stateKey('draft', machine, 'chat-a')), false);
  assert.equal(fs.existsSync(b.sync.blobFile(digest)), false);
  await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'chat-a')).text, value.text);
  assert.deepEqual(fs.readFileSync(b.sync.blobFile(digest)), bytes);
});

test('a failed cache write is retried even when the next pull has no newer conversation changes', async t => {
  const { a, b } = fixture(t), key = stateKey('pin', machine, 'chat-a');
  a.edit('pin', 'chat-a', true); await a.sync.tick();
  b.sync.load(); b.sync.save();
  const open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === b.sync.file + '.tmp') throw new Error('Conversation cache disk is full');
    return open(file, ...args);
  };
  try { await assert.rejects(b.sync.tick(), /cache disk is full/); }
  finally { fs.openSync = open; }
  const cursor = b.sync.state.cursor;
  assert.ok(cursor > 0); assert.equal(b.sync.dirty, true);
  assert.equal(JSON.parse(fs.readFileSync(b.sync.file, 'utf8')).cursor, 0);
  await b.sync.tick();
  assert.equal(b.sync.dirty, false);
  b.restart(); b.sync.load();
  assert.equal(b.sync.state.cursor, cursor); assert.equal(b.sync.state.entries[key].value, true);
});

test('later pulls refresh conflicted remote versions before resolving either local or remote', async t => {
  const { a, b } = fixture(t);
  for (const id of ['choose-local', 'choose-remote']) a.edit('draft', id, draft('Initial shared text'));
  await a.sync.tick(); await b.sync.tick();
  for (const id of ['choose-local', 'choose-remote']) { a.edit('draft', id, draft('First remote edit')); b.edit('draft', id, draft('Keep local typing')); }
  await a.sync.tick(); await b.sync.tick();
  const previous = b.sync.conflicts();
  for (const id of ['choose-local', 'choose-remote']) a.edit('draft', id, draft('Newest remote edit'));
  await a.sync.tick(); await b.sync.tick();
  for (const conflict of b.sync.conflicts()) {
    assert.equal(conflict.remote.value.text, 'Newest remote edit'); assert.equal(conflict.local.text, 'Keep local typing');
    const stale = previous.find(entry => entry.key === conflict.key);
    await assert.rejects(b.sync.resolve(conflict.key, 'remote', stale.version), /versions changed/);
  }
  const localKey = stateKey('draft', machine, 'choose-local'), remoteKey = stateKey('draft', machine, 'choose-remote');
  await b.sync.resolve(localKey, 'local', b.sync.conflicts().find(entry => entry.key === localKey).version);
  await b.sync.resolve(remoteKey, 'remote', b.sync.conflicts().find(entry => entry.key === remoteKey).version);
  await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(localKey).text, 'Keep local typing'); assert.equal(b.local.get(remoteKey).text, 'Newest remote edit');
  assert.equal(b.sync.conflicts().length, 0); assert.equal(b.sync.pending(), false);
});

test('typing during attachment upload chains the saved in-flight draft instead of replacing it or self-conflicting', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  const digest = a.sync.keepBlob(Buffer.from('Image awaiting upload'));
  const first = { ...draft('Before upload finishes'), images: [{ hash: digest, mime: 'image/png', name: 'fixture.png' }] };
  const call = a.shared.bridge.call;
  let releaseUpload, uploadStarted;
  const hold = new Promise(resolve => { releaseUpload = resolve; });
  const started = new Promise(resolve => { uploadStarted = resolve; });
  a.shared.bridge.call = async (method, args) => { if (method === 'blob-put') { uploadStarted(); await hold; } return call(method, args); };
  a.edit('draft', 'chat-a', first);
  const sending = a.sync.tick(); await started;
  const original = a.sync.state.pending[0];
  assert.equal(original.sent, true); assert.equal(JSON.parse(fs.readFileSync(a.sync.file, 'utf8')).pending[0].sent, true);
  a.edit('draft', 'chat-a', { ...first, text: 'Typed while image was uploading' });
  assert.equal(a.sync.state.pending.length, 2); assert.equal(a.sync.state.pending[1].parent, original.opId);
  releaseUpload(); await sending;
  assert.equal(a.local.get(key).text, 'Typed while image was uploading'); assert.equal(a.sync.conflicts().length, 0);
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Typed while image was uploading');
  assert.equal(a.sync.pending(), false); assert.equal(a.sync.conflicts().length, 0);
});

test('typing journals only pending edits, survives restart before first upload, and cannot revive an old outbox after a checkpoint', async t => {
  const { a, b } = fixture(t);
  a.edit('draft', 'chat-a', draft('First pending draft'));
  assert.equal(fs.existsSync(a.sync.file), false);
  assert.equal(fs.existsSync(a.sync.file + '.outbox'), true);
  const older = fs.readFileSync(a.sync.file + '.outbox');
  a.restart(); assert.equal(a.sync.pending(), true);
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'chat-a')).text, 'First pending draft');
  assert.equal(fs.existsSync(a.sync.file + '.outbox'), false);
  const checkpoint = fs.readFileSync(a.sync.file);
  a.edit('draft', 'chat-a', draft('Typed after checkpoint'));
  assert.deepEqual(fs.readFileSync(a.sync.file), checkpoint);
  a.restart(); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'chat-a')).text, 'Typed after checkpoint');
  fs.writeFileSync(a.sync.file + '.outbox', older);
  a.restart(); assert.equal(a.sync.pending(), false);
});

test('completion can be acknowledged only after observing the completed turn, even with the latest state revision', async t => {
  const { a, b } = fixture(t), key = stateKey('completion', machine, 'chat-a');
  a.edit('completion', 'chat-a', { status: 'completed', turnId: 'new-turn' });
  await a.sync.tick(); await b.sync.tick();
  b.edit('completion', 'chat-a', null); await b.sync.tick();
  assert.deepEqual(b.local.get(key), { status: 'completed', turnId: 'new-turn' });
  b.sync.capture('completion', machine, 'chat-a', null, false, 'old-turn'); await b.sync.tick();
  assert.deepEqual(b.local.get(key), { status: 'completed', turnId: 'new-turn' });
  b.sync.capture('completion', machine, 'chat-a', null, false, 'new-turn'); await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(key), null);
});

test('failed remote conflict application preserves both drafts and the explicit choice across restart', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'chat-a');
  a.edit('draft', 'chat-a', draft('Original')); await a.sync.tick(); await b.sync.tick();
  a.edit('draft', 'chat-a', draft('Remote edit')); b.edit('draft', 'chat-a', draft('My edit'));
  await a.sync.tick(); await b.sync.tick();
  b.sync.apply = async () => { throw new Error('Local draft disk is full'); };
  await assert.rejects(b.sync.resolve(key, 'remote'), /disk is full/);
  assert.equal(b.sync.conflicts()[0].local.text, 'My edit');
  b.restart(); assert.equal(b.sync.conflicts()[0].remote.value.text, 'Remote edit');
  await b.sync.resolve(key, 'remote'); assert.equal(b.local.get(key).text, 'Remote edit');
});
