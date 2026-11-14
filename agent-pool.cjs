const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { AgentConnection, connectionOptions, connectionKey, providerSettings } = require('./providers.cjs');

function poolOptions(value = {}, registry) {
  connectionOptions(value, registry);
  const options = connectionOptions({ ...value, provider: 'codex' }, registry);
  if (value.providerOptions !== undefined) {
    if (!value.providerOptions || typeof value.providerOptions !== 'object' || Array.isArray(value.providerOptions)) throw new Error('Invalid agent settings.');
    const descriptors = providerSettings(registry);
    options.providerOptions = Object.fromEntries(Object.entries(value.providerOptions).map(([provider, patch]) => {
      const descriptor = descriptors.find(entry => entry.id === provider);
      if (!descriptor) throw new Error(`Unsupported coding agent: ${provider}.`);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('Invalid agent settings.');
      const enabled = patch.enabled ?? descriptor.defaultEnabled;
      const executablePath = patch.executablePath ?? (provider === 'codex' ? options.executablePath : '') ?? '';
      if (typeof executablePath !== 'string' || executablePath.includes('\0') || options.mode === 'local' && executablePath.trim() && !path.isAbsolute(executablePath.trim())) throw new Error('Use an absolute path to the agent executable.');
      const normalized = descriptor.available ? connectionOptions({ ...options, executablePath, provider }, registry) : { executablePath: executablePath.trim() };
      return [provider, { enabled, executablePath: normalized.executablePath || '' }];
    }));
  }
  return options;
}

function agentId(provider, kind, value) {
  return value === undefined || value === null || kind === 'project' && value === '' || provider === 'codex' ? value : `agent:${provider}:${kind}:${encodeURIComponent(String(value))}`;
}
function agentTarget(value, kind) {
  if (typeof value !== 'string' || !value.startsWith('agent:')) return { provider: 'codex', value };
  const match = value.match(/^agent:([a-z][a-z0-9-]*):([^:]+):(.*)$/);
  if (!match || match[2] !== kind) throw new Error(`Invalid ${kind} identity.`);
  return { provider: match[1], value: decodeURIComponent(match[3]) };
}

class AgentPool extends EventEmitter {
  constructor(registry) {
    super();
    this.registry = registry;
    this.catalog = new AgentConnection(registry);
    this.connections = new Map(); this.errors = new Map();
    this.connecting = new Set(); this.pages = new Map();
    this.launchOptions = []; this.recovering = null; this.attempts = new Map(); this.configuration = null;
    this.session = null; this.generation = 0; this.machine = null;
  }
  get ready() { return [...this.connections.values()].some(connection => connection.ready); }
  describe(id = 'codex', options = this.configuration) {
    const descriptor = providerSettings(this.registry).find(provider => provider.id === id);
    if (!descriptor) throw new Error(`Unsupported coding agent: ${id}.`);
    const enabled = options?.providerOptions?.[id]?.enabled ?? descriptor.defaultEnabled;
    return { ...descriptor, enabled, connected: Boolean(this.connections.get(id)?.ready), defaultModel: agentId(id, 'model', ''), error: enabled && descriptor.available ? this.errors.get(id) || null : null };
  }
  listProviders(options = this.configuration) { return providerSettings(this.registry).map(provider => this.describe(provider.id, options)); }
  launchSettings(options) {
    return this.listProviders(options).filter(provider => provider.available && provider.enabled).map(({ id }) => connectionOptions({ ...options, ...(id === 'codex' ? {} : { executablePath: '' }), ...options.providerOptions?.[id], provider: id }, this.registry));
  }
  changes(value) {
    const next = poolOptions(value, this.registry);
    const machineChanged = !this.configuration || ['mode', 'host', 'port', 'key', 'cwd', 'localCwd'].some(key => next[key] !== this.configuration[key]);
    const launch = this.launchSettings(next);
    const providers = this.listProviders(next).filter(provider => {
      const before = this.describe(provider.id);
      const executable = options => options?.providerOptions?.[provider.id]?.executablePath ?? (provider.id === 'codex' ? options?.executablePath : '') ?? '';
      return provider.enabled !== before.enabled || executable(next) !== executable(this.configuration) || JSON.stringify(launch.find(option => option.provider === provider.id)) !== JSON.stringify(this.launchOptions.find(option => option.provider === provider.id));
    }).map(provider => provider.id);
    return { machineChanged, providers };
  }
  providerFor(params = {}, context = {}) {
    const identities = [['threadId', 'thread'], ['model', 'model'], ['projectId', 'project']].filter(([key]) => params[key]).map(([key, kind]) => agentTarget(params[key], kind).provider);
    for (const provider of [params.provider, context.provider]) if (provider) identities.push(provider);
    const provider = identities[0] || 'codex';
    this.catalog.describe(provider);
    if (identities.some(id => id !== provider)) throw new Error('This conversation belongs to another coding agent.');
    return provider;
  }
  connectionFor(provider) {
    this.catalog.describe(provider);
    const connection = this.connections.get(provider);
    if (!connection?.ready) throw new Error(`${this.catalog.describe(provider).name} is not connected.`);
    return connection;
  }
  supports(method, provider = 'codex') { return this.catalog.describe(provider).methods.includes(method); }

