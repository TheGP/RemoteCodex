const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ScheduleStore, Scheduler, createSchedulerMcp } = require('../scheduler.cjs');

const thread = { id: 'scheduled-chat', cwd: '/project', name: 'Scheduled chat', status: { type: 'idle' } };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-scheduler-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(path.join(directory, 'schedules.json'));
  const now = Date.now();
  const calls = [];
  const connection = { ready: true, session: {}, call: async (method, params) => { calls.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'scheduled-turn' } } : { thread: method === 'thread/read' ? { ...thread, status: { type: 'notLoaded' } } : thread }; } };
  const scheduler = new Scheduler({ store, connection, available: () => true });
  return { store, now, calls, connection, scheduler, add: (args = {}) => store.add(thread, { prompt: 'Check the deployment', delay_seconds: 1, ...args }, null, now) };
}

test('schedules survive restart, reject ambiguous dates and invalid prompts, and deduplicate tool retries', t => {
  const f = fixture(t);
  const task = f.store.add(thread, { prompt: 'Check in twelve hours', delay_seconds: 43200 }, 'tool-call', f.now);
  assert.equal(Date.parse(task.runAt), f.now + 43200000);
  assert.deepEqual(new ScheduleStore(f.store.file).list(), [task]);
  assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
  assert.equal(f.store.add(thread, { prompt: 'Same call', delay_seconds: 1 }, 'tool-call', f.now).id, task.id);
  for (const args of [{ prompt: '', delay_seconds: 1 }, { prompt: 'x', delay_seconds: '12' }, { prompt: 'x', delay_seconds: -1 }, { prompt: 'x', run_at: 'tomorrow' }, { prompt: 'x', run_at: '2027-01-01T12:00:00' }, { prompt: 'x', delay_seconds: 1, run_at: new Date(f.now + 1000).toISOString() }, { prompt: 'x', delay_seconds: 1, threadId: 'other' }]) assert.throws(() => f.store.add(thread, args, null, f.now));
  assert.equal(f.store.list().length, 1);
  const explicit = f.store.add(thread, { prompt: 'At a timestamp', run_at: new Date(f.now + 5000).toISOString() }, null, f.now);
  assert.equal(Date.parse(explicit.runAt), f.now + 5000);
  assert.throws(() => f.store.cancel(task.id, 'other-chat'), /not found/);
  f.store.cancel(task.id, thread.id);
  assert.equal(new ScheduleStore(f.store.file).list()[0].status, 'cancelled');
});

