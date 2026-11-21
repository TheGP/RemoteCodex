const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { SharedScheduleDatabase, leaseMs } = require('../shared-schedules-host.cjs');
const { ScheduleStore } = require('../scheduler.cjs');

const now = Date.UTC(2026, 10, 15, 12);
const due = now + 3600000;
const machine = 'access:shared-host:22';
function message(threadId = 'shared-chat', text = 'Check the deployment', selectedMachine = machine) {
  return { machine: selectedMachine, thread: { id: threadId, cwd: '/srv/project', name: 'Shared chat' }, text, images: [], input: [{ type: 'text', text }], access: { sandbox: 'read-only', approvalPolicy: 'on-request' }, mode: 'default', turnSettings: { threadId, model: 'saved-model' } };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-shared-schedules-'));
  const file = path.join(directory, 'schedules.sqlite');
  const first = new SharedScheduleDatabase(file), second = new SharedScheduleDatabase(file);
  t.after(() => { second.close(); first.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const a = (method, args = {}, at = now) => first.request(method, args, 'computer-a', at).result;
  const b = (method, args = {}, at = now) => second.request(method, args, 'computer-b', at).result;
  const create = (id = 'task-a', threadId = 'shared-chat', selectedMachine = machine) => a('create', { id, message: message(threadId, 'Check the deployment', selectedMachine), hours: 1 });
  return { file, first, second, a, b, create };
}

test('storage details report the selected folder and its file sizes without following symlinks', t => {
  const f = fixture(t), directory = path.dirname(f.file);
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'nested', 'attachment'), Buffer.alloc(1234));
  fs.symlinkSync(directory, path.join(directory, 'nested', 'loop'), 'dir');
  const info = f.a('storage-info');
  const bytes = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).reduce((total, entry) => total + fs.statSync(path.join(directory, entry.name)).size, 1234);
  assert.equal(info.directory, directory); assert.equal(info.complete, true); assert.equal(info.bytes, bytes);
  assert.equal(info.measuredAt, new Date(now).toISOString());
});

test('shared schedules are durable across SQLite connections and only one computer claims a due task', t => {
  const f = fixture(t), task = f.create();
  const hello = f.first.request('hello', {}, 'computer-a', now);
  assert.equal(hello.serverNow, now); assert.equal(hello.result.protocol, 1); assert.equal(hello.result.leaseMs, leaseMs);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.b('list')[0].id, task.id); assert.equal(f.b('list')[0].message, undefined);
  assert.equal(f.a('claim', { id: task.id }, due - 1), null);
  const claim = f.a('claim', { id: task.id }, due);
  assert.equal(claim.task.status, 'claimed'); assert.equal(claim.task.delivery.owner, 'computer-a');
  assert.equal(claim.expiresAt, due + leaseMs); assert.ok(claim.token);
  assert.equal(f.b('claim', { id: task.id }, due), null);
  assert.equal(f.a('claim', { id: task.id }, due), null);
  assert.equal(f.b('list', {}, due)[0].status, 'claimed');
});

