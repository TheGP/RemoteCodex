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
test('the app scheduler is injected only into local Codex without changing user config or exposing its token in arguments', async () => {
  const f = fixture(); const scheduler = { url: 'http://127.0.0.1:12345/mcp', token: 'private-scheduler-token' };
  await f.connection.connect({ mode: 'local', codexPath: process.execPath }, scheduler);
  const [, args, options] = f.invocation();
  assert.ok(args.includes('mcp_servers.remote_codex_scheduler.url="http://127.0.0.1:12345/mcp"'));
  assert.ok(!args.join(' ').includes(scheduler.token));
  assert.equal(options.env.REMOTE_CODEX_SCHEDULER_TOKEN, scheduler.token);
  f.connection.disconnect();
  const remote = fixture(); await remote.connection.connect({ host: 'root@warmer' }, scheduler);
  assert.ok(!remote.invocation()[1].join(' ').includes('scheduler'));
  remote.connection.disconnect();
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

test('large UTF-8 history with Unicode line separators remains one JSON-RPC response', async () => {
  const f = fixture(); await f.connection.connect();
  const text = 'マイメロディ\u2028next\u2029paragraph 🐈\n'.repeat(12000);
  const pending = f.connection.call('thread/turns/list', { threadId: 'unicode-history', itemsView: 'full' });
  const id = f.writes.at(-1).id;
  const data = [{ id: 'history-turn', items: [{ id: 'history-reply', type: 'agentMessage', text }] }];
  const response = Buffer.from(JSON.stringify({ id, result: { data, nextCursor: null } }) + '\r\n');
  for (let offset = 0; offset < response.length; offset += 4093) f.child.stdout.write(response.subarray(offset, offset + 4093));
  assert.deepEqual((await pending).data, data);
  assert.equal(f.child.killed, undefined);
  assert.equal(f.connection.pending.size, 0);
  f.connection.disconnect();
});

test('malformed RPC diagnostics omit contents and an unterminated final frame flushes on EOF', async () => {
  const f = fixture(); await f.connection.connect(); const entries = [];
  f.connection.on('diagnostic', event => entries.push(event));
  const pending = f.connection.call('thread/read', { threadId: 'final-frame' }); const id = f.writes.at(-1).id;
  f.child.stdout.write('PRIVATE_INVALID_RESPONSE\n');
  f.child.stdout.end(JSON.stringify({ id, result: { thread: { id: 'final-frame' } } }));
  assert.equal((await pending).thread.id, 'final-frame');
  assert.ok(entries.some(event => event.event === 'rpc.invalid-message'));
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_INVALID_RESPONSE'));
  f.connection.disconnect();
});

test('RPC diagnostics correlate sends and replies without retaining user inputs', async () => {
  const f = fixture(); const events = [];
  f.connection.on('diagnostic', event => events.push(event));
  await f.connection.connect();
  const pending = f.connection.call('turn/start', { threadId: 'log-thread', input: [{ type: 'text', text: 'PRIVATE_MESSAGE_BODY' }] });
  const request = f.writes.at(-1);
  f.child.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: 'log-turn', status: 'inProgress' } } }) + '\n');
  await pending;
  assert.ok(events.some(event => event.event === 'rpc.started' && event.details.threadId === 'log-thread' && event.details.requestId === request.id));
  assert.ok(events.some(event => event.event === 'rpc.completed' && event.details.requestId === request.id && event.details.status === 'inProgress'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_MESSAGE_BODY'));
  await assert.rejects(f.connection.call('turn/start', { threadId: 'timed-out-thread' }, 5), /timed out/);
  assert.ok(events.some(event => event.event === 'rpc.timeout' && event.details.threadId === 'timed-out-thread'));
  f.connection.disconnect();
});

test('real RPC and notification routing keeps the app awake through parallel turns and releases failures, timeouts, and disconnects', async () => {
  const { AgentWakeLock } = require('../wake-lock.cjs');
  const f = fixture(); const starts = []; const stops = [];
  const lock = new AgentWakeLock({ start: type => { starts.push(type); return starts.length; }, stop: id => stops.push(id) }, f.connection);
  await f.connection.connect(); assert.equal(starts.length, 0);
  const one = f.connection.call('turn/start', { threadId: 'one' });
  const firstRequest = f.writes.at(-1);
  f.child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'first' } } }) + '\n');
  f.child.stdout.write(JSON.stringify({ id: firstRequest.id, result: { turn: { id: 'first', status: 'inProgress' } } }) + '\n'); await one;
  const two = f.connection.call('turn/start', { threadId: 'two' });
  f.child.stdout.write(JSON.stringify({ id: f.writes.at(-1).id, result: { turn: { id: 'second', status: 'inProgress' } } }) + '\n'); await two;
  f.child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'first', status: 'completed' } } }) + '\n');
  await assert.rejects(f.connection.call('turn/start', { threadId: 'timeout' }, 5), /timed out/);
  assert.equal(lock.pending.size, 0); assert.equal(stops.length, 0); assert.equal(lock.active.size, 1);
  f.child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'two', turn: { id: 'second', status: 'interrupted' } } }) + '\n');
  assert.deepEqual(starts, ['prevent-app-suspension']); assert.deepEqual(stops, [1]);
  const rejected = f.connection.call('turn/start', { threadId: 'rejected' });
  f.child.stdout.write(JSON.stringify({ id: f.writes.at(-1).id, error: { message: 'Turn rejected' } }) + '\n');
  await assert.rejects(rejected, /Turn rejected/); assert.deepEqual(stops, [1, 2]);
  const disconnected = f.connection.call('review/start', { threadId: 'review' });
  f.connection.disconnect(); await assert.rejects(disconnected, /Disconnected/); assert.deepEqual(stops, [1, 2, 3]);
  await assert.rejects(f.connection.call('turn/start', { threadId: 'offline' }), /Connect to Codex/);
  assert.deepEqual(stops, [1, 2, 3, 4]); assert.equal(lock.id, null);
});

