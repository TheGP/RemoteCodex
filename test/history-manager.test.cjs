const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HistoryManager } = require('../history-manager.cjs');
const { ConversationState } = require('../conversation-state.cjs');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { PinStore } = require('../pins.cjs');
const { DraftStore } = require('../drafts.cjs');
const { PreferencesStore } = require('../preferences.cjs');
const { hash, stateKey } = require('../sync-state.cjs');

const machine = 'access:local';
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const question = (ordinal, text) => ({ timestamp: '2026-11-16T12:00:00.000Z', ordinal, type: 'event_msg', payload: { type: 'user_message', message: text } });
function gate() {
  let started, release;
  return { started: new Promise(resolve => { started = resolve; }), held: new Promise(resolve => { release = resolve; }), begin: () => started(), release: () => release() };
}
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-history-manager-')));
  const home = path.join(directory, 'codex-home'), previousHome = process.env.CODEX_HOME;
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true }); process.env.CODEX_HOME = home;
  const servers = new Map();
  const server = key => {
    if (!servers.has(key)) servers.set(key, [0, 1].map(() => new SharedScheduleDatabase(path.join(directory, hash(key) + '.sqlite'))));
    return servers.get(key);
  };
  const clients = [0, 1].map(index => {
    const profile = path.join(directory, 'computer-' + index), root = path.join(profile, 'own project');
    fs.mkdirSync(root, { recursive: true });
    let options = { mode: 'local', localCwd: root }, selectedMachine = machine;
    const calls = [], bridgeCalls = [], native = new Map();
    const connection = {
      ready: true, session: {}, before: null,
      supports: (method, provider = 'codex') => provider === 'codex' && method === 'thread/list',
      async call(method, params) {
        calls.push({ method, params: structuredClone(params) }); await this.before?.(method, params);
        if (method === 'thread/list') return { data: [...native.values()].map(thread => structuredClone(thread)), nextCursor: null };
        if (method === 'thread/read') { const thread = native.get(params.threadId); if (!thread) throw new Error('Thread not found'); return { thread: structuredClone(thread) }; }
        if (method === 'thread/turns/list') return { data: structuredClone(native.get(params.threadId)?.turns || []), nextCursor: null };
        if (method === 'thread/unsubscribe') return {};
        assert.equal(method, 'thread/resume', 'history synchronization must not start inference or edit native history');
        assert.ok(params.path, 'native import must resume an explicit private working copy');
        const meta = JSON.parse(fs.readFileSync(params.path, 'utf8').split('\n')[0]);
        const thread = { id: meta.payload.id, path: params.path, cwd: params.cwd, name: 'Imported history', status: { type: 'idle' } };
        native.set(thread.id, thread); return { thread: structuredClone(thread) };
      }
    };
    const shared = {
      enabled: true, key: 'history-fixture:/shared', state: { device: 'computer-' + index }, online: async () => {}, before: null,
      bridge: { call: async (method, args = {}) => {
        const namespace = shared.key;
        bridgeCalls.push({ namespace, method, args: structuredClone(args) }); await shared.before?.(method, args);
        return server(namespace)[index].request(method, structuredClone(args), shared.state.device).result;
      } }
    };
    const state = new ConversationState({ directory: path.join(profile, 'sync'), shared, pins: new PinStore(path.join(profile, 'pins.json')), drafts: new DraftStore(path.join(profile, 'drafts')), preferences: new PreferencesStore(path.join(profile, 'preferences.json')), machine: () => selectedMachine, options: () => options, connection, changed() {}, log() {} });
    state.sync.soon = () => {};
    return { index, state, shared, root, calls, bridgeCalls, native, connection, get options() { return options; }, setOptions: value => { options = value; }, switchMachine: value => { selectedMachine = value; }, history: state.history };
  });
  t.after(() => {
    for (const client of clients) client.state.sync.close();
    for (const databases of servers.values()) for (const database of databases) database.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const create = (client, text = 'Original question', id = randomUUID()) => {
    const file = path.join(home, 'sessions', 'rollout-' + client.index + '-' + id + '.jsonl');
    fs.writeFileSync(file, encode([{ timestamp: '2026-11-16T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id, cwd: client.root, runtime_workspace_roots: [client.root] } }, question(1, text)]));
    const thread = { id, path: file, cwd: client.root, name: 'History fixture', provider: 'codex', status: { type: 'idle' } };
    client.native.set(id, thread); return thread;
  };
  return { directory, home, a: clients[0], b: clients[1], create, server };
}

test('ConversationState owns HistoryManager and sharing-disabled, SSH and unsupported providers never access native history', async t => {
  const f = fixture(t), { a } = f, thread = f.create(a);
  assert.ok(a.history instanceof HistoryManager);
  for (const stop of [() => { a.shared.enabled = false; }, () => { a.connection.ready = false; }, () => a.setOptions({ mode: 'ssh', host: 'other', localCwd: a.root }), () => { a.connection.supports = () => false; }]) {
    a.shared.enabled = true; a.connection.ready = true; a.setOptions({ mode: 'local', localCwd: a.root }); a.connection.supports = (method, provider = 'codex') => method === 'thread/list' && provider === 'codex';
    stop(); const calls = a.calls.length, requests = a.bridgeCalls.length;
    a.history.observe(thread); await a.history.read(thread.id); await a.history.verify(thread.id); await a.history.tick();
    await assert.rejects(a.history.request(thread.id), /not available/);
    assert.deepEqual(a.history.status(), []); assert.equal(a.calls.length, calls); assert.equal(a.bridgeCalls.length, requests);
  }
  a.shared.enabled = true; a.connection.ready = true; a.setOptions({ mode: 'local', localCwd: a.root }); a.connection.supports = () => true;
  for (const ignored of [{ ...thread, id: 'agent:zcode:thread:local' }, { ...thread, provider: 'zcode' }, { ...thread, remoteOnly: true }, { ...thread, ephemeral: true }]) a.history.observe(ignored);
  await a.history.read('agent:zcode:thread:local'); await a.history.verify('agent:zcode:thread:local');
  await assert.rejects(a.history.request('agent:zcode:thread:local'), /not available/);
  assert.equal(a.history.queue.size, 0); assert.equal(a.calls.length, 0);
});

test('only an idle owned native conversation exports in the background and its peer can read without taking ownership', async t => {
  const f = fixture(t), { a, b } = f;
  const idle = f.create(a), active = f.create(a), peer = f.create(b); active.status.type = 'active'; a.native.set(peer.id, peer);
  await a.history.verify(idle.id); await a.history.verify(active.id); await b.history.verify(peer.id);
  await a.history.tick();
  assert.ok(a.state.catalog('history', idle.id)); assert.equal(a.state.catalog('history', active.id), undefined); assert.equal(a.state.catalog('history', peer.id), undefined);
  assert.equal(a.calls.some(call => call.method === 'thread/read' && call.params.threadId === peer.id), false);
  await b.history.refresh(); await assert.rejects(b.history.verify(idle.id), /Use this conversation/);
  await b.history.read(idle.id);
  assert.equal(b.history.canRun(idle.id), false);
  assert.equal(b.history.status().find(owner => owner.id === idle.id).owned, false);
  assert.equal(a.history.canRun(idle.id), true);
  assert.ok([...a.calls, ...b.calls].every(call => ['thread/list', 'thread/read', 'thread/unsubscribe', 'thread/resume'].includes(call.method)));
});

test('a chosen workspace without an imported file can receive its first conversation snapshot', async t => {
  const { a, b, create } = fixture(t), source = create(a);
  await a.history.tick(); await b.state.tick();
  b.state.sync.state.localHistory[source.id] = { workspace: b.root }; b.state.sync.save();
  await b.history.read(source.id);
  const resumed = b.calls.find(call => call.method === 'thread/resume').params;
  assert.equal(resumed.cwd, b.root); assert.ok(fs.existsSync(resumed.path));
  assert.equal(b.history.record(source.id).workspace, b.root);
});

test('a newer trusted history import uses the current local workspace and safe read-only resume without changing either original rollout', async t => {
  const f = fixture(t), { a, b } = f, source = f.create(a, 'Shared original history');
  await a.history.tick(); await b.history.read(source.id);
  const local = b.native.get(source.id), previousDigest = b.history.record(source.id).digest;
  fs.appendFileSync(source.path, encode([question(2, 'New shared message after the trusted baseline')]));
  a.history.observe(source); await a.history.tick();
  assert.notEqual(a.state.catalog('history', source.id).digest, previousDigest);
  const originals = [source.path, local.path].map(file => fs.readFileSync(file));
  await b.history.read(source.id);
  const resumed = b.calls.findLast(call => call.method === 'thread/resume').params;
  assert.equal(resumed.threadId, source.id); assert.equal(resumed.cwd, b.root); assert.deepEqual(resumed.runtimeWorkspaceRoots, [b.root]);
  assert.equal(resumed.sandbox, 'read-only'); assert.equal(resumed.approvalPolicy, 'never'); assert.equal(resumed.excludeTurns, true);
  assert.notEqual(resumed.path, source.path); assert.notEqual(resumed.path, local.path);
  assert.match(path.relative(path.join(f.home, 'sessions'), resumed.path), /^\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-.*\.jsonl$/);
  const metadata = JSON.parse(fs.readFileSync(resumed.path, 'utf8').split('\n')[0]).payload;
  assert.equal(metadata.id, source.id); assert.equal(metadata.cwd, b.root); assert.deepEqual(metadata.runtime_workspace_roots, [b.root]);
  [source.path, local.path].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originals[index]));
  assert.equal(b.history.record(source.id).previousPath, local.path); assert.equal(b.history.record(source.id).digest, a.state.catalog('history', source.id).digest);
  assert.equal(b.calls.filter(call => call.method === 'thread/unsubscribe').length, 1); assert.equal(b.calls.some(call => call.method === 'turn/start'), false);
});

test('a first import cannot replace existing native history without a trusted digest or change its aliases', async t => {
  for (const previous of ['absent', 'workspace-only']) await t.test(previous, async t => {
    const f = fixture(t), { a, b } = f, source = f.create(a);
    await a.history.tick();
    const local = f.create(b, 'Unsynced local original history', source.id), bytes = fs.readFileSync(local.path);
    let aliases;
    b.connection.setThreadAliases = value => { aliases = structuredClone(value); };
    b.history.context();
    if (previous === 'workspace-only') {
      b.state.sync.state.localHistory[source.id] = { workspace: b.root }; b.state.sync.save();
      b.connection.session = {}; b.history.context();
    }
    const savedAliases = structuredClone(aliases), savedRecord = structuredClone(b.history.record(source.id));
    await assert.rejects(b.history.read(source.id), /unsynced conversation messages/);
    assert.equal(b.native.get(source.id).path, local.path);
    assert.deepEqual(fs.readFileSync(local.path), bytes);
    assert.deepEqual(aliases, savedAliases); assert.deepEqual(b.history.record(source.id), savedRecord);
    assert.equal(b.calls.some(call => ['thread/resume', 'thread/unsubscribe'].includes(call.method)), false);
    assert.equal(b.bridgeCalls.some(call => call.method === 'blob-get'), false);
  });
});

test('an identical existing native rollout can receive its first trusted import without losing any records', async t => {
  for (const previous of ['absent', 'workspace-only']) await t.test(previous, async t => {
    const f = fixture(t), { a, b } = f, source = f.create(a, 'Exact baseline question');
    fs.appendFileSync(source.path, encode([
      { ordinal: 2, type: 'event_msg', payload: { type: 'agent_message', message: 'Exact baseline answer' } },
      { ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'baseline-call', output: 'Keep this tool result' } }
    ]));
    await a.history.tick();
    const local = f.create(b, 'Will be replaced by identical bytes', source.id);
    fs.copyFileSync(source.path, local.path);
    const bytes = fs.readFileSync(local.path), rows = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
    b.history.context(); assert.equal(b.history.record(source.id), undefined);
    if (previous === 'workspace-only') { b.state.sync.state.localHistory[source.id] = { workspace: b.root }; b.state.sync.save(); }
    await b.history.read(source.id);
    const record = b.history.record(source.id), imported = fs.readFileSync(record.path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(record.digest, a.state.catalog('history', source.id).digest);
    assert.notEqual(record.path, local.path); assert.equal(record.previousPath, local.path);
    assert.deepEqual(imported.slice(1), rows.slice(1));
    assert.equal(imported[0].payload.cwd, b.root);
    assert.deepEqual(fs.readFileSync(local.path), bytes); assert.deepEqual(fs.readFileSync(source.path), bytes);
    const resumes = b.calls.filter(call => call.method === 'thread/resume');
    assert.equal(resumes.length, 1); assert.equal(resumes[0].params.sandbox, 'read-only');
    assert.equal(b.calls.some(call => call.method === 'turn/start'), false);
  });
});

test('reconnecting after begin clears the stale local reservation and recovers server busy from idle native turns', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  const reservation = await a.history.begin(thread.id);
  assert.ok(reservation.runToken); assert.equal(a.history.starting.has(thread.id), true);
  assert.equal(a.history.status().find(owner => owner.id === thread.id).busy, true);
  thread.turns = [{ id: 'finished-before-reconnect', status: 'completed' }];
  a.connection.session = {};
  await a.history.tick(); await b.history.refresh();
  assert.equal(a.history.starting.has(thread.id), false);
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, false);
  assert.equal(a.calls.some(call => call.method === 'thread/turns/list' && call.params.threadId === thread.id), true);
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-end'), true);
});

test('a Codex-only reconnect fences stale reservations and recovers busy even when the shared pool session stays unchanged', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a), poolSession = a.connection.session;
  const codex = { session: {} }; a.connection.connections = new Map([['codex', codex]]);
  const reservation = await a.history.begin(thread.id);
  thread.turns = [{ id: 'finished-on-old-codex-session', status: 'completed' }];
  codex.session = {};
  assert.equal(a.connection.session, poolSession); assert.equal(a.history.current(reservation), false);
  await a.history.started(thread.id, reservation, { turn: { id: thread.turns[0].id, status: 'completed' } });
  await a.history.end(thread.id, reservation);
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-end'), false, 'a stale native reservation cannot clear server busy');
  await a.history.tick(); await b.history.refresh();
  assert.equal(a.connection.session, poolSession);
  assert.equal(a.history.starting.has(thread.id), false); assert.equal(a.history.runs.has(thread.id), false);
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, false);
  assert.equal(a.bridgeCalls.filter(call => call.method === 'history-end').length, 1);
  await a.history.started(thread.id, reservation, { turn: { id: 'late-old-start', status: 'inProgress' } });
  assert.equal(a.history.runs.has(thread.id), false);
});

