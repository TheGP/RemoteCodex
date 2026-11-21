const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentPool, agentId, agentTarget, poolOptions } = require('../agent-pool.cjs');
const { rendererMethods } = require('../providers.cjs');
const { AgentWakeLock } = require('../wake-lock.cjs');
const { ScheduleStore, Scheduler } = require('../scheduler.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const adapters = new Map();
  const registry = Object.fromEntries(['codex', 'sample'].map(id => [id, {
    id, name: id === 'codex' ? 'Codex' : 'Sample', methods: [...rendererMethods, 'fs/readFile'],
    options: value => ({ mode: value.mode || 'local', executablePath: value.executablePath || '' }),
    create() {
      const adapter = new EventEmitter();
      Object.assign(adapter, {
        ready: false, calls: [], answers: [], disconnects: 0,
        connect: async () => { adapter.ready = true; },
        call: async (method, params) => {
          adapter.calls.push({ method, params });
          if (method === 'model/list') return { data: [{ model: 'shared-model', displayName: 'Shared', isDefault: true }], nextCursor: null };
          if (method === 'turn/start') return { turn: { id: 'same-turn', status: 'inProgress' } };
          if (method === 'thread/turns/list') return { data: [{ id: 'same-turn', items: [{ id: 'same-item', text: id }] }], nextCursor: null };
          if (method === 'thread/list') return { data: [{ id: 'same-chat', updatedAt: id === 'codex' ? 20 : 30 }], nextCursor: null };
          return { thread: { id: 'same-chat', cwd: '/tmp', model: 'shared-model' } };
        },
        respond: async (nativeId, result) => { adapter.answers.push({ nativeId, result }); },
        rejectRequest: async nativeId => { adapter.answers.push({ nativeId, rejected: true }); },
        disconnect: () => { adapter.ready = false; adapter.disconnects++; adapter.emit('disconnected'); }
      });
      adapters.set(id, adapter); return adapter;
    }
  }]));
  const pool = new AgentPool(registry);
  t.after(() => pool.disconnect());
  return { pool, registry, adapters };
}

test('parallel agents share a machine while models, chats, history and turns retain their owner', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  assert.ok(pool.listProviders().every(provider => provider.connected));
  assert.equal(pool.machine, 'access:local');
  const models = await pool.call('model/list');
  assert.deepEqual(models.data.map(model => model.model), ['shared-model', agentId('sample', 'model', 'shared-model')]);
  const sample = await pool.call('thread/start', { model: models.data[1].model });
  assert.equal(sample.thread.id, agentId('sample', 'thread', 'same-chat'));
  assert.equal(adapters.get('sample').calls.at(-1).params.model, 'shared-model');
  const results = await Promise.all([
    pool.call('turn/start', { threadId: 'same-chat', model: 'shared-model' }),
    pool.call('turn/start', { threadId: sample.thread.id, model: models.data[1].model })
  ]);
  assert.notEqual(results[0].turn.id, results[1].turn.id);
  assert.equal(adapters.get('codex').disconnects, 0); assert.equal(adapters.get('sample').disconnects, 0);
  const history = await pool.call('thread/turns/list', { threadId: sample.thread.id });
  assert.equal(history.data[0].id, agentId('sample', 'turn', 'same-turn'));
  assert.equal(history.data[0].items[0].id, agentId('sample', 'item', 'same-item'));
  await pool.call('thread/revert', { threadId: sample.thread.id, beforeTurnId: history.data[0].id });
  assert.equal(adapters.get('sample').calls.at(-1).params.beforeTurnId, 'same-turn');
  const before = adapters.get('codex').calls.length + adapters.get('sample').calls.length;
  await assert.rejects(pool.call('turn/start', { threadId: sample.thread.id, model: 'shared-model' }), /another coding agent/);
  await assert.rejects(pool.call('thread/read', { threadId: sample.thread.id }, undefined, { provider: 'codex' }), /another coding agent/);
  assert.equal(adapters.get('codex').calls.length + adapters.get('sample').calls.length, before);
});

