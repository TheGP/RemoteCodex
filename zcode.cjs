const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { crc32 } = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connectionOptions: machineOptions } = require('./transport.cjs');

const zcodeMethods = ['model/list', 'collaborationMode/list', 'thread/list', 'thread/read', 'thread/start', 'thread/resume', 'thread/name/set', 'thread/turns/list', 'thread/edit', 'turn/start', 'turn/steer', 'turn/interrupt', 'queue/delete', 'queue/resume', 'fs/readDirectory', 'fs/readFile', 'account/rateLimits/read'];
const MAX_FRAME = 32 * 1024 * 1024;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const namespace = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
function decode(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('Invalid ZCode identity.');
  try { return JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString()); }
  catch { throw new Error('Invalid ZCode identity.'); }
}
const threadId = (cwd, sessionId) => { try { cwd = fs.realpathSync(cwd); } catch {} return 'z:' + namespace(cwd) + ':' + sessionId; };
const modelId = (providerId, model) => 'm:' + encode([providerId, model]);
const turnId = (id, turn) => 't:' + namespace(id) + ':' + String(turn);
const rowId = (id, row) => 'r:' + namespace(id) + ':' + row.rowId;
const activePhase = phase => ['prewarming', 'running'].includes(phase);
const turnStatus = state => ({ running: 'inProgress', completedSuccess: 'completed', completedInterrupted: 'interrupted', failed: 'failed' })[state] || 'inProgress';

function connectionOptions(value = {}) {
  const options = machineOptions({ ...value, codexPath: '', executablePath: '' });
  const executablePath = String(value.executablePath || '').trim();
  if (executablePath && (!path.isAbsolute(executablePath) || executablePath.includes('\0'))) throw new Error('Use an absolute path to the ZCode executable.');
  const { codexPath, ...machine } = options;
  return { ...machine, executablePath };
}