test('an uncertain native start retains server busy until recovery verifies both terminal turns and an idle thread', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  const reservation = await a.history.begin(thread.id);
  thread.status.type = 'active'; thread.turns = [{ id: 'native-start-timed-out', status: 'inProgress' }];
  a.history.uncertain(thread.id, reservation);
  assert.equal(a.history.starting.has(thread.id), false);
  assert.equal(a.history.runs.get(thread.id), reservation);
  assert.equal(a.history.queue.has(thread.id), true);
  await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, true);
  await a.history.tick(); await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, true);
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-end'), false);
  thread.turns[0].status = 'completed';
  await a.history.tick(); await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, true, 'a terminal turn alone must not clear a still-active native thread');
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-end'), false);
  thread.status.type = 'idle';
  await a.history.tick(); await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, false);
  assert.equal(a.history.runs.has(thread.id), false); assert.equal(a.history.starting.has(thread.id), false);
  const finishes = a.bridgeCalls.filter(call => call.method === 'history-end');
  assert.equal(finishes.length, 1); assert.equal(finishes[0].args.runToken, reservation.runToken);
  assert.ok(a.calls.some(call => call.method === 'thread/turns/list' && call.params.threadId === thread.id));
  assert.equal(a.calls.some(call => call.method === 'turn/start'), false);
});

