const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { validateQueue } = require('./queues.cjs');

const statuses = new Set(['pending', 'sending', 'sent', 'cancelled', 'unconfirmed']);
const protocols = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);

class ScheduleStore {
  constructor(file) {
    this.file = file;
    this.tasks = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.some(task => !task || typeof task.id !== 'string' || typeof task.threadId !== 'string' || typeof task.prompt !== 'string' || !Number.isFinite(Date.parse(task.runAt)) || !statuses.has(task.status))) throw new Error('Invalid saved scheduled tasks.');
      for (const task of data.tasks) if (task.message) {
        validateQueue({ key: task.machine + ':' + task.threadId, machine: task.machine, thread: task.message.thread, messages: [task.message] });
      }
      this.tasks = data.tasks;
      if (this.tasks.some(task => task.status === 'sending')) this.save(this.tasks.map(task => task.status === 'sending' ? { ...task, status: 'unconfirmed', error: 'App closed during delivery; check chat history before rescheduling.' } : task));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save(tasks) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, tasks }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.tasks = tasks;
  }

  list(threadId) { return structuredClone(this.tasks.filter(task => !threadId || task.threadId === threadId)); }
  summaries() { return this.tasks.map(({ message, ...task }) => structuredClone(task)); }

  add(thread, args, sourceId, now = Date.now(), message = null) {
    if (!args || typeof args !== 'object' || Object.keys(args).some(key => !['prompt', 'delay_seconds', 'run_at'].includes(key)) || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 50000 || (args.delay_seconds !== undefined) === (args.run_at !== undefined)) throw new Error('Provide a prompt and exactly one of delay_seconds or run_at.');
    if (args.delay_seconds !== undefined && (typeof args.delay_seconds !== 'number' || !Number.isFinite(args.delay_seconds) || args.delay_seconds <= 0)) throw new Error('delay_seconds must be positive.');
    if (args.run_at !== undefined && (typeof args.run_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(args.run_at))) throw new Error('run_at must be an ISO timestamp with a timezone.');
    const due = args.run_at === undefined ? now + args.delay_seconds * 1000 : Date.parse(args.run_at);
    if (!Number.isFinite(due) || due <= now || due > now + 366 * 86400000) throw new Error('Schedule a future time within one year.');
    const existing = sourceId && this.tasks.find(task => task.threadId === thread.id && task.sourceId === sourceId);
    if (existing) return structuredClone(existing);
    if (this.tasks.filter(task => task.status === 'pending').length >= 1000) throw new Error('Cancel pending tasks before scheduling more.');
    const task = { id: randomUUID(), threadId: thread.id, cwd: thread.cwd, title: thread.name || thread.preview || 'Conversation', prompt: args.prompt.trim(), runAt: new Date(due).toISOString(), createdAt: new Date(now).toISOString(), status: 'pending', machine: message?.machine || 'access:local', ...(message ? { message: structuredClone(message) } : {}), ...(sourceId ? { sourceId } : {}) };
    this.save([...this.tasks, task]);
    return structuredClone(task);
  }

  enqueue(message, hours, now = Date.now()) {
    if (!Number.isInteger(hours) || !(hours >= 1 && hours <= 24 || [48, 72, 96, 120, 144, 168].includes(hours))) throw new Error('Choose a delay from one hour to seven days.');
    validateQueue({ key: message?.machine + ':' + message?.thread?.id, machine: message?.machine, thread: message?.thread, messages: [message] });
    if (!message.input.length || message.review || !['default', 'plan'].includes(message.mode) || !message.turnSettings || message.turnSettings.threadId !== message.thread.id) throw new Error('Invalid scheduled message.');
    return this.add(message.thread, { prompt: message.text || `${message.images.length} image(s)`, delay_seconds: hours * 3600 }, null, now, message);
  }

  update(id, patch) {
    const task = this.tasks.find(task => task.id === id);
    if (!task) throw new Error('Scheduled task not found.');
    const updated = { ...task, ...patch };
    this.save(this.tasks.map(entry => entry.id === id ? updated : entry));
    return structuredClone(updated);
  }

  cancel(id, threadId) {
    const task = this.tasks.find(task => task.id === id && (!threadId || task.threadId === threadId));
    if (!task) throw new Error('Scheduled task not found in this conversation.');
    if (task.status === 'cancelled') return structuredClone(task);
    if (task.status !== 'pending') throw new Error('This task has already been sent or attempted; check chat history.');
    return this.update(id, { status: 'cancelled', message: null });
  }

}

class Scheduler {
  constructor({ store, connection, available, machine = () => 'access:local', blocked = () => false, changed = () => {} }) {
    Object.assign(this, { store, connection, available, machine, blocked, changed });
    this.dispatching = new Set();
    this.running = false;
  }

