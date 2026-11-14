const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ZCodeConnection, modelId, threadId } = require('../zcode.cjs');
const { agentId } = require('../agent-pool.cjs');

async function until(predicate, message = 'Timed out waiting for fixture', timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(message);
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-zcode-test '));
  const children = [], requests = [], records = [], notifications = [], invocations = [];
  const connection = new ZCodeConnection((...args) => {
    invocations.push(args);
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/zcode-server.cjs')], { cwd: args[2]?.cwd || directory, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('message', message => { if (message.request) { requests.push(message.request); records.push({ child, request: message.request }); } });
    children.push(child); return child;
  });
  connection.on('notification', notification => notifications.push(notification));
  t.after(async () => {
    connection.disconnect();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await connection.connect({ mode: 'local', localCwd: directory, executablePath: process.execPath });
  return { connection, directory, children, requests, notifications, invocations, requestsFor: child => records.filter(record => record.child === child).map(record => record.request), send: message => children.at(-1).send(message) };
}
async function history(f) {
  const result = await f.connection.call('thread/list', { limit: 50 });
  const thread = result.data.find(entry => entry.name === 'Fixture conversation');
  assert.ok(thread, 'Native stored session did not appear in the thread list');
  await f.connection.call('thread/read', { threadId: thread.id, includeTurns: false });
  return thread;
}
const commands = f => f.requests.filter(request => request.method === 'v4/command');

test('ZCode uses native catalogs and stored V4 history without running inference', async t => {
  const f = await fixture(t);
  assert.equal(f.connection.ready, true);
  assert.ok(f.invocations.every(invocation => !invocation[2]?.shell));
  const models = await f.connection.call('model/list', { limit: 100 });
  assert.ok(models.data.some(model => model.model === modelId('fixture', 'model-a')));
  const thread = await history(f);
  const result = await f.connection.call('thread/turns/list', { threadId: thread.id, limit: 50 });
  const items = result.data.flatMap(turn => turn.items);
  assert.ok(items.some(item => item.type === 'userMessage' && item.content.some(part => part.text === 'Saved question')));
  assert.ok(items.some(item => item.type === 'agentMessage' && item.text === 'Saved answer'));
  assert.equal(f.notifications.filter(notification => notification.method === 'turn/completed').length, 0, 'Opening saved history announced an old completion');
  assert.equal(commands(f).length, 0);
  assert.ok(f.requests.filter(request => request.method === 'v4/conversation/subscribe').every(request => request.params.clientMode === 'desktop-continuous'));
});

test('ZCode creates chats and streams authoritative turns instead of completing on command ACK', async t => {
  const f = await fixture(t);
  const created = await f.connection.call('thread/start', { cwd: f.directory, model: modelId('fixture', 'model-a') });
  assert.ok(created.thread.id);
  const before = f.notifications.length;
  const result = await f.connection.call('turn/start', { threadId: created.thread.id, model: modelId('fixture', 'model-a'), input: [{ type: 'text', text: 'Say hello' }] });
  assert.ok(result.turn.id);
  await until(() => f.notifications.slice(before).some(notification => notification.method === 'turn/completed'));
  const events = f.notifications.slice(before);
  assert.equal(events.filter(notification => notification.method === 'turn/completed').length, 1);
  assert.ok(events.some(notification => notification.method === 'item/agentMessage/delta' && notification.params.delta.includes('世界')));
  assert.ok(events.some(notification => notification.method === 'item/completed' && notification.params.item?.type === 'agentMessage' && notification.params.item.text === 'Hello 世界🙂'));
  assert.ok(events.findIndex(notification => notification.method === 'turn/started') < events.findIndex(notification => notification.method === 'turn/completed'));
  const send = await until(() => commands(f).find(request => request.params.type === 'sendText'));
  assert.equal(send.params.payload.text, 'Say hello');
  assert.equal(send.params.payload.requestedDelivery, undefined);
  assert.ok(send.params.commandId && send.params.clientId);
});

test('ZCode rejected inputs fail explicitly and accepted native queued inputs are not resubmitted', async t => {
  const f = await fixture(t), thread = await history(f);
  await assert.rejects(f.connection.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'reject this input' }] }), /Fixture rejected input|guard.fixture/);
  const before = f.notifications.length;
  await f.connection.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'queue this input' }] });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(commands(f).filter(request => request.params.type === 'sendText' && request.params.payload.text === 'queue this input').length, 1);
  assert.equal(f.notifications.slice(before).filter(notification => notification.method === 'turn/completed').length, 0);
});