test('providers without projects inherit a unique matching workspace group without changing their owner', async t => {
  const { pool, registry, adapters } = fixture(t);
  registry.sample.methods = registry.sample.methods.filter(method => !method.startsWith('project/'));
  await pool.connect({ mode: 'local' });
  const project = { id: 'rapidcode', name: 'Rapidcode', roots: [{ path: '/work/rapidcode' }] };
  adapters.get('codex').call = async () => ({ data: [project], nextCursor: null });
  await pool.call('project/list');
  const thread = { id: 'sample-chat', cwd: '/work/rapidcode/' };
  assert.equal(pool.thread('sample', thread).projectId, project.id);
  assert.equal(pool.thread('sample', thread).provider, 'sample');
  assert.equal(pool.thread('sample', thread).id, agentId('sample', 'thread', thread.id));
  assert.equal(pool.thread('codex', thread).projectId, undefined, 'native project choices must stay authoritative');
  assert.equal(pool.thread('sample', { ...thread, cwd: '/work/rapidcode-other' }).projectId, undefined);
  assert.equal(pool.thread('sample', { ...thread, projectId: 'explicit' }).projectId, agentId('sample', 'project', 'explicit'));
  pool.project('codex', { id: 'multi-root', roots: [{ path: '/work/primary' }, { path: '/work/secondary' }] });
  assert.equal(pool.thread('sample', { ...thread, cwd: '/work/secondary' }).projectId, undefined, 'secondary roots must not silently redirect a conversation to the bound primary root');
  await pool.call('turn/start', { threadId: agentId('sample', 'thread', thread.id) });
  assert.equal(adapters.get('sample').calls.at(-1).params.threadId, thread.id);
  pool.project('codex', { ...project, id: 'ambiguous-duplicate' });
  assert.equal(pool.thread('sample', thread).projectId, undefined, 'ambiguous workspaces must not choose an arbitrary project');
  pool.disconnect(); assert.equal(pool.projects.size, 0);
});

test('project pages include workspace-only providers and keep unmatched chats in Other across pagination', async t => {
  const { pool, registry, adapters } = fixture(t);
  registry.sample.methods = registry.sample.methods.filter(method => !method.startsWith('project/'));
  await pool.connect({ mode: 'local' });
  pool.project('codex', { id: 'rapidcode', roots: [{ path: '/work/rapidcode' }] });
  const sample = [
    { id: 'outside', cwd: '/work/other', updatedAt: 40 },
    { id: 'matched-one', cwd: '/work/rapidcode', updatedAt: 10 },
    { id: 'matched-two', cwd: '/work/rapidcode', updatedAt: 5 }
  ];
  adapters.get('codex').call = async (_method, params) => ({ data: params.projectId === 'rapidcode' ? [{ id: 'native-member', projectId: 'rapidcode', updatedAt: 20 }] : [], nextCursor: null });
  adapters.get('sample').call = async (method, params) => {
    adapters.get('sample').calls.push({ method, params });
    assert.equal(params.projectId, null, 'foreign project identities must never reach the workspace-only provider');
    const offset = Number(params.cursor || 0);
    return { data: sample.slice(offset, offset + 1), nextCursor: offset + 1 < sample.length ? String(offset + 1) : null };
  };
  const found = []; let cursor;
  do {
    const page = await pool.call('thread/list', { projectId: 'rapidcode', limit: 1, cursor }, undefined, { provider: 'codex' });
    found.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found.map(thread => thread.id), ['native-member', agentId('sample', 'thread', 'matched-one'), agentId('sample', 'thread', 'matched-two')]);
  const other = await pool.call('thread/list', { projectId: null, limit: 10 });
  assert.deepEqual(other.data.map(thread => thread.id), [agentId('sample', 'thread', 'outside')]);
});

test('sidebar search merges Codex message matches and provider title matches across pages', async t => {
  const { pool, registry, adapters } = fixture(t);
  registry.codex.methods.push('thread/search');
  await pool.connect({ mode: 'local' });
  const table = '| Error Type | Occurrences | Can Fix? | Notes';
  const titleMatch = { id: 'title-match', updatedAt: 30 };
  const messageMatch = { id: 'message-match', projectId: 'rapidcode', updatedAt: 20 };
  let hasHistorySearch = true;
  adapters.get('codex').call = async (method, params) => {
    assert.equal(params.searchTerm, table);
    assert.ok(!Object.hasOwn(params, 'projectId'));
    if (method === 'thread/list') return { data: [titleMatch], nextCursor: null };
    assert.equal(method, 'thread/search');
    if (!hasHistorySearch) throw new Error('Invalid request: unknown variant `thread/search`');
    return params.cursor
      ? { data: [{ thread: messageMatch }], nextCursor: null }
      : { data: [{ thread: titleMatch }], nextCursor: 'more-history' };
  };
  const query = { limit: 1, searchTerm: table, sortKey: 'updated_at' };
  const first = await pool.call('thread/list', query);
  const second = await pool.call('thread/list', { ...query, cursor: first.nextCursor });
  const third = await pool.call('thread/list', { ...query, cursor: second.nextCursor });
  assert.deepEqual([first, second, third].flatMap(page => page.data.map(thread => thread.id)),
    ['title-match', agentId('sample', 'thread', 'same-chat'), 'message-match']);
  assert.equal(third.data[0].projectId, 'rapidcode');
  assert.equal(third.nextCursor, null);
  hasHistorySearch = false;
  const legacy = await pool.call('thread/list', { ...query, limit: 10 });
  assert.deepEqual(legacy.data.map(thread => thread.id), ['title-match', agentId('sample', 'thread', 'same-chat')]);
  assert.equal(legacy.errors, undefined);
});