test('a detached review completing before its start reply clears the source reservation once its identity arrives', async t => {
  const f = fixture(t), { a, b } = f, source = f.create(a), child = randomUUID();
  const reservation = await a.history.begin(source.id);
  await a.history.completed({ threadId: child, turn: { id: 'review-turn', status: 'completed' } });
  await a.history.started(source.id, reservation, { reviewThreadId: child, turn: { id: 'review-turn', status: 'inProgress' } });
  await b.history.refresh();
  assert.equal(a.history.starting.has(source.id), false);
  assert.equal(b.history.status().find(owner => owner.id === source.id).busy, false);
  assert.equal(a.bridgeCalls.filter(call => call.method === 'history-end').length, 1);
  assert.equal(a.bridgeCalls.find(call => call.method === 'history-end').args.id, source.id);
  assert.equal(a.calls.some(call => call.method === 'turn/start'), false);
});

test('a late completion from a previous turn cannot clear a newer reservation for the same thread', async t => {
  const f = fixture(t), { a, b } = f, source = f.create(a);
  const first = await a.history.begin(source.id);
  await a.history.started(source.id, first, { turn: { id: 'old-turn', status: 'inProgress' } });
  await a.history.completed({ threadId: source.id, turn: { id: 'old-turn', status: 'completed' } });
  const second = await a.history.begin(source.id);
  assert.ok(second.runToken); assert.notEqual(second.runToken, first.runToken);
  await a.history.started(source.id, second, { turn: { id: 'new-turn', status: 'inProgress' } });
  const finished = a.bridgeCalls.filter(call => call.method === 'history-end').length;
  await a.history.completed({ threadId: source.id, turn: { id: 'old-turn', status: 'completed' } });
  await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === source.id).busy, true);
  assert.equal(a.bridgeCalls.filter(call => call.method === 'history-end').length, finished);
  await a.history.completed({ threadId: source.id, turn: { id: 'new-turn', status: 'completed' } });
  await b.history.refresh();
  assert.equal(b.history.status().find(owner => owner.id === source.id).busy, false);
  assert.equal(a.bridgeCalls.filter(call => call.method === 'history-end').length, finished + 1);
});

