const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { ConversationSync } = require('../conversation-sync.cjs');
const { stateKey, hash, blobGraceMs } = require('../sync-state.cjs');

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

test('state-get reads one current shared entry without uploads and validates its complete identity', t => {
  const { a, b } = fixture(t);
  assert.equal(a.database.request('state-get', { kind: 'history', machine, id: 'missing' }, 'computer-a').result, null);
  const op = operation('note', 'direct-read', 'First value');
  const [first] = a.database.request('state-push', { operations: [op] }, 'computer-a').result;
  const [next] = b.database.request('state-push', { operations: [operation('note', 'direct-read', 'Latest value', 'updated-read', first.revision)] }, 'computer-b').result;
  const read = a.database.request('state-get', { kind: 'note', machine, id: op.id }, 'computer-a').result;
  assert.equal(read.revision, next.revision); assert.equal(read.value, 'Latest value');
  assert.equal(read.key, stateKey('note', machine, op.id));
  for (const change of [{ kind: 'unknown' }, { machine: 'invalid-machine' }, { id: '' }, { id: 'bad\0id' }]) assert.throws(() => a.database.request('state-get', { kind: 'note', machine, id: op.id, ...change }, 'computer-a'), /Invalid synced conversation identity/);
  assert.deepEqual(a.calls, []);
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


test('interrupted completion markers synchronize and clear only after their interrupted turn is observed', async t => {
  const { a, b } = fixture(t), key = stateKey('completion', machine, 'interrupted-chat');
  const marker = { status: 'failed', reason: 'interrupted', turnId: 'interrupted-turn' };
  assert.throws(() => a.database.request('state-push', { operations: [{ kind: 'completion', machine, id: 'invalid-interrupted', opId: 'invalid-interrupted', base: 0, value: 'interrupted' }] }, 'computer-a'), /Invalid synced completion/);
  a.edit('completion', 'interrupted-chat', marker); await a.sync.tick(); await b.sync.tick();
  assert.deepEqual(b.local.get(key), marker);
  b.sync.capture('completion', machine, 'interrupted-chat', null, false, 'older-turn'); await b.sync.tick();
  assert.deepEqual(b.local.get(key), marker);
  b.sync.capture('completion', machine, 'interrupted-chat', null, false, 'interrupted-turn'); await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(key), null); assert.equal(b.local.get(key), null);
});

test('concurrent note edits and clears preserve both versions until an explicit conflict choice', async t => {
  const { a, b } = fixture(t), key = stateKey('note', machine, 'shared-note');
  a.edit('note', 'shared-note', 'Initial note'); await a.sync.tick(); await b.sync.tick();
  a.edit('note', 'shared-note', 'Remote edit'); b.edit('note', 'shared-note', null);
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.sync.conflicts().length, 1); assert.equal(b.sync.conflicts()[0].local, null); assert.equal(b.sync.conflicts()[0].remote.value, 'Remote edit');
  await b.sync.resolve(key, 'remote'); assert.equal(b.local.get(key), 'Remote edit');
  b.sync.capture('note', machine, 'shared-note', 'Typed while a newer note arrived', false, undefined, true); await b.sync.tick();
  assert.equal(b.sync.conflicts().length, 1);
  await b.sync.resolve(key, 'local'); await b.sync.tick(); await a.sync.tick(); assert.equal(a.local.get(key), 'Typed while a newer note arrived');
});