  item(provider, item) { return item ? { ...item, id: agentId(provider, 'item', item.id) } : item; }
  turn(provider, turn) { return turn ? { ...turn, id: agentId(provider, 'turn', turn.id), ...(turn.items ? { items: turn.items.map(item => this.item(provider, item)) } : {}) } : turn; }
  thread(provider, thread) {
    if (!thread) return thread;
    return { ...thread, provider, id: agentId(provider, 'thread', thread.id), projectId: agentId(provider, 'project', thread.projectId), ...(thread.model ? { model: agentId(provider, 'model', thread.model) } : {}), ...(thread.turns ? { turns: thread.turns.map(turn => this.turn(provider, turn)) } : {}) };
  }
  project(provider, project) { return project ? { ...project, provider, id: agentId(provider, 'project', project.id) } : project; }
  result(provider, method, result) {
    if (!result) return result;
    const mapped = { ...result };
    if (result.thread) mapped.thread = this.thread(provider, result.thread);
    if (result.turn) mapped.turn = this.turn(provider, result.turn);
    if (result.project) mapped.project = this.project(provider, result.project);
    if (result.reviewThreadId) mapped.reviewThreadId = agentId(provider, 'thread', result.reviewThreadId);
    if (Array.isArray(result.data)) mapped.data = result.data.map(value => {
      if (method === 'thread/list') return this.thread(provider, value);
      if (method === 'project/list') return this.project(provider, value);
      if (method === 'thread/turns/list') return this.turn(provider, value);
      if (method === 'thread/items/list') return this.item(provider, value);
      if (method === 'model/list') return { ...value, provider, providerName: this.catalog.describe(provider).name, nativeModel: value.model, model: agentId(provider, 'model', value.model) };
      if (method === 'collaborationMode/list') return { ...value, provider, ...(value.model ? { model: agentId(provider, 'model', value.model) } : {}) };
      return value;
    });
    return mapped;
  }
  notification(provider, message) {
    const params = { ...message.params };
    for (const [key, kind] of [['threadId', 'thread'], ['turnId', 'turn'], ['itemId', 'item'], ['projectId', 'project']]) if (params[key] !== undefined) params[key] = agentId(provider, kind, params[key]);
    if (params.thread) params.thread = this.thread(provider, params.thread);
    if (params.turn) params.turn = this.turn(provider, params.turn);
    if (params.item) params.item = this.item(provider, params.item);
    if (params.requestId !== undefined) params.requestId = agentId(provider, 'request', params.requestId);
    let method = message.method;
    if (method === 'connection/closed') this.errors.set(provider, params.message || 'Connection closed.');
    if (method === 'connection/closed' && [...this.connections].some(([id, connection]) => id !== provider && connection.ready)) { method = 'provider/closed'; params.provider = provider; }
    return { ...message, method, params, provider, machine: this.machine, ...(message.id !== undefined ? { id: agentId(provider, 'request', message.id) } : {}) };
  }