test('stderr warnings survive split UTF-8 lines, omit raw text, and have a bounded event rate', async () => {
  const f = fixture(); const entries = [];
  f.connection.on('diagnostic', entry => entries.push(entry));
  await f.connection.connect();
  const warning = Buffer.from('\x1b[33mWARN\x1b[0m codex_core::responses_retry: timed out PRIVATE_MESSAGE 界\n');
  f.child.stderr.write(warning.subarray(0, 5));
  f.child.stderr.write(warning.subarray(5, warning.length - 2));
  f.child.stderr.write(warning.subarray(warning.length - 2));
  assert.equal(entries.filter(entry => entry.event === 'process.stderr').length, 1);
  assert.equal(entries.at(-1).details.reason, 'timeout');
  f.child.stderr.write('INFO codex_core::client: PRIVATE_MESSAGE\n');
  assert.equal(entries.filter(entry => entry.event === 'process.stderr').length, 1);
  f.child.stderr.write(('ERROR codex_core::client: connection reset PRIVATE_TOKEN\n').repeat(30));
  assert.equal(entries.filter(entry => entry.event === 'process.stderr').length, 20);
  f.child.stderr.write('x'.repeat(100000));
  f.child.stderr.end('\nERROR codex_core::client: final warning');
  await new Promise(resolve => setImmediate(resolve));
  f.child.emit('close', 1, 'SIGTERM');
  const exit = entries.find(entry => entry.event === 'process.exited');
  assert.equal(exit.details.exitCode, 1); assert.equal(exit.details.signal, 'SIGTERM'); assert.equal(exit.details.count, 12);
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_'));
  f.child.stderr.emit('data', Buffer.from('ERROR old process: timed out\n'));
  assert.equal(entries.filter(entry => entry.event === 'process.stderr').length, 20);
});

test('unterminated stderr warning is classified on EOF', async () => {
  const f = fixture(); const entries = [];
  f.connection.on('diagnostic', entry => entries.push(entry));
  await f.connection.connect();
  f.child.stderr.end('ERROR codex_core::client: status 429 PRIVATE_MESSAGE');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.at(-1).details.reason, 'rate-limit');
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_'));
  f.connection.disconnect();
});

test('real transport notifications produce quiet and resumed diagnostics without sending recovery commands', async () => {
  const { TurnDiagnostics, DiagnosticLog } = require('../diagnostics.cjs');
  const f = fixture(); const entries = [];
  f.connection.on('diagnostic', entry => entries.push(entry));
  let now = 0;
  const turns = new TurnDiagnostics(f.connection, () => now);
  await f.connection.connect();
  const pending = f.connection.call('turn/start', { threadId: 'chat', input: [{ type: 'text', text: 'PRIVATE_MESSAGE' }] });
  const id = f.writes.at(-1).id;
  f.child.stdout.write(JSON.stringify({ id, result: { turn: { id: 'turn', status: 'inProgress' } } }) + '\n');
  await pending;
  const writes = f.writes.length;
  now = 60000; turns.check();
  assert.equal(entries.at(-1).event, 'turn.quiet');
  assert.equal(entries.at(-1).details.phase, 'waiting-for-output');
  assert.equal(f.writes.length, writes);
  f.child.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'chat', turnId: 'turn', delta: 'PRIVATE_REPLY' } }) + '\n');
  assert.equal(entries.at(-1).event, 'turn.first-output');
  assert.equal(entries.at(-1).details.firstOutputMs, 60000);
  f.child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'chat', turn: { id: 'turn', status: 'completed' } } }) + '\n');
  assert.equal(entries.at(-1).event, 'turn.summary');
  assert.equal(entries.at(-1).details.reason, 'completed');
  assert.equal(f.writes.length, writes);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-turn-log-'));
  try {
    const log = new DiagnosticLog(directory);
    for (const entry of entries) log.write(entry.event, entry.details);
    const text = fs.readFileSync(log.file, 'utf8');
    assert.ok(!text.includes('PRIVATE_'));
    assert.match(text, /"firstOutputMs":60000/);
    assert.match(text, /"idleMs":60000/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); f.connection.disconnect(); }
});