test('legacy numeric child revisions normalize before replay and coalesced typing survives a lost ACK plus restart', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'legacy-chain'), call = a.shared.bridge.call;
  a.edit('draft', 'legacy-chain', draft('Committed root'));
  a.shared.bridge.call = async (method, args) => { const result = await call(method, args); if (method === 'state-push') throw new Error('Lost ACK'); return result; };
  await assert.rejects(a.sync.tick(), /Lost ACK/);
  const root = a.sync.state.pending[0];
  a.edit('draft', 'legacy-chain', draft('First child')); a.edit('draft', 'legacy-chain', draft('Newest coalesced child'));
  const child = a.sync.state.pending[1]; assert.equal(child.parent, root.opId);
  child.base = root.base; a.sync.savePending(); a.restart(); a.shared.bridge.call = call;
  a.sync.load(); assert.equal(a.sync.state.pending[1].base, null); assert.deepEqual(a.sync.queueErrors(), []);
  const before = a.calls.length; await a.sync.tick();
  const pushed = a.calls.slice(before).filter(call => call.method === 'state-push').flatMap(call => call.args.operations);
  assert.deepEqual(pushed.map(op => op.opId), [root.opId]);
  assert.equal(a.sync.state.pending[0].parent, undefined); assert.ok(a.sync.state.pending[0].base > root.base);
  a.restart(); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Newest coalesced child'); assert.equal(a.sync.pending(), false); assert.deepEqual(a.sync.conflicts(), []);
});

test('orphaned, cross-key and cyclic saved edits stay retained and cannot block healthy sync or pulls', async t => {
  const { a, b } = fixture(t);
  a.edit('draft', 'orphan', draft('Preserve orphan')); a.edit('draft', 'cycle', draft('Preserve cycle'));
  const orphan = a.sync.state.pending[0], cycle = a.sync.state.pending[1];
  orphan.parent = 'missing-parent'; orphan.base = 0;
  const other = { ...structuredClone(cycle), opId: 'cycle-child', parent: cycle.opId, base: 0 };
  cycle.parent = other.opId; a.sync.state.pending.push(other);
  a.edit('draft', 'cross-key', draft('Preserve cross-key'));
  a.sync.state.pending.at(-1).parent = orphan.opId;
  a.edit('draft', 'bad-attachments', { text: 'Preserve malformed attachment metadata', images: {} });
  a.edit('pin', 'healthy', true); a.sync.savePending(); a.restart();
  b.edit('note', 'remote-note', 'Keep receiving remote updates'); await b.sync.tick(); await a.sync.tick();
  assert.equal(a.local.get(stateKey('note', machine, 'remote-note')), 'Keep receiving remote updates');
  await b.sync.tick(); assert.equal(b.local.get(stateKey('pin', machine, 'healthy')), true);
  assert.deepEqual(new Set(a.sync.queueErrors().map(error => error.id)), new Set(['orphan', 'cycle', 'cross-key', 'bad-attachments']));
  assert.equal(a.sync.state.pending.length, 5); assert.equal(a.sync.error, null);
  assert.equal(a.calls.filter(call => call.method === 'state-push').flatMap(call => call.args.operations).some(op => op.kind === 'draft'), false);
  a.restart(); assert.equal(a.sync.queueErrors().length, 5);
});

test('one rejected mutation is persisted per conversation while other mutations and incoming updates continue', async t => {
  const { a, b } = fixture(t);
  a.edit('pin', 'invalid', 'not a boolean'); a.edit('finished', 'healthy', true); a.edit('note', 'healthy-note', 'Valid note');
  b.edit('pin', 'peer', true); await b.sync.tick(); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('finished', machine, 'healthy')), true);
  assert.equal(b.local.get(stateKey('note', machine, 'healthy-note')), 'Valid note');
  assert.equal(a.local.get(stateKey('pin', machine, 'peer')), true);
  assert.equal(a.sync.queueErrors()[0].id, 'invalid'); assert.match(a.sync.queueErrors()[0].message, /Invalid synced marker/);
  assert.equal(a.sync.error, null); a.restart(); assert.equal(a.sync.queueErrors().length, 1);
  a.edit('pin', 'invalid', false); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('pin', machine, 'invalid')), false); assert.deepEqual(a.sync.queueErrors(), []);
});