test('ZCode questions preserve answers and permission acceptance grants only the advertised one-time option', async t => {
  const f = await fixture(t), thread = await history(f);
  f.send({ action: 'interaction', kind: 'userInput', id: 'question-1' });
  const question = await until(() => f.notifications.find(notification => notification.method === 'item/tool/requestUserInput'));
  assert.match(question.params.questions[0].question, /fixture option/);
  const id = question.params.questions[0].id;
  await f.connection.respond(question.id, { answers: { [id]: { answers: ['Alpha'] } } });
  const answer = await until(() => commands(f).find(request => request.params.type === 'resolveInteraction' && request.params.payload.interactionId === 'question-1'));
  assert.ok(answer.params.payload.answer.content || answer.params.payload.answer.freeText || answer.params.payload.answer.optionId);
  f.send({ action: 'interaction', kind: 'permission', id: 'permission-1' });
  const approval = await until(() => f.notifications.find(notification => notification.method === 'item/commandExecution/requestApproval'));
  await f.connection.respond(approval.id, { decision: 'accept' });
  const grant = await until(() => commands(f).find(request => request.params.type === 'resolveInteraction' && request.params.payload.interactionId === 'permission-1'));
  assert.equal(grant.params.payload.answer.optionId, 'allow-once');
  assert.equal(grant.params.sessionId, answer.params.sessionId);
  f.send({ action: 'interaction', kind: 'permission', id: 'permission-denied' });
  const refusal = await until(() => f.notifications.find(notification => notification.method === 'item/commandExecution/requestApproval' && notification.id !== approval.id));
  await f.connection.rejectRequest(refusal.id);
  const deny = await until(() => commands(f).find(request => request.params.type === 'resolveInteraction' && request.params.payload.interactionId === 'permission-denied'));
  assert.equal(deny.params.payload.answer.optionId, 'deny');
  assert.ok(thread.id);
});

test('ZCode stop targets the current foreground execution and waits for an interrupted projection', async t => {
  const f = await fixture(t), thread = await history(f);
  const before = f.notifications.length;
  await f.connection.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hold this input' }] });
  const started = await until(() => f.notifications.slice(before).find(notification => notification.method === 'turn/started'));
  await f.connection.call('turn/interrupt', { threadId: thread.id, turnId: started.params.turn.id });
  const stopped = await until(() => f.notifications.find(notification => notification.method === 'turn/completed' && notification.params.turn.status === 'interrupted'));
  assert.equal(stopped.params.turn.id, started.params.turn.id);
  const command = await until(() => commands(f).find(request => request.params.type === 'stop'));
  assert.ok(command.params.payload.expectedForegroundExecutionId);
});

test('ZCode recovers sequence gaps from snapshots and reassembles fragmented UTF-8 frames', async t => {
  const f = await fixture(t), thread = await history(f);
  f.send({ action: 'gap' });
  await until(() => f.requests.some(request => request.method === 'v4/conversation/resync') || f.requests.filter(request => request.method === 'v4/conversation/subscribe' && request.params.topic === 'conversation/history-session').length > 1);
  await until(async () => (await f.connection.call('thread/read', { threadId: thread.id, includeTurns: false })).thread.name === 'Recovered after gap');
  f.send({ action: 'fragment' });
  await new Promise(resolve => setTimeout(resolve, 25));
  const turns = await f.connection.call('thread/turns/list', { threadId: thread.id, limit: 50 });
  assert.ok(turns.data.flatMap(turn => turn.items).some(item => item.text === 'Recovered 世界🙂'));
});

test('ZCode disconnected calls fail and reconnect replaces only its own child', async t => {
  const f = await fixture(t);
  const thread = await history(f);
  const old = f.children[0];
  f.connection.disconnect();
  assert.equal(f.connection.ready, false);
  await assert.rejects(f.connection.call('thread/read', { threadId: thread.id }), /connect|closed|disconnected/i);
  await f.connection.connect({ mode: 'local', localCwd: f.directory, executablePath: process.execPath });
  assert.equal(f.connection.ready, true);
  assert.notEqual(f.children.at(-1), old);
});