  async connect(value) {
    const primary = poolOptions(value, this.registry);
    const options = this.launchSettings(primary);
    this.disconnect(); this.errors.clear(); this.session = { generation: ++this.generation }; this.machine = connectionKey({ ...primary, provider: 'codex' });
    this.launchOptions = options; this.configuration = primary;
    const session = this.session;
    const results = await this.startConnections(options, session);
    if (this.session !== session) throw new Error('The agent connections changed.');
    if (!this.ready && options.length) throw new Error(results.find(result => result.status === 'rejected')?.reason?.message || 'No coding agent connected.');
    return { connected: this.ready };
  }
  async reconfigure(value) {
    const next = poolOptions(value, this.registry), changes = this.changes(next);
    if (!this.session || changes.machineChanged) throw new Error('Changing the machine requires a new connection.');
    const session = this.session;
    const options = this.launchSettings(next).map(option => {
      const before = this.launchOptions.find(entry => entry.provider === option.provider);
      return JSON.stringify(before) === JSON.stringify(option) ? before : option;
    });
    this.launchOptions = options; this.configuration = next; this.recovering = null; this.pages.clear();
    for (const id of changes.providers) {
      const connection = this.connections.get(id), wasReady = connection?.ready;
      this.connecting.delete(id); this.attempts.delete(id); this.errors.delete(id);
      connection?.disconnect();
      if (wasReady) this.emit('notification', { method: 'provider/closed', provider: id, machine: this.machine, params: { provider: id, reconfigured: true, disabled: !this.describe(id).enabled, message: `${this.describe(id).name} settings changed.` } });
    }
    await this.startConnections(options.filter(option => changes.providers.includes(option.provider)), session);
    if (this.session !== session) throw new Error('The agent connections changed.');
    const reconnected = changes.providers.filter(id => this.connections.get(id)?.ready);
    this.emit('notification', { method: 'providers/updated', params: { agents: this.listProviders(), reconnected, reconfigured: changes.providers }, machine: this.machine });
    return { reused: true, connected: this.ready, reconnected };
  }
  async startConnections(options, session) {
    const results = await Promise.allSettled(options.map(async option => {
      const id = option.provider;
      let connection = this.connections.get(id);
      if (!connection) {
        connection = new AgentConnection(this.registry); this.connections.set(id, connection);
        connection.on('notification', message => { if (message.method !== 'connection/closed' || !this.connecting.has(id)) this.emit('notification', this.notification(id, message)); });
        connection.on('diagnostic', entry => this.emit('diagnostic', { ...entry, details: { ...entry.details, provider: id } }));
        this.emit('connection', { provider: id, connection });
      }
      this.connecting.add(id); this.attempts.set(id, option);
      const current = () => this.session === session && this.launchOptions.includes(option);
      try { await connection.connect(option); if (current()) this.errors.delete(id); }
      catch (error) { if (current()) this.errors.set(id, error.message); throw error; }
      finally { if (this.attempts.get(id) === option) { this.connecting.delete(id); this.attempts.delete(id); } }
    }));
    return results;
  }
  recover() {
    if (this.recovering) return this.recovering;
    const session = this.session;
    if (!session) return Promise.reject(new Error('Connect to a coding agent first.'));
    const options = this.launchOptions.filter(option => !this.connections.get(option.provider)?.ready && !this.connecting.has(option.provider));
    if (!options.length) return Promise.resolve({ reused: true, reconnected: [] });
    const before = JSON.stringify(this.listProviders());
    const pending = (async () => {
      const results = await this.startConnections(options, session);
      if (this.session !== session) throw new Error('The agent connections changed.');
      const reconnected = options.filter(option => this.launchOptions.includes(option) && this.connections.get(option.provider)?.ready).map(option => option.provider);
      const agents = this.listProviders();
      if (before !== JSON.stringify(agents)) this.emit('notification', { method: 'providers/updated', params: { agents, reconnected }, machine: this.machine });
      if (!this.ready && options.some(option => this.launchOptions.includes(option))) throw new Error(results.find(result => result.status === 'rejected')?.reason?.message || 'No coding agent connected.');
      return { reused: true, reconnected };
    })().finally(() => { if (this.recovering === pending) this.recovering = null; });
    this.recovering = pending;
    return pending;
  }
  failure(provider, method, error) {
    this.emit('diagnostic', { event: 'provider.list.failed', details: { provider, method, error: error.message } });
    return { provider, message: error.message };
  }