test('a delayed duplicate end reply cannot overwrite a newer local reservation or its busy state', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  const first = await a.history.begin(thread.id);
  await a.history.started(thread.id, first, { turn: { id: 'first-run', status: 'inProgress' } });
  await a.history.completed({ threadId: thread.id, turn: { id: 'first-run', status: 'completed' } });
  const waiting = gate(), original = a.shared.bridge.call;
  a.shared.bridge.call = async (method, args) => {
    const result = await original(method, args);
    if (method === 'history-end' && args.runToken === first.runToken) { waiting.begin(); await waiting.held; }
    return result;
  };
  const delayedEnd = a.history.end(thread.id, first); await waiting.started;
  const second = await a.history.begin(thread.id);
  await a.history.started(thread.id, second, { turn: { id: 'second-run', status: 'inProgress' } });
  waiting.release(); await delayedEnd; await b.history.refresh();
  assert.equal(a.history.runs.get(thread.id), second);
  assert.equal(a.history.owners.get(thread.id).run_token, second.runToken);
  assert.equal(a.history.status().find(owner => owner.id === thread.id).busy, true);
  assert.equal(b.history.status().find(owner => owner.id === thread.id).busy, true);
});

test('concurrent history reads share one native import and do not resume a working copy twice', async t => {
  const f = fixture(t), { a, b } = f, source = f.create(a); await a.history.tick();
  const waiting = gate(); b.shared.before = async method => { if (method === 'blob-get') { waiting.begin(); await waiting.held; } };
  const first = b.history.read(source.id), second = b.history.read(source.id); await waiting.started; waiting.release();
  await Promise.all([first, second]);
  assert.equal(b.calls.filter(call => call.method === 'thread/read').length, 1); assert.equal(b.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(b.history.importing.size, 0); assert.ok(b.history.record(source.id));
});

test('a startup read of the current server digest preserves newly appended unsynced native messages', async t => {
  const f = fixture(t), { a } = f, thread = f.create(a);
  await a.history.tick();
  const previous = structuredClone(a.history.record(thread.id));
  fs.appendFileSync(thread.path, encode([question(2, 'Unsynced message written before restart')]));
  const bytes = fs.readFileSync(thread.path), resumeCount = a.calls.filter(call => call.method === 'thread/resume').length;
  assert.notEqual(a.history.stamp(thread.path), previous.stamp);
  a.history.owners.clear();
  await a.history.read(thread.id);
  assert.deepEqual(a.history.record(thread.id), previous);
  assert.equal(a.native.get(thread.id).path, thread.path);
  assert.deepEqual(fs.readFileSync(a.native.get(thread.id).path), bytes);
  assert.equal(a.calls.filter(call => call.method === 'thread/resume').length, resumeCount);
  assert.equal(a.history.owners.size, 0, 'opening the existing local digest must not require ownership refresh');
});

test('newer peer history cannot replace a dirty local working copy with an empty or foreign ownership cache', async t => {
  for (const cache of ['empty', 'foreign']) await t.test(cache, async t => {
    const f = fixture(t), { a, b } = f, thread = f.create(a);
    await a.history.tick(); await b.history.read(thread.id);
    const previous = structuredClone(b.history.record(thread.id));
    fs.appendFileSync(previous.path, encode([question(2, 'Unsynced local working-copy message')]));
    const bytes = fs.readFileSync(previous.path), resumeCount = b.calls.filter(call => call.method === 'thread/resume').length;
    fs.appendFileSync(thread.path, encode([question(2, 'New peer manifest message')]));
    a.history.observe(thread); await a.history.tick();
    b.history.owners.clear();
    if (cache === 'foreign') {
      await b.history.refresh();
      assert.equal(b.history.owners.get(thread.id).owner, a.shared.state.device);
    }
    await assert.rejects(b.history.read(thread.id), /unsynced conversation messages/);
    assert.notEqual(b.state.catalog('history', thread.id).digest, previous.digest);
    assert.deepEqual(b.history.record(thread.id), previous);
    assert.equal(b.native.get(thread.id).path, previous.path);
    assert.deepEqual(fs.readFileSync(previous.path), bytes);
    assert.equal(b.calls.filter(call => call.method === 'thread/resume').length, resumeCount);
  });
});

test('a shared conversation tombstone hides an imported native copy and native capture cannot resurrect it', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  await a.history.tick(); await b.history.read(thread.id);
  const imported = b.native.get(thread.id), bytes = fs.readFileSync(imported.path);
  assert.equal(b.state.threads([imported], null).some(item => item.id === thread.id), true);
  a.state.sync.capture('thread', machine, thread.id, null);
  await a.state.sync.tick(); await b.state.sync.tick();
  assert.equal(b.state.catalog('thread', thread.id), null);
  assert.deepEqual(b.state.threads([imported], null), []);
  b.history.queue.clear(); b.state.captureThread({ ...imported, name: 'Stale native catalog result', updatedAt: Date.now() });
  assert.equal(b.state.sync.state.pending.some(op => op.kind === 'thread' && op.id === thread.id), false);
  assert.equal(b.history.queue.has(thread.id), false);
  await b.state.sync.tick(); await a.state.sync.tick();
  assert.equal(a.state.catalog('thread', thread.id), null);
  assert.deepEqual(fs.readFileSync(imported.path), bytes);
});