test('completed project refreshes remove obsolete groups and partial or stale catalogs keep valid folders', async t => {
  const { pool, registry, adapters } = fixture(t);
  registry.sample.methods = registry.sample.methods.filter(method => !method.startsWith('project/'));
  await pool.connect({ mode: 'local' });
  const old = { id: 'removed', roots: [{ path: '/work/old' }] }, current = { id: 'retained', roots: [{ path: '/work/current' }] };
  pool.project('codex', old);
  adapters.get('codex').call = async () => ({ data: [current], nextCursor: null });
  await pool.call('project/list');
  assert.equal(pool.projects.has(old.id), false);
  assert.equal(pool.thread('sample', { id: 'old-workspace', cwd: '/work/old' }).projectId, undefined);
  pool.project('codex', old);
  adapters.get('codex').call = async (_method, params) => {
    if (params.cursor) throw new Error('Catalog page unavailable');
    return { data: [current], nextCursor: 'more-native-projects' };
  };
  const page = await pool.call('project/list', { limit: 1 });
  assert.ok(pool.projects.has(old.id), 'a partial project catalog must retain undiscovered groups');
  await assert.rejects(pool.call('project/list', { limit: 1, cursor: page.nextCursor }), /Catalog page unavailable/);
  assert.ok(pool.projects.has(old.id), 'a failed later catalog page must retain cached groups');
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  adapters.get('codex').call = async () => { started(); return new Promise(resolve => { release = () => resolve({ data: [old], nextCursor: null }); }); };
  const stale = pool.call('project/list'); await held;
  adapters.get('codex').call = async () => ({ data: [current], nextCursor: null });
  await pool.call('project/list'); release(); await stale;
  assert.equal(pool.projects.has(old.id), false, 'an older catalog reply must not restore a removed group');
  assert.ok(pool.projects.has(current.id));
});

test('direct message reads preserve wrapped identities and reject foreign or invalid item lists', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  for (const provider of ['codex', 'sample']) {
    const adapter = adapters.get(provider);
    adapter.call = async (method, params) => {
      adapter.calls.push({ method, params });
      return { data: [{ turnId: 'same-turn', item: { id: 'same-item', type: 'agentMessage', text: 'Pinned' }, startedAtMs: 1234 }] };
    };
    const params = { threadId: agentId(provider, 'thread', 'same-chat'), turnId: agentId(provider, 'turn', 'same-turn'), itemIds: [agentId(provider, 'item', 'same-item')] };
    const result = await pool.call('thread/items/read', params);
    assert.deepEqual(adapter.calls.at(-1), { method: 'thread/items/read', params: { threadId: 'same-chat', turnId: 'same-turn', itemIds: ['same-item'] } });
    assert.deepEqual(result.data, [{ turnId: params.turnId, item: { id: params.itemIds[0], type: 'agentMessage', text: 'Pinned' }, startedAtMs: 1234 }]);
  }
  const adapter = adapters.get('sample'), count = adapter.calls.length;
  const base = { threadId: agentId('sample', 'thread', 'same-chat'), turnId: agentId('sample', 'turn', 'same-turn') };
  for (const itemIds of [null, 'same-item', [], [null], [''], Array(101).fill('same-item')]) {
    await assert.rejects(pool.call('thread/items/read', { ...base, itemIds }), /Invalid message/);
  }
  await assert.rejects(pool.call('thread/items/read', { ...base, itemIds: ['same-item'] }), /another coding agent/);
  await assert.rejects(pool.call('thread/items/read', { ...base, itemIds: [agentId('sample', 'turn', 'same-item')] }), /Invalid item/);
  assert.equal(adapter.calls.length, count);
});

test('simultaneous questions with identical native IDs can be answered independently and expire on reconnect', async t => {
  const { pool, adapters } = fixture(t), events = [];
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  const question = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'same-chat', turnId: 'same-turn' } };
  for (const adapter of adapters.values()) adapter.emit('notification', question);
  assert.notEqual(events[0].id, events[1].id); assert.notEqual(events[0].params.threadId, events[1].params.threadId);
  assert.ok(events.every(event => event.machine === 'access:local'));
  const old = events[1].id;
  await pool.respond(events[0].id, { text: 'codex answer' });
  await pool.respond(events[1].id, { text: 'sample answer' });
  assert.deepEqual(adapters.get('codex').answers, [{ nativeId: 1, result: { text: 'codex answer' } }]);
  assert.deepEqual(adapters.get('sample').answers, [{ nativeId: 1, result: { text: 'sample answer' } }]);
  adapters.get('sample').emit('notification', question);
  adapters.get('sample').emit('notification', { method: 'serverRequest/resolved', params: { requestId: 1 } });
  assert.equal(events.at(-1).params.requestId, events.at(-2).id);
  await pool.connect({ mode: 'local' });
  adapters.get('sample').emit('notification', question);
  assert.notEqual(events.at(-1).id, old);
  await assert.rejects(pool.respond(old, {}), /no longer pending/);
});