  async tick(now = Date.now()) {
    if (this.running || !this.connection.ready || !this.available()) return;
    this.running = true;
    const child = this.connection.child;
    const machine = this.machine();
    const current = () => this.connection.ready && this.connection.child === child && this.available() && this.machine() === machine;
    try {
      const due = this.store.summaries().filter(task => (task.machine || 'access:local') === machine && task.status === 'pending' && Date.parse(task.runAt) <= now && (!task.retryAt || task.retryAt <= now)).sort((a, b) => a.runAt.localeCompare(b.runAt));
      for (const task of due) {
        if (!current()) break;
        if (this.blocked(task.threadId)) continue;
        this.dispatching.add(task.threadId);
        try {
          const before = await this.connection.call('thread/read', { threadId: task.threadId, includeTurns: false });
          if (!current()) break;
          if (before.thread.status?.type === 'active') continue;
          const resumed = before.thread.status?.type === 'idle' ? before : await this.connection.call('thread/resume', { threadId: task.threadId, excludeTurns: true });
          if (!current()) break;
          const saved = this.store.tasks.find(entry => entry.id === task.id);
          if (resumed.thread.status?.type === 'active' || this.blocked(task.threadId) || saved?.status !== 'pending') continue;
          this.store.update(task.id, { status: 'sending', error: null });
          this.changed();
          try {
            const result = await this.connection.call('turn/start', saved.message ? { ...saved.message.turnSettings, threadId: task.threadId, input: saved.message.input } : { threadId: task.threadId, input: [{ type: 'text', text: task.prompt }] });
            this.store.update(task.id, { status: 'sent', message: null, turnId: result.turn.id, sentAt: new Date().toISOString() });
          } catch (error) {
            this.store.update(task.id, { status: 'unconfirmed', error: `Delivery was not confirmed: ${error.message} Check chat history before rescheduling.` });
          }
        } catch (error) {
          if (this.store.tasks.find(entry => entry.id === task.id)?.status === 'pending') this.store.update(task.id, { error: error.message, retryAt: now + 60000 });
          else throw error;
        } finally { this.dispatching.delete(task.threadId); this.changed(); }
      }
    } finally { this.running = false; }
  }
}

async function createSchedulerMcp({ store, context, changed = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const tools = [
    { name: 'schedule_task', description: 'Schedule one follow-up message in this conversation. Use this instead of sleeping for long waits. Saved across app restarts; sends automatically when the app is connected locally and the chat is idle, including overdue tasks after wake. Does not wake the computer. Only schedule work the user requested.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete instructions to send later; include the necessary context.' }, delay_seconds: { type: 'number', exclusiveMinimum: 0, description: 'Seconds from now, e.g. 21600 for 6 hours or 43200 for 12 hours.' }, run_at: { type: 'string', description: 'ISO 8601 timestamp with explicit timezone; use either run_at or delay_seconds.' } }, required: ['prompt'], additionalProperties: false, oneOf: [{ required: ['delay_seconds'] }, { required: ['run_at'] }] }, annotations: { destructiveHint: false, openWorldHint: false } },
    { name: 'list_scheduled_tasks', description: 'List saved scheduled tasks and delivery statuses for this conversation, with the current time.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'cancel_scheduled_task', description: 'Cancel a pending follow-up in this conversation.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }, annotations: { idempotentHint: true, openWorldHint: false } }
  ];
  const server = http.createServer(async (request, response) => {
    const end = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(data === undefined ? undefined : JSON.stringify(data)); };
    const authorization = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address().port}` || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return end(403);
    if (request.url !== '/mcp') return end(404);
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return end(405); }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return end(415);
    if (request.headers['mcp-protocol-version'] && !protocols.has(request.headers['mcp-protocol-version'])) return end(400);
    let message;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) { end(413); return; } chunks.push(chunk); }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return end(400); }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message)) return end(400);
    if (message.id === undefined) return end(202);
    const reply = result => end(200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: protocols.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote-codex-scheduler', version: '1.0.0' } });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools });
    if (message.method !== 'tools/call') return end(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } });
    try {
      const params = message.params;
      const threadId = params?._meta?.threadId;
      if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('Codex did not provide the conversation ID; no task was changed.');
      if (!tools.some(tool => tool.name === params.name)) throw new Error('Unknown scheduler tool.');
      const thread = await context(threadId);
      const args = params.arguments || {};
      let result;
      if (params.name === 'schedule_task') result = store.add(thread, args, params._meta.itemId || params._meta.callId);
      else if (params.name === 'list_scheduled_tasks') result = { now: new Date().toISOString(), tasks: store.list(threadId) };
      else {
        if (typeof args.task_id !== 'string') throw new Error('Provide task_id.');
        result = store.cancel(args.task_id, threadId);
      }
      changed();
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp`, token };
}

module.exports = { ScheduleStore, Scheduler, createSchedulerMcp };
