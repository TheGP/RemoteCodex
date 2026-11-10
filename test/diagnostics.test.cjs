const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DiagnosticLog, MAX_LOG_BYTES, stderrDiagnostic, TurnDiagnostics } = require('../diagnostics.cjs');

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new DiagnosticLog(directory, options);
}

test('diagnostics rotate whole JSON lines within a total 10 MB cap', t => {
  assert.equal(MAX_LOG_BYTES, 10 * 1024 * 1024);
  const log = fixture(t, { maxBytes: 1024 });
  for (let requestId = 0; requestId < 100; requestId++) assert.equal(log.write('rpc.completed', { requestId, threadId: 'test-thread', status: 'completed' }), true);
  const files = fs.readdirSync(log.directory);
  assert.deepEqual(files.sort(), ['diagnostics.1.log', 'diagnostics.log']);
  assert.ok(files.reduce((total, file) => total + fs.statSync(path.join(log.directory, file)).size, 0) <= 1024);
  const records = files.flatMap(file => fs.readFileSync(path.join(log.directory, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  assert.ok(records.some(record => record.requestId === 99));
  assert.ok(!records.some(record => record.requestId === 0));
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});

test('logs keep diagnostic metadata while omitting input bodies and redacting common credentials', t => {
  const log = fixture(t);
  log.write('queue.failed', { threadId: 'test-thread', queueLength: 2, paused: true, prompt: 'PRIVATE_PROMPT', input: ['PRIVATE_INPUT'], images: ['PRIVATE_IMAGE'], arguments: 'PRIVATE_ARGS', error: 'Bearer hiddenBearer sk-proj-hiddenKey password="two word secret" token=hiddenToken {"api_key":"hiddenApiKey"} mongodb://user:pass@example.test/db' });
  const text = fs.readFileSync(log.file, 'utf8');
  for (const secret of ['PRIVATE_', 'hiddenBearer', 'hiddenKey', 'two word secret', 'hiddenToken', 'hiddenApiKey', 'user:pass']) assert.ok(!text.includes(secret), secret);
  const entry = JSON.parse(text);
  assert.equal(entry.threadId, 'test-thread'); assert.equal(entry.queueLength, 2); assert.equal(entry.paused, true);
  assert.match(entry.error, /redacted/);
  assert.equal(log.write('bad event\ntext', {}), false);
});

test('oversized UTF-8 entries and old files stay bounded and parseable', t => {
  const log = fixture(t, { maxBytes: 1024 });
  fs.writeFileSync(log.file, 'x'.repeat(2048)); fs.writeFileSync(log.previous, 'x'.repeat(2048));
  assert.equal(log.write('rpc.failed', { error: '界'.repeat(5000) }), true);
  assert.ok(fs.statSync(log.file).size + fs.statSync(log.previous).size <= 1024);
  assert.equal(JSON.parse(fs.readFileSync(log.file, 'utf8')).reason, 'Oversized diagnostic entry omitted');
});

test('logging failures never throw into sending and report only once', t => {
  const log = fixture(t); const messages = [];
  const blocked = path.join(log.directory, 'not-a-directory'); fs.writeFileSync(blocked, '');
  const failing = new DiagnosticLog(blocked, { report: message => messages.push(message) });
  assert.equal(failing.write('queue.failed'), false);
  assert.equal(failing.write('queue.failed'), false);
  assert.equal(messages.length, 1);
  assert.throws(() => new DiagnosticLog(log.directory, { maxBytes: MAX_LOG_BYTES + 1 }));
});

test('stderr classification retains causes and IDs without recording raw warning contents', t => {
  const log = fixture(t);
  const threadId = '01a1b69d-595b-7c32-b26c-36abd2b9732b';
  const turnId = '01a1bc7a-2caa-74b1-818d-211b42ead072';
  const details = stderrDiagnostic(`2026-11-08T18:46:30Z \x1b[33mWARN\x1b[0m codex_core::responses_retry: session_loop{thread_id=${threadId}}: turn.id="${turnId}" stream disconnected - retrying: Operation timed out (os error 60) PRIVATE_PROMPT token=PRIVATE_TOKEN`);
  assert.deepEqual(details, { source: 'stderr', level: 'WARN', reason: 'timeout', module: 'codex_core::responses_retry', threadId, turnId });
  log.write('process.stderr', details);
  assert.ok(!fs.readFileSync(log.file, 'utf8').includes('PRIVATE_'));
  for (const [message, reason] of [['status 429', 'rate-limit'], ['unauthorized', 'authentication'], ['connection reset', 'connection'], ['status 503', 'overloaded'], ['retry sampling', 'retry'], ['PRIVATE_UNKNOWN', 'unclassified']]) assert.equal(stderrDiagnostic('ERROR codex_core::client: ' + message).reason, reason);
  assert.equal(stderrDiagnostic('INFO codex_core::client: PRIVATE_PROMPT'), null);
});

function turnsFixture() {
  const connection = new EventEmitter(); connection.requests = new Map();
  const entries = []; connection.on('diagnostic', entry => entries.push(entry));
  let now = 0;
  const turns = new TurnDiagnostics(connection, () => now);
  return { connection, entries, turns, at: value => { now = value; }, notify: (method, params, id) => connection.emit('notification', { method, params, id }) };
}

test('silent turns log once, isolate parallel chats, and record first output and recovery timing', () => {
  const f = turnsFixture();
  f.notify('turn/started', { threadId: 'quiet', turn: { id: 'one' } });
  f.notify('turn/started', { threadId: 'busy', turn: { id: 'two' } });
  f.at(59999); f.turns.check(); assert.equal(f.entries.length, 0);
  f.notify('item/reasoning/textDelta', { threadId: 'busy', turnId: 'two', delta: 'PRIVATE_REASONING' });
  f.at(60000); f.turns.check(); f.at(120000); f.turns.check();
  assert.equal(f.entries.filter(entry => entry.event === 'turn.quiet' && entry.details.threadId === 'quiet').length, 1);
  const busy = f.entries.find(entry => entry.event === 'turn.first-output');
  assert.equal(busy.details.firstOutputMs, 59999);
  f.at(121000); f.notify('item/agentMessage/delta', { threadId: 'quiet', turnId: 'one', delta: 'PRIVATE_REPLY' });
  const resumed = f.entries.find(entry => entry.event === 'turn.resumed' && entry.details.threadId === 'quiet');
  assert.equal(resumed.details.idleMs, 121000);
  assert.equal(f.entries.find(entry => entry.event === 'turn.first-output' && entry.details.threadId === 'quiet').details.firstOutputMs, 121000);
  f.at(181000); f.turns.check();
  assert.equal(f.entries.filter(entry => entry.event === 'turn.quiet' && entry.details.threadId === 'quiet').length, 2);
  assert.ok(!JSON.stringify(f.entries).includes('PRIVATE_'));
});

test('tool and approval waits carry phase and pending interaction counts; terminal states stop monitoring', () => {
  const f = turnsFixture();
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'turn' } });
  f.at(5000); f.notify('item/started', { threadId: 'chat', turnId: 'turn', item: { type: 'commandExecution', command: 'PRIVATE_COMMAND' } });
  f.at(65000); f.turns.check();
  assert.equal(f.entries.at(-1).details.phase, 'commandExecution:started');
  f.connection.requests.set('approval', { params: { threadId: 'chat', command: 'PRIVATE_COMMAND' } });
  f.notify('item/commandExecution/requestApproval', { threadId: 'chat', turnId: 'turn', command: 'PRIVATE_COMMAND' }, 'approval');
  f.at(125000); f.turns.check();
  assert.equal(f.entries.at(-1).details.pendingRequests, 1);
  assert.equal(f.entries.at(-1).details.phase, 'item/commandExecution/requestApproval');
  f.notify('item/agentMessage/delta', { threadId: 'chat', turnId: 'old-turn', delta: 'PRIVATE_OLD_REPLY' });
  assert.equal(f.entries.at(-1).event, 'turn.quiet');
  f.notify('turn/completed', { threadId: 'chat', turn: { id: 'old-turn', status: 'completed' } });
  assert.equal(f.turns.turns.size, 1);
  f.notify('thread/status/changed', { threadId: 'chat', status: { type: 'idle' } });
  f.notify('turn/completed', { threadId: 'chat', turn: { id: 'turn', status: 'completed' } });
  f.connection.emit('rpc', { phase: 'finished', threadId: 'chat', result: { turn: { id: 'turn', status: 'inProgress' } } });
  f.at(300000); f.turns.check();
  assert.equal(f.turns.turns.size, 0);
  assert.equal(f.entries.filter(entry => entry.event === 'turn.summary').length, 1);
  assert.equal(f.entries.at(-1).details.reason, 'thread-idle');
  assert.ok(!JSON.stringify(f.entries).includes('PRIVATE_'));
});