test('losing one agent leaves the other running and releases only its own wake lock', async t => {
  const { pool, adapters } = fixture(t), locks = new Map(), events = [];
  let lockId = 0; const stopped = [];
  pool.on('connection', ({ provider, connection }) => locks.set(provider, new AgentWakeLock({ start: () => ++lockId, stop: id => stopped.push(id) }, connection)));
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  for (const adapter of adapters.values()) adapter.emit('notification', { method: 'turn/started', params: { threadId: 'same-chat', turn: { id: 'same-turn' } } });
  const survivingLock = locks.get('codex').id;
  adapters.get('sample').disconnect();
  adapters.get('sample').emit('notification', { method: 'connection/closed', params: { message: 'Sample stopped' } });
  assert.equal(events.at(-1).method, 'provider/closed'); assert.equal(events.at(-1).provider, 'sample');
  assert.equal(locks.get('sample').id, null); assert.equal(locks.get('codex').id, survivingLock);
  assert.ok(!stopped.includes(survivingLock)); assert.ok(pool.ready);
  await pool.call('thread/read', { threadId: 'same-chat' });
  await assert.rejects(pool.call('thread/read', { threadId: agentId('sample', 'thread', 'same-chat') }), /not connected/);
});

test('merged pagination retains both histories in updated order, supports repeated cursors and detects stale cursors', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  for (const [id, adapter] of adapters) adapter.call = async (_method, params) => {
    const pages = id === 'codex' ? [[{ id: 'a', updatedAt: 40 }], [{ id: 'b', updatedAt: 10 }]] : [[], [{ id: 'a', updatedAt: 30 }, { id: 'b', updatedAt: 20 }]];
    const index = Number(params.cursor || 0);
    return { data: pages[index], nextCursor: index === 0 ? '1' : null };
  };
  const query = { limit: 1, sortKey: 'updated_at' };
  const first = await pool.call('thread/list', query);
  assert.equal(first.data[0].updatedAt, 40);
  const second = await pool.call('thread/list', { ...query, cursor: first.nextCursor });
  assert.equal(second.data[0].updatedAt, 30);
  assert.deepEqual((await pool.call('thread/list', { ...query, cursor: first.nextCursor })).data, second.data);
  const third = await pool.call('thread/list', { ...query, cursor: second.nextCursor });
  const fourth = await pool.call('thread/list', { ...query, cursor: third.nextCursor });
  assert.equal(third.data[0].updatedAt, 20); assert.equal(fourth.data[0].updatedAt, 10); assert.equal(fourth.nextCursor, null);
  adapters.get('sample').disconnect();
  await assert.rejects(pool.call('thread/list', { ...query, cursor: first.nextCursor }), /list expired/);
});

test('default model and explicit service context route correctly; settings and invalid IDs fail before replacing connections', async t => {
  const { pool, registry, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  const session = pool.session;
  const id = agentId('sample', 'model', '');
  await pool.call('thread/start', { model: id });
  assert.equal(adapters.get('sample').calls.at(-1).params.model, undefined);
  await pool.call('skills/list', { cwds: ['/tmp'] }, undefined, { provider: 'sample' });
  assert.equal(adapters.get('sample').calls.at(-1).method, 'skills/list');
  assert.deepEqual(agentTarget(agentId('sample', 'thread', 'native:/聊天%'), 'thread'), { provider: 'sample', value: 'native:/聊天%' });
  assert.throws(() => agentTarget(id, 'thread'), /Invalid thread/);
  const options = poolOptions({ mode: 'local', providerOptions: { sample: { executablePath: '/tmp/sample' } } }, registry);
  assert.deepEqual(poolOptions(options, registry), options);
  await assert.rejects(pool.connect({ provider: 'missing' }), /Unsupported/);
  await assert.rejects(pool.connect({ providerOptions: { missing: {} } }), /Unsupported/);
  assert.equal(pool.session, session); assert.ok(pool.ready);
});

test('optional agent startup failure leaves a usable Codex connection and visible provider error', async t => {
  const { pool, registry } = fixture(t);
  registry.sample.create = () => Object.assign(new EventEmitter(), { ready: false, connect: async () => { throw new Error('Not installed'); }, disconnect() {} });
  await pool.connect({ mode: 'local' });
  assert.equal(pool.describe('sample').error, 'Not installed'); assert.equal(pool.describe('sample').connected, false);
  assert.ok(pool.describe('codex').connected);
  assert.equal((await pool.call('thread/list')).data.length, 1);
});

test('schedules on both agents preserve models and settings; a queued chat only blocks its own schedule', async t => {
  const { pool, adapters } = fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-pool-schedule-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await pool.connect({ mode: 'local' });
  const store = new ScheduleStore(path.join(directory, 'schedules.json'));
  for (const provider of ['codex', 'sample']) {
    const thread = { id: agentId(provider, 'thread', 'same-chat'), cwd: '/tmp' };
    const model = agentId(provider, 'model', 'shared-model');
    store.enqueue({ machine: pool.machine, draftId: provider, text: 'Later', images: [], input: [{ type: 'text', text: 'Later' }], access: { sandbox: 'read-only', approvalPolicy: 'never' }, mode: 'default', model, thread, turnSettings: { threadId: thread.id, model, effort: 'high', sandboxPolicy: { type: 'readOnly' } } }, 1, 1000);
  }
  let blocked = true;
  const scheduler = new Scheduler({ store, connection: pool, available: () => true, machine: () => pool.machine, blocked: threadId => blocked && threadId === 'same-chat' });
  await scheduler.tick(3601001);
  assert.deepEqual(store.tasks.map(task => task.status), ['pending', 'sent']);
  assert.ok(!adapters.get('codex').calls.some(call => call.method === 'turn/start'));
  assert.deepEqual(adapters.get('sample').calls.find(call => call.method === 'turn/start').params, { threadId: 'same-chat', model: 'shared-model', effort: 'high', sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text: 'Later' }] });
  blocked = false;
  await scheduler.tick(3601002);
  assert.ok(store.tasks.every(task => task.status === 'sent'));
  assert.equal(adapters.get('codex').calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(adapters.get('sample').calls.filter(call => call.method === 'turn/start').length, 1);
});