test('bounded blob uploads deliver metadata and pulls before and between chunks and resume safely next tick', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'large-draft');
  const images = Array.from({ length: 6 }, (_, index) => ({ hash: a.sync.keepBlob(Buffer.from('Unique image ' + index)), mime: 'image/png', name: index + '.png' }));
  a.edit('draft', 'large-draft', { ...draft('Attachment batch'), images }); a.edit('pin', 'early', true);
  b.edit('note', 'peer-before-upload', 'Already available'); await b.sync.tick();
  const call = a.shared.bridge.call; let chunks = 0;
  a.shared.bridge.call = async (method, args) => {
    if (method === 'blob-put') {
      chunks++;
      assert.equal(a.local.get(stateKey('note', machine, 'peer-before-upload')), 'Already available');
      if (chunks === 1) a.edit('note', 'during-upload', 'Do not wait for six images');
      if (chunks === 2) assert.equal(b.database.request('state-pull', { cursor: 0 }, 'computer-1').result.entries.find(entry => entry.key === stateKey('note', machine, 'during-upload')).value, 'Do not wait for six images');
    }
    return call(method, args);
  };
  await a.sync.tick();
  assert.equal(chunks, 4); assert.equal(a.sync.state.pending.some(op => op.key === key), true);
  assert.equal(a.calls.find(call => call.method === 'state-push').args.operations[0].id, 'early');
  assert.equal(b.database.request('state-pull', { cursor: 0 }, 'computer-1').result.entries.some(entry => entry.key === key), false);
  a.restart(); await a.sync.tick(); await b.sync.tick();
  assert.equal(chunks, 6); assert.equal(b.local.get(key).text, 'Attachment batch'); assert.equal(a.sync.pending(), false);
});

test('an unavailable local blob does not block metadata and a repaired cache retries the same pending edit', async t => {
  const { a, b } = fixture(t), bytes = Buffer.from('Image can be restored'), id = a.sync.keepBlob(bytes);
  a.edit('draft', 'repair-image', { ...draft('Keep this text'), images: [{ hash: id, mime: 'image/png', name: 'a.png' }] });
  fs.unlinkSync(a.sync.blobFile(id)); a.edit('pin', 'healthy', true);
  await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('pin', machine, 'healthy')), true); assert.equal(a.sync.queueErrors()[0].id, 'repair-image');
  const operation = a.sync.state.pending[0].opId; a.sync.keepBlob(bytes); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'repair-image')).text, 'Keep this text');
  assert.deepEqual(a.sync.queueErrors(), []);
  assert.equal(a.calls.filter(call => call.method === 'state-push').flatMap(call => call.args.operations).some(op => op.opId === operation), true);
});

test('an operation and its receipt roll back together when receipt storage fails', t => {
  const { a } = fixture(t), prepare = a.database.db.prepare.bind(a.database.db), op = operation('note', 'atomic', 'No partial commit', 'atomic-operation');
  t.mock.method(a.database.db, 'prepare', sql => {
    if (sql.startsWith('INSERT INTO sync_ops')) throw new Error('Receipt storage full');
    return prepare(sql);
  });
  const [failed] = a.database.request('state-push', { operations: [op], isolateErrors: true }, 'computer-0').result;
  assert.match(failed.error, /Receipt storage full/);
  assert.equal(a.database.request('state-pull', { cursor: 0 }, 'computer-0').result.entries.length, 0);
  t.mock.restoreAll();
  const [saved] = a.database.request('state-push', { operations: [op] }, 'computer-0').result;
  assert.equal(saved.revision, 1); assert.equal(saved.current.value, 'No partial commit');
});

