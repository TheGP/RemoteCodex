const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AgentConnection, connectionOptions, connectionKey, rendererMethods, providerSettings } = require('../providers.cjs');
const { CodexConnection } = require('../transport.cjs');
const { AgentWakeLock } = require('../wake-lock.cjs');

function fixture() {
  const adapters = [];
  const registry = Object.fromEntries(['codex', 'sample'].map(id => [id, {
    id, name: id === 'codex' ? 'Codex' : 'Sample Agent', methods: ['thread/read', 'turn/start'],
    options: value => ({ mode: value.mode || 'local' }),
    create() {
      const adapter = new EventEmitter();
      Object.assign(adapter, {
        ready: false, calls: [], answers: [], declined: [], disconnects: 0,
        connect: async () => { adapter.ready = true; return { connected: true }; },
        call: async (...args) => { adapter.calls.push(args); return { thread: { id: 'same-chat' } }; },
        respond: async (id, result) => { adapter.answers.push({ id, result }); },
        rejectRequest: async id => { adapter.declined.push(id); },
        disconnect: () => { adapter.ready = false; adapter.disconnects++; adapter.emit('disconnected'); }
      });
      adapters.push(adapter); return adapter;
    }
  }]));
  const connection = new AgentConnection(registry);
  return { adapters, registry, connection };
}

test('Codex and ZCode expose their supported capabilities without launch internals', () => {
  const connection = new AgentConnection();
  const [provider, zcode] = connection.listProviders();
  assert.equal(connection.listProviders().length, 2);
  assert.deepEqual(Object.keys(provider).sort(), ['id', 'methods', 'name']);
  assert.equal(provider.id, 'codex'); assert.equal(provider.name, 'Codex');
  assert.ok(provider.methods.includes('thread/revert'));
  assert.ok(!provider.methods.includes('fs/readFile') && !rendererMethods.includes('initialize'));
  assert.ok(!provider.methods.includes('queue/delete') && !provider.methods.includes('queue/resume'));
  assert.equal(zcode.id, 'zcode'); assert.equal(zcode.name, 'ZCode');
  assert.ok(zcode.methods.includes('turn/start') && zcode.methods.includes('thread/read'));
  assert.ok(!zcode.methods.includes('thread/revert') && !zcode.methods.includes('fs/readFile'));
  provider.methods.length = 0;
  assert.ok(connection.describe().methods.length > 0);
});

test('settings register ZCode but keep it disabled by default', () => {
  const catalog = providerSettings();
  assert.deepEqual(catalog.map(({ id, available, defaultEnabled }) => ({ id, available, defaultEnabled })), [
    { id: 'codex', available: true, defaultEnabled: true },
    { id: 'zcode', available: true, defaultEnabled: false }
  ]);
  assert.ok(catalog[1].methods.includes('model/list'));
  assert.deepEqual(catalog[1].permissionOptions, [{ value: 'workspace-write', label: 'Ask before changes' }, { value: 'danger-full-access', label: 'Full access' }]);
  const metadata = new AgentConnection().describe('zcode');
  assert.deepEqual(metadata.permissionOptions, catalog[1].permissionOptions);
  metadata.permissionOptions[0].label = 'Changed';
  assert.equal(new AgentConnection().describe('zcode').permissionOptions[0].label, 'Ask before changes');
  assert.deepEqual(new AgentConnection().listProviders().map(agent => agent.id), ['codex', 'zcode']);
});

test('old connection files default to Codex and migrate the executable path without changing machines', () => {
  const local = connectionOptions({ mode: 'local', codexPath: process.execPath });
  assert.equal(local.provider, 'codex'); assert.equal(local.executablePath, process.execPath);
  assert.equal(local.codexPath, undefined);
  assert.deepEqual(connectionOptions(local), local);
  assert.equal(connectionOptions({ host: 'root@warmer' }).mode, 'ssh');
  for (const provider of ['claude', '__proto__', '../transport.cjs', '']) {
    assert.throws(() => connectionOptions({ provider }), /Unsupported coding agent/);
  }
});