test('a changed native file is retried and never publishes a partially captured history', async t => {
  const f = fixture(t), { a } = f, thread = f.create(a), keepBlob = a.state.sync.keepBlob.bind(a.state.sync);
  let changed = false;
  a.state.sync.keepBlob = data => {
    if (!changed) { changed = true; fs.appendFileSync(thread.path, encode([question(2, 'Arrived while exporting')])); }
    return keepBlob(data);
  };
  const failure = await a.history.tick().then(() => null, error => error);
  if (failure) assert.match(failure.message, /changed while exporting/);
  assert.equal(a.state.catalog('history', thread.id), undefined);
  await a.history.tick();
  assert.ok(a.state.catalog('history', thread.id)); assert.equal(a.history.record(thread.id).stamp, a.history.stamp(thread.path));
  assert.match(fs.readFileSync(thread.path, 'utf8'), /Arrived while exporting/);
  assert.equal(a.calls.some(call => call.method === 'turn/start'), false);
});

test('a requested handoff waits for both native idle state and a fully uploaded history before releasing ownership', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  await a.history.verify(thread.id); await b.history.request(thread.id);
  thread.status.type = 'active'; await a.history.tick();
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, true); assert.equal(a.bridgeCalls.some(call => call.method === 'history-release'), false);
  assert.equal(b.history.status().find(owner => owner.id === thread.id).waiting, true);
  thread.status.type = 'idle'; a.shared.before = method => { if (method === 'blob-put') throw new Error('Upload unavailable'); };
  await assert.rejects(a.history.tick(), /Upload unavailable/);
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-release'), false);
  a.shared.before = null; await a.state.sync.tick(); await a.history.tick(); await b.history.refresh();
  const release = a.bridgeCalls.findIndex(call => call.method === 'history-release'), published = a.bridgeCalls.findLastIndex(call => call.method === 'state-push');
  assert.ok(published >= 0 && release > published);
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, false); assert.equal(b.history.status().find(owner => owner.id === thread.id).owned, true);
  await assert.rejects(a.history.verify(thread.id), /Use this conversation/);
  assert.equal(a.calls.some(call => call.method === 'turn/start'), false);
});