test('shared catalogs and histories preserve healthy results and identify a failing provider', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  adapters.get('sample').call = async () => { throw new Error('Sample unavailable'); };
  for (const method of ['model/list', 'collaborationMode/list', 'thread/list', 'project/list']) {
    const healthy = adapters.get('codex');
    const original = healthy.call;
    healthy.call = async () => ({ data: [method === 'model/list' ? { model: 'healthy' } : { id: 'healthy' }], nextCursor: null });
    const result = await pool.call(method);
    assert.equal(result.data.length, 1, method);
    assert.deepEqual(result.errors, [{ provider: 'sample', message: 'Sample unavailable' }]);
    healthy.call = original;
  }
  adapters.get('codex').call = async () => { throw new Error('Codex unavailable'); };
  await assert.rejects(pool.call('thread/list'), /Codex unavailable/);
  await assert.rejects(pool.call('model/list'), /Codex unavailable/);
});

test('a failed provider during pagination does not discard the other provider’s remaining history', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  adapters.get('codex').call = async (_method, params) => ({ data: [{ id: params.cursor ? 'older' : 'newer', updatedAt: params.cursor ? 10 : 40 }], nextCursor: params.cursor ? null : 'next' });
  let sampleCalls = 0;
  adapters.get('sample').call = async () => {
    if (++sampleCalls > 1) throw new Error('Sample page unavailable');
    return { data: [{ id: 'sample', updatedAt: 30 }], nextCursor: 'next' };
  };
  const first = await pool.call('thread/list', { limit: 1 });
  const second = await pool.call('thread/list', { limit: 1, cursor: first.nextCursor });
  const third = await pool.call('thread/list', { limit: 1, cursor: second.nextCursor });
  assert.equal(first.data[0].id, 'newer'); assert.equal(second.data[0].provider, 'sample'); assert.equal(third.data[0].id, 'older');
  assert.deepEqual(third.errors, [{ provider: 'sample', message: 'Sample page unavailable' }]);
  assert.equal(third.nextCursor, null);
});

test('recovery retries only the failed agent, coalesces requests, and preserves active chats and questions', async t => {
  const { pool, adapters, registry } = fixture(t), events = [];
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  const codex = adapters.get('codex'), sample = adapters.get('sample'), session = pool.session, driverSession = pool.connectionFor('codex').session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'same-chat', turn: { id: 'running' } } });
  codex.emit('notification', { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'same-chat' } });
  const questionId = events.at(-1).id;
  sample.disconnect();
  sample.emit('notification', { method: 'connection/closed', params: { message: 'Sample stopped' } });
  const create = registry.sample.create; let finish;
  registry.sample.create = () => {
    const adapter = create();
    adapter.connect = async () => { await new Promise(resolve => { finish = resolve; }); adapter.ready = true; };
    return adapter;
  };
  const first = pool.recover(), second = pool.recover();
  assert.equal(first, second); finish();
  assert.deepEqual(await first, { reused: true, reconnected: ['sample'] });
  assert.equal(pool.session, session); assert.equal(pool.connectionFor('codex').session, driverSession);
  assert.equal(adapters.get('codex'), codex); assert.equal(codex.disconnects, 0); assert.ok(codex.ready);
  await pool.respond(questionId, { text: 'Still pending' });
  assert.equal(codex.answers[0].result.text, 'Still pending');
  assert.equal(events.at(-1).method, 'providers/updated'); assert.deepEqual(events.at(-1).params.reconnected, ['sample']);
  const count = events.length;
  assert.deepEqual(await pool.recover(), { reused: true, reconnected: [] }); assert.equal(events.length, count);
});