test('connection identities preserve Codex data and isolate other providers on local and SSH machines', () => {
  assert.equal(connectionKey({ mode: 'local' }), 'access:local');
  assert.equal(connectionKey({ provider: 'codex', mode: 'local' }), 'access:local');
  assert.equal(connectionKey({ mode: 'ssh', host: 'root@host', port: 22 }), 'access:root@host:22');
  assert.equal(connectionKey({ provider: 'sample', mode: 'local' }), 'access:provider=sample:local');
  assert.notEqual(connectionKey({ provider: 'sample', mode: 'ssh', host: 'host', port: 22 }), connectionKey({ provider: 'codex', mode: 'ssh', host: 'host', port: 22 }));
  assert.throws(() => connectionKey({ provider: '../bad', mode: 'local' }));
});

test('a rejected provider selection leaves the running adapter and connection identity intact', async () => {
  const f = fixture(); await f.connection.connect({ provider: 'codex' });
  const session = f.connection.session;
  await assert.rejects(f.connection.connect({ provider: 'missing' }), /Unsupported coding agent/);
  assert.equal(f.adapters.length, 1); assert.equal(f.adapters[0].disconnects, 0);
  assert.ok(f.connection.ready); assert.equal(f.connection.session, session);
  f.connection.disconnect();
});

test('provider calls preserve parameters, timeout, RPC events, diagnostics, and capability checks', async () => {
  const f = fixture(), events = [];
  f.connection.on('rpc', event => events.push(event));
  f.connection.on('diagnostic', event => events.push(event));
  await f.connection.connect({ provider: 'sample' });
  const params = { threadId: 'same-chat', includeTurns: false };
  assert.deepEqual(await f.connection.call('thread/read', params, 100), { thread: { id: 'same-chat' } });
  assert.deepEqual(f.adapters[0].calls, [['thread/read', params, 100]]);
  await assert.rejects(f.connection.call('thread/revert', params), /does not support/);
  assert.equal(f.adapters[0].calls.length, 1);
  f.adapters[0].emit('rpc', { method: 'turn/start', phase: 'started' });
  f.adapters[0].emit('diagnostic', { event: 'process.started' });
  assert.equal(events.length, 2);
  f.connection.disconnect();
  await assert.rejects(f.connection.call('thread/read', params), /Connect to a coding agent/);
});

test('switching providers detaches old events, rejects stale call results, and clears pending requests', async () => {
  const f = fixture(), notifications = [];
  f.connection.on('notification', event => notifications.push(event));
  await f.connection.connect({ provider: 'codex' });
  const old = f.adapters[0], session = f.connection.session;
  old.emit('notification', { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'same-chat' } });
  let finish;
  old.call = () => new Promise(resolve => { finish = resolve; });
  const pending = f.connection.call('thread/read', { threadId: 'same-chat' });
  await f.connection.connect({ provider: 'sample' });
  assert.notEqual(f.connection.session, session);
  assert.equal(old.disconnects, 1); assert.equal(old.listenerCount('notification'), 0);
  old.emit('notification', { method: 'turn/completed', params: {} });
  finish({ thread: { id: 'wrong-provider' } });
  await assert.rejects(pending, /connection changed/);
  assert.equal(notifications.length, 1); assert.equal(f.connection.requests.size, 0);
  f.connection.disconnect();
});