test('receipt replay succeeds after an obsolete attachment has been collected without restoring the obsolete draft', t => {
  const { a } = fixture(t), now = Date.now(), bytes = Buffer.from('Old attachment'), digest = hash(bytes);
  a.database.request('blob-put', { hash: digest, data: bytes.toString('base64') }, 'computer-0', now);
  const original = operation('draft', 'collected', { ...draft('Old draft'), images: [{ hash: digest, mime: 'image/png', name: 'old.png' }] }, 'old-image-operation');
  const [first] = a.database.request('state-push', { operations: [original] }, 'computer-0', now).result;
  const [newer] = a.database.request('state-push', { operations: [operation('draft', 'collected', draft('New draft'), 'new-draft-operation', first.revision)] }, 'computer-0', now).result;
  a.database.request('blob-prepare', { hashes: [] }, 'computer-0', now + blobGraceMs + 60001);
  assert.throws(() => a.database.request('blob-get', { hash: digest }, 'computer-0'), /not found/);
  const [receipt] = a.database.request('state-push', { operations: [original] }, 'computer-0').result;
  assert.equal(receipt.revision, first.revision); assert.equal(receipt.current.revision, newer.revision); assert.equal(receipt.current.value.text, 'New draft');
});

test('an acknowledged parent and typing journal recover together after its checkpoint write fails and the client restarts', async t => {
  const { a, b } = fixture(t), key = stateKey('draft', machine, 'checkpoint-crash'), call = a.shared.bridge.call;
  const open = fs.openSync; let failCheckpoint = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (failCheckpoint && file === a.sync.file + '.tmp') throw new Error('Checkpoint unavailable after ACK');
    return open(file, ...args);
  });
  a.shared.bridge.call = async (method, args) => {
    const result = await call(method, args);
    if (method === 'state-push') {
      a.edit('draft', 'checkpoint-crash', draft('Typed while parent was in flight'));
      a.edit('draft', 'checkpoint-crash', draft('Newest typing before crash'));
      failCheckpoint = true;
    }
    return result;
  };
  a.edit('draft', 'checkpoint-crash', draft('Acknowledged parent'));
  await assert.rejects(a.sync.tick(), /Checkpoint unavailable/);
  failCheckpoint = false; a.shared.bridge.call = call; a.restart(); a.sync.load();
  assert.equal(a.sync.state.pending.length, 2); assert.equal(a.sync.state.pending[1].base, null);
  await a.sync.tick(); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(key).text, 'Newest typing before crash'); assert.equal(a.sync.pending(), false); assert.deepEqual(a.sync.conflicts(), []);
});

test('editing a later attachment draft before its upload starts never dispatches its replaced snapshot', async t => {
  const { a, b } = fixture(t), id = a.sync.keepBlob(Buffer.from('Shared test image'));
  const withImage = text => ({ ...draft(text), images: [{ hash: id, mime: 'image/png', name: 'a.png' }] });
  a.edit('draft', 'first-upload', withImage('First draft'));
  a.edit('draft', 'later-upload', withImage('Superseded draft'));
  const replaced = a.sync.state.pending[1].opId, call = a.shared.bridge.call; let edited = false;
  a.shared.bridge.call = async (method, args) => {
    if (method === 'blob-put' && !edited) { edited = true; a.edit('draft', 'later-upload', withImage('Newest draft')); }
    return call(method, args);
  };
  await a.sync.tick(); await a.sync.tick(); await b.sync.tick();
  assert.equal(b.local.get(stateKey('draft', machine, 'later-upload')).text, 'Newest draft');
  assert.equal(a.calls.filter(call => call.method === 'state-push').flatMap(call => call.args.operations).some(op => op.opId === replaced), false);
  assert.deepEqual(a.sync.conflicts(), []); assert.equal(a.sync.pending(), false);
});