test('turns acknowledged by RPC are monitored without start notifications, and disconnect clears tracking', () => {
  const f = turnsFixture();
  f.connection.emit('rpc', { phase: 'finished', threadId: 'chat', result: { turn: { id: 'one', status: 'inProgress' } } });
  f.at(60000); f.turns.check(); assert.equal(f.entries.at(-1).event, 'turn.quiet');
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'two' } });
  assert.equal(f.entries.at(-1).details.reason, 'replaced');
  f.connection.emit('rpc', { phase: 'finished', threadId: 'chat', result: { turn: { id: 'one', status: 'inProgress' } } });
  assert.equal(f.turns.turns.get('chat').turnId, 'two');
  f.connection.emit('disconnected');
  assert.equal(f.entries.at(-1).details.reason, 'disconnected');
  assert.equal(f.turns.turns.size, 0); assert.equal(f.turns.finished.size, 0);
  const count = f.entries.length; f.at(600000); f.turns.check(); assert.equal(f.entries.length, count);
});

test('streaming tool output prevents false silence warnings without counting as model output', () => {
  const f = turnsFixture();
  f.notify('turn/started', { threadId: 'chat', turn: { id: 'turn' } });
  f.notify('item/started', { threadId: 'chat', turnId: 'turn', item: { type: 'commandExecution' } });
  for (const now of [50000, 100000, 150000]) {
    f.at(now); f.notify('item/commandExecution/outputDelta', { threadId: 'chat', turnId: 'turn', delta: 'PRIVATE_COMMAND_OUTPUT' });
    f.turns.check();
  }
  assert.equal(f.entries.length, 1);
  f.at(210000); f.turns.check();
  assert.equal(f.entries.at(-1).event, 'turn.quiet');
  assert.equal(f.entries.at(-1).details.phase, 'item/commandExecution/outputDelta');
  assert.equal(f.entries.at(-1).details.firstOutputMs, undefined);
  assert.ok(!JSON.stringify(f.entries).includes('PRIVATE_'));
});
