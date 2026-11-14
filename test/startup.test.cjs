const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const providers = require('../providers.cjs');
const pool = require('../agent-pool.cjs');

async function fixture(t, saved, ids = ['codex']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-startup-'));
  const file = path.join(directory, 'connection.json');
  if (saved !== undefined) fs.writeFileSync(file, saved);
  const app = new EventEmitter(), ipcMain = new EventEmitter();
  const windows = [], exits = [], attempts = [], errors = [], notifications = [], intervals = [], adapters = new Map(), handlers = new Map(), connectErrors = new Map();
  let connection;
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => directory, getVersion: () => 'test', exit: code => exits.push(code), dock: { setIcon() {} } });
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter();
      this.webContents.session = { setPermissionRequestHandler() {} };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_name, message) => notifications.push(message);
      this.isDestroyed = () => false;
      this.loadFile = file => { this.file = file; };
      windows.push(this);
    }
  }
  class Connection extends pool.AgentPool {
    constructor() {
      super(Object.fromEntries(ids.map(id => [id, {
        id, name: id, methods: providers.rendererMethods,
        options: value => providers.connectionOptions({ ...value, provider: 'codex' }),
        create() {
          const adapter = new EventEmitter();
          Object.assign(adapter, {
            ready: false, disconnects: 0, answers: [],
            async connect(options) { attempts.push(options); if (connectErrors.has(id)) throw connectErrors.get(id); adapter.ready = true; return {}; },
            async respond(nativeId, result) { adapter.answers.push({ nativeId, result }); },
            disconnect() { adapter.ready = false; adapter.disconnects++; adapter.emit('disconnected'); }
          });
          adapters.set(id, adapter); return adapter;
        }
      }]))); connection = this;
    }
  }
  const electron = { app, ipcMain, BrowserWindow, Menu: { buildFromTemplate: value => value, setApplicationMenu() {} }, powerMonitor: new EventEmitter(), powerSaveBlocker: { start: () => 1, stop() {} } };
  const main = path.resolve(__dirname, '../main.cjs'), realRequire = createRequire(main);
  t.after(() => { app.emit('before-quit'); fs.rmSync(directory, { recursive: true, force: true }); });
  vm.runInNewContext(fs.readFileSync(main, 'utf8'), {
    require: name => name === 'electron' ? electron : name === './agent-pool.cjs' ? { ...pool, AgentPool: Connection } : realRequire(name),
    __dirname: path.dirname(main), process: { platform: process.platform, argv: [] },
    console: { error: error => errors.push(String(error)) }, setInterval: (...args) => { intervals.push(args[0]); return setInterval(...args); }, clearInterval, setImmediate
  }, { filename: main });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []); assert.deepEqual(exits, []); assert.equal(windows.length, 1);
  const event = { sender: windows[0].webContents, senderFrame: { url: pathToFileURL(windows[0].file).href } };
  return { file, directory, attempts, adapters, connection, notifications, intervals, connectErrors, request: (name, ...args) => handlers.get(name)(event, ...args) };
}

for (const [label, saved] of [
  ['malformed JSON', '{invalid-json'],
  ['unknown provider', JSON.stringify({ provider: 'missing-provider', mode: 'local' })],
  ['invalid connection fields', JSON.stringify({ mode: 'ssh', host: '-bad-host' })]
]) test(`startup with ${label} opens a repairable window without connecting or replacing the saved file`, async t => {
  const f = await fixture(t, saved);
  assert.match(f.request('settings').settingsError, /Saved connection settings could not be loaded/);
  assert.deepEqual(f.attempts, []); assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  await assert.rejects(f.request('connect', { provider: 'missing-provider' }), /Unsupported coding agent/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved); assert.deepEqual(f.attempts, []);
  const repaired = await f.request('connect', { provider: 'codex', mode: 'local', localCwd: f.directory });
  assert.equal(f.attempts.length, 1); assert.equal(repaired.options.settingsError, null);
  assert.equal(f.request('settings').settingsError, null);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).provider, 'codex');
  await new Promise(resolve => setImmediate(resolve));
});

test('first startup without a saved connection has no repair error or premature file write', async t => {
  const f = await fixture(t);
  assert.equal(f.request('settings').settingsError, null);
  assert.equal(fs.existsSync(f.file), false);
});