test('remote resolution callbacks restore pending versions on failure and run only for the chosen remote version', async t => {
  const { a, b } = fixture(t), key = stateKey('note', machine, 'callback-note');
  a.edit('note', 'callback-note', 'Original'); await a.sync.tick(); await b.sync.tick();
  a.edit('note', 'callback-note', 'Remote version'); b.edit('note', 'callback-note', 'Preserved local version');
  await a.sync.tick(); await b.sync.tick();
  const conflict = b.sync.conflicts()[0], pending = structuredClone(b.sync.state.pending);
  let callbacks = 0;
  await assert.rejects(b.sync.resolve(key, 'remote', conflict.version, async () => {
    callbacks++; assert.equal(b.local.get(key), 'Remote version'); throw new Error('Native history could not load');
  }), /Native history could not load/);
  assert.equal(callbacks, 1); assert.deepEqual(b.sync.state.pending, pending);
  assert.equal(b.sync.conflicts()[0].local, 'Preserved local version'); assert.equal(b.sync.conflicts()[0].remote.value, 'Remote version');
  b.restart();
  await b.sync.resolve(key, 'remote', conflict.version, async () => { callbacks++; });
  assert.equal(callbacks, 2); assert.equal(b.sync.pending(), false); assert.deepEqual(b.sync.conflicts(), []);
  await assert.rejects(b.sync.resolve(key, 'remote', conflict.version, async () => { callbacks++; }), /no longer available/);
  assert.equal(callbacks, 2);
  a.edit('note', 'callback-note', 'Another remote edit'); b.edit('note', 'callback-note', 'Choose local');
  await a.sync.tick(); await b.sync.tick();
  await b.sync.resolve(key, 'local', undefined, async () => { throw new Error('Local choices must not call afterRemote'); });
  await b.sync.tick(); await a.sync.tick(); assert.equal(a.local.get(key), 'Choose local');
});

test('state-get remains available while a blob transfer is held by another sync operation', async t => {
  const { a, b } = fixture(t);
  b.edit('note', 'control-read', 'Read without waiting for upload'); await b.sync.tick();
  const id = a.sync.keepBlob(Buffer.from('Held transfer'));
  a.edit('draft', 'held-transfer', { ...draft('Upload pending'), images: [{ hash: id, mime: 'image/png', name: 'a.png' }] });
  const call = a.shared.bridge.call; let release, started;
  const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  a.shared.bridge.call = async (method, args) => { if (method === 'blob-put') { started(); await held; } return call(method, args); };
  const uploading = a.sync.tick(); await began;
  try {
    const entry = await a.shared.bridge.call('state-get', { kind: 'note', machine, id: 'control-read' });
    assert.equal(entry.value, 'Read without waiting for upload');
    assert.equal(a.sync.state.pending.some(op => op.id === 'held-transfer'), true);
  } finally { release(); await uploading; }
});

test('remote resolution rollback restores its original journal without touching a replacement namespace', async t => {
  for (const outcome of ['reject', 'return']) await t.test(outcome, async t => {
    const { a, b } = fixture(t), key = stateKey('note', machine, 'old-conflict');
    a.edit('note', 'old-conflict', 'Original'); await a.sync.tick(); await b.sync.tick();
    a.edit('note', 'old-conflict', 'Remote version'); b.edit('note', 'old-conflict', 'Keep local version');
    await a.sync.tick(); await b.sync.tick();
    const oldNamespace = b.shared.key, oldFile = b.sync.file, pending = structuredClone(b.sync.state.pending), conflict = b.sync.conflicts()[0];
    let release, started;
    const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    const resolving = b.sync.resolve(key, 'remote', conflict.version, async () => {
      started(); await held; if (outcome === 'reject') throw new Error('Native import failed after switching destination');
    });
    await began;
    assert.equal(JSON.parse(fs.readFileSync(oldFile, 'utf8')).pending.length, 0);
    b.shared.key = 'fixture-server:/replacement'; b.sync.load();
    b.edit('note', 'new-namespace', 'Keep new namespace data'); b.sync.save();
    const replacement = b.sync.state, newFile = b.sync.file, newBytes = fs.readFileSync(newFile);
    release(); await assert.rejects(resolving, /Native import failed|destination changed/);
    assert.equal(b.sync.state, replacement); assert.equal(b.sync.file, newFile);
    assert.deepEqual(fs.readFileSync(newFile), newBytes);
    assert.equal(replacement.conflicts[key], undefined); assert.equal(replacement.entries[key], undefined);
    const recovered = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    assert.deepEqual(recovered.pending, pending); assert.equal(recovered.conflicts[key].remote.value, 'Remote version');
    b.shared.key = oldNamespace; b.restart();
    assert.equal(b.sync.conflicts()[0].local, 'Keep local version');
    b.shared.key = 'fixture-server:/replacement'; b.restart(); b.sync.load();
    assert.equal(b.sync.state.pending[0].value, 'Keep new namespace data'); assert.equal(b.sync.state.conflicts[key], undefined);
  });
});

