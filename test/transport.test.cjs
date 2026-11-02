const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexConnection, connectionOptions } = require('../transport.cjs');

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const writes = [];
  let invocation;
  child.stdin.on('data', data => {
    const message = JSON.parse(data.toString()); writes.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }) + '\n'));
  });
  const connection = new CodexConnection((...args) => { invocation = args; return child; });
  return { child, writes, connection, invocation: () => invocation };
}

test('connection options reject SSH option and shell injection', () => {
  for (const host of ['-oProxyCommand=bad', 'root@host;touch /tmp/test', 'host\nother', 'root@host $(whoami)', 'root@host/other']) assert.throws(() => connectionOptions({ host }));
  for (const port of [-1, 0, 0.5, 65536, 'not-a-port']) assert.throws(() => connectionOptions({ port }));
  assert.throws(() => connectionOptions({ cwd: 'relative/folder' }));
  assert.equal(connectionOptions({ host: 'root@warmer' }).port, 22);
});
test('saved SSH settings stay remote; local paths validate independently', () => {
  assert.equal(connectionOptions({ host: 'root@warmer' }).mode, 'ssh');
  assert.equal(connectionOptions({ mode: 'local', host: 'unused invalid host', port: 0 }).mode, 'local');
  for (const options of [{ mode: 'other' }, { mode: 'local', localCwd: 'relative' }, { mode: 'local', codexPath: 'codex;echo test' }, { mode: 'local', codexPath: '/bin/codex\0' }]) assert.throws(() => connectionOptions(options));
});
test('local connection spawns an executable directly with the local workspace', async () => {
  const f = fixture();
  await f.connection.connect({ mode: 'local', codexPath: process.execPath, localCwd: os.tmpdir() });
  const [command, args, options] = f.invocation();
  assert.equal(command, fs.realpathSync(process.execPath));
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
  assert.equal(options.cwd, os.tmpdir());
  assert.equal(options.shell, undefined);
  assert.equal(f.connection.ready, true);
  f.connection.disconnect();
});
test('local discovery prefers the current managed Codex over an older CLI on PATH', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-managed-'));
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'packages/app-server-daemon/current/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  process.env.CODEX_HOME = dir;
  const f = fixture();
  await f.connection.connect({ mode: 'local' });
  assert.equal(f.invocation()[0], fs.realpathSync(process.execPath));
  f.connection.disconnect();
  await assert.rejects(fixture().connection.connect({ mode: 'local', codexPath: path.join(dir, 'missing-override') }), /executable not found/);
});
test('a local npm launcher with spaces is passed as one argument to Node', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-launcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launcher = path.join(dir, 'codex with spaces.js');
  fs.writeFileSync(launcher, '// fixture', { mode: 0o700 });
  fs.symlinkSync(process.execPath, path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
  const f = fixture();
  await f.connection.connect({ mode: 'local', codexPath: launcher });
  const [command, args, options] = f.invocation();
  assert.equal(fs.realpathSync(command), fs.realpathSync(process.execPath));
  assert.equal(args[0], fs.realpathSync(launcher));
  assert.equal(args[1], 'app-server');
  assert.equal(options.shell, undefined);
  f.connection.disconnect();
});
test('missing local Codex fails without invoking SSH', async () => {
  const f = fixture();
  await assert.rejects(f.connection.connect({ mode: 'local', codexPath: path.join(os.tmpdir(), 'missing-codex-executable') }), /executable not found/);
  assert.equal(f.invocation(), undefined);
});
test('SSH requires a trusted host and key-based auth without local shell interpolation', async () => {
  const f = fixture();
  await f.connection.connect({ host: 'root@warmer', key: '/some/key with spaces', port: 2200 });
  const [, args, options] = f.invocation();
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('/some/key with spaces'));
  assert.ok(args.includes('2200'));
  assert.equal(options.shell, undefined);
  assert.equal(f.writes[1].method, 'initialized');
  f.connection.disconnect();
});
test('split and coalesced JSON lines match concurrent responses by ID', async () => {
  const f = fixture(); await f.connection.connect();
  const first = f.connection.call('thread/list');
  const second = f.connection.call('model/list');
  const requests = f.writes.slice(-2);
  const data = JSON.stringify({ id: requests[1].id, result: 'models' }) + '\n' + JSON.stringify({ id: requests[0].id, result: 'threads' }) + '\n';
  f.child.stdout.write(data.slice(0, 9)); f.child.stdout.write(data.slice(9));
  assert.deepEqual(await Promise.all([first, second]), ['threads', 'models']);
  f.connection.disconnect();
});
test('SSH exit rejects requests and delivers a useful connection error', async () => {
  const f = fixture(); await f.connection.connect();
  const pending = f.connection.call('thread/list');
  const rejected = assert.rejects(pending, /Disconnected/);
  const events = []; f.connection.on('notification', message => events.push(message));
  f.child.stderr.write('Permission denied (publickey).'); f.child.emit('close', 255);
  await rejected;
  assert.match(events[0].params.message, /Permission denied/);
  assert.equal(f.connection.ready, false);
});
test('late close from an old connection cannot close the replacement', async () => {
  const f = fixture(); await f.connection.connect();
  const old = f.child;
  f.connection.disconnect();
  f.connection.child = { stdin: { end() {} }, kill() {} };
  f.connection.ready = true;
  old.emit('close', 0);
  assert.equal(f.connection.ready, true);
  f.connection.disconnect();
});
test('approval requests round trip without confusing response IDs', async () => {
  const f = fixture(); await f.connection.connect();
  f.child.stdout.write(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } }) + '\n');
  f.connection.respond('approval-1', { decision: 'decline' });
  assert.deepEqual(f.writes.at(-1), { id: 'approval-1', result: { decision: 'decline' } });
  assert.throws(() => f.connection.respond('approval-1', { decision: 'accept' }), /no longer pending/);
  f.connection.disconnect();
});
test('a timeout clears its pending request and warns against blind retries', async () => {
  const f = fixture(); await f.connection.connect();
  await assert.rejects(f.connection.call('turn/start', {}, 15), /server may have received/);
  assert.equal(f.connection.pending.size, 0);
  f.connection.disconnect();
});
test('history responses mark the boundary between past and new stream events', async () => {
  const f = fixture(); await f.connection.connect();
  const events = [];
  f.connection.on('notification', message => events.push(message));
  const pending = f.connection.call('thread/turns/list');
  const requestId = f.writes.at(-1).id;
  f.child.stdout.write([
    { method: 'item/agentMessage/delta', params: { delta: 'Hello' } },
    { id: requestId, result: { data: [], nextCursor: null } },
    { method: 'item/agentMessage/delta', params: { delta: ' world' } }
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  const snapshot = await pending;
  assert.ok(events[0].receivedSequence < snapshot.receivedSequence);
  assert.ok(events[1].receivedSequence > snapshot.receivedSequence);
  f.connection.disconnect();
});