test('a failed machine switch clears its launch settings before connecting the original saved machine', async t => {
  const f = await fixture(t);
  const original = { mode: 'local', localCwd: f.directory };
  await f.request('connect', original);
  const saved = fs.readFileSync(f.file, 'utf8');
  f.connectErrors.set('codex', new Error('SSH unavailable'));
  await assert.rejects(f.request('connect', { mode: 'ssh', host: 'other-host' }), /SSH unavailable/);
  assert.equal(f.connection.session, null); assert.equal(f.connection.ready, false);
  assert.deepEqual(f.connection.launchOptions, []);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  assert.equal(f.request('settings').mode, 'local');
  f.connectErrors.clear();
  const result = await f.request('connect', JSON.parse(saved));
  assert.deepEqual(f.attempts.map(attempt => attempt.mode), ['local', 'ssh', 'local']);
  assert.equal(result.options.mode, 'local'); assert.equal(result.options.localCwd, f.directory);
  assert.equal(f.connection.machine, 'access:local'); assert.ok(f.connection.ready);
});

test('failed partial recovery preserves a healthy running chat and can retry the unavailable agent', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const options = { mode: 'local', localCwd: f.directory };
  await f.request('connect', options);
  const codex = f.adapters.get('codex'), session = f.connection.session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'running-chat', turn: { id: 'running-turn' } } });
  const sample = f.adapters.get('sample'); sample.disconnect();
  sample.emit('notification', { method: 'connection/closed', params: { message: 'Sample stopped' } });
  f.connectErrors.set('sample', new Error('Sample unavailable'));
  const result = await f.request('connect', options);
  assert.equal(result.reused, true); assert.deepEqual(result.reconnected, []);
  assert.equal(f.connection.session, session); assert.equal(f.adapters.get('codex'), codex);
  assert.ok(codex.ready); assert.equal(codex.disconnects, 0);
  assert.equal(result.options.agents.find(agent => agent.id === 'sample').error, 'Sample unavailable');
  assert.equal(f.notifications.filter(message => message.method === 'connection/closed').length, 0);
  await assert.rejects(f.request('connect', { ...options, localCwd: path.join(f.directory, 'changed') }), /Finish or stop running tasks/);
  f.connectErrors.clear();
  assert.deepEqual((await f.request('connect', options)).reconnected, ['sample']);
  assert.equal(f.adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
});

test('unchanged connect and automatic recovery restart only the failed agent while another chat is running', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const options = { mode: 'local', localCwd: f.directory };
  await f.request('connect', options);
  const codex = f.adapters.get('codex');
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'running-chat', turn: { id: 'running-turn' } } });
  const saved = fs.readFileSync(f.file, 'utf8'), session = f.connection.session;
  const failSample = () => {
    const adapter = f.adapters.get('sample'); adapter.disconnect();
    adapter.emit('notification', { method: 'connection/closed', params: { message: 'Sample stopped' } });
  };
  failSample();
  const result = await f.request('connect', options);
  assert.deepEqual(result.reconnected, ['sample']); assert.equal(result.reused, true);
  assert.ok(result.options.agents.every(agent => agent.connected));
  assert.equal(f.connection.session, session); assert.equal(f.adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
  assert.deepEqual(f.attempts.map(attempt => attempt.provider), ['codex', 'sample', 'sample']);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  await assert.rejects(f.request('connect', { ...options, localCwd: path.join(f.directory, 'changed') }), /Finish or stop running tasks/);
  failSample(); f.intervals[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.connection.describe('sample').connected);
  assert.deepEqual(f.attempts.map(attempt => attempt.provider), ['codex', 'sample', 'sample', 'sample']);
  assert.equal(codex.disconnects, 0); assert.equal(f.notifications.filter(message => message.method === 'providers/updated').length, 2);
});

test('disabled agent preferences are visible before startup and all-off settings survive restart', async t => {
  const saved = JSON.stringify({ mode: 'local', providerOptions: { codex: { enabled: false } } });
  const f = await fixture(t, saved);
  assert.equal(f.request('settings').agents[0].enabled, false); assert.equal(f.request('providers')[0].enabled, false);
  const off = await f.request('connect', f.request('settings'));
  assert.equal(off.connected, false); assert.equal(f.connection.ready, false); assert.equal(f.attempts.length, 0);
  const restarted = await fixture(t, fs.readFileSync(f.file, 'utf8'));
  assert.equal(restarted.request('settings').agents[0].enabled, false); assert.equal(restarted.attempts.length, 0);
  const enabled = await f.request('connect', { ...f.request('settings'), providerOptions: { codex: { enabled: true } } });
  assert.equal(enabled.connected, true); assert.equal(f.attempts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).providerOptions.codex.enabled, true);
});