test('stale push and upload responses retain the original outbox and cannot continue against another destination', async t => {
  for (const method of ['state-push', 'blob-prepare', 'blob-put']) await t.test(method, async t => {
    const { a, b } = fixture(t), namespace = a.shared.key, call = a.shared.bridge.call;
    if (method === 'state-push') a.edit('note', 'stale-push', 'Original queued text');
    else {
      const id = a.sync.keepBlob(Buffer.from('Original queued image'));
      a.edit('draft', 'stale-upload', { ...draft('Original queued text'), images: [{ hash: id, mime: 'image/png', name: 'a.png' }] });
    }
    let release, started;
    const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    a.shared.bridge.call = async (name, args) => { const result = await call(name, args); if (name === method) { started(); await held; } return result; };
    const syncing = a.sync.tick(); await began;
    const oldFile = a.sync.file, bytes = fs.readFileSync(oldFile), calls = a.calls.length;
    a.shared.key = 'fixture-server:/changed-while-awaiting'; release();
    await assert.rejects(syncing, error => { a.sync.failed(error); return error.code === 'SYNC_DESTINATION_CHANGED'; });
    assert.equal(a.calls.length, calls); assert.equal(a.sync.error, null); assert.deepEqual(fs.readFileSync(oldFile), bytes);
    a.shared.key = namespace; a.shared.bridge.call = call; a.restart(); await a.sync.tick(); await b.sync.tick();
    const id = method === 'state-push' ? 'stale-push' : 'stale-upload', kind = method === 'state-push' ? 'note' : 'draft';
    const value = b.local.get(stateKey(kind, machine, id));
    assert.equal(typeof value === 'string' ? value : value.text, 'Original queued text'); assert.equal(a.sync.pending(), false);
  });
});

test('stale pull and image responses cannot apply entries or advance a replacement namespace journal', async t => {
  for (const method of ['state-pull', 'blob-get']) await t.test(method, async t => {
    const { a, b } = fixture(t), call = a.shared.bridge.call;
    if (method === 'state-pull') b.edit('note', 'old-incoming', 'Old server note');
    else {
      const id = b.sync.keepBlob(Buffer.from('Old server image'));
      b.edit('draft', 'old-incoming', { ...draft('Old server draft'), images: [{ hash: id, mime: 'image/png', name: 'a.png' }] });
    }
    await b.sync.tick();
    let release, started;
    const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    a.shared.bridge.call = async (name, args) => { const result = await call(name, args); if (name === method) { started(); await held; } return result; };
    const syncing = a.sync.tick(); await began;
    a.shared.key = 'fixture-server:/replacement-incoming'; a.sync.load();
    a.edit('note', 'new-namespace', 'Keep current destination'); a.sync.save();
    const replacement = a.sync.state, file = a.sync.file, bytes = fs.readFileSync(file);
    release(); await assert.rejects(syncing, /destination changed/);
    assert.equal(a.sync.state, replacement); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(replacement.cursor, 0);
    assert.equal(a.local.has(stateKey(method === 'state-pull' ? 'note' : 'draft', machine, 'old-incoming')), false);
    assert.equal(Object.values(replacement.entries).some(entry => entry.id === 'old-incoming'), false);
  });
});
