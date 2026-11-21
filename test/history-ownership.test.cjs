const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
const { stateKey, hash, blobGraceMs } = require('../sync-state.cjs');

const machine = 'access:fixture-computer:22';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-history-owner-'));
  const file = path.join(directory, 'shared.sqlite');
  const databases = Array.from({ length: 3 }, () => new SharedScheduleDatabase(file));
  const clock = { now: Date.now() }, id = randomUUID();
  const names = ['Laptop', 'Desktop', 'Third computer'], owners = ['device-a', 'device-b', 'device-c'];
  const request = (client, method, args = {}) => databases[client].request(method, args, owners[client], clock.now).result;
  const claim = (client, extra = {}) => request(client, 'history-claim', { machine, id, name: names[client], ...extra });
  const ask = client => request(client, 'history-request', { machine, id, name: names[client] });
  const verify = (client, epoch) => request(client, 'history-verify', { machine, id, epoch });
  const release = (client, epoch, digest) => request(client, 'history-release', { machine, id, epoch, digest });
  const put = (client, data) => { const bytes = Buffer.from(data), digest = hash(bytes); request(client, 'blob-put', { hash: digest, data: bytes.toString('base64') }); return { hash: digest, bytes: bytes.length }; };
  const push = (client, value, base = 0, extra = {}) => request(client, 'state-push', { operations: [{ kind: 'history', machine, id, opId: randomUUID(), value, base, ...extra }] })[0];
  const publish = (client, epoch, base = 0, text = 'Fixture history') => { const blob = put(client, text), value = { epoch, digest: blob.hash, blobs: [blob] }; return { value, receipt: push(client, value, base) }; };
  const restart = client => { databases[client].close(); databases[client] = new SharedScheduleDatabase(file); };
  t.after(() => { databases.forEach(database => database.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  return { file, databases, clock, id, owners, request, claim, ask, verify, release, put, push, publish, restart };
}

test('the first claimant owns a conversation across independent connections and restarts without a timeout steal', t => {
  const f = fixture(t), first = f.claim(0);
  assert.equal(first.owner, f.owners[0]); assert.equal(first.name, 'Laptop');
  assert.equal(first.epoch, 1); assert.equal(first.requested, null);
  assert.deepEqual(f.claim(1), first); assert.deepEqual(f.claim(2), first);
  f.clock.now += 365 * 86400000; f.restart(0); f.restart(1);
  assert.deepEqual(f.claim(1), first); assert.deepEqual(f.verify(0, 1), first);
  assert.throws(() => f.verify(1, 1), /computer|ownership|owned/);
  assert.deepEqual(f.request(2, 'history-owners', { machine }).owners, [first]);
  const other = f.claim(1, { machine: 'access:another-computer' });
  assert.equal(other.owner, f.owners[1]); assert.equal(other.epoch, 1);
  assert.deepEqual(f.request(0, 'history-owners', { machine }).owners, [first]);
});

async function raceRequests(t, f, operations) {
  const modulePath = require.resolve('../shared-schedules-host.cjs');
  const clients = operations.map(operation => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { SharedScheduleDatabase } = require(workerData.modulePath);
      const database = new SharedScheduleDatabase(workerData.file);
      parentPort.once('message', () => {
        try { parentPort.postMessage({ result: database.request(workerData.method, workerData.args, workerData.owner).result }); }
        catch (error) { parentPort.postMessage({ error: error.message }); }
        finally { database.close(); parentPort.close(); }
      });
      parentPort.postMessage('ready');
    `, { eval: true, workerData: { modulePath, file: f.file, ...operation } });
    const ready = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); });
    const result = new Promise((resolve, reject) => { worker.once('error', reject); worker.on('message', value => { if (value !== 'ready') resolve(value); }); });
    return { worker, ready, result };
  });
  t.after(() => Promise.all(clients.map(client => client.worker.terminate())));
  await Promise.all(clients.map(client => client.ready));
  clients.forEach(client => client.worker.postMessage('start'));
  return Promise.all(clients.map(client => client.result));
}

test('simultaneous claims from independent SQLite workers select exactly one owner', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const replies = await raceRequests(t, f, f.owners.map((owner, index) => ({ owner, method: 'history-claim', args: { machine, id: f.id, name: 'Computer ' + index } })));
  replies.forEach(reply => assert.equal(reply.error, undefined));
  const results = replies.map(reply => reply.result);
  assert.equal(new Set(results.map(row => row.owner)).size, 1);
  assert.ok(f.owners.includes(results[0].owner));
  assert.ok(results.every(row => row.epoch === 1 && row.requested === null));
  assert.deepEqual(f.request(0, 'history-owners', { machine }).owners.map(row => ({ ...row })), [results[0]]);
});

test('one pending handoff request is idempotent, blocks sends and excludes a third requester', t => {
  const f = fixture(t); f.claim(0); f.publish(0, 1);
  assert.equal(f.ask(0).requested, null);
  const requested = f.ask(1);
  assert.equal(requested.owner, f.owners[0]); assert.equal(requested.requested, f.owners[1]);
  assert.equal(requested.requested_name, 'Desktop'); assert.equal(requested.epoch, 1);
  assert.deepEqual(f.ask(1), requested);
  assert.throws(() => f.ask(2), /already waiting/);
  assert.deepEqual(f.claim(2), requested);
  assert.throws(() => f.verify(0, 1), /computer|ownership/);
  assert.throws(() => f.verify(1, 1), /computer|ownership/);
  f.restart(2); f.clock.now += 30 * 86400000;
  assert.deepEqual(f.request(2, 'history-owners', { machine }).owners, [requested]);
});

test('ownership transfers only after the current owner publishes the exact current-epoch history digest', t => {
  const f = fixture(t); f.claim(0);
  const unpublished = hash(Buffer.from('Not uploaded'));
  assert.throws(() => f.release(0, 1, unpublished), /ownership changed/);
  assert.throws(() => f.ask(1), /not uploaded/);
  const saved = f.publish(0, 1);
  f.ask(1);
  assert.throws(() => f.release(0, 1, unpublished), /uploading conversation history/);
  assert.throws(() => f.release(1, 1, saved.value.digest), /ownership changed/);
  assert.throws(() => f.release(0, 2, saved.value.digest), /ownership changed/);
  assert.throws(() => f.release(0, 1, unpublished), /uploading conversation history/);
  const transferred = f.release(0, 1, saved.value.digest);
  assert.equal(transferred.owner, f.owners[1]); assert.equal(transferred.name, 'Desktop');
  assert.equal(transferred.epoch, 2); assert.equal(transferred.requested, null); assert.equal(transferred.requested_name, null);
  assert.deepEqual(f.verify(1, 2), transferred);
  assert.throws(() => f.verify(0, 1), /computer|ownership/);
  assert.throws(() => f.release(0, 1, saved.value.digest), /ownership changed/);
  f.ask(2);
  assert.throws(() => f.release(1, 2, saved.value.digest), /uploading conversation history/);
  const next = f.publish(1, 2, saved.receipt.revision, 'New owner history');
  const third = f.release(1, 2, next.value.digest);
  assert.equal(third.owner, f.owners[2]); assert.equal(third.epoch, 3);
  assert.equal(f.verify(2, 3).requested, null);
});

test('history publishing requires ownership, uploaded blobs and epoch, then uses compare-and-swap revisions', t => {
  const f = fixture(t), blob = f.put(0, 'First history'), value = { digest: blob.hash, epoch: 1, blobs: [blob] };
  assert.throws(() => f.push(0, value), /owned by another computer/);
  f.claim(0);
  assert.throws(() => f.push(1, value), /owned by another computer/);
  assert.throws(() => f.push(0, { ...value, epoch: 2 }), /owned by another computer/);
  assert.throws(() => f.push(0, { ...value, digest: 'invalid' }), /Invalid conversation snapshot/);
  assert.throws(() => f.push(0, { ...value, blobs: [{ hash: hash(Buffer.from('Missing')), bytes: 7 }] }), /Upload conversation history/);
  const opId = randomUUID(), first = f.push(0, value, 0, { opId });
  const newer = f.publish(0, 1, first.revision, 'Second history');
  const stale = f.push(0, value, first.revision);
  assert.equal(stale.conflict, true); assert.equal(stale.current.revision, newer.receipt.revision);
  assert.deepEqual(stale.current.value, newer.value);
  const replay = f.push(0, value, 0, { opId });
  assert.equal(replay.revision, first.revision); assert.equal(replay.current.revision, newer.receipt.revision);
  assert.deepEqual(replay.current.value, newer.value);
  f.ask(1); f.release(0, 1, newer.value.digest);
  assert.throws(() => f.push(0, value, newer.receipt.revision), /owned by another computer/);
  assert.throws(() => f.push(1, value, newer.receipt.revision), /owned by another computer/);
  const current = f.publish(1, 2, newer.receipt.revision, 'Transferred history');
  assert.equal(current.receipt.current.writer, f.owners[1]);
});

test('a foreign null history write cannot erase the owner snapshot or bypass ownership in a batch', t => {
  const f = fixture(t); f.claim(0);
  const saved = f.publish(0, 1), marker = { kind: 'pin', machine, id: f.id, opId: randomUUID(), base: 0, value: true };
  assert.throws(() => f.push(1, null, saved.receipt.revision), /owned by another computer|snapshot/);
  assert.throws(() => f.request(1, 'state-push', { operations: [marker, { kind: 'history', machine, id: f.id, opId: randomUUID(), base: saved.receipt.revision, value: null }] }), /owned by another computer|snapshot/);
  const entries = f.request(2, 'state-pull', { cursor: 0 }).entries;
  assert.equal(entries.some(entry => entry.kind === 'pin'), false);
  assert.deepEqual(entries.find(entry => entry.key === stateKey('history', machine, f.id)).value, saved.value);
  f.ask(1); f.release(0, 1, saved.value.digest);
  assert.throws(() => f.push(0, null, saved.receipt.revision), /owned by another computer|snapshot/);
});

test('ownership methods reject invalid identities and fence stale or malformed epochs', t => {
  const f = fixture(t); f.claim(0);
  for (const extra of [{ machine: 'local' }, { machine: 'access:bad\n' }, { id: '' }, { id: 'bad\u0000id' }, { id: 'a'.repeat(1001) }, { name: '' }, { name: 'a'.repeat(101) }, { name: 'bad\nname' }]) assert.throws(() => f.claim(1, extra), /Invalid/);
  for (const epoch of [0, 2, '1', null]) assert.throws(() => f.verify(0, epoch), /computer|ownership/);
  assert.throws(() => f.request(1, 'history-owners', { machine: 'invalid' }), /Invalid/);
  assert.throws(() => f.request(1, 'history-unknown', { machine, id: f.id }), /Unsupported/);
  assert.equal(f.verify(0, 1).owner, f.owners[0]);
});

test('history manifests retain their blobs during cleanup and replaced snapshots release unreferenced blobs', t => {
  const f = fixture(t); f.claim(0);
  const saved = f.publish(0, 1), oldBlob = saved.value.blobs[0], orphan = f.put(1, 'Orphan payload');
  f.clock.now += blobGraceMs + 1; f.request(2, 'blob-prepare', { hashes: [] });
  assert.throws(() => f.request(2, 'blob-get', { hash: orphan.hash }), /not found/);
  assert.equal(Buffer.from(f.request(2, 'blob-get', { hash: oldBlob.hash }).data, 'base64').toString(), 'Fixture history');
  const next = f.publish(0, 1, saved.receipt.revision, 'Replacement payload');
  f.clock.now += blobGraceMs + 1; f.request(1, 'blob-prepare', { hashes: [] });
  assert.throws(() => f.request(1, 'blob-get', { hash: oldBlob.hash }), /not found/);
  assert.equal(Buffer.from(f.request(1, 'blob-get', { hash: next.value.blobs[0].hash }).data, 'base64').toString(), 'Replacement payload');
});


test('active reservations survive restart, block handoff, and can only be ended by their current owner and epoch', t => {
  const f = fixture(t); f.claim(0);
  const begin = (client, epoch = 1) => f.request(client, 'history-begin', { machine, id: f.id, epoch });
  const first = begin(0);
  const end = (client, epoch = 1) => f.request(client, 'history-end', { machine, id: f.id, epoch, runToken: first.run_token });
  assert.equal(first.busy, 1);
  assert.match(first.run_token, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.throws(() => begin(0), /already has a running task/);
  assert.throws(() => begin(1), /this computer/);
  const saved = f.publish(0, 1);
  const requested = f.ask(1); assert.equal(requested.busy, 1);
  assert.throws(() => f.release(0, 1, saved.value.digest), /still running/);
  assert.throws(() => end(1), /ownership changed/);
  assert.throws(() => end(0, 2), /ownership changed/);
  f.restart(0); f.clock.now += 365 * 86400000;
  assert.equal(f.request(2, 'history-owners', { machine }).owners[0].busy, 1);
  assert.throws(() => f.release(0, 1, saved.value.digest), /still running/);
  const ended = end(0);
  assert.equal(ended.busy, 0); assert.equal(ended.requested, f.owners[1]);
  assert.equal(end(0).busy, 0);
  const transferred = f.release(0, 1, saved.value.digest);
  assert.equal(transferred.owner, f.owners[1]); assert.equal(transferred.epoch, 2); assert.equal(transferred.busy, 0);
  assert.throws(() => end(0), /ownership changed/);
  assert.equal(begin(1, 2).busy, 1);
  assert.throws(() => end(0), /ownership changed/);
  assert.equal(f.request(2, 'history-owners', { machine }).owners[0].busy, 1);
});

test('concurrent begin calls reserve only one native run', { timeout: 10000 }, async t => {
  const f = fixture(t); f.claim(0);
  const replies = await raceRequests(t, f, [0, 0, 1].map(client => ({ owner: f.owners[client], method: 'history-begin', args: { machine, id: f.id, epoch: 1 } })));
  assert.equal(replies.filter(reply => reply.result?.busy === 1).length, 1);
  assert.equal(replies.filter(reply => reply.error).length, 2);
  assert.equal(f.request(2, 'history-owners', { machine }).owners[0].busy, 1);
});

test('a pending request racing with begin either fences the run or prevents release until it ends', { timeout: 10000 }, async t => {
  const f = fixture(t); f.claim(0); const saved = f.publish(0, 1);
  const [begin, request] = await raceRequests(t, f, [
    { owner: f.owners[0], method: 'history-begin', args: { machine, id: f.id, epoch: 1 } },
    { owner: f.owners[1], method: 'history-request', args: { machine, id: f.id, name: 'Desktop' } },
  ]);
  assert.equal(request.error, undefined); assert.equal(request.result.requested, f.owners[1]);
  const current = f.request(2, 'history-owners', { machine }).owners[0];
  assert.equal(current.owner, f.owners[0]);
  if (begin.result) {
    assert.equal(current.busy, 1);
    assert.throws(() => f.release(0, 1, saved.value.digest), /still running/);
    f.request(0, 'history-end', { machine, id: f.id, epoch: 1, runToken: begin.result.run_token });
  } else {
    assert.match(begin.error, /this computer/); assert.equal(current.busy, 0);
  }
  assert.equal(f.release(0, 1, saved.value.digest).owner, f.owners[1]);
  assert.throws(() => f.request(0, 'history-begin', { machine, id: f.id, epoch: 1 }), /this computer/);
});


test('late or missing run tokens cannot clear a newer reservation or allow a premature handoff', t => {
  const f = fixture(t); f.claim(0); const saved = f.publish(0, 1);
  const begin = () => f.request(0, 'history-begin', { machine, id: f.id, epoch: 1 });
  const end = runToken => f.request(0, 'history-end', { machine, id: f.id, epoch: 1, runToken });
  const first = begin();
  assert.match(first.run_token, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const idle = end(first.run_token); assert.equal(idle.busy, 0);
  assert.deepEqual(end(first.run_token), idle);
  const second = begin(); assert.notEqual(second.run_token, first.run_token); assert.equal(second.busy, 1);
  f.ask(1);
  const current = f.request(2, 'history-owners', { machine }).owners[0];
  for (const token of [first.run_token, undefined, null, randomUUID()]) {
    assert.deepEqual(end(token), current);
    assert.throws(() => f.release(0, 1, saved.value.digest), /still running/);
  }
  assert.equal(end(second.run_token).busy, 0);
  assert.equal(f.release(0, 1, saved.value.digest).owner, f.owners[1]);
  const third = f.request(1, 'history-begin', { machine, id: f.id, epoch: 2 });
  assert.notEqual(third.run_token, second.run_token);
  assert.throws(() => end(second.run_token), /ownership changed/);
  const stale = f.request(1, 'history-end', { machine, id: f.id, epoch: 2, runToken: second.run_token });
  assert.equal(stale.busy, 1); assert.equal(stale.run_token, third.run_token);
});

test('a duplicate completion racing with a new begin never clears the new run token', { timeout: 10000 }, async t => {
  const f = fixture(t); f.claim(0); const saved = f.publish(0, 1);
  const previous = f.request(0, 'history-begin', { machine, id: f.id, epoch: 1 });
  f.request(0, 'history-end', { machine, id: f.id, epoch: 1, runToken: previous.run_token });
  const [begun, completed] = await raceRequests(t, f, [
    { owner: f.owners[0], method: 'history-begin', args: { machine, id: f.id, epoch: 1 } },
    { owner: f.owners[0], method: 'history-end', args: { machine, id: f.id, epoch: 1, runToken: previous.run_token } },
  ]);
  assert.equal(begun.error, undefined); assert.equal(completed.error, undefined);
  assert.notEqual(begun.result.run_token, previous.run_token);
  const current = f.request(2, 'history-owners', { machine }).owners[0];
  assert.equal(current.busy, 1); assert.equal(current.run_token, begun.result.run_token);
  f.ask(1); assert.throws(() => f.release(0, 1, saved.value.digest), /still running/);
});

test('migration keeps an old busy row recoverable but subsequent runs require their generated token', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-history-owner-migration-'));
  const file = path.join(directory, 'shared.sqlite'), id = randomUUID();
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE sync_owners(machine TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,requested TEXT,requested_name TEXT,epoch INTEGER NOT NULL,busy INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(machine,id))');
  legacy.prepare('INSERT INTO sync_owners VALUES(?,?,?,?,NULL,NULL,?,1)').run(machine, id, 'device-a', 'Legacy computer', 3);
  legacy.close();
  const databases = [new SharedScheduleDatabase(file), new SharedScheduleDatabase(file)];
  t.after(() => { databases.forEach(database => database.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (index, method, args, owner = 'device-a') => databases[index].request(method, { machine, id, epoch: 3, ...args }, owner).result;
  const migrated = request(0, 'history-owners', {}).owners[0];
  assert.equal(migrated.busy, 1); assert.equal(migrated.run_token, null); assert.equal(migrated.epoch, 3); assert.equal(migrated.name, 'Legacy computer');
  assert.throws(() => request(1, 'history-end', {}, 'device-b'), /ownership changed/);
  assert.equal(request(1, 'history-end', {}).busy, 0);
  const begun = request(1, 'history-begin', {});
  assert.match(begun.run_token, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(request(0, 'history-end', {}), begun);
  databases[0].close(); databases[0] = new SharedScheduleDatabase(file);
  const restored = request(0, 'history-owners', {}).owners[0];
  assert.equal(restored.busy, 1); assert.equal(restored.run_token, begun.run_token);
  assert.deepEqual(request(0, 'history-end', { runToken: null }), begun);
  assert.equal(request(0, 'history-end', { runToken: begun.run_token }).busy, 0);
});

test('unpublished peer histories cannot reserve a transfer and only its requester can cancel without changing the active run', t => {
  const f = fixture(t); f.claim(0);
  const active = f.request(0, 'history-begin', { machine, id: f.id, epoch: 1 });
  assert.throws(() => f.ask(1), /not uploaded/);
  assert.deepEqual(f.request(0, 'history-owners', { machine }).owners[0], active);
  f.publish(0, 1); const requested = f.ask(1);
  for (const client of [0, 2]) assert.throws(() => f.request(client, 'history-cancel-request', { machine, id: f.id }), /Only the requesting computer/);
  assert.deepEqual(f.request(0, 'history-owners', { machine }).owners[0], requested);
  const cancelled = f.request(1, 'history-cancel-request', { machine, id: f.id });
  assert.equal(cancelled.requested, null); assert.equal(cancelled.requested_name, null);
  assert.equal(cancelled.owner, active.owner); assert.equal(cancelled.epoch, active.epoch);
  assert.equal(cancelled.busy, active.busy); assert.equal(cancelled.run_token, active.run_token);
  assert.deepEqual(f.verify(0, 1), cancelled);
});