test('enabling another agent preserves active chats and questions; disabling its own running agent is rejected', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const original = { mode: 'local', localCwd: f.directory, providerOptions: { sample: { enabled: false } } };
  await f.request('connect', original);
  const codex = f.adapters.get('codex'), session = f.connection.session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'working', turn: { id: 'turn' } } });
  codex.emit('notification', { id: 5, method: 'item/tool/requestUserInput', params: { threadId: 'working' } });
  const question = f.notifications.at(-1).id;
  const options = { ...original, providerOptions: { sample: { enabled: true } } };
  const enabled = await f.request('connect', options);
  assert.equal(enabled.reused, true); assert.deepEqual(enabled.reconnected, ['sample']);
  assert.equal(f.connection.session, session); assert.equal(f.adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
  assert.equal(f.notifications.filter(message => message.method === 'connection/closed').length, 0);
  await f.request('respond', question, { text: 'Continue' });
  assert.deepEqual(codex.answers, [{ nativeId: 5, result: { text: 'Continue' } }]);
  const saved = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(f.request('connect', { ...options, providerOptions: { codex: { enabled: false }, sample: { enabled: true } } }), /this agent’s running tasks/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved); assert.equal(codex.disconnects, 0);
  const sample = f.adapters.get('sample');
  const disabled = await f.request('connect', original);
  assert.equal(disabled.connected, true); assert.equal(sample.disconnects, 1); assert.equal(codex.disconnects, 0);
  f.intervals[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapters.get('sample'), sample); assert.equal(f.connection.describe('sample').enabled, false);
});

test('an agent enable failure is saved and reported without disconnecting unrelated running work', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const options = { mode: 'local', localCwd: f.directory, providerOptions: { sample: { enabled: false } } };
  await f.request('connect', options);
  const codex = f.adapters.get('codex'), session = f.connection.session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'working', turn: { id: 'turn' } } });
  f.connectErrors.set('sample', new Error('Sample is unavailable'));
  const result = await f.request('connect', { ...options, providerOptions: { sample: { enabled: true } } });
  assert.equal(result.connected, true); assert.equal(result.options.agents.find(agent => agent.id === 'sample').error, 'Sample is unavailable');
  assert.equal(result.options.agents.find(agent => agent.id === 'sample').enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).providerOptions.sample.enabled, true);
  assert.equal(f.connection.session, session); assert.equal(f.adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
  assert.equal(f.notifications.filter(message => message.method === 'connection/closed').length, 0);
});

test('failed agent settings writes leave runtime flags and unrelated running work unchanged', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const original = { mode: 'local', localCwd: f.directory, providerOptions: { sample: { enabled: false } } };
  await f.request('connect', original);
  const saved = fs.readFileSync(f.file, 'utf8'), codex = f.adapters.get('codex'), session = f.connection.session;
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'working', turn: { id: 'turn' } } });
  const next = { ...original, providerOptions: { sample: { enabled: true } } };
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (file === f.file + '.tmp') throw Object.assign(new Error('Settings disk is full'), { code: 'ENOSPC' });
    return write(file, ...args);
  };
  try { await assert.rejects(f.request('connect', next), /Settings disk is full/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  const sample = f.request('settings').agents.find(agent => agent.id === 'sample');
  assert.equal(sample.enabled, false); assert.equal(sample.connected, false);
  assert.equal(f.connection.describe('sample').enabled, false); assert.equal(f.adapters.has('sample'), false);
  assert.equal(f.connection.session, session); assert.equal(f.adapters.get('codex'), codex); assert.equal(codex.disconnects, 0);
  assert.equal(f.notifications.filter(message => message.method === 'connection/closed').length, 0);
  const result = await f.request('connect', next);
  assert.equal(result.options.agents.find(agent => agent.id === 'sample').connected, true);
  assert.equal(codex.disconnects, 0);
});