  nativeParams(provider, params) {
    const native = { ...params };
    for (const [key, kind] of [['threadId', 'thread'], ['turnId', 'turn'], ['beforeTurnId', 'turn'], ['expectedTurnId', 'turn'], ['itemId', 'item'], ['projectId', 'project'], ['beforeProjectId', 'project'], ['model', 'model']]) {
      if (native[key] === undefined || native[key] === null || native[key] === '') continue;
      const target = agentTarget(native[key], kind);
      if (target.provider !== provider) throw new Error('This conversation belongs to another coding agent.');
      native[key] = target.value;
      if (key === 'model' && !target.value) delete native.model;
    }
    if (native.collaborationMode?.settings?.model) {
      const target = agentTarget(native.collaborationMode.settings.model, 'model');
      if (target.provider !== provider) throw new Error('This mode belongs to another coding agent.');
      native.collaborationMode = { ...native.collaborationMode, settings: { ...native.collaborationMode.settings, model: target.value } };
    }
    return native;
  }
  async call(method, params = {}, timeout, context = {}) {
    const session = this.session;
    if (['thread/list', 'project/list'].includes(method) && !params.provider && !context.provider && (params.projectId === undefined || params.projectId === null)) return this.list(method, params, timeout);
    if (['model/list', 'collaborationMode/list'].includes(method) && !params.provider && !context.provider) {
      const entries = [...this.connections].filter(([, connection]) => connection.ready && connection.supports(method));
      if (!this.ready) throw new Error('Connect to a coding agent first.');
      const results = await Promise.allSettled(entries.map(async ([id, connection]) => this.result(id, method, await connection.call(method, params, timeout))));
      if (this.session !== session) throw new Error('The agent connections changed.');
      const errors = results.flatMap((result, index) => result.status === 'rejected' ? [this.failure(entries[index][0], method, result.reason)] : []);
      if (results.length && errors.length === results.length) throw results[0].reason;
      return { data: results.flatMap(result => result.status === 'fulfilled' ? result.value.data || [] : []), nextCursor: null, ...(errors.length ? { errors } : {}) };
    }
    const provider = this.providerFor(params, context), connection = this.connectionFor(provider);
    const native = this.nativeParams(provider, params); delete native.provider;
    return this.result(provider, method, await connection.call(method, native, timeout));
  }
  async list(method, params, timeout) {
    const entries = [...this.connections].filter(([, connection]) => connection.ready && connection.supports(method));
    if (!this.ready) throw new Error('Connect to a coding agent first.');
    if (entries.length === 1 && !String(params.cursor || '').startsWith('agents:')) {
      const [id, connection] = entries[0];
      return this.result(id, method, await connection.call(method, params, timeout));
    }
    const signature = JSON.stringify([method, { ...params, cursor: undefined }, entries.map(([id]) => id)]);
    let previous = params.cursor ? this.pages.get(params.cursor) : null;
    if (params.cursor && (!previous || previous.signature !== signature)) throw new Error('Conversation list expired. Refresh the list.');
    const state = previous ? { ...previous, buffers: new Map([...previous.buffers].map(([id, values]) => [id, [...values]])), cursors: new Map(previous.cursors), ended: new Set(previous.ended), failures: new Map(previous.failures) } : { signature, buffers: new Map(), cursors: new Map(), ended: new Set(), failures: new Map(), session: this.session };
    const limit = params.limit || 50, data = [];
    while (data.length < limit) {
      const results = await Promise.allSettled(entries.map(async ([id, connection]) => {
        if (state.buffers.get(id)?.length || state.ended.has(id)) return;
        const seen = new Set();
        do {
          const cursor = state.cursors.get(id) || null;
          if (seen.has(cursor)) throw new Error('The agent repeated a list cursor.');
          seen.add(cursor);
          const result = this.result(id, method, await connection.call(method, { ...params, cursor }, timeout));
          state.buffers.set(id, result.data || []); state.cursors.set(id, result.nextCursor);
          if (!result.nextCursor) state.ended.add(id);
        } while (!state.buffers.get(id).length && !state.ended.has(id));
      }));
      if (this.session !== state.session) throw new Error('The agent connections changed.');
      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        const id = entries[index][0];
        state.failures.set(id, this.failure(id, method, result.reason)); state.ended.add(id);
      });
      if (entries.length && state.failures.size === entries.length && !data.length) throw results.find(result => result.status === 'rejected').reason;
      const available = entries.filter(([id]) => state.buffers.get(id)?.length);
      if (!available.length) break;
      const sortKey = ({ updated_at: 'updatedAt', created_at: 'createdAt' })[params.sortKey] || params.sortKey || (method === 'project/list' ? 'position' : 'updatedAt');
      const direction = params.sortDirection === 'asc' || !params.sortDirection && sortKey === 'position' ? 1 : -1;
      available.sort(([a], [b]) => direction * ((state.buffers.get(a)[0][sortKey] || 0) - (state.buffers.get(b)[0][sortKey] || 0)));
      data.push(state.buffers.get(available[0][0]).shift());
    }
    let nextCursor = null;
    if (entries.some(([id]) => state.buffers.get(id)?.length || !state.ended.has(id))) {
      nextCursor = 'agents:' + randomUUID(); this.pages.set(nextCursor, state);
      while (this.pages.size > 256) this.pages.delete(this.pages.keys().next().value);
    }
    return { data, nextCursor, ...(state.failures.size ? { errors: [...state.failures.values()] } : {}) };
  }
  async respond(id, result) { const target = agentTarget(id, 'request'); return this.connectionFor(target.provider).respond(target.value, result); }
  async rejectRequest(id) { const target = agentTarget(id, 'request'); return this.connectionFor(target.provider).rejectRequest(target.value); }
  disconnect() {
    this.session = null; this.pages.clear(); this.connecting.clear(); this.attempts.clear(); this.launchOptions = []; this.recovering = null; this.configuration = null;
    for (const connection of this.connections.values()) connection.disconnect();
    this.emit('disconnected');
  }
}

module.exports = { AgentPool, agentId, agentTarget, poolOptions };
