const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiagnosticLog, MAX_LOG_BYTES } = require('../diagnostics.cjs');

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