test('failed recovery reports its provider without closing healthy agents or accepting late recovery results', async t => {
  const { pool, adapters, registry } = fixture(t), events = [];
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  adapters.get('sample').disconnect();
  const create = registry.sample.create;
  registry.sample.create = () => { const adapter = create(); adapter.connect = async () => { throw new Error('Retry failed'); }; return adapter; };
  await pool.recover();
  assert.ok(pool.describe('codex').connected); assert.equal(adapters.get('codex').disconnects, 0);
  assert.equal(pool.describe('sample').error, 'Retry failed'); assert.equal(events.at(-1).method, 'providers/updated');
  let finish;
  registry.sample.create = () => { const adapter = create(); adapter.connect = async () => { await new Promise(resolve => { finish = resolve; }); adapter.ready = true; }; return adapter; };
  const pending = pool.recover();
  registry.sample.create = create;
  await pool.connect({ mode: 'local' });
  const count = events.length; finish();
  await assert.rejects(pending, /connections changed/);
  assert.equal(events.length, count); assert.ok(pool.describe('sample').connected); assert.equal(pool.describe('sample').error, null);
});

test('recovery does not restart an agent whose initial connection is still pending', async t => {
  const { pool, adapters, registry } = fixture(t);
  const create = registry.sample.create; let finish;
  registry.sample.create = () => {
    const adapter = create();
    adapter.connect = async () => { await new Promise(resolve => { finish = resolve; }); adapter.ready = true; };
    return adapter;
  };
  const connecting = pool.connect({ mode: 'local' });
  await Promise.resolve();
  const sample = adapters.get('sample');
  assert.ok(pool.ready); assert.equal(sample.ready, false);
  assert.deepEqual(await pool.recover(), { reused: true, reconnected: [] });
  assert.equal(adapters.get('sample'), sample); assert.equal(sample.disconnects, 0);
  finish(); await connecting;
  assert.ok(pool.describe('sample').connected);
});

test('agent enable preferences validate before mutation and respect descriptor defaults', async t => {
  const { pool, adapters, registry } = fixture(t);
  registry.sample.defaultEnabled = false;
  await pool.connect({ mode: 'local' });
  assert.equal(pool.describe('sample').enabled, false); assert.equal(adapters.has('sample'), false);
  const session = pool.session;
  for (const enabled of ['false', 0, null]) {
    await assert.rejects(pool.reconfigure({ mode: 'local', providerOptions: { sample: { enabled } } }), /Invalid agent settings/);
  }
  await assert.rejects(pool.reconfigure({ mode: 'local', providerOptions: { missing: { enabled: true } } }), /Unsupported coding agent/);
  assert.equal(pool.session, session); assert.equal(adapters.get('codex').disconnects, 0);
  const options = poolOptions({ mode: 'local', providerOptions: { codex: { enabled: false }, sample: { enabled: true, executablePath: process.execPath } } }, registry);
  assert.deepEqual(poolOptions(JSON.parse(JSON.stringify(options)), registry), options);
  await pool.reconfigure(options);
  assert.equal(pool.describe('codex').enabled, false); assert.equal(pool.describe('sample').connected, true);
});

test('disabled agents stay stopped while unrelated chats and questions survive disabling and reenabling', async t => {
  const { pool, adapters } = fixture(t), events = [];
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  const session = pool.session, codex = adapters.get('codex'), sample = adapters.get('sample');
  const codexSession = pool.connectionFor('codex').session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'running', turn: { id: 'turn' } } });
  codex.emit('notification', { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'running' } });
  const questionId = events.at(-1).id;
  const options = { mode: 'local', providerOptions: { sample: { enabled: false } } };
  const disabled = await pool.reconfigure(options);
  assert.equal(disabled.connected, true); assert.equal(sample.disconnects, 1);
  assert.equal(pool.describe('sample').enabled, false); assert.equal(pool.describe('sample').connected, false);
  assert.equal(pool.session, session); assert.equal(pool.connectionFor('codex').session, codexSession);
  assert.deepEqual(await pool.recover(), { reused: true, reconnected: [] });
  assert.equal(adapters.get('sample'), sample);
  await pool.respond(questionId, { text: 'Keep working' });
  assert.equal(codex.answers[0].result.text, 'Keep working'); assert.equal(codex.disconnects, 0);
  const enabled = await pool.reconfigure({ mode: 'local', providerOptions: { sample: { enabled: true } } });
  assert.deepEqual(enabled.reconnected, ['sample']); assert.notEqual(adapters.get('sample'), sample);
  assert.equal(pool.session, session); assert.equal(adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
  assert.ok(events.some(event => event.method === 'provider/closed' && event.params.reconfigured && event.params.disabled));
});

test('all agents may be disabled and later enabled without recovery relaunching disabled adapters', async t => {
  const { pool, adapters } = fixture(t);
  const off = { mode: 'local', providerOptions: { codex: { enabled: false }, sample: { enabled: false } } };
  assert.equal((await pool.connect(off)).connected, false); assert.equal(adapters.size, 0);
  const session = pool.session;
  assert.ok(pool.listProviders().every(provider => !provider.enabled && !provider.connected));
  assert.deepEqual(await pool.recover(), { reused: true, reconnected: [] });
  await pool.reconfigure({ ...off, providerOptions: { ...off.providerOptions, codex: { enabled: true } } });
  assert.ok(pool.ready); assert.equal(adapters.has('sample'), false); assert.equal(pool.session, session);
  await pool.reconfigure(off);
  assert.equal(pool.ready, false); assert.equal(adapters.get('codex').disconnects, 1);
  await pool.recover(); assert.equal(adapters.has('sample'), false);
});

