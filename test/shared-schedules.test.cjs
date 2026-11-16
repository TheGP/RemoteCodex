const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedSchedules } = require('../shared-schedules.cjs');
const { SharedScheduleDatabase, leaseMs } = require('../shared-schedules-host.cjs');
const { ScheduleStore } = require('../scheduler.cjs');

const initialTime = Date.UTC(2026, 10, 15, 12);
const machine = 'access:local';
const options = { enabled: true, host: 'schedule-host', port: 22, key: '' };
function message(threadId = 'same-local-chat', text = 'Check the deployment') {
  return { machine, thread: { id: threadId, cwd: '/work/project', name: 'Local chat' }, text, images: [], input: [{ type: 'text', text }], access: { sandbox: 'read-only', approvalPolicy: 'on-request' }, mode: 'default', turnSettings: { threadId, model: 'saved-model' } };
}
function nativeConnection(owner) {
  return {
    ready: true, session: {}, calls: [], turns: [],
    lookup: (_method, params) => ({ id: params.threadId, cwd: '/work/project', status: { type: 'idle' } }),
    async call(method, params) {
      this.calls.push({ method, params: structuredClone(params) });
      if (method === 'thread/read' || method === 'thread/resume') {
        const thread = this.lookup(method, params);
        return { thread: thread && { ...thread, ...(params.includeTurns ? { turns: structuredClone(this.turns) } : {}) } };
      }
      assert.equal(method, 'turn/start');
      const turn = { id: owner + '-turn-' + (this.turns.length + 1), status: 'inProgress' };
      this.turns.push(turn); return { turn: { ...turn } };
    }
  };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-schedule-coordinator-'));
  const database = new SharedScheduleDatabase(path.join(directory, 'shared.sqlite'));
  const clients = [], databases = [database], clock = { value: initialTime };
  t.after(() => {
    for (const client of clients) client.shared.close();
    for (const db of databases) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (method, params = {}, owner = 'seed') => database.request(method, params, owner, clock.value).result;
  const seed = (id, threadId) => request('create', { id, message: message(threadId), hours: 1 });
  function client(owner, connection = nativeConnection(owner)) {
    const db = new SharedScheduleDatabase(path.join(directory, 'shared.sqlite')); databases.push(db);
    const bridge = {
      child: {}, calls: [], before: null, after: null,
      async connect() { this.child ||= {}; },
      now: () => clock.value,
      async call(method, params = {}) {
        this.calls.push({ method, params: structuredClone(params) });
        await this.before?.(method, params);
        const result = db.request(method, params, owner, clock.value).result;
        await this.after?.(method, params, result);
        return structuredClone(result);
      },
      close() { this.child = null; }
    };
    const file = path.join(directory, owner + '-shared.json');
    const store = new ScheduleStore(path.join(directory, owner + '-local.json'));
    const shared = new SharedSchedules({ file, store, bridge, connection, machine: () => machine, blocked: () => false, dispatching: new Set(), available: () => true });
    const result = { shared, store, bridge, connection, file }; clients.push(result); return result;
  }
  return { directory, database, clock, request, seed, client };
}
const sends = client => client.connection.calls.filter(call => call.method === 'turn/start');

test('eight unchanged polls use eight fetches with no cache writes or UI notifications, while real changes and recovery still publish', async t => {
  const f = fixture(t), a = f.client('computer-a'); await a.shared.configure(options);
  const save = a.shared.save.bind(a.shared); let writes = 0, notices = 0;
  a.shared.save = () => { writes++; save(); }; a.shared.changed = () => notices++;
  a.bridge.calls.length = 0;
  for (let index = 0; index < 8; index++) { f.clock.value += 15000; await a.shared.tick(); }
  assert.equal(a.bridge.calls.filter(call => call.method === 'list').length, 8);
  assert.equal(writes, 0); assert.equal(notices, 0);
  f.seed('new-task'); await a.shared.tick();
  assert.equal(writes, 1); assert.equal(notices, 1);
  assert.equal(JSON.parse(fs.readFileSync(a.file)).tasks[0].id, 'new-task');
  f.request('cancel', { id: 'new-task' }); await a.shared.tick();
  assert.equal(writes, 2); assert.equal(notices, 2);
  assert.equal(a.shared.tasks()[0].status, 'cancelled');
  a.shared.failed(new Error('Offline')); a.shared.failed(new Error('Offline'));
  assert.equal(notices, 3); await a.shared.tick();
  assert.equal(writes, 2); assert.equal(notices, 4); assert.equal(a.shared.settings().error, null);
});

test('a failed cache write retries unchanged server data before reporting recovery, then resumes skipping unchanged saves', async t => {
  const f = fixture(t), a = f.client('computer-a'); await a.shared.configure(options);
  f.seed('retry-cache'); const previous = fs.readFileSync(a.file, 'utf8');
  const rename = fs.renameSync; let attempts = 0;
  fs.renameSync = (source, destination) => {
    if (destination === a.file && ++attempts === 1) throw new Error('Temporary cache write failure');
    return rename(source, destination);
  };
  try {
    await a.shared.tick();
    assert.match(a.shared.settings().error, /Temporary cache write failure/);
    assert.equal(fs.readFileSync(a.file, 'utf8'), previous);
    await a.shared.tick();
    assert.equal(attempts, 2); assert.equal(a.shared.settings().error, null);
    assert.equal(JSON.parse(fs.readFileSync(a.file)).tasks[0].id, 'retry-cache');
    await a.shared.tick(); assert.equal(attempts, 2);
  } finally { fs.renameSync = rename; }
});

function liveStatus(client, forceActive = false) {
  client.connection.lookup = (_method, params) => ({ id: params.threadId, cwd: '/work/project', status: { type: client.connection.turns.some(turn => forceActive || turn.status === 'inProgress') ? 'active' : 'idle' } });
}
const histories = client => client.connection.calls.filter(call => call.method === 'thread/read' && call.params.includeTurns);

test('completion events finish scheduled runs durably without full-history reads during normal execution', async t => {
  const f = fixture(t); f.seed('event-driven'); const a = f.client('computer-a'); liveStatus(a);
  await a.shared.configure(options); f.clock.value += 3600000; await a.shared.tick();
  for (let index = 0; index < 8; index++) { f.clock.value += 15000; await a.shared.tick(); }
  assert.equal(sends(a).length, 1); assert.equal(histories(a).length, 0);
  assert.equal(f.request('list')[0].active, true);
  const save = a.shared.save.bind(a.shared); let writes = 0;
  a.shared.save = () => { writes++; save(); };
  a.connection.turns[0].status = 'completed';
  a.shared.completed({ threadId: 'same-local-chat', turn: a.connection.turns[0] });
  a.shared.completed({ threadId: 'same-local-chat', turn: a.connection.turns[0] });
  assert.equal(writes, 1);
  assert.equal(JSON.parse(fs.readFileSync(a.file)).receipts[0].completed, true);
  await a.shared.tick();
  assert.equal(histories(a).length, 0); assert.equal(f.request('list')[0].active, false);
  assert.equal(a.shared.state.receipts.length, 0); assert.equal(a.shared.receiptChecks.size, 0);
});

test('a completion arriving during a lightweight status request releases delivery without starting a full-history request', async t => {
  const f = fixture(t); f.seed('completion-race'); const a = f.client('computer-a'); liveStatus(a);
  await a.shared.configure(options); f.clock.value += 3600000; await a.shared.tick();
  const call = a.connection.call.bind(a.connection); let arrived = false;
  a.connection.call = async (method, params, ...args) => {
    const snapshot = await call(method, params, ...args);
    if (!arrived && method === 'thread/read' && params.includeTurns === false) {
      arrived = true; a.connection.turns[0].status = 'completed';
      a.shared.completed({ threadId: 'same-local-chat', turn: a.connection.turns[0] });
    }
    return snapshot;
  };
  await a.shared.tick();
  assert.equal(arrived, true); assert.equal(histories(a).length, 0); assert.equal(sends(a).length, 1);
  assert.equal(f.request('list')[0].active, false); assert.equal(a.shared.state.receipts.length, 0);
});

test('a missed completion event recovers from an idle status without waiting for the history fallback', async t => {
  const f = fixture(t); f.seed('missed-event'); const a = f.client('computer-a'); liveStatus(a);
  await a.shared.configure(options); f.clock.value += 3600000; await a.shared.tick();
  a.connection.turns[0].status = 'completed'; await a.shared.tick();
  assert.equal(histories(a).length, 1); assert.equal(sends(a).length, 1);
  assert.equal(f.request('list')[0].active, false); assert.equal(a.shared.state.receipts.length, 0);
});

test('stale active status gets a bounded history fallback, and reconnect or wake forces recovery immediately', async t => {
  for (const trigger of ['fallback', 'session', 'wake']) {
    const f = fixture(t); f.seed(trigger); const a = f.client('computer-a'); liveStatus(a, true);
    await a.shared.configure(options); f.clock.value += 3600000; await a.shared.tick();
    a.connection.turns[0].status = 'interrupted';
    await a.shared.tick(); assert.equal(histories(a).length, 0);
    if (trigger === 'fallback') f.clock.value += 5 * 60000;
    if (trigger === 'session') a.connection.session = {};
    if (trigger === 'wake') a.shared.receiptChecks.clear();
    await a.shared.tick();
    assert.equal(histories(a).length, 1); assert.equal(sends(a).length, 1);
    assert.equal(f.request('list')[0].active, false); assert.equal(a.shared.state.receipts.length, 0);
  }
});

test('migrating a pending upload publishes its shared row even when the following fetch is unchanged', async t => {
  const f = fixture(t), a = f.client('computer-a'); await a.shared.configure(options);
  const task = a.store.enqueue(message(), 1, initialTime); let notices = 0;
  a.shared.changed = () => notices++;
  await a.shared.tick();
  assert.equal(notices, 1); assert.equal(a.shared.summaries()[0].shared, true);
  assert.equal(a.store.get(task.id).sharedImported, true);
});

test('settings expose the folder and storage info, and a folder change cannot orphan pending shared work', async t => {
  const f = fixture(t), a = f.client('computer-a');
  await a.shared.configure({ ...options, folder: '/srv/shared schedules' });
  assert.equal(a.shared.settings().folder, '/srv/shared schedules');
  assert.equal((await a.shared.storageInfo()).directory, f.directory);
  f.seed('pending'); await a.shared.refresh();
  await assert.rejects(a.shared.configure({ ...options, folder: '/srv/different-folder' }), /Cancel or finish/);
  assert.equal(a.shared.settings().folder, '/srv/shared schedules');
});

for (const failure of ['before', 'after']) test(`an interrupted upload ${failure} server acceptance blocks destination changes across restart`, async t => {
  const f = fixture(t), a = f.client('computer-a');
  await a.shared.configure(options);
  a.bridge[failure] = method => { if (method === 'import') throw new Error('Upload interrupted'); };
  const task = await a.shared.create(message(), 1);
  const originalKey = a.shared.key;
  const originalSettings = fs.readFileSync(a.file, 'utf8');
  const originalTask = a.store.get(task.id);
  assert.equal(a.shared.tasks().length, 0);
  assert.equal(originalTask.sharedTo, originalKey); assert.notEqual(originalTask.sharedImported, true);
  a.shared.close();
  const reopened = f.client('computer-a');
  for (const destination of [{ ...options, folder: '/srv/new-folder' }, { ...options, host: 'another-server' }, { ...options, port: 2200 }]) {
    await assert.rejects(reopened.shared.configure(destination), /upload|sync/i);
    assert.equal(reopened.shared.key, originalKey);
    assert.equal(fs.readFileSync(reopened.file, 'utf8'), originalSettings);
    assert.deepEqual(reopened.store.get(task.id), originalTask);
  }
  assert.equal(reopened.bridge.calls.length, 0);
  // Same destination still allows updating connection settings and retrying the saved upload.
  await reopened.shared.configure({ ...options, key: '/keys/repaired-key' });
  await reopened.shared.migrate(); await reopened.shared.refresh();
  assert.equal(f.request('list').length, 1); assert.equal(f.request('list')[0].id, task.id);
  assert.equal(reopened.store.get(task.id).sharedImported, true);
  f.clock.value += 3600000;
  await reopened.shared.tick(); await reopened.shared.tick();
  assert.equal(sends(reopened).length, 1);
});

test('closing the app window or losing the native agent does not renew delivery ownership forever', async t => {
  const f = fixture(t); f.seed('window-closed');
  const a = f.client('computer-a'); await a.shared.configure(options); f.clock.value += 3600000;
  await a.shared.tick();
  assert.equal(sends(a).length, 1);
  a.shared.available = () => false; a.connection.ready = false;
  f.clock.value += 20000; await a.shared.renew();
  f.clock.value += leaseMs; await a.shared.renew();
  const task = f.request('list')[0];
  assert.equal(task.needsReview, true); assert.equal(task.active, true);
  assert.equal(a.shared.locks.size, 0);
  assert.equal(f.request('claim', { id: task.id }), null);
});

test('creating a shared schedule atomically marks its local outbox and accepts an interrupted import without local delivery', async t => {
  const f = fixture(t), a = f.client('computer-a');
  await a.shared.configure(options);
  const writes = [], save = a.store.save.bind(a.store);
  a.store.save = tasks => { writes.push(structuredClone(tasks)); return save(tasks); };
  a.bridge.before = method => {
    if (method !== 'import') return;
    const tasks = new ScheduleStore(a.store.file).list();
    assert.equal(tasks.length, 1); assert.equal(tasks[0].sharedTo, a.shared.key);
    throw new Error('Schedule storage disconnected during import');
  };
  const task = await a.shared.create(message(), 1);
  assert.equal(writes.length, 1); assert.equal(writes[0][0].id, task.id); assert.equal(writes[0][0].sharedTo, a.shared.key);
  assert.equal(a.store.get(task.id).status, 'pending'); assert.notEqual(a.store.get(task.id).sharedImported, true);
  assert.equal(a.shared.summaries()[0].id, task.id); assert.match(a.shared.settings().error, /disconnected during import/);
  assert.equal(f.request('list').length, 0); assert.equal(sends(a).length, 0);
  a.bridge.before = null;
  await a.shared.migrate(); await a.shared.refresh();
  assert.equal(f.request('list').length, 1); assert.equal(a.store.get(task.id).sharedImported, true);
  assert.equal(a.store.get(task.id).message, null); assert.equal(a.shared.summaries().length, 1);
});

test('two coordinators send a shared local-chat task once and wait for its native terminal receipt before the next task', async t => {
  const f = fixture(t);
  f.seed('first'); f.seed('second');
  const a = f.client('computer-a'), b = f.client('computer-b');
  await Promise.all([a.shared.configure(options), b.shared.configure(options)]);
  f.clock.value += 3600000;
  await Promise.all([a.shared.tick(), b.shared.tick()]);
  assert.equal(sends(a).length + sends(b).length, 1);
  const winner = sends(a).length ? a : b;
  assert.equal(f.request('list').find(task => task.id === 'first').active, true);
  assert.equal(f.request('list').find(task => task.id === 'second').status, 'pending');
  assert.equal(winner.shared.state.receipts.length, 1);
  await Promise.all([a.shared.tick(), b.shared.tick()]);
  assert.equal(sends(a).length + sends(b).length, 1);
  assert.deepEqual(sends(winner)[0].params.input, message().input);
  assert.equal(sends(winner)[0].params.model, 'saved-model');
  winner.connection.turns[0].status = 'completed';
  await winner.shared.tick();
  assert.equal(sends(a).length + sends(b).length, 2);
  assert.equal(f.request('list').find(task => task.id === 'first').active, false);
  assert.equal(f.request('list').find(task => task.id === 'second').active, true);
  assert.ok(a.shared.dispatching.size === 0 && b.shared.dispatching.size === 0);
});

test('missing chats, mismatched local folders and a changed resume identity never start a scheduled turn', async t => {
  const f = fixture(t);
  for (const id of ['missing', 'wrong-folder', 'wrong-resume', 'wrong-resume-id']) f.seed(id, id);
  const a = f.client('computer-a');
  a.connection.lookup = (method, params) => {
    if (params.threadId === 'missing') return undefined;
    return { id: method === 'thread/resume' && params.threadId === 'wrong-resume-id' ? 'different-chat' : params.threadId, cwd: params.threadId === 'wrong-folder' || method === 'thread/resume' && params.threadId === 'wrong-resume' ? '/other/project' : '/work/project', status: { type: 'idle' } };
  };
  await a.shared.configure(options); f.clock.value += 3600000;
  await a.shared.tick();
  assert.equal(sends(a).length, 0);
  assert.ok(f.request('list').every(task => task.status === 'pending'));
  assert.equal(a.bridge.calls.filter(call => call.method === 'release').length, 2);
  assert.equal(a.bridge.calls.filter(call => call.method === 'begin').length, 0);
  assert.equal(a.shared.locks.size, 0); assert.equal(a.shared.dispatching.size, 0);
});

test('migration saves outbox intent before importing and never resurrects a previously imported pruned task', async t => {
  const f = fixture(t), a = f.client('computer-a');
  const task = a.store.enqueue(message(), 1, initialTime);
  await a.shared.configure(options);
  let imports = 0;
  a.bridge.before = method => {
    if (method !== 'import') return;
    const saved = new ScheduleStore(a.store.file).get(task.id);
    assert.equal(saved.sharedTo, a.shared.key);
    assert.notEqual(saved.sharedImported, true);
    if (++imports === 1) throw new Error('Import connection dropped');
  };
  await assert.rejects(a.shared.migrate(), /Import connection dropped/);
  assert.equal(new ScheduleStore(a.store.file).get(task.id).sharedTo, a.shared.key);
  assert.notEqual(a.store.get(task.id).sharedImported, true);
  assert.equal(f.request('list').length, 0);
  await a.shared.migrate();
  assert.equal(new ScheduleStore(a.store.file).get(task.id).sharedImported, true);
  assert.equal(f.request('list').length, 1);
  f.request('cancel', { id: task.id }); f.clock.value += 8 * 86400000;
  assert.equal(f.request('list').length, 0);
  a.shared.close();
  const reopened = f.client('computer-a');
  await reopened.shared.refresh(); await reopened.shared.migrate();
  assert.equal(reopened.bridge.calls.filter(call => call.method === 'import').length, 0);
  assert.equal(f.request('list').length, 0); assert.deepEqual(reopened.shared.summaries(), []);
});

test('a lost finish acknowledgment replays its durable receipt after restart without sending the input twice', async t => {
  const f = fixture(t); f.seed('once');
  const a = f.client('computer-a'); await a.shared.configure(options); f.clock.value += 3600000;
  let dropped = false;
  a.bridge.after = method => {
    if (method === 'finish' && !dropped) { dropped = true; throw new Error('Finish acknowledgment was lost'); }
  };
  await a.shared.tick();
  assert.equal(sends(a).length, 1);
  assert.equal(f.request('list')[0].status, 'sent'); assert.equal(f.request('list')[0].active, true);
  const saved = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  assert.equal(saved.receipts.length, 1); assert.equal(saved.receipts[0].turnId, a.connection.turns[0].id);
  const sentAt = f.request('list')[0].sentAt;
  a.shared.close();
  const reopened = f.client('computer-a', a.connection);
  await reopened.shared.tick();
  assert.equal(sends(reopened).length, 1); assert.equal(reopened.shared.state.receipts.length, 1);
  assert.equal(f.request('list')[0].sentAt, sentAt);
  reopened.connection.turns[0].status = 'interrupted';
  await reopened.shared.tick();
  assert.equal(sends(reopened).length, 1); assert.equal(f.request('list')[0].active, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(reopened.file, 'utf8')).receipts, []);
  assert.ok(reopened.bridge.calls.filter(call => call.method === 'finish').length >= 2);
});

test('coordinator editing leases expire locally and old tokens cannot renew or unlock another editor', async t => {
  const f = fixture(t), a = f.client('computer-a'), b = f.client('computer-b');
  await Promise.all([a.shared.configure(options), b.shared.configure(options)]);
  const expired = await a.shared.lock('same-local-chat');
  await assert.rejects(b.shared.lock('same-local-chat'), /Another computer/);
  f.clock.value += leaseMs + 1;
  const current = await b.shared.lock('same-local-chat');
  await assert.rejects(a.shared.verify(expired), /editing lock expired/);
  await a.shared.unlock(expired);
  await b.shared.verify(current);
  await b.shared.unlock(current);
  const fenced = await a.shared.lock('same-local-chat');
  f.request('unlock', { token: fenced }, 'computer-a');
  const replacement = await b.shared.lock('same-local-chat');
  await assert.rejects(a.shared.verify(fenced), /editing lock expired/);
  assert.equal(a.shared.locks.has(fenced), false);
  await a.shared.unlock(fenced);
  await b.shared.verify(replacement);
  await assert.rejects(a.shared.lock('same-local-chat'), /Another computer/);
});

test('an uncertain native send releases its local starting marker while retaining its durable reservation', async t => {
  const f = fixture(t); f.seed('history-timeout'); const a = f.client('computer-a');
  await a.shared.configure(options);
  const reservation = { runToken: 'reserved-run' }; let uncertain = 0, cancelled = 0;
  a.shared.beforeSend = async () => reservation;
  a.shared.uncertainSend = (id, value) => { assert.equal(id, 'same-local-chat'); assert.equal(value, reservation); uncertain++; };
  a.shared.cancelSend = async () => { cancelled++; };
  const call = a.connection.call.bind(a.connection);
  a.connection.call = async (method, params) => { if (method === 'turn/start') throw new Error('Native request timed out'); return call(method, params); };
  f.clock.value += 3600000; await a.shared.tick();
  assert.equal(uncertain, 1); assert.equal(cancelled, 0);
  assert.equal(a.shared.state.receipts.length, 0);
  assert.equal(f.request('list')[0].status, 'unconfirmed');
});

test('a confirmed native send stays sent when recording its completed history reservation needs retry', async t => {
  const f = fixture(t); f.seed('history-after-send'); const a = f.client('computer-a');
  await a.shared.configure(options);
  const reservation = { runToken: 'reserved-run' }; let recorded = 0;
  a.shared.beforeSend = async () => reservation;
  a.shared.afterSend = async (id, value, result) => { assert.equal(id, 'same-local-chat'); assert.equal(value, reservation); assert.ok(result.turn.id); recorded++; throw new Error('Sync server temporarily offline'); };
  f.clock.value += 3600000; await a.shared.tick(); await a.shared.tick();
  assert.equal(recorded, 1); assert.equal(sends(a).length, 1);
  assert.equal(f.request('list')[0].status, 'sent');
});