test('overdue tasks send into their original chat once, including after disk reload', async t => {
  const f = fixture(t); const task = f.add();
  f.scheduler.store = new ScheduleStore(f.store.file);
  await f.scheduler.tick(f.now);
  assert.equal(f.calls.length, 0);
  await Promise.all([f.scheduler.tick(f.now + 43200000), f.scheduler.tick(f.now + 43200000)]);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read', 'thread/resume', 'turn/start']);
  assert.deepEqual(f.calls.at(-1).params, { threadId: thread.id, input: [{ type: 'text', text: task.prompt }] });
  assert.equal(new ScheduleStore(f.store.file).list()[0].status, 'sent');
  await f.scheduler.tick(f.now + 86400000);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('composer schedules preserve attachments, skills, settings, and machine identity without sending early', async t => {
  const f = fixture(t);
  const text = 'Check this image later';
  const message = { machine: 'access:local', thread, text, images: [{ name: 'preview.png', url: 'data:image/png;base64,AA==' }], input: [{ type: 'text', text }, { type: 'image', url: 'data:image/png;base64,AA==' }, { type: 'skill', name: 'cr', path: '/skills/cr/SKILL.md' }], access: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, mode: 'plan', model: 'test-model', effort: 'high', turnSettings: { threadId: thread.id, model: 'test-model', effort: 'high', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, collaborationMode: { mode: 'plan', settings: { model: 'test-model' } } } };
  const task = f.store.enqueue(message, 168, f.now);
  assert.equal(Date.parse(task.runAt), f.now + 7 * 86400000);
  const restored = new ScheduleStore(f.store.file);
  assert.deepEqual(restored.list()[0].message, message);
  assert.equal(restored.summaries()[0].message, undefined);
  for (const hours of [0, -1, 25, 36, 169, '1', NaN]) assert.throws(() => f.store.enqueue(message, hours, f.now));
  const scheduler = new Scheduler({ store: restored, connection: f.connection, available: () => true });
  await scheduler.tick(f.now + 86400000); assert.equal(f.calls.length, 0);
  await scheduler.tick(f.now + 8 * 86400000);
  assert.deepEqual(f.calls.at(-1).params, { ...message.turnSettings, input: message.input });
  assert.equal(restored.list()[0].message, null);
  const remote = { ...message, machine: 'access:test-host:22' };
  const remoteTask = restored.enqueue(remote, 24, f.now);
  await scheduler.tick(f.now + 8 * 86400000);
  assert.equal(restored.list().find(task => task.id === remoteTask.id).status, 'pending');
  scheduler.machine = () => remote.machine;
  await scheduler.tick(f.now + 8 * 86400000);
  assert.equal(restored.list().find(task => task.id === remoteTask.id).status, 'sent');
});

test('editing a pending schedule retains its identity, attachments and turn settings, survives reload and sends once at the new time', async t => {
  const f = fixture(t);
  const image = { name: 'preview.png', url: 'data:image/png;base64,AA==' };
  const skill = { type: 'skill', name: 'cr', path: '/skills/cr/SKILL.md' };
  const message = { machine: 'access:local', thread, text: 'Original $cr', images: [image], input: [{ type: 'text', text: 'Original $cr' }, { type: 'image', url: image.url }, skill], access: { sandbox: 'read-only', approvalPolicy: 'on-request' }, mode: 'plan', model: 'saved-model', effort: 'high', turnSettings: { threadId: thread.id, model: 'saved-model', effort: 'high' } };
  const task = f.store.enqueue(message, 1, f.now);
  f.store.update(task.id, { error: 'Earlier error', retryAt: f.now + 500000 });
  const runAt = new Date(f.now + 7200000).toISOString();
  const edited = f.store.edit(task.id, { text: 'Edited $cr', runAt, skills: [skill] }, f.now);
  assert.equal(edited.id, task.id); assert.equal(edited.createdAt, task.createdAt);
  assert.equal(edited.prompt, 'Edited $cr'); assert.equal(edited.error, null); assert.equal(edited.retryAt, null);
  assert.deepEqual(edited.message, { ...message, text: 'Edited $cr', input: [{ type: 'text', text: 'Edited $cr', text_elements: [] }, { type: 'image', url: image.url }, skill] });
  const restored = new ScheduleStore(f.store.file);
  assert.deepEqual(restored.get(task.id), edited);
  f.scheduler.store = restored;
  await f.scheduler.tick(f.now + 3600001); assert.equal(f.calls.length, 0);
  await f.scheduler.tick(f.now + 7200001);
  assert.deepEqual(f.calls.at(-1).params, { ...message.turnSettings, input: edited.message.input });
  await f.scheduler.tick(f.now + 9000000);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.throws(() => restored.edit(task.id, { text: 'Too late', runAt }), /no longer pending/);
});

test('scheduled edits reject invalid content, dates and status changes while keeping an overdue time or image-only message valid', t => {
  const f = fixture(t), task = f.add();
  for (const patch of [{ text: '', runAt: task.runAt }, { text: 'x', runAt: 'invalid' }, { text: 'x', runAt: new Date(f.now - 1).toISOString() }, { text: 'x', runAt: new Date(f.now + 367 * 86400000).toISOString() }, { text: 'x', runAt: task.runAt, status: 'sent' }, { text: 'x', runAt: task.runAt, skills: [{ type: 'text' }] }]) assert.throws(() => f.store.edit(task.id, patch, f.now));
  assert.deepEqual(f.store.get(task.id), task);
  const overdue = f.store.edit(task.id, { text: 'Updated overdue', runAt: task.runAt }, f.now + 10000);
  assert.equal(overdue.runAt, task.runAt);
  f.store.cancel(task.id);
  assert.throws(() => f.store.edit(task.id, { text: 'Cancelled', runAt: task.runAt }), /no longer pending/);
  const message = { machine: 'access:local', thread, text: 'Image', images: [{ name: 'a.png' }], input: [{ type: 'text', text: 'Image' }, { type: 'image', url: 'data:image/png;base64,AA==' }, { type: 'skill', name: 'cr', path: '/cr' }], access: { sandbox: 'read-only', approvalPolicy: 'never' }, mode: 'default', turnSettings: { threadId: thread.id } };
  const imageTask = f.store.enqueue(message, 1, f.now);
  const imageOnly = f.store.edit(imageTask.id, { text: ' ', runAt: imageTask.runAt, skills: [] }, f.now);
  assert.equal(imageOnly.prompt, '1 image(s)'); assert.deepEqual(imageOnly.message.input, [{ type: 'image', url: 'data:image/png;base64,AA==' }]);
});

test('rescheduling during delivery preflight cannot send an old due snapshot', async t => {
  const f = fixture(t), task = f.add();
  let finishRead;
  f.connection.call = () => new Promise(resolve => { finishRead = resolve; });
  const tick = f.scheduler.tick(f.now + 2000);
  f.store.edit(task.id, { text: 'Send later', runAt: new Date(f.now + 3600000).toISOString() }, f.now);
  finishRead({ thread }); await tick;
  assert.equal(f.store.get(task.id).status, 'pending');
  assert.equal(f.scheduler.dispatching.size, 0);
});

test('disconnected, other-machine, active, and queued chats defer scheduled delivery', async t => {
  const f = fixture(t); f.add();
  f.connection.ready = false; await f.scheduler.tick(f.now + 2000);
  f.connection.ready = true; f.scheduler.available = () => false; await f.scheduler.tick(f.now + 2000);
  f.scheduler.available = () => true; f.scheduler.blocked = () => true; await f.scheduler.tick(f.now + 2000);
  assert.equal(f.calls.length, 0);
  f.scheduler.blocked = () => false;
  f.connection.call = async () => ({ thread: { ...thread, status: { type: 'active' } } });
  await f.scheduler.tick(f.now + 2000);
  assert.equal(f.store.list()[0].status, 'pending');
  f.connection.call = async method => method === 'turn/start' ? { turn: { id: 'after-idle' } } : { thread };
  await f.scheduler.tick(f.now + 3000);
  assert.equal(f.store.list()[0].status, 'sent');
});

test('cancellation or a connection switch during preflight cannot send a task', async t => {
  const f = fixture(t); const task = f.add();
  let finish;
  f.connection.call = () => new Promise(resolve => { finish = resolve; });
  const dispatch = f.scheduler.tick(f.now + 2000);
  assert.ok(f.scheduler.dispatching.has(thread.id));
  f.store.cancel(task.id); finish({ thread });
  await Promise.resolve(); finish({ thread }); await dispatch;
  assert.equal(f.store.list()[0].status, 'cancelled');
  assert.equal(f.scheduler.dispatching.size, 0);
  f.add();
  const switched = f.scheduler.tick(f.now + 2000);
  f.connection.session = {}; finish({ thread }); await switched;
  assert.equal(f.store.list().at(-1).status, 'pending');
});

test('unconfirmed delivery and app closure during delivery never auto-resend', async t => {
  const f = fixture(t); f.add();
  const call = f.connection.call;
  f.connection.call = async (method, params) => { if (method === 'turn/start') throw new Error('timed out; server may have received it'); return call(method, params); };
  await f.scheduler.tick(f.now + 2000);
  assert.equal(f.store.list()[0].status, 'unconfirmed');
  assert.match(f.store.list()[0].error, /Check chat history/);
  f.scheduler.store = new ScheduleStore(f.store.file); f.connection.call = call;
  await f.scheduler.tick(f.now + 86400000);
  assert.ok(!f.calls.some(call => call.method === 'turn/start'));
  const crash = f.add(); f.store.update(crash.id, { status: 'sending' });
  const recovered = new ScheduleStore(f.store.file);
  assert.equal(recovered.list().at(-1).status, 'unconfirmed');
});

test('preflight errors remain retryable, cancelled work stays cancelled, and failed disk writes prevent delivery', async t => {
  const f = fixture(t); const task = f.add();
  const call = f.connection.call;
  f.connection.call = async () => { throw new Error('Writer belongs to another session'); };
  await f.scheduler.tick(f.now + 2000);
  assert.equal(f.store.list()[0].status, 'pending');
  assert.match(f.store.list()[0].error, /Writer/);
  f.connection.call = call;
  await f.scheduler.tick(f.now + 3000); assert.equal(f.calls.length, 0);
  f.store.cancel(task.id); assert.equal(f.store.list()[0].status, 'cancelled');
  const another = f.add();
  fs.mkdirSync(f.store.file + '.tmp');
  await assert.rejects(f.scheduler.tick(f.now + 90000));
  assert.equal(f.store.list().find(entry => entry.id === another.id).status, 'pending');
  assert.ok(!f.calls.some(call => call.method === 'turn/start'));
  assert.equal(f.store.list().find(entry => entry.id === task.id).status, 'cancelled');
});

test('HTTP MCP authenticates, validates origins and context, and schedules/lists/cancels only the calling chat', async t => {
  const f = fixture(t); let changes = 0;
  const mcp = await createSchedulerMcp({ store: f.store, context: async id => { assert.equal(id, thread.id); return thread; }, changed: () => { changes++; } });
  t.after(() => { mcp.server.closeAllConnections(); mcp.server.close(); });
  let sequence = 0;
  const post = (message, headers = {}) => fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mcp.token, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, ...message }) });
  assert.equal((await post({ method: 'tools/list' }, { Authorization: '' })).status, 403);
  assert.equal((await post({ method: 'tools/list' }, { Origin: 'https://example.com' })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = http.request(mcp.url, { method: 'POST', headers: { Host: 'malicious.example', Authorization: 'Bearer ' + mcp.token } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(rebound, 403);
  assert.equal((await post({ method: 'tools/list' }, { 'MCP-Protocol-Version': 'unsupported' })).status, 400);
  assert.equal((await post({ method: 'notifications/initialized', id: undefined })).status, 202);
  assert.equal((await (await post({ method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()).result.protocolVersion, '2025-06-18');
  assert.equal((await (await post({ method: 'tools/list' })).json()).result.tools.length, 3);
  const missing = await (await post({ method: 'tools/call', params: { name: 'schedule_task', arguments: { prompt: 'x', delay_seconds: 1 } } })).json();
  assert.equal(missing.result.isError, true); assert.equal(f.store.list().length, 0);
  const invoke = async (name, args = {}) => (await (await post({ method: 'tools/call', params: { name, arguments: args, _meta: { threadId: thread.id } } })).json()).result;
  const scheduled = await invoke('schedule_task', { prompt: 'Send this later', delay_seconds: 43200 });
  const task = JSON.parse(scheduled.content[0].text);
  assert.equal(task.threadId, thread.id); assert.equal(task.status, 'pending');
  const listed = JSON.parse((await invoke('list_scheduled_tasks')).content[0].text);
  assert.equal(listed.tasks[0].id, task.id);
  assert.equal((await invoke('cancel_scheduled_task', { task_id: task.id })).isError, undefined);
  assert.equal(f.store.list()[0].status, 'cancelled');
  assert.equal(changes, 3);
});