test('changing one executable restarts only that agent and rejects physical changes before stopping drivers', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  const codex = adapters.get('codex'), sample = adapters.get('sample'), session = pool.session;
  await pool.reconfigure({ mode: 'local', providerOptions: { sample: { executablePath: process.execPath } } });
  assert.equal(sample.disconnects, 1); assert.notEqual(adapters.get('sample'), sample);
  assert.equal(adapters.get('codex'), codex); assert.equal(codex.disconnects, 0); assert.equal(pool.session, session);
  await assert.rejects(pool.reconfigure({ mode: 'ssh' }), /requires a new connection/);
  assert.equal(codex.disconnects, 0); assert.equal(pool.session, session);
});

test('registered ZCode stays disabled by default and preserves its executable setting offline', async t => {
  const pool = new AgentPool(); t.after(() => pool.disconnect());
  const initial = pool.listProviders().find(provider => provider.id === 'zcode');
  assert.equal(initial.available, true); assert.equal(initial.enabled, false);
  const options = poolOptions({ mode: 'local', providerOptions: { codex: { enabled: false }, zcode: { enabled: false, executablePath: process.execPath } } });
  assert.deepEqual(poolOptions(JSON.parse(JSON.stringify(options))), options);
  assert.equal((await pool.connect(options)).connected, false);
  assert.equal(pool.connections.size, 0); assert.deepEqual(pool.launchOptions, []);
  const zcode = pool.describe('zcode');
  assert.equal(zcode.enabled, false); assert.equal(zcode.available, true); assert.equal(zcode.connected, false);
  await pool.recover(); assert.equal(pool.connections.size, 0);
});

test('disabled agent warnings are removed and do not follow a full machine reconnect', async t => {
  const { pool } = fixture(t);
  await pool.connect({ mode: 'local' });
  pool.errors.set('sample', 'Old machine failure');
  assert.equal(pool.describe('sample').error, 'Old machine failure');
  const off = { mode: 'local', providerOptions: { sample: { enabled: false } } };
  assert.equal(pool.listProviders(off).find(provider => provider.id === 'sample').error, null);
  await pool.connect(off);
  assert.equal(pool.describe('sample').error, null); assert.equal(pool.errors.has('sample'), false);
});