function localLaunch(options, cwd) {
  if (options.mode !== 'local') throw new Error('ZCode currently supports local workspaces. Disable ZCode before connecting over SSH.');
  const directories = (process.env.PATH || '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
  for (const root of [path.join(os.homedir(), '.local/share/nvm'), path.join(os.homedir(), '.nvm/versions/node')]) {
    try { for (const version of fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) directories.push(path.join(root, version, 'bin')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const candidates = options.executablePath ? [options.executablePath] : [path.join(os.homedir(), '.local/share/zcode-cli/dist/zcode.cjs'), ...directories.map(directory => path.join(directory, process.platform === 'win32' ? 'zcode.cmd' : 'zcode'))];
  const cli = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!cli) throw new Error('ZCode CLI not found. Install ZCode and set its CLI path in Settings.');
  const node = directories.map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!node) throw new Error('ZCode requires Node.js 24 or later.');
  // The child runs under Node, which cannot load modules from Electron's app archive.
  const host = ['zcode-usage.mjs', 'zcode-host.mjs'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  return { command: node, args: ['--input-type=module', '-e', host, fs.realpathSync(cli), cwd], env: { ...process.env, PATH: [path.dirname(node), ...directories].join(path.delimiter) } };
}

function mapItem(id, row) {
  const base = { id: rowId(id, row), startedAtMs: row.createdAt };
  if (row.kind === 'userInput') return { ...base, type: 'userMessage', canEdit: row.actions?.canEdit === true, attachmentCount: row.attachments?.length || 0, content: [{ type: 'text', text: row.text }] };
  if (row.kind === 'assistantText') return { ...base, type: 'agentMessage', text: row.text };
  if (row.kind === 'reasoning') return { ...base, type: 'reasoning', summary: [row.text], content: [] };
  if (row.kind === 'timelineMarker' && row.payload?.type === 'compact') return { ...base, type: 'contextCompaction', status: row.payload.status === 'running' ? 'inProgress' : 'completed' };
  if (row.kind !== 'toolCall') return null;
  const status = ['inputStreaming', 'pendingApproval', 'running'].includes(row.status) ? 'inProgress' : row.status === 'error' ? 'failed' : 'completed';
  const display = row.output?.display || row.display;
  if (display?.kind === 'file_diff') {
    const diff = display.structuredPatch.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n');
    return { ...base, type: 'fileChange', status, changes: [{ path: display.filePath, kind: { type: 'update' }, diff }] };
  }
  const input = row.input || {};
  const output = typeof row.output === 'string' ? row.output : row.output?.text ?? row.output?.content ?? row.outputPreview?.text ?? row.error?.message ?? '';
  if (/^(bash|shell|execute|runcommand)$/i.test(row.toolName)) return { ...base, type: 'commandExecution', command: input.command || row.inputText || row.toolName, aggregatedOutput: typeof output === 'string' ? output : JSON.stringify(output), status, exitCode: row.status === 'error' ? 1 : status === 'inProgress' ? null : 0 };
  return { ...base, type: 'mcpToolCall', server: 'ZCode', tool: row.toolName, arguments: input, result: typeof output === 'string' ? { content: [{ type: 'text', text: output }] } : output, status };
}

class WorkspaceRuntime extends EventEmitter {
  constructor(owner, cwd) {
    super(); this.owner = owner; this.cwd = cwd; this.workspace = { workspacePath: cwd, workspaceKey: cwd };
    this.pending = new Map(); this.topics = new Map(); this.fragments = new Map(); this.sequence = 0; this.closed = false;
  }
  async start() {
    const launch = localLaunch(this.owner.options, this.cwd);
    const child = this.owner.spawnProcess(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.cwd, env: launch.env, windowsHide: true });
    this.child = child;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME) { this.fail(new Error('ZCode returned an oversized protocol frame.')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch (error) { this.fail(new Error('Invalid ZCode protocol frame: ' + error.message)); return; }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => this.fail(new Error('Could not start ZCode. Check its CLI path and Node.js installation.')));
    child.stdin.on('error', () => this.fail(new Error('ZCode connection closed.')));
    child.on('close', () => this.fail(new Error('ZCode runtime closed.')));
    this.owner.emit('diagnostic', { event: 'process.started', details: { provider: 'zcode', pid: child.pid } });
    await this.wait(() => this.hostReady, 45000);
    await this.request('runtime/capabilities', {});
    const catalog = await this.request('remote-codex/catalog', {});
    this.catalog = catalog;
    await this.subscribe('workspace-config/' + this.cwd);
    await this.subscribe('sessions-index/' + this.cwd);
    return this;
  }
  write(message) {
    if (this.closed || !this.child || this.child.stdin.destroyed) throw new Error('ZCode is disconnected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = 'remote-codex:' + ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; check the conversation before retrying.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  wait(predicate, timeout = 45000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.removeListener('state', changed); this.removeListener('closed', closed); };
      const changed = () => { if (predicate()) { cleanup(); resolve(); } };
      const closed = () => { cleanup(); reject(new Error('ZCode is disconnected.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('ZCode did not publish its conversation state in time.')); }, timeout);
      this.on('state', changed); this.on('closed', closed);
      if (this.closed) closed();
    });
  }
  receive(message) {
    if (this.closed) return;
    if (message.method === 'remote-codex/ready') { this.hostReady = true; this.emit('state'); return; }
    if (message.method === 'remote-codex/error') { this.fail(new Error(message.params?.message || 'ZCode host failed.')); return; }
    if (!message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'ZCode request failed.')); else pending.resolve(message.result);
      return;
    }
    if (message.method === 'v4/conversation/frame') { this.frame(message.params); return; }
    if (message.id !== undefined) {
      if (['interaction/requestPermission', 'interaction/requestUserInput'].includes(message.method)) return;
      this.write({ id: message.id, error: { code: -32601, message: 'Remote Codex does not support this host request.' } });
      this.owner.emit('notification', { method: 'error', params: { message: `ZCode requested an unsupported host feature: ${message.method}` } });
    }
  }
  async subscribe(topic, force = false) {
    let slot = this.topics.get(topic);
    if (slot?.state && !force) return slot;
    if (slot?.subscribing) { await slot.subscribing; return slot; }
    slot ||= { state: null, seq: null, buffered: [] };
    this.topics.set(topic, slot);
    const oldId = slot.subscriptionId; slot.subscriptionId = null;
    const subscribing = (async () => {
      const result = await this.request('v4/conversation/subscribe', { topic, workspace: this.workspace, connectionId: this.owner.clientId, clientMode: 'desktop-continuous' });
      slot.subscriptionId = result.ack.subscriptionId; slot.epoch = result.ack.logEpoch;
      slot.seq = null;
      for (const frame of slot.buffered.splice(0)) this.frame(frame);
      await this.wait(() => slot.seq !== null);
      if (oldId && oldId !== slot.subscriptionId) this.request('v4/conversation/unsubscribe', { topic, connectionId: this.owner.clientId, subscriptionId: oldId }).catch(() => {});
      return slot;
    })();
    slot.subscribing = subscribing;
    try { return await subscribing; } finally { if (slot.subscribing === subscribing) slot.subscribing = null; }
  }
  frame(wire) {
    const slot = this.topics.get(wire?.topic);
    if (!slot) return;
    if (!slot.subscriptionId) { if (slot.buffered.length >= 256) throw new Error('Too many frames before subscription acknowledgment.'); slot.buffered.push(wire); return; }
    if (wire.subscriptionId !== slot.subscriptionId) return;
    let frame;
    if (wire.wireVersion !== 3) throw new Error('Unsupported ZCode wire version.');
    if (wire.kind === 'complete') frame = wire.frame;
    else if (wire.kind === 'fragment') {
      if (!Number.isSafeInteger(wire.fragmentCount) || wire.fragmentCount < 1 || wire.fragmentCount > 1024 || !Number.isSafeInteger(wire.fragmentIndex) || wire.fragmentIndex < 0 || wire.fragmentIndex >= wire.fragmentCount || !Number.isSafeInteger(wire.logicalBytes) || wire.logicalBytes > MAX_FRAME || wire.logicalBytes < 1) throw new Error('Invalid fragmented frame.');
      const key = wire.subscriptionId + ':' + wire.logicalFrameId;
      let parts = this.fragments.get(key);
      if (!parts) {
        if (this.fragments.size >= 8) throw new Error('Too many unfinished fragmented frames.');
        parts = { chunks: new Map(), bytes: 0, count: wire.fragmentCount, size: wire.logicalBytes, checksum: wire.checksum?.value }; this.fragments.set(key, parts);
      }
      if (parts.count !== wire.fragmentCount || parts.size !== wire.logicalBytes || parts.checksum !== wire.checksum?.value || wire.checksum?.algorithm !== 'crc32') throw new Error('Inconsistent fragmented frame.');
      if (!parts.chunks.has(wire.fragmentIndex)) { const chunk = Buffer.from(wire.dataBase64, 'base64'); parts.chunks.set(wire.fragmentIndex, chunk); parts.bytes += chunk.length; }
      if (parts.bytes > parts.size) throw new Error('Oversized fragmented frame.');
      if (parts.chunks.size !== parts.count) return;
      const buffer = Buffer.concat(Array.from({ length: parts.count }, (_, index) => parts.chunks.get(index)));
      this.fragments.delete(key);
      if (buffer.length !== parts.size || crc32(buffer).toString(16).padStart(8, '0') !== parts.checksum) throw new Error('Invalid fragmented frame checksum.');
      frame = JSON.parse(buffer.toString('utf8'));
    } else throw new Error('Unknown ZCode frame kind.');
    if (frame?.topic !== wire.topic || frame.subscriptionId !== wire.subscriptionId || !Number.isSafeInteger(frame.toSeq) || !Number.isSafeInteger(frame.fromSeq)) throw new Error('Invalid logical frame.');
    if (slot.seq !== null && frame.toSeq <= slot.seq) return;
    const previous = slot.state;
    if (frame.payload?.kind === 'snapshot') {
      if (frame.payload.snapshot.logEpoch !== slot.epoch) return this.recoverTopic(wire.topic);
      slot.state = frame.payload.snapshot;
    } else if (frame.payload?.kind === 'deltas') {
      if (slot.seq === null || frame.fromSeq !== slot.seq) return this.recoverTopic(wire.topic);
      slot.state = structuredClone(slot.state);
      for (const delta of frame.payload.deltas) this.apply(slot.state, delta);
    } else throw new Error('Unknown logical frame payload.');
    slot.seq = frame.toSeq;
    if (wire.topic.startsWith('conversation/')) {
      slot.state.seq = frame.toSeq;
      this.owner.project(this, slot.state, previous);
    } else if (wire.topic.startsWith('sessions-index/')) this.owner.emit('notification', { method: 'thread/list/updated', params: {} });
    this.emit('state');
  }
  recoverTopic(topic) {
    const slot = this.topics.get(topic);
    if (slot.subscribing) return;
    this.owner.emit('diagnostic', { event: 'zcode.subscription.recovering', details: { provider: 'zcode' } });
    this.subscribe(topic, true).catch(error => this.fail(error));
  }
  apply(state, delta) {
    if (delta.op === 'state.updated') Object.assign(state, delta.patch);
    else if (delta.op === 'config.updated') state.config = delta.config;
    else if (delta.op === 'session.upserted') { state.sessions = state.sessions.filter(session => session.sessionId !== delta.session.sessionId); state.sessions.push(delta.session); }
    else if (delta.op === 'session.removed') state.sessions = state.sessions.filter(session => session.sessionId !== delta.sessionId);
    else if (delta.op === 'row.removed') {
      const before = state.rows.window.length;
      state.rows.window = state.rows.window.filter(row => row.rowId < delta.fromRowId);
      if (state.rows.firstRowId !== null && delta.fromRowId <= state.rows.firstRowId) { state.rows.totalCount = 0; state.rows.firstRowId = null; }
      else state.rows.totalCount = Math.max(0, state.rows.totalCount - before + state.rows.window.length);
    }
    else if (['row.appended', 'row.upserted'].includes(delta.op)) {
      const index = state.rows.window.findIndex(row => row.rowId === delta.row.rowId);
      if (index >= 0) state.rows.window[index] = delta.row;
      else if (delta.op === 'row.appended') { state.rows.window.push(delta.row); state.rows.totalCount++; state.rows.firstRowId ??= delta.row.rowId; }
    } else if (delta.op === 'row.delta') {
      const row = state.rows.window.find(row => row.rowId === delta.rowId);
      if (!row) return;
      if (!['text', 'inputText', 'output.text', 'summaryText'].includes(delta.path)) throw new Error('Unsupported stream path.');
      if (delta.path === 'output.text') row.output = { ...row.output, text: (row.output?.text || '') + delta.append };
      else row[delta.path] = (row[delta.path] || '') + delta.append;
    }
  }
  async command(sessionId, type, payload, commandId = randomUUID()) {
    const state = this.topics.get('conversation/' + sessionId)?.state;
    const ack = await this.request('v4/command', { workspace: this.workspace, commandId, clientId: this.owner.clientId, sessionId, type, payload, issuedAt: Date.now(), ...(state ? { baseRevision: state.revision, baseLogEpoch: state.logEpoch } : {}) }, 90000);
    if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) throw Object.assign(new Error(ack.message || ack.reasonCode || `ZCode rejected ${type}.`), { nativeStatus: ack.status, code: ack.reasonCode });
    return { ...ack, commandId };
  }
  async upload(sessionId, part) {
    let bytes, mime, fileName;
    if (part.type === 'image') {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url || '');
      if (!match || match[2].length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error('Attach a PNG, JPEG, WebP or GIF image under 20 MB.');
      mime = match[1]; bytes = Buffer.from(match[2], 'base64'); fileName = 'image.' + mime.split('/')[1];
    } else {
      if (!path.isAbsolute(part.path || '')) throw new Error('Use an absolute image path.');
      const stat = await fs.promises.stat(part.path);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MB.');
      const extension = path.extname(part.path).toLowerCase(); mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
      if (!mime) throw new Error('Unsupported image type.');
      bytes = await fs.promises.readFile(part.path); fileName = path.basename(part.path);
    }
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Image must be between 1 byte and 20 MB.');
    const uploadId = randomUUID(), connectionId = this.owner.clientId, chunkSize = 512 * 1024, totalChunks = Math.ceil(bytes.length / chunkSize);
    const params = { workspace: this.workspace, connectionId, uploadId, sessionId, fileName, mime, totalBytes: bytes.length, totalChunks, checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
    try {
      const begin = await this.request('v4/attachment/begin', params);
      let ref = begin.ref;
      if (begin.state !== 'committed') {
        for (let index = begin.nextChunkIndex || 0; index < totalChunks; index++) await this.request('v4/attachment/chunk', { connectionId, uploadId, sessionId, chunkIndex: index, dataBase64: bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64') });
        ref = (await this.request('v4/attachment/commit', { connectionId, uploadId, sessionId })).ref;
      }
      if (typeof ref !== 'string' || !ref) throw new Error('ZCode did not return an attachment reference.');
      return { ref, fileName, mime, bytes: bytes.length };
    } catch (error) { await this.request('v4/attachment/abort', { connectionId, uploadId, sessionId }, 5000).catch(() => {}); throw error; }
  }
  fail(error) {
    if (this.closed) return;
    this.close(); this.emit('failure', error);
  }
  close() {
    if (this.closed) return;
    this.closed = true; const child = this.child; this.child = null;
    if (child) { child.stdin.end(); child.kill(); }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ZCode disconnected.')); }
    this.pending.clear(); this.fragments.clear(); this.emit('closed');
  }
}

class ZCodeConnection extends EventEmitter {
  constructor(spawnProcess = spawn) {
    super(); this.spawnProcess = spawnProcess; this.runtimes = new Map(); this.targets = new Map(); this.requests = new Map(); this.sequence = 0; this.receivedSequence = 0; this.ready = false;
  }
  async connect(value) {
    const options = connectionOptions(value);
    if (options.mode !== 'local') throw new Error('ZCode currently supports local workspaces. Disable ZCode before connecting over SSH.');
    this.disconnect(); this.options = options; this.clientId = randomUUID(); this.session = {};
    const session = this.session;
    await this.runtime(options.localCwd);
    if (session !== this.session) throw new Error('ZCode connection changed.');
    this.ready = true; return { connected: true };
  }
  async runtime(cwd) {
    if (!path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Use an absolute ZCode workspace folder.');
    cwd = fs.realpathSync(cwd);
    let entry = this.runtimes.get(cwd);
    if (!entry) {
      const runtime = new WorkspaceRuntime(this, cwd);
      entry = { runtime }; this.runtimes.set(cwd, entry);
      runtime.on('failure', error => {
        if (this.runtimes.get(cwd)?.runtime !== runtime) return;
        this.runtimes.delete(cwd);
        for (const slot of runtime.topics.values()) if (slot.state?.sessionId) {
          const id = threadId(cwd, slot.state.sessionId);
          this.notify('error', { threadId: id, message: error.message });
          this.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
        }
        for (const [id, request] of this.requests) if (request.runtime === runtime) { this.requests.delete(id); this.notify('serverRequest/resolved', { requestId: id }); }
        if (![...this.runtimes.values()].some(entry => entry.runtime.started && !entry.runtime.closed)) {
          this.ready = false; this.emit('notification', { method: 'connection/closed', params: { message: error.message } });
        }
      });
      entry.loading = runtime.start().then(value => { runtime.started = true; return value; }).catch(error => { if (this.runtimes.get(cwd) === entry) this.runtimes.delete(cwd); runtime.close(); throw error; });
    }
    return entry.loading;
  }
  async target(id) {
    if (this.targets.has(id)) return this.targets.get(id);
    const match = /^z:([0-9a-f]{24}):(.+)$/.exec(id || '');
    if (!match) throw new Error('Invalid ZCode conversation identity.');
    const cwd = [...this.runtimes.keys()].find(cwd => namespace(cwd) === match[1]);
    if (cwd) return { cwd, sessionId: match[2] };
    const runtime = await this.runtime(this.options.localCwd);
    const { sessions } = await runtime.request('session/list', { sessionIds: [match[2]], limit: 10000 });
    for (const session of sessions) this.summary(runtime, session);
    if (!this.targets.has(id)) throw new Error('ZCode conversation workspace is unavailable.');
    return this.targets.get(id);
  }
  notify(method, params, id) { this.emit('notification', { method, params, ...(id !== undefined ? { id } : {}), receivedSequence: ++this.receivedSequence }); }
  summary(runtime, session) {
    let cwd = session.workspace?.workspacePath || runtime.cwd;
    try { cwd = fs.realpathSync(cwd); } catch {}
    const current = this.runtimes.get(cwd)?.runtime.topics.get('conversation/' + session.sessionId)?.state;
    this.targets.set(threadId(cwd, session.sessionId), { cwd, sessionId: session.sessionId });
    const model = session.model?.modelId ? modelId(session.model.providerId, session.model.modelId) : undefined;
    return { id: threadId(cwd, session.sessionId), name: current?.meta.title || session.title || session.meta?.title || '', preview: session.lastAssistantPreview || '', cwd, model, createdAt: Math.floor((session.createdAt || Date.now()) / 1000), updatedAt: Math.floor((session.updatedAt || session.lastActivityAt || Date.now()) / 1000), status: { type: activePhase(current?.control.phase || session.phase || session.status) ? 'active' : 'idle' }, source: 'zcode' };
  }
  thread(runtime, snapshot) {
    const summary = this.summary(runtime, { ...snapshot, title: snapshot.meta?.title, phase: snapshot.control.phase });
    return { ...summary, model: snapshot.config?.model ? modelId(snapshot.config.provider, snapshot.config.model) : undefined, reasoningEffort: snapshot.config?.thought, historyMode: 'paginated' };
  }
  turns(id, rows) {
    const turns = new Map();
    for (const row of rows) {
      const key = String(row.turnId ?? row.productTurnId ?? row.rowId);
      if (!turns.has(key)) turns.set(key, { id: turnId(id, key), status: 'completed', items: [] });
      const turn = turns.get(key);
      if (row.kind === 'turnHeader') { turn.status = turnStatus(row.state); turn.startedAtMs = row.startedAt; turn.completedAtMs = row.endedAt; }
      else { const item = mapItem(id, row); if (item) turn.items.push(item); }
    }
    return [...turns.values()];
  }
  project(runtime, state, previous) {
    const id = threadId(runtime.cwd, state.sessionId), beforeRows = new Map((previous?.rows.window || []).map(row => [row.rowId, row]));
    for (const row of state.rows.window) {
      const before = beforeRows.get(row.rowId), key = turnId(id, row.turnId ?? row.productTurnId ?? row.rowId);
      if (row.kind === 'turnHeader') {
        if ((!before || before.state !== row.state) && (previous || row.state === 'running')) this.notify(row.state === 'running' ? 'turn/started' : 'turn/completed', { threadId: id, turn: { id: key, status: turnStatus(row.state), ...(row.state === 'failed' && state.control.lastError ? { error: { message: state.control.lastError.message } } : {}) } });
        continue;
      }
      if (!previous || JSON.stringify(before) === JSON.stringify(row)) continue;
      const item = mapItem(id, row); if (!item) continue;
      if (row.kind === 'assistantText' && before && row.state === before.state && row.text.startsWith(before.text) && row.text !== before.text) this.notify('item/agentMessage/delta', { threadId: id, turnId: key, itemId: item.id, delta: row.text.slice(before.text.length) });
      else this.notify(!before ? 'item/started' : 'item/completed', { threadId: id, turnId: key, item });
    }
    if (state.meta?.title && previous?.meta?.title !== state.meta.title) this.notify('thread/name/updated', { threadId: id, threadName: state.meta.title });
    const phase = state.control.phase;
    if (previous && previous.control.phase !== phase) this.notify('thread/status/changed', { threadId: id, status: { type: activePhase(phase) ? 'active' : 'idle' } });
    const usage = state.usage?.contextWindow;
    if (usage && JSON.stringify(usage) !== JSON.stringify(previous?.usage?.contextWindow)) this.notify('thread/tokenUsage/updated', { threadId: id, tokenUsage: { modelContextWindow: usage.maxTokens, last: { totalTokens: usage.usedTokens } } });
    const pending = new Set();
    for (const interaction of state.pendingInteractions || []) {
      const requestId = id + ':interaction:' + interaction.interactionId; pending.add(requestId);
      if (this.requests.has(requestId)) continue;
      const native = interaction.payload;
      const request = { runtime, state, interaction, threadId: id }; this.requests.set(requestId, request);
      const header = state.rows.window.filter(row => row.kind === 'turnHeader').at(-1);
      const params = { threadId: id, turnId: header ? turnId(id, header.turnId ?? header.productTurnId ?? header.rowId) : null, itemId: rowId(id, { rowId: interaction.anchorRowId }) };
      if (native.kind === 'userInput') {
        if (native.schema && !native.questions?.length) {
          request.structured = true;
          this.notify('mcpServer/elicitation/request', { ...params, message: native.prompt, requestedSchema: native.schema }, requestId); continue;
        }
        request.questions = native.questions?.length ? native.questions : [{ question: native.prompt, header: 'Question', options: (native.options || []).map(option => ({ label: option.label, value: option.optionId })) }];
        this.notify('item/tool/requestUserInput', { ...params, questions: request.questions.map((question, index) => ({ id: String(index), header: question.header, question: question.question, isSecret: native.sensitive === true, options: question.options.map(option => ({ label: option.label, description: option.description || '' })) })) }, requestId);
      } else if (native.kind === 'permission') this.notify('item/commandExecution/requestApproval', { ...params, command: native.toolName, reason: native.summary, availableDecisions: ['accept', 'decline'] }, requestId);
      else this.notify('error', { threadId: id, message: `ZCode requested an unsupported interaction: ${interaction.kind}` });
    }
    for (const [requestId, request] of this.requests) if (request.threadId === id && !pending.has(requestId)) { this.requests.delete(requestId); this.notify('serverRequest/resolved', { requestId }); }
    if (JSON.stringify(state.queue) !== JSON.stringify(previous?.queue)) this.notify('provider/queue/updated', { threadId: id, queue: state.queue });
  }
  async call(method, params = {}, timeout) {
    const requestId = ++this.sequence;
    this.emit('rpc', { phase: 'started', requestId, method, threadId: params.threadId });
    let result;
    try { result = await this.operation(method, params, timeout); return result; }
    finally { this.emit('rpc', { phase: 'finished', requestId, method, threadId: params.threadId, result }); }
  }
  async operation(method, params) {
    if (!this.ready) throw new Error('Connect to ZCode first.');
    if (method === 'account/rateLimits/read') {
      const runtime = await this.runtime(this.options.localCwd);
      const modelSelection = params.model ? this.selection(params.model) : null;
      return runtime.request('remote-codex/usage', { modelSelection });
    }
    if (method === 'model/list' || method === 'collaborationMode/list') {
      const runtime = await this.runtime(this.options.localCwd), catalog = await runtime.request('remote-codex/catalog', {});
      if (method === 'collaborationMode/list') return { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan' }], nextCursor: null };
      return { data: catalog.models.map(model => ({ model: modelId(model.providerId, model.modelId), displayName: `${model.modelId} · ${model.providerName || model.providerId}`, isDefault: catalog.defaultModelSelection?.providerId === model.providerId && catalog.defaultModelSelection?.modelId === model.modelId, supportedReasoningEfforts: (model.reasoningLevels || []).map(reasoningEffort => ({ reasoningEffort })) })), nextCursor: null };
    }
    if (method === 'thread/list') {
      const runtime = await this.runtime(this.options.localCwd), result = await runtime.request('session/list', { limit: 10000 });
      const data = result.sessions.map(session => this.summary(runtime, session)).filter(thread => !params.searchTerm || (thread.name + thread.preview).toLowerCase().includes(params.searchTerm.toLowerCase()));
      const sort = params.sortKey === 'created_at' ? 'createdAt' : 'updatedAt'; data.sort((a, b) => (params.sortDirection === 'asc' ? 1 : -1) * (a[sort] - b[sort]));
      const offset = params.cursor ? Number(params.cursor) : 0, limit = params.limit || 50;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid ZCode list cursor.');
      return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? String(offset + limit) : null };
    }
    if (method === 'thread/start') {
      if (params.sandbox === 'read-only') throw new Error('ZCode does not provide a read-only filesystem sandbox. Choose Ask before changes.');
      const runtime = await this.runtime(params.cwd || this.options.localCwd), sessionId = randomUUID();
      const selection = params.model ? this.selection(params.model, params.reasoningEffort) : undefined;
      await runtime.command(null, 'createSession', { workspaceId: runtime.cwd, sessionId, config: { ...(selection ? { modelSelection: selection } : {}), mode: params.sandbox === 'danger-full-access' ? 'yolo' : 'build', followupMode: 'queue' } });
      const slot = await runtime.subscribe('conversation/' + sessionId);
      return { thread: this.thread(runtime, slot.state) };
    }
    if (method === 'fs/readDirectory') {
      const dir = params.path || params.directory || this.options.localCwd;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return { entries: entries.map(entry => ({ fileName: entry.name, isDirectory: entry.isDirectory(), path: path.join(dir, entry.name) })) };
    }
    if (method === 'fs/readFile') {
      const stat = await fs.promises.stat(params.path);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('File exceeds 20 MB.');
      return { dataBase64: (await fs.promises.readFile(params.path)).toString('base64') };
    }
    const target = await this.target(params.threadId), runtime = await this.runtime(target.cwd), slot = await runtime.subscribe('conversation/' + target.sessionId);
    if (method === 'thread/read' || method === 'thread/resume') return { thread: this.thread(runtime, slot.state), queuedMessageCount: slot.state.queue?.items?.length || 0 };
    if (method === 'thread/turns/list') {
      const result = await runtime.request('v4/conversation/rowsRange', { workspace: runtime.workspace, sessionId: target.sessionId, clientMode: 'desktop-continuous', ...(params.cursor ? { beforeRowId: Number(params.cursor) } : {}), limit: 200 });
      return { data: this.turns(params.threadId, result.rows).reverse(), nextCursor: result.hasMore && result.rows.length ? String(result.rows[0].rowId) : null, receivedSequence: this.receivedSequence };
    }
    if (method === 'thread/name/set') { await runtime.command(target.sessionId, 'renameSession', { title: params.name }); return {}; }
    if (method === 'queue/delete') { await runtime.command(target.sessionId, 'deleteQueueItem', { queueItemId: params.queueItemId }); return {}; }
    if (method === 'queue/resume') { await runtime.command(target.sessionId, 'setAutoDrain', { autoDrain: true }); return {}; }
    if (method === 'turn/interrupt') {
      const header = slot.state.rows.window.filter(row => row.kind === 'turnHeader').at(-1);
      if (params.turnId && header && turnId(params.threadId, header.turnId ?? header.productTurnId ?? header.rowId) !== params.turnId) throw new Error('This ZCode turn already finished.');
      const executionId = slot.state.control.activeWorks?.find(work => work.foregroundExecutionId)?.foregroundExecutionId;
      await runtime.command(target.sessionId, 'stop', executionId ? { expectedForegroundExecutionId: executionId } : {}); return {};
    }
    if (['turn/start', 'turn/steer', 'thread/edit'].includes(method)) {
      const editing = method === 'thread/edit';
      const unconfirmedEdit = error => Object.assign(new Error(`Edit may have been submitted; check conversation history before retrying. ${error.message || error}`), { uncertain: true });
      const requireIdle = () => {
        if (activePhase(slot.state.control.phase) || slot.state.control.activeWorks?.length || slot.state.pendingInteractions?.length || slot.state.pendingCommands?.length) throw new Error('Wait for the running task before editing messages.');
        if (slot.state.queue?.items?.length) throw new Error('Send or remove native queued messages before editing.');
      };
      let editRow;
      if (editing) {
        requireIdle();
        const prefix = 'r:' + namespace(params.threadId) + ':';
        const number = typeof params.itemId === 'string' && params.itemId.startsWith(prefix) ? params.itemId.slice(prefix.length) : '';
        const targetRowId = /^\d+$/.test(number) ? Number(number) : NaN;
        if (!Number.isSafeInteger(targetRowId) || targetRowId < 0 || targetRowId >= Number.MAX_SAFE_INTEGER) throw new Error('Reopen the message editor before editing this ZCode message.');
        editRow = slot.state.rows.window.find(row => row.rowId === targetRowId);
        if (!editRow) {
          const page = await runtime.request('v4/conversation/rowsRange', { workspace: runtime.workspace, sessionId: target.sessionId, clientMode: 'desktop-continuous', beforeRowId: targetRowId + 1, limit: 1 });
          editRow = page.rows.find(row => row.rowId === targetRowId);
        }
        if (editRow?.kind !== 'userInput' || editRow.origin !== 'realUser' || editRow.actions?.canEdit !== true || !editRow.entityId || turnId(params.threadId, editRow.turnId ?? editRow.productTurnId ?? editRow.rowId) !== params.beforeTurnId) throw new Error('ZCode can only edit its latest user message. Reload the conversation and reopen the editor.');
      }
      if (params.sandboxPolicy?.type === 'readOnly') throw new Error('ZCode does not provide a read-only filesystem sandbox. Choose Ask before changes.');
      if (method === 'turn/steer' && params.expectedTurnId) {
        const header = slot.state.rows.window.filter(row => row.kind === 'turnHeader').at(-1);
        if (!header || header.state !== 'running' || turnId(params.threadId, header.turnId ?? header.productTurnId ?? header.rowId) !== params.expectedTurnId) throw new Error('This ZCode turn already finished.');
      }
      const unsupported = (params.input || []).filter(part => !['text', 'image', 'localImage'].includes(part.type));
      if (unsupported.length) throw new Error('ZCode cannot execute Codex skill references. Select a ZCode-native skill or send its instructions as text.');
      const text = (params.input || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const attachments = [];
      for (const part of (params.input || []).filter(part => ['image', 'localImage'].includes(part.type))) attachments.push(await runtime.upload(target.sessionId, part));
      const model = params.collaborationMode?.settings?.model || params.model;
      const selection = model ? this.selection(model, params.collaborationMode?.settings?.reasoning_effort || params.effort) : undefined;
      if (editing) requireIdle();
      let ack;
      try {
        ack = await runtime.command(target.sessionId, editing ? 'editUserQuery' : 'sendText', { ...(editing ? { target: { rowId: editRow.rowId, entityId: editRow.entityId }, newText: text, workspaceMode: 'preserve' } : { text }), ...(attachments.length ? { attachments } : {}), ...(selection ? { modelSelection: selection } : {}), planEnabled: params.collaborationMode?.mode === 'plan', mode: params.sandboxPolicy?.type === 'dangerFullAccess' ? 'yolo' : 'build', ...(method === 'turn/steer' ? { requestedDelivery: 'guide' } : {}) });
      } catch (error) {
        if (editing && !['rejected', 'stale'].includes(error.nativeStatus)) throw unconfirmedEdit(error);
        throw error;
      }
      if (editing) {
        if (ack.result?.disposition === 'blocked') throw new Error(ack.result.reasonCode || 'ZCode blocked this edit.');
        if (ack.result?.type !== 'editUserQuery' || ack.result.disposition !== 'rewind' || ack.result.sessionId !== target.sessionId) throw unconfirmedEdit(new Error('ZCode did not confirm an edit in this conversation.'));
      }
      if (method === 'turn/steer') return {};
      if (ack.result?.delivery === 'queue' || ack.result?.delivery === 'guide') return { ...(editing ? { thread: this.thread(runtime, slot.state) } : {}), turn: { id: ack.commandId, status: 'queued' } };
      const queuedEdit = () => editing && slot.state.queue?.items?.some(item => item.sourceCommandId === ack.commandId);
      try { await runtime.wait(() => slot.state.rows.window.some(row => row.sourceCommandId === ack.commandId) || queuedEdit()); }
      catch (error) { if (editing) throw unconfirmedEdit(error); throw error; }
      if (queuedEdit()) return { thread: this.thread(runtime, slot.state), turn: { id: ack.commandId, status: 'queued' } };
      const row = slot.state.rows.window.find(row => row.sourceCommandId === ack.commandId);
      const key = row.turnId ?? row.productTurnId ?? row.rowId;
      const header = slot.state.rows.window.find(row => row.kind === 'turnHeader' && String(row.turnId ?? row.productTurnId ?? row.rowId) === String(key));
      return { ...(editing ? { thread: this.thread(runtime, slot.state) } : {}), turn: { id: turnId(params.threadId, key), status: header ? turnStatus(header.state) : 'inProgress', ...(editing && header?.state === 'failed' && slot.state.control.lastError ? { error: { message: slot.state.control.lastError.message } } : {}) } };
    }
    throw new Error(`ZCode does not support ${method}.`);
  }
  selection(model, effort) {
    const selection = decode(model, 'm:');
    if (!Array.isArray(selection) || selection.length !== 2 || selection.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid ZCode model selection.');
    const metadata = [...this.runtimes.values()].flatMap(entry => entry.runtime.catalog?.models || []).find(model => model.providerId === selection[0] && model.modelId === selection[1]);
    const level = effort || metadata?.defaultReasoningLevel;
    if (effort && metadata?.reasoningLevels && !metadata.reasoningLevels.includes(effort)) throw new Error('This ZCode model does not support the selected reasoning level.');
    return { providerId: selection[0], modelId: selection[1], ...(level ? { options: { reasoningLevel: level } } : {}) };
  }
  async respond(id, result) {
    const request = this.requests.get(id);
    if (!request) throw new Error('This ZCode request is no longer pending.');
    let answer;
    if (request.interaction.kind === 'userInput') {
      if (request.structured) {
        if (!['accept', 'decline', 'cancel'].includes(result.action)) throw new Error('Invalid ZCode interaction response.');
        await request.runtime.command(request.state.sessionId, 'resolveInteraction', { interactionId: request.interaction.interactionId, answer: { action: result.action, ...(result.content ? { content: result.content } : {}) } }); return;
      }
      const answers = {};
      for (const [index, question] of request.questions.entries()) {
        const values = result.answers?.[String(index)]?.answers || [];
        const mapped = values.map(value => question.options.find(option => option.label === value)?.value ?? value);
        answers[question.question] = question.multiSelect ? mapped : mapped.join('\n');
      }
      answer = { action: 'accept', content: { answers } };
    } else {
      const kind = result.decision === 'accept' ? 'allowOnce' : 'deny';
      const option = request.interaction.payload.options.find(option => option.kind === kind);
      if (!option) throw new Error('ZCode did not offer this permission decision.');
      answer = { optionId: option.optionId };
    }
    await request.runtime.command(request.state.sessionId, 'resolveInteraction', { interactionId: request.interaction.interactionId, answer });
  }
  async rejectRequest(id) {
    const request = this.requests.get(id);
    if (!request) throw new Error('This ZCode request is no longer pending.');
    if (request.interaction.kind === 'permission') return this.respond(id, { decision: 'decline' });
    await request.runtime.command(request.state.sessionId, 'resolveInteraction', { interactionId: request.interaction.interactionId, answer: { action: 'decline' } });
  }
  disconnect() {
    this.ready = false; this.session = null;
    for (const entry of this.runtimes.values()) entry.runtime.close();
    this.runtimes.clear(); this.targets.clear(); this.requests.clear(); this.emit('disconnected');
  }
}

module.exports = { ZCodeConnection, connectionOptions, zcodeMethods, localLaunch, threadId, modelId };