test('interaction IDs are scoped to each connection even when providers reuse native IDs', async () => {
  const f = fixture(), notifications = [];
  f.connection.on('notification', event => notifications.push(event));
  const question = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'same-chat' } };
  await f.connection.connect({ provider: 'codex' }); f.adapters[0].emit('notification', question);
  const oldId = notifications.at(-1).id;
  await f.connection.connect({ provider: 'sample' }); f.adapters[1].emit('notification', question);
  const id = notifications.at(-1).id;
  assert.notEqual(id, oldId);
  await assert.rejects(f.connection.respond(oldId, {}), /no longer pending/);
  assert.equal(f.adapters[1].answers.length, 0);
  f.adapters[1].respond = async () => { throw new Error('Delivery failed'); };
  await assert.rejects(f.connection.respond(id, {}), /Delivery failed/);
  assert.ok(f.connection.requests.has(id));
  f.adapters[1].respond = async (nativeId, result) => { f.adapters[1].answers.push({ nativeId, result }); };
  await f.connection.respond(id, { answers: {} });
  assert.deepEqual(f.adapters[1].answers, [{ nativeId: 7, result: { answers: {} } }]);
  assert.equal(f.connection.requests.size, 0);
  f.adapters[1].emit('notification', question);
  f.adapters[1].emit('notification', { method: 'serverRequest/resolved', params: { requestId: 7 } });
  assert.equal(notifications.at(-1).params.requestId, id); assert.equal(f.connection.requests.size, 0);
  f.adapters[1].emit('notification', { ...question, id: 'unsupported' });
  await f.connection.rejectRequest(notifications.at(-1).id);
  assert.deepEqual(f.adapters[1].declined, ['unsupported']);
  assert.equal(f.connection.requests.size, 0); f.connection.disconnect();
});

test('a late initialization result cannot replace or disconnect the newer provider', async () => {
  const f = fixture(); let finish;
  const create = f.registry.codex.create;
  f.registry.codex.create = () => {
    const adapter = create(); adapter.connect = () => new Promise(resolve => { finish = resolve; }); return adapter;
  };
  const old = f.connection.connect({ provider: 'codex' });
  await f.connection.connect({ provider: 'sample' });
  finish({ connected: true }); await assert.rejects(old, /connection changed/);
  assert.ok(f.connection.ready); assert.equal(f.connection.provider.id, 'sample');
  assert.equal(f.adapters[1].disconnects, 0); f.connection.disconnect();
});

test('failed initialization releases the adapter and a disconnected adapter cannot return a late result', async () => {
  const f = fixture(); const create = f.registry.codex.create;
  f.registry.codex.create = () => {
    const adapter = create(); adapter.connect = async () => { throw new Error('Initialization failed'); }; return adapter;
  };
  await assert.rejects(f.connection.connect({ provider: 'codex' }), /Initialization failed/);
  assert.equal(f.connection.session, null); assert.equal(f.adapters[0].disconnects, 1);
  assert.equal(f.adapters[0].listenerCount('notification'), 0);
  await f.connection.connect({ provider: 'sample' });
  let finish;
  f.adapters[1].call = () => new Promise(resolve => { finish = resolve; });
  const pending = f.connection.call('thread/read', { threadId: 'same-chat' });
  f.adapters[1].ready = false; f.adapters[1].emit('disconnected'); finish({ thread: { id: 'late' } });
  await assert.rejects(pending, /connection changed/); f.connection.disconnect();
});

test('the native Codex adapter streams normalized events through the provider boundary', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk));
    if (message.id !== undefined && message.method) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : { turn: { id: 'native-turn', status: 'inProgress' } } }) + '\n'));
  });
  const f = fixture();
  f.registry.codex.create = () => new CodexConnection(() => child);
  const notifications = []; f.connection.on('notification', value => notifications.push(value));
  const wakeLock = new AgentWakeLock({ start: () => 12, stop() {} }, f.connection);
  await f.connection.connect({ provider: 'codex', mode: 'local', codexPath: process.execPath });
  await f.connection.call('turn/start', { threadId: 'native-chat' });
  assert.equal(wakeLock.id, 12);
  const events = [
    { method: 'item/agentMessage/delta', params: { threadId: 'native-chat', itemId: 'reply', delta: 'Hello 世界' } },
    { id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'native-chat' } },
    { method: 'serverRequest/resolved', params: { requestId: 4 } },
    { method: 'turn/completed', params: { threadId: 'native-chat', turn: { id: 'native-turn', status: 'completed' } } }
  ];
  for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
  assert.equal(notifications[0].params.delta, 'Hello 世界');
  assert.equal(notifications[1].id, notifications[2].params.requestId);
  assert.equal(f.connection.requests.size, 0); assert.equal(f.connection.adapter.requests.size, 0);
  assert.equal(wakeLock.id, null); f.connection.disconnect();
});