test('ZCode scopes identical native session and question IDs to their workspace processes', async t => {
  const f = await fixture(t), first = await history(f);
  const other = path.join(f.directory, 'second workspace'); fs.mkdirSync(other);
  await f.connection.call('thread/start', { cwd: other });
  const second = (await f.connection.call('thread/read', { threadId: threadId(other, 'history-session'), includeTurns: false })).thread;
  assert.notEqual(first.id, second.id);
  assert.equal(f.children.length, 2);
  for (const child of f.children) child.send({ action: 'interaction', kind: 'userInput', id: 'same-question', sessionId: 'history-session' });
  const questions = await until(() => {
    const values = f.notifications.filter(notification => notification.method === 'item/tool/requestUserInput');
    return values.length === 2 && values;
  });
  assert.notEqual(questions[0].id, questions[1].id);
  for (const [index, thread] of [first, second].entries()) {
    const question = questions.find(question => question.params.threadId === thread.id);
    assert.ok(question);
    await f.connection.respond(question.id, { answers: { [question.params.questions[0].id]: { answers: [index ? 'Beta' : 'Alpha'] } } });
  }
  for (const [index, child] of f.children.entries()) {
    const answer = await until(() => f.requestsFor(child).find(request => request.method === 'v4/command' && request.params.type === 'resolveInteraction'));
    assert.equal(answer.params.sessionId, 'history-session');
    assert.ok(JSON.stringify(answer.params.payload.answer).includes(index ? 'beta' : 'alpha'));
  }
});

test('ZCode uploads image bytes through native attachment transactions before submitting their references', async t => {
  const f = await fixture(t), thread = await history(f);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzXcAAAAASUVORK5CYII=', 'base64');
  await f.connection.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Describe the fixture image' }, { type: 'image', url: 'data:image/png;base64,' + bytes.toString('base64') }] });
  const upload = await until(() => f.requests.find(request => request.method === 'v4/attachment/begin'));
  assert.equal(upload.params.mime, 'image/png');
  assert.equal(upload.params.totalBytes, bytes.length);
  const chunks = f.requests.filter(request => request.method === 'v4/attachment/chunk').map(request => Buffer.from(request.params.dataBase64, 'base64'));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const send = await until(() => commands(f).find(request => request.params.type === 'sendText'));
  assert.equal(send.params.payload.attachments.length, 1);
  assert.equal(send.params.payload.attachments[0].bytes, bytes.length);
  assert.equal(send.params.payload.attachments[0].mime, 'image/png');
  assert.ok(send.params.payload.attachments[0].ref.startsWith('/fixture-upload/'));
  assert.ok(f.requests.findIndex(request => request.method === 'v4/attachment/commit') < f.requests.indexOf(send));
});

test('ZCode preserves command output and structured file diffs in the normal activity view', async t => {
  const f = await fixture(t); await history(f);
  f.send({ action: 'tools' });
  const command = await until(() => f.notifications.find(notification => notification.method === 'item/completed' && notification.params.item?.type === 'commandExecution'));
  assert.equal(command.params.item.command, 'printf fixture');
  assert.equal(command.params.item.aggregatedOutput, 'fixture output');
  assert.equal(command.params.item.status, 'completed');
  const change = await until(() => f.notifications.find(notification => notification.params.item?.type === 'fileChange'));
  assert.equal(path.basename(change.params.item.changes[0].path), 'example.ts');
  assert.match(change.params.item.changes[0].diff, /@@ -1,1 \+1,1 @@/);
  assert.match(change.params.item.changes[0].diff, /\+const count = 2;/);
});

test('ZCode uses each model\'s native default reasoning when no effort was selected', async t => {
  const f = await fixture(t);
  const created = await f.connection.call('thread/start', { cwd: f.directory, model: modelId('fixture', 'model-a') });
  const create = await until(() => commands(f).find(request => request.params.type === 'createSession'));
  assert.equal(create.params.payload.config.modelSelection.options.reasoningLevel, 'high');
  await f.connection.call('turn/start', { threadId: created.thread.id, model: modelId('fixture', 'model-a'), input: [{ type: 'text', text: 'Use default reasoning' }] });
  const send = await until(() => commands(f).find(request => request.params.type === 'sendText'));
  assert.equal(send.params.payload.modelSelection.options.reasoningLevel, 'high');
  const before = commands(f).length;
  await assert.rejects(f.connection.call('turn/start', { threadId: created.thread.id, model: modelId('fixture', 'model-a'), effort: 'unsupported', input: [{ type: 'text', text: 'Invalid reasoning' }] }), /reasoning|support/i);
  assert.equal(commands(f).length, before);
});

test('ZCode local folder entries expose the app\'s fileName field and file reads preserve bytes', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'fixture file.txt'); fs.writeFileSync(file, 'Fixture 世界🙂');
  fs.mkdirSync(path.join(f.directory, 'fixture folder'));
  const listing = await f.connection.call('fs/readDirectory', { path: f.directory });
  assert.ok(listing.entries.some(entry => entry.fileName === 'fixture file.txt' && !entry.isDirectory));
  assert.ok(listing.entries.some(entry => entry.fileName === 'fixture folder' && entry.isDirectory));
  const result = await f.connection.call('fs/readFile', { path: file });
  assert.equal(Buffer.from(result.dataBase64, 'base64').toString(), 'Fixture 世界🙂');
});

