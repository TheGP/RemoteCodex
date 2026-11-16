const { EventEmitter } = require('node:events');
const { CodexConnection, connectionOptions: codexOptions } = require('./transport.cjs');
const { ZCodeConnection, connectionOptions: zcodeOptions, zcodeMethods } = require('./zcode.cjs');

const rendererMethods = Object.freeze(['thread/list', 'thread/read', 'thread/resume', 'thread/start', 'thread/fork', 'thread/revert', 'thread/archive', 'thread/turns/list', 'thread/items/list', 'thread/items/read', 'thread/name/set', 'thread/settings/update', 'thread/metadata/update', 'project/list', 'project/create', 'project/update', 'project/move', 'turn/start', 'turn/steer', 'turn/interrupt', 'model/list', 'account/read', 'account/rateLimits/read', 'fs/readDirectory', 'skills/list', 'collaborationMode/list', 'thread/compact/start', 'review/start', 'mcpServerStatus/list', 'queue/delete', 'queue/resume']);
const providers = Object.freeze({
  codex: {
    id: 'codex', name: 'Codex', methods: [...rendererMethods.filter(method => !method.startsWith('queue/')), 'fs/readFile', 'thread/unsubscribe', 'experimentalFeature/list', 'thread/goal/get'],
    options(value) {
      const { codexPath, ...options } = codexOptions({ ...value, codexPath: value.executablePath ?? value.codexPath });
      return { ...options, executablePath: codexPath };
    },
    create: () => new CodexConnection()
  },
  zcode: {
    id: 'zcode', name: 'ZCode', methods: zcodeMethods, defaultEnabled: false,
    permissionOptions: [{ value: 'workspace-write', label: 'Ask before changes' }, { value: 'danger-full-access', label: 'Full access' }],
    options: zcodeOptions,
    create: () => new ZCodeConnection()
  }
});

function providerSettings(registry = providers) {
  return Object.values(registry).map(provider => ({ id: provider.id, name: provider.name, methods: provider.methods.filter(method => rendererMethods.includes(method)), available: true, defaultEnabled: provider.defaultEnabled ?? true, ...(provider.permissionOptions ? { permissionOptions: provider.permissionOptions.map(option => ({ ...option })) } : {}) }));
}

function providerFor(id, registry) {
  if (typeof id !== 'string' || !Object.hasOwn(registry, id)) throw new Error(`Unsupported coding agent: ${String(id)}.`);
  return registry[id];
}

function connectionOptions(value = {}, registry = providers) {
  const provider = providerFor(value.provider ?? 'codex', registry);
  return { ...provider.options(value), provider: provider.id };
}

function connectionKey(options) {
  const provider = options.provider ?? 'codex';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new Error('Invalid coding agent ID.');
  const machine = options.mode === 'local' ? 'local' : `${options.host}:${options.port}`;
  return `access:${provider === 'codex' ? '' : 'provider=' + provider + ':'}${machine}`;
}

class AgentConnection extends EventEmitter {
  constructor(registry = providers) {
    super();
    this.registry = registry;
    this.adapter = null;
    this.provider = null;
    this.session = null;
    this.generation = 0;
    this.requests = new Map();
    this.requestIds = new Map();
    this.forwarders = [];
  }

  get ready() { return Boolean(this.adapter?.ready); }
  describe(id = this.provider?.id || 'codex') {
    const { name, methods, permissionOptions } = providerFor(id, this.registry);
    return { id, name, methods: methods.filter(method => rendererMethods.includes(method)), ...(permissionOptions ? { permissionOptions: permissionOptions.map(option => ({ ...option })) } : {}) };
  }
  listProviders() { return Object.keys(this.registry).map(id => this.describe(id)); }
  supports(method) { return Boolean(this.provider?.methods.includes(method)); }

  async connect(value) {
    const options = connectionOptions(value, this.registry);
    const provider = providerFor(options.provider, this.registry);
    const adapter = provider.create();
    this.disconnect();
    const session = { generation: ++this.generation };
    this.adapter = adapter; this.provider = provider; this.session = session;
    const current = () => this.adapter === adapter && this.session === session;
    const requestKey = id => JSON.stringify([session.generation, id]);
    for (const event of ['notification', 'diagnostic', 'rpc', 'disconnected']) {
      const listener = value => {
        if (!current()) return;
        if (event === 'disconnected') { this.requests.clear(); this.requestIds.clear(); }
        if (event === 'notification') {
          value = { ...value, machine: connectionKey(options) };
          if (value.id !== undefined) {
            const id = requestKey(value.id);
            this.requestIds.set(id, value.id);
            value = { ...value, id }; this.requests.set(id, value);
          }
          if (value.method === 'serverRequest/resolved') {
            const requestId = requestKey(value.params.requestId);
            this.requests.delete(requestId); this.requestIds.delete(requestId);
            value = { ...value, params: { ...value.params, requestId } };
          }
        }
        this.emit(event, value);
      };
      adapter.on(event, listener); this.forwarders.push([event, listener]);
    }
    try {
      const result = await adapter.connect(options);
      if (!current() || !this.ready) throw new Error('The agent connection changed.');
      return result;
    } catch (error) {
      if (current()) this.disconnect();
      throw error;
    }
  }

  async call(method, params, timeout) {
    if (!this.ready) throw new Error('Connect to a coding agent first.');
    if (!this.supports(method)) throw new Error(`${this.provider.name} does not support ${method}.`);
    const adapter = this.adapter, session = this.session;
    const result = await adapter.call(method, params, timeout);
    if (!this.ready || this.adapter !== adapter || this.session !== session) throw new Error('The agent connection changed.');
    return result;
  }

  async answer(id, result, reject = false) {
    if (!this.requestIds.has(id)) throw new Error('This request is no longer pending.');
    const adapter = this.adapter, session = this.session;
    const nativeId = this.requestIds.get(id);
    await (reject ? adapter.rejectRequest(nativeId) : adapter.respond(nativeId, result));
    if (this.adapter === adapter && this.session === session) { this.requests.delete(id); this.requestIds.delete(id); }
  }
  respond(id, result) { return this.answer(id, result); }
  rejectRequest(id) { return this.answer(id, undefined, true); }

  disconnect() {
    const adapter = this.adapter;
    this.adapter = null; this.provider = null; this.session = null;
    for (const [event, listener] of this.forwarders) adapter.removeListener(event, listener);
    this.forwarders = []; this.requests.clear(); this.requestIds.clear();
    try { adapter?.disconnect(); } finally { this.emit('disconnected'); }
  }
}

module.exports = { AgentConnection, connectionOptions, connectionKey, rendererMethods, providerSettings };