test('simultaneous SQLite claim transactions in separate workers admit exactly one sender', async t => {
  const f = fixture(t); f.create();
  const gate = new SharedArrayBuffer(4), workers = [];
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { SharedScheduleDatabase } = require(workerData.module);
    const store = new SharedScheduleDatabase(workerData.file);
    parentPort.postMessage({ ready: true });
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    try {
      const response = store.request('claim', { id: 'task-a' }, workerData.owner, workerData.now);
      store.close(); parentPort.postMessage({ result: response.result });
    } catch (error) { store.close(); throw error; }
  `;
  let started = 0;
  const contenders = ['computer-a', 'computer-b'].map(owner => {
    const worker = new Worker(source, { eval: true, workerData: { module: require.resolve('../shared-schedules-host.cjs'), file: f.file, owner, now: due, gate } });
    workers.push(worker);
    return new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (!message.ready) return resolve(message.result);
        if (++started === 2) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2); }
      });
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error('Claim worker exited with ' + code)); });
    });
  });
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = await Promise.all(contenders);
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(f.a('list', {}, due)[0].delivery.token, winners[0].token);
});

test('shared schedule claims preserve per-chat ordering and isolate machines and other chats', t => {
  const f = fixture(t);
  f.create('task-a'); f.create('task-b');
  f.create('other-chat', 'another-chat'); f.create('other-machine', 'shared-chat', 'access:other-host:22');
  assert.equal(f.b('claim', { id: 'task-b' }, due), null);
  const first = f.a('claim', { id: 'task-a' }, due);
  assert.ok(first);
  assert.equal(f.b('claim', { id: 'task-b' }, due), null);
  assert.ok(f.b('claim', { id: 'other-chat' }, due));
  assert.ok(f.b('claim', { id: 'other-machine' }, due));
  f.a('release', { id: 'task-a', token: first.token }, due + 1);
  assert.ok(f.b('claim', { id: 'task-a' }, due + 2));
});

test('expired unsent claims can move to another computer while old tokens stay fenced', t => {
  const f = fixture(t); f.create();
  const old = f.a('claim', { id: 'task-a' }, due);
  const current = f.b('claim', { id: 'task-a' }, due + leaseMs + 1);
  assert.ok(current); assert.notEqual(current.token, old.token);
  for (const method of ['begin', 'release']) assert.throws(() => f.a(method, { id: 'task-a', token: old.token }, due + leaseMs + 2), /lock expired|no longer claimed/);
  assert.deepEqual(f.a('renew', { tokens: [old.token, current.token] }, due + leaseMs + 2), []);
  assert.deepEqual(f.b('renew', { tokens: [current.token] }, due + leaseMs + 2), [current.token]);
  assert.equal(f.b('begin', { id: 'task-a', token: current.token }, due + leaseMs + 3).status, 'sending');
  assert.equal(f.a('list', {}, due + leaseMs + 3)[0].delivery.owner, 'computer-b');
});

test('expired sends become unconfirmed and never auto-retry or admit another scheduled turn in that chat', t => {
  const f = fixture(t); f.create('task-a'); f.create('task-b'); f.create('other-chat', 'another-chat');
  const claim = f.a('claim', { id: 'task-a' }, due);
  f.a('begin', { id: 'task-a', token: claim.token }, due + 1);
  const tasks = f.b('list', {}, due + leaseMs + 1);
  const uncertain = tasks.find(task => task.id === 'task-a');
  assert.equal(uncertain.status, 'unconfirmed'); assert.match(uncertain.error, /check chat history/i);
  assert.equal(f.b('claim', { id: 'task-a' }, due + leaseMs + 2), null);
  assert.equal(f.b('claim', { id: 'task-b' }, due + leaseMs + 2), null);
  assert.ok(f.b('claim', { id: 'other-chat' }, due + leaseMs + 2));
  assert.throws(() => f.a('begin', { id: 'task-a', token: claim.token }, due + leaseMs + 2), /lock expired/);
  assert.throws(() => f.b('cancel', { id: 'task-a' }, due + leaseMs + 2), /already been attempted|being sent/);
  assert.throws(() => f.a('complete', { id: 'task-a', token: claim.token, turnId: 'unknown-turn' }, due + leaseMs + 2), /receipt/);
});

test('restarting a device can rotate only its own editing lease and invalidates the old token', t => {
  const f = fixture(t), task = f.create();
  const args = { machine, threadId: task.threadId }, old = f.a('edit-lock', args, due);
  assert.throws(() => f.b('edit-lock', { ...args, recoverOwn: true }, due + 1), /Another computer/);
  assert.throws(() => f.a('edit-lock', args, due + 1), /Another computer/);
  assert.throws(() => f.a('edit-lock', { ...args, recoverOwn: 'yes' }, due + 1), /Invalid editing lock recovery/);
  const current = f.a('edit-lock', { ...args, recoverOwn: true }, due + 1);
  assert.notEqual(current.token, old.token);
  assert.deepEqual(f.a('renew', { tokens: [old.token] }, due + 2), []);
  f.a('unlock', { token: old.token }, due + 2);
  assert.throws(() => f.a('get', { id: task.id, token: old.token }, due + 2), /lock expired/);
  assert.equal(f.a('get', { id: task.id, token: current.token }, due + 2).id, task.id);
  f.a('unlock', { token: current.token }, due + 2);
  const delivery = f.a('claim', { id: task.id }, due + 3);
  assert.ok(delivery);
  assert.throws(() => f.a('edit-lock', { ...args, recoverOwn: true }, due + 4), /Another computer/);
});

test('shared editor locks require both owner and token and exclude cancellation and delivery', t => {
  const f = fixture(t), task = f.create();
  const a = (method, args) => f.a(method, args, due), b = (method, args) => f.b(method, args, due);
  const lock = a('edit-lock', { machine, threadId: task.threadId });
  assert.equal(a('get', { id: task.id, token: lock.token }).message.text, task.prompt);
  assert.throws(() => b('edit-lock', { machine, threadId: task.threadId }), /Another computer/);
  assert.throws(() => b('get', { id: task.id, token: lock.token }), /lock expired/);
  assert.throws(() => a('get', { id: task.id, token: 'wrong-token' }), /lock expired/);
  assert.throws(() => b('cancel', { id: task.id }), /Close the scheduled editor/);
  assert.throws(() => a('cancel', { id: task.id }), /Close the scheduled editor/);
  assert.equal(b('claim', { id: task.id }), null);
  b('unlock', { token: lock.token });
  assert.throws(() => b('cancel', { id: task.id }), /Close the scheduled editor/);
  const edited = a('edit', { id: task.id, token: lock.token, patch: { text: 'Edited prompt', runAt: new Date(due + 3600000).toISOString(), skills: [] } });
  assert.equal(edited.prompt, 'Edited prompt'); assert.deepEqual(edited.message.turnSettings, task.message.turnSettings);
  a('unlock', { token: lock.token });
  assert.equal(b('cancel', { id: task.id }).status, 'cancelled');
  assert.equal(a('cancel', { id: task.id }).status, 'cancelled');
});

test('reimporting the same local task cannot overwrite shared edits, cancel state or conversation identity', t => {
  const f = fixture(t);
  const original = f.create('imported');
  const lock = f.b('edit-lock', { machine, threadId: original.threadId }, now + 1);
  const edited = f.b('edit', { id: original.id, token: lock.token, patch: { text: 'Changed on another computer', runAt: new Date(due + 3600000).toISOString(), skills: [] } }, now + 2);
  f.b('unlock', { token: lock.token }, now + 3);
  const imported = f.a('import', { task: original }, now + 4);
  assert.equal(imported.prompt, edited.prompt); assert.equal(imported.runAt, edited.runAt); assert.deepEqual(imported.message, edited.message);
  f.b('cancel', { id: original.id }, now + 5);
  assert.equal(f.a('import', { task: original }, now + 6).status, 'cancelled');
  assert.throws(() => f.a('import', { task: { ...original, message: message('different-chat'), threadId: 'different-chat' } }, now + 7), /another conversation/);
  assert.equal(f.b('list', {}, now + 8).length, 1);
});

test('confirmed delivery keeps the chat locked until the owner confirms that exact native turn completed', t => {
  const f = fixture(t); f.create('task-a'); f.create('task-b');
  const claim = f.a('claim', { id: 'task-a' }, due);
  f.a('begin', { id: 'task-a', token: claim.token }, due + 1);
  const receipt = { id: 'task-a', token: claim.token, status: 'sent', turnId: 'native-turn' };
  const sent = f.a('finish', receipt, due + 2);
  assert.equal(sent.status, 'sent'); assert.equal(sent.active, true); assert.equal(sent.message, null);
  assert.equal(f.b('claim', { id: 'task-b' }, due + 3), null);
  assert.throws(() => f.b('edit-lock', { machine, threadId: sent.threadId }, due + 3), /Another computer/);
  assert.throws(() => f.b('finish', receipt, due + 3), /own the delivery receipt/);
  assert.throws(() => f.a('finish', { ...receipt, turnId: 'wrong-turn' }, due + 3), /does not match/);
  for (const [request, owner] of [
    [{ id: 'task-a', token: claim.token, turnId: 'native-turn' }, f.b],
    [{ id: 'task-a', token: 'wrong-token', turnId: 'native-turn' }, f.a],
    [{ id: 'task-a', token: claim.token, turnId: 'wrong-turn' }, f.a]
  ]) assert.throws(() => owner('complete', request, due + 3), /receipt/);
  assert.equal(f.b('claim', { id: 'task-b' }, due + 4), null);
  assert.equal(f.a('complete', { id: 'task-a', token: claim.token, turnId: 'native-turn' }, due + 5).active, false);
  const next = f.b('claim', { id: 'task-b' }, due + 6);
  assert.ok(next);
  f.a('complete', { id: 'task-a', token: claim.token, turnId: 'native-turn' }, due + 7);
  assert.equal(f.b('begin', { id: 'task-b', token: next.token }, due + 8).status, 'sending');
});

test('an expired active delivery blocks later scheduled turns even beyond normal receipt cleanup', t => {
  const f = fixture(t); f.create('task-a'); f.create('task-b');
  const claim = f.a('claim', { id: 'task-a' }, due);
  f.a('begin', { id: 'task-a', token: claim.token }, due + 1);
  f.a('finish', { id: 'task-a', token: claim.token, status: 'sent', turnId: 'long-native-turn' }, due + 2);
  const later = due + 8 * 86400000;
  const receipt = f.b('list', {}, later).find(task => task.id === 'task-a');
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.active, true);
  assert.equal(receipt.needsReview, true);
  assert.equal(f.b('claim', { id: 'task-b' }, later), null);
  f.a('complete', { id: 'task-a', token: claim.token, turnId: 'long-native-turn' }, later + 1);
  assert.ok(f.b('claim', { id: 'task-b' }, later + 2));
});

test('a late positive native receipt resolves an expired send without a second delivery attempt', t => {
  const f = fixture(t); f.create('task-a'); f.create('task-b');
  const claim = f.a('claim', { id: 'task-a' }, due);
  f.a('begin', { id: 'task-a', token: claim.token }, due + 1);
  const late = due + leaseMs + 10;
  assert.equal(f.b('list', {}, late).find(task => task.id === 'task-a').status, 'unconfirmed');
  assert.equal(f.b('claim', { id: 'task-a' }, late + 1), null);
  const args = { id: 'task-a', token: claim.token, status: 'sent', turnId: 'late-confirmed-turn' };
  const receipt = f.a('finish', args, late + 2);
  assert.equal(receipt.status, 'sent'); assert.equal(receipt.active, true); assert.equal(receipt.error, null); assert.equal(receipt.message, null);
  assert.equal(f.a('finish', args, late + 3).sentAt, receipt.sentAt);
  assert.equal(f.b('claim', { id: 'task-b' }, late + 4), null);
  f.a('complete', { id: 'task-a', token: claim.token, turnId: 'late-confirmed-turn' }, late + 5);
  assert.ok(f.b('claim', { id: 'task-b' }, late + 6));
});

test('a lost import acknowledgement cannot recreate a completed task after receipt payload cleanup', t => {
  const f = fixture(t), original = new ScheduleStore(null).enqueue(message(), 1, now);
  f.a('import', { task: original });
  const claim = f.b('claim', { id: original.id }, due);
  f.b('begin', { id: original.id, token: claim.token }, due + 1);
  const receipt = { id: original.id, token: claim.token, status: 'sent', turnId: 'peer-confirmed-turn' };
  f.b('finish', receipt, due + 2);
  f.b('complete', receipt, due + 3);
  const later = due + 8 * 86400000;
  assert.deepEqual(f.a('list', {}, later), []);
  const restored = f.a('import', { task: original }, later + 1);
  assert.equal(restored.status, 'sent'); assert.equal(restored.retired, true); assert.equal(restored.active, false);
  assert.equal(restored.prompt, undefined); assert.equal(restored.message, undefined);
  assert.deepEqual(f.second.get(original.id), restored);
  assert.equal(f.b('finish', receipt, later + 2).retired, true);
  assert.equal(f.b('complete', receipt, later + 3).retired, true);
  assert.throws(() => f.a('finish', receipt, later + 4), /own the delivery receipt/);
  assert.equal(f.a('claim', { id: original.id }, later + 5), null);
  assert.deepEqual(f.b('list', {}, later + 6), []);
});

test('cancelled imported task tombstones survive cleanup and stale migration retries', t => {
  const f = fixture(t), original = new ScheduleStore(null).enqueue(message(), 1, now);
  f.a('import', { task: original });
  f.b('cancel', { id: original.id }, now + 1);
  const later = due + 8 * 86400000;
  assert.deepEqual(f.a('list', {}, later), []);
  const restored = f.a('import', { task: original }, later + 1);
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.retired, true);
  assert.equal(restored.prompt, undefined); assert.equal(restored.message, undefined);
  assert.equal(f.first.get(original.id).status, 'cancelled');
  assert.equal(f.b('cancel', { id: original.id }, later + 2).retired, true);
  assert.equal(f.b('claim', { id: original.id }, later + 3), null);
  assert.deepEqual(f.a('list', {}, later + 4), []);
});

test('dismissal refuses pending and connected active deliveries, then releases only an expired reviewed run', t => {
  const f = fixture(t); f.create('task-a'); f.create('task-b');
  assert.throws(() => f.b('dismiss', { id: 'task-a' }), /Only uncertain deliveries/);
  const claim = f.a('claim', { id: 'task-a' }, due);
  assert.throws(() => f.b('dismiss', { id: 'task-a' }, due + 1), /Only uncertain deliveries/);
  f.a('begin', { id: 'task-a', token: claim.token }, due + 2);
  assert.throws(() => f.b('dismiss', { id: 'task-a' }, due + 3), /Only uncertain deliveries/);
  const receipt = { id: 'task-a', token: claim.token, status: 'sent', turnId: 'still-running-turn' };
  f.a('finish', receipt, due + 4);
  assert.throws(() => f.b('dismiss', { id: 'task-a' }, due + 5), /Only uncertain deliveries/);
  const expired = due + leaseMs + 1;
  const review = f.b('list', {}, expired).find(task => task.id === 'task-a');
  assert.equal(review.status, 'sent'); assert.equal(review.active, true); assert.equal(review.needsReview, true);
  assert.equal(f.b('claim', { id: 'task-b' }, expired + 1), null);
  const editor = f.a('edit-lock', { machine, threadId: 'shared-chat' }, expired + 2);
  assert.throws(() => f.b('dismiss', { id: 'task-a' }, expired + 3), /still sending or editing/);
  f.a('unlock', { token: editor.token }, expired + 4);
  const dismissed = f.b('dismiss', { id: 'task-a' }, expired + 5);
  assert.equal(dismissed.status, 'cancelled'); assert.equal(dismissed.active, false); assert.equal(dismissed.dismissed, true); assert.equal(dismissed.needsReview, false);
  const next = f.b('claim', { id: 'task-b' }, expired + 6);
  assert.ok(next);
  assert.equal(f.a('finish', receipt, expired + 7).status, 'cancelled');
  assert.throws(() => f.b('finish', receipt, expired + 8), /own the delivery receipt/);
  assert.equal(f.b('begin', { id: 'task-b', token: next.token }, expired + 9).status, 'sending');
});

test('dismissing an expired uncertain send unblocks its chat and preserves cancellation through late receipts and cleanup', t => {
  const f = fixture(t), original = f.create('task-a'); f.create('task-b');
  const claim = f.a('claim', { id: original.id }, due);
  f.a('begin', { id: original.id, token: claim.token }, due + 1);
  const expired = due + leaseMs + 1;
  assert.equal(f.b('list', {}, expired).find(task => task.id === original.id).status, 'unconfirmed');
  const editor = f.b('edit-lock', { machine, threadId: 'shared-chat' }, expired + 1);
  assert.throws(() => f.a('dismiss', { id: original.id }, expired + 2), /still sending or editing/);
  f.b('unlock', { token: editor.token }, expired + 3);
  const dismissed = f.b('dismiss', { id: original.id }, expired + 4);
  assert.equal(dismissed.status, 'cancelled'); assert.equal(dismissed.dismissed, true); assert.equal(dismissed.message, null);
  const next = f.b('claim', { id: 'task-b' }, expired + 5);
  assert.ok(next);
  const receipt = { id: original.id, token: claim.token, status: 'sent', turnId: 'late-old-turn' };
  assert.equal(f.a('finish', receipt, expired + 6).status, 'cancelled');
  assert.equal(f.b('begin', { id: 'task-b', token: next.token }, expired + 7).status, 'sending');
  f.b('finish', { id: 'task-b', token: next.token, status: 'sent', turnId: 'next-turn' }, expired + 8);
  f.b('complete', { id: 'task-b', token: next.token, turnId: 'next-turn' }, expired + 9);
  const later = expired + 8 * 86400000;
  assert.deepEqual(f.a('list', {}, later), []);
  const restored = f.a('import', { task: original }, later + 1);
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.dismissed, true); assert.equal(restored.retired, true);
  assert.equal(f.a('finish', receipt, later + 2).retired, true);
  assert.equal(f.b('dismiss', { id: original.id }, later + 3).retired, true);
  assert.equal(f.b('claim', { id: original.id }, later + 4), null);
  assert.deepEqual(f.a('list', {}, later + 5), []);
});

test('the SSH helper acknowledges partial uploads without storing an incomplete blob', async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { createInterface } = require('node:readline');
  const { hash } = require('../sync-state.cjs');
  const f = fixture(t), data = Buffer.alloc(128 * 1024, 42), id = hash(data);
  const child = spawn(process.execPath, ['--no-warnings', require.resolve('../shared-schedules-host.cjs'), f.file]);
  const closed = once(child, 'close');
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stderr.resume();
  t.after(() => child.kill());
  const request = JSON.stringify({ id: 1, method: 'blob-put', owner: 'upload-test', params: { hash: id, data: data.toString('base64') } }) + '\n';
  child.stdin.write(request.slice(0, 1000));
  assert.deepEqual(JSON.parse((await output.next()).value), { progress: true });
  assert.deepEqual(f.a('blob-prepare', { hashes: [id] }).missing, [id]);
  child.stdin.end(request.slice(1000));
  let response;
  do { response = JSON.parse((await output.next()).value); } while (response.progress);
  assert.equal(response.id, 1); assert.deepEqual(response.result, {});
  assert.deepEqual(f.a('blob-prepare', { hashes: [id] }).missing, []);
  assert.deepEqual(Buffer.from(f.a('blob-get', { hash: id }).data, 'base64'), data);
  assert.deepEqual(await closed, [0, null]);
});