test('disabling an agent during recovery ignores its late initialization and leaves healthy work untouched', async t => {
  const { pool, registry, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  const codex = adapters.get('codex'); adapters.get('sample').disconnect();
  const create = registry.sample.create; let finish;
  registry.sample.create = () => {
    const adapter = create(); adapter.connect = async () => { await new Promise(resolve => { finish = resolve; }); adapter.ready = true; }; return adapter;
  };
  const recovery = pool.recover();
  await pool.reconfigure({ mode: 'local', providerOptions: { sample: { enabled: false } } });
  finish(); await recovery;
  assert.equal(pool.describe('sample').enabled, false); assert.equal(pool.describe('sample').connected, false);
  assert.equal(pool.describe('sample').error, null); assert.equal(adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
});

test('synced Codex aliases route native calls and normalize replies and events while preserving turn and item IDs', async t => {
  const { pool, adapters } = fixture(t), events = [];
  pool.on('notification', event => events.push(event));
  await pool.connect({ mode: 'local' });
  pool.setThreadAliases({ 'logical-chat': { nativeId: 'native-current', retiredNativeIds: ['native-retired'] } });
  const codex = adapters.get('codex');
  codex.call = async (method, params) => {
    codex.calls.push({ method, params });
    if (method === 'thread/turns/list') return { data: [{ id: 'stable-turn', items: [{ id: 'stable-item', type: 'agentMessage', text: 'Pinned answer' }] }], nextCursor: null };
    return { thread: { id: params.threadId, cwd: '/tmp', turns: [{ id: 'stable-turn', items: [{ id: 'stable-item', type: 'agentMessage', text: 'Pinned answer' }] }] } };
  };
  const result = await pool.call('thread/resume', { threadId: 'logical-chat', excludeTurns: true });
  assert.equal(codex.calls.at(-1).params.threadId, 'native-current');
  assert.equal(result.thread.id, 'logical-chat');
  assert.equal(result.thread.turns[0].id, 'stable-turn'); assert.equal(result.thread.turns[0].items[0].id, 'stable-item');
  const history = await pool.call('thread/turns/list', { threadId: 'logical-chat' });
  assert.equal(codex.calls.at(-1).params.threadId, 'native-current');
  assert.equal(history.data[0].id, 'stable-turn'); assert.equal(history.data[0].items[0].id, 'stable-item');
  codex.emit('notification', { method: 'item/completed', params: { threadId: 'native-current', turnId: 'stable-turn', item: { id: 'stable-item', type: 'agentMessage', text: 'Pinned answer' }, thread: { id: 'native-current' }, turn: { id: 'stable-turn', items: [{ id: 'stable-item' }] } } });
  const event = events.at(-1);
  assert.equal(event.params.threadId, 'logical-chat'); assert.equal(event.params.thread.id, 'logical-chat');
  assert.equal(event.params.turnId, 'stable-turn'); assert.equal(event.params.turn.id, 'stable-turn');
  assert.equal(event.params.item.id, 'stable-item'); assert.equal(event.params.turn.items[0].id, 'stable-item');
  const count = events.length;
  for (const id of ['native-retired', 'logical-chat']) {
    const stale = { method: 'turn/completed', params: { threadId: id, turn: { id: 'stable-turn', status: 'completed' } } };
    assert.equal(pool.notification('codex', stale), null);
    codex.emit('notification', stale);
    assert.equal(events.length, count);
  }
  const sample = adapters.get('sample');
  await pool.call('thread/read', { threadId: agentId('sample', 'thread', 'logical-chat') });
  assert.equal(sample.calls.at(-1).params.threadId, 'logical-chat');
  sample.emit('notification', { method: 'item/completed', params: { threadId: 'native-current', turnId: 'stable-turn', item: { id: 'stable-item' } } });
  assert.equal(events.at(-1).params.threadId, agentId('sample', 'thread', 'native-current'));
  assert.equal(events.at(-1).params.item.id, agentId('sample', 'item', 'stable-item'));
});

test('conversation lists expose only the active Codex alias and preserve colliding IDs from other providers', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  pool.setThreadAliases({ 'logical-chat': { nativeId: 'native-current', retiredNativeIds: ['native-retired'] } });
  const rows = ['logical-chat', 'native-retired', 'native-current', 'unrelated-chat'].map((id, index) => ({ id, updatedAt: 100 - index, path: '/fixture/' + id }));
  for (const adapter of adapters.values()) adapter.call = async () => ({ data: rows, nextCursor: null });
  const merged = await pool.call('thread/list', { limit: 50 });
  const codex = merged.data.filter(thread => thread.provider === 'codex'), sample = merged.data.filter(thread => thread.provider === 'sample');
  assert.deepEqual(codex.map(thread => thread.id).sort(), ['logical-chat', 'unrelated-chat']);
  assert.equal(codex.find(thread => thread.id === 'logical-chat').path, '/fixture/native-current');
  assert.deepEqual(sample.map(thread => thread.id), rows.map(thread => agentId('sample', 'thread', thread.id)));
  const direct = await pool.call('thread/list', { provider: 'codex', limit: 50 });
  assert.deepEqual(direct.data.map(thread => thread.id), ['logical-chat', 'unrelated-chat']);
});

test('disconnect clears Codex aliases and saved aliases can be restored without changing other providers', async t => {
  const { pool, adapters } = fixture(t);
  const records = { 'logical-chat': { nativeId: 'native-current', retiredNativeIds: ['native-retired'] } };
  const persisted = JSON.stringify(records);
  await pool.connect({ mode: 'local' }); pool.setThreadAliases(records);
  pool.disconnect();
  assert.equal(pool.threadIdentity('codex', 'native-current'), 'native-current');
  assert.equal(pool.threadIdentity('codex', 'native-retired'), 'native-retired');
  assert.equal(pool.nativeParams('codex', { threadId: 'logical-chat' }).threadId, 'logical-chat');
  await pool.connect({ mode: 'local' });
  assert.equal(pool.threadIdentity('codex', 'native-current'), 'native-current');
  pool.setThreadAliases(JSON.parse(persisted));
  await pool.call('thread/read', { threadId: 'logical-chat' });
  assert.equal(adapters.get('codex').calls.at(-1).params.threadId, 'native-current');
  assert.equal(pool.threadIdentity('codex', 'native-retired'), 'logical-chat');
  assert.equal(pool.threadIdentity('sample', 'native-current'), agentId('sample', 'thread', 'native-current'));
  pool.setThreadAliases({});
  assert.equal(pool.threadIdentity('codex', 'native-current'), 'native-current');
});

test('alias replacement invalidates buffered native conversation pages', async t => {
  const { pool, adapters } = fixture(t);
  await pool.connect({ mode: 'local' });
  adapters.get('codex').call = async () => ({ data: [{ id: 'logical-chat', updatedAt: 100 }, { id: 'native-retired', updatedAt: 90 }, { id: 'native-current', updatedAt: 80 }], nextCursor: null });
  adapters.get('sample').call = async () => ({ data: [{ id: 'sample-chat', updatedAt: 200 }], nextCursor: null });
  const first = await pool.call('thread/list', { limit: 1 });
  assert.ok(first.nextCursor);
  pool.setThreadAliases({ 'logical-chat': { nativeId: 'native-current', retiredNativeIds: ['native-retired'] } });
  await assert.rejects(pool.call('thread/list', { limit: 1, cursor: first.nextCursor }), /list expired/);
});