test('ZCode accepts native tool-output and subagent-summary streaming paths without disconnecting', async t => {
  const f = await fixture(t), thread = await history(f);
  f.send({ action: 'stream-paths' });
  await until(() => f.notifications.some(notification => notification.params.item?.aggregatedOutput === 'First output'));
  assert.equal(f.connection.ready, true);
  assert.equal(f.notifications.some(notification => notification.method === 'connection/closed'), false);
  const result = await f.connection.call('thread/turns/list', { threadId: thread.id });
  assert.ok(result.data.flatMap(turn => turn.items).some(item => item.aggregatedOutput === 'First output'));
});

test('ZCode ignores row updates outside the loaded window and keeps applying later state', async t => {
  const f = await fixture(t), thread = await history(f);
  f.send({ action: 'outside-window' });
  await until(() => f.notifications.some(notification => notification.method === 'thread/name/updated' && notification.params.threadName === 'Kept after outside-window deltas'));
  assert.equal(f.connection.ready, true);
  const result = await f.connection.call('thread/turns/list', { threadId: thread.id });
  const text = JSON.stringify(result.data);
  assert.ok(text.includes('Saved answer'));
  assert.ok(!text.includes('Do not show this') && !text.includes('Do not insert this'));
  assert.equal(f.notifications.some(notification => /Do not (show|insert) this/.test(notification.params.item?.text || '')), false);
  assert.equal(f.notifications.some(notification => notification.method === 'connection/closed'), false);
});

test('a failed ZCode workspace leaves another workspace\'s running chat and child alive', async t => {
  const f = await fixture(t), first = await history(f);
  const other = path.join(f.directory, 'healthy workspace'); fs.mkdirSync(other);
  await f.connection.call('thread/start', { cwd: other });
  const second = (await f.connection.call('thread/read', { threadId: threadId(other, 'history-session'), includeTurns: false })).thread;
  await f.connection.call('turn/start', { threadId: first.id, input: [{ type: 'text', text: 'hold this input' }] });
  await f.connection.call('turn/start', { threadId: second.id, input: [{ type: 'text', text: 'hold this input' }] });
  const running = await until(() => f.notifications.find(notification => notification.method === 'turn/started' && notification.params.threadId === second.id));
  const healthy = f.children[1];
  f.children[0].send({ action: 'close' });
  await until(() => f.notifications.some(notification => notification.method === 'error' && notification.params.threadId === first.id));
  assert.equal(f.connection.ready, true);
  assert.equal(healthy.exitCode, null); assert.equal(healthy.signalCode, null);
  assert.equal(f.notifications.some(notification => notification.method === 'connection/closed'), false);
  await f.connection.call('turn/interrupt', { threadId: second.id, turnId: running.params.turn.id });
  await until(() => f.notifications.some(notification => notification.method === 'turn/completed' && notification.params.threadId === second.id && notification.params.turn.status === 'interrupted'));
});

test('ZCode reports provider failures after admission as failed turns with visible error details', async t => {
  const f = await fixture(t), thread = await history(f);
  await f.connection.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'fail after admission' }] });
  const failed = await until(() => f.notifications.find(notification => notification.method === 'turn/completed' && notification.params.turn.status === 'failed'));
  assert.equal(failed.params.threadId, thread.id);
  assert.equal(failed.params.turn.error.message, 'Fixture provider request failed');
  assert.equal(f.connection.ready, true);
});

test('ZCode thread and turn identities fit app storage limits even for deep workspace paths', async t => {
  const f = await fixture(t);
  const cwd = path.join(f.directory, ...Array.from({ length: 3 }, (_, index) => 'long workspace ' + index + 'x'.repeat(80)));
  fs.mkdirSync(cwd, { recursive: true });
  const created = await f.connection.call('thread/start', { cwd, model: modelId('fixture', 'model-a') });
  assert.ok(agentId('zcode', 'thread', created.thread.id).length <= 200);
  const sent = await f.connection.call('turn/start', { threadId: created.thread.id, model: modelId('fixture', 'model-a'), input: [{ type: 'text', text: 'hold this input' }] });
  assert.ok(agentId('zcode', 'turn', sent.turn.id).length <= 200);
  const items = f.notifications.filter(notification => notification.params.item?.id);
  assert.ok(items.length);
  assert.ok(items.every(notification => agentId('zcode', 'item', notification.params.item.id).length <= 200));
  const models = await f.connection.call('model/list');
  assert.ok(models.data.every(model => agentId('zcode', 'model', model.model).length <= 200));
});