test('a native turn becoming active during upload keeps ownership until a later idle history check', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  await a.history.verify(thread.id); await b.history.request(thread.id);
  a.shared.before = method => { if (method === 'blob-put') thread.status.type = 'active'; };
  await a.history.tick();
  assert.ok(a.state.catalog('history', thread.id));
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-release'), false, 'an upload finishing after native work starts must not hand off its conversation');
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, true);
  thread.status.type = 'idle'; a.shared.before = null; a.history.observe(thread); await a.history.tick();
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, false);
});

test('native messages appended after export must upload before ownership can transfer', async t => {
  const f = fixture(t), { a, b } = f, thread = f.create(a);
  await a.history.verify(thread.id); await b.history.request(thread.id);
  let appended = false;
  a.shared.before = method => {
    if (method === 'blob-put' && !appended) { appended = true; fs.appendFileSync(thread.path, encode([question(2, 'Message added during upload')])); }
  };
  await a.history.tick();
  assert.equal(a.bridgeCalls.some(call => call.method === 'history-release'), false, 'handoff must not leave a newer native rollout behind its published snapshot');
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, true);
  a.shared.before = null; a.history.observe(thread); await a.history.tick(); await b.history.read(thread.id);
  const resumed = b.calls.find(call => call.method === 'thread/resume');
  assert.ok(resumed); assert.match(fs.readFileSync(resumed.params.path, 'utf8'), /Message added during upload/);
  assert.equal(a.history.status().find(owner => owner.id === thread.id).owned, false);
});

test('history imports ignore stale namespace, machine and agent-session responses before native resume', async t => {
  for (const change of ['namespace', 'machine', 'session']) await t.test(change, async t => {
    const f = fixture(t), { a, b } = f, source = f.create(a); await a.history.tick();
    const waiting = gate(); b.shared.before = async method => { if (method === 'blob-get') { waiting.begin(); await waiting.held; } };
    const reading = b.history.read(source.id); await waiting.started;
    if (change === 'namespace') b.shared.key = 'history-fixture:/other-namespace';
    else if (change === 'machine') b.switchMachine('access:another-machine:22');
    else b.connection.session = {};
    waiting.release(); await assert.rejects(reading, /connection changed/);
    assert.equal(b.calls.some(call => call.method === 'thread/resume'), false); assert.equal(b.state.sync.state.localHistory?.[source.id], undefined); assert.equal(b.history.importing.size, 0);
  });
});
