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
const links = require('../links.cjs');
const conversationModule = require('../conversation-state.cjs');
const { stateKey } = require('../sync-state.cjs');

async function fixture(t, saved, ids = ['codex'], savedPreferences) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-startup-'));
  const file = path.join(directory, 'connection.json');
  if (saved !== undefined) fs.writeFileSync(file, saved);
  if (savedPreferences !== undefined) fs.writeFileSync(path.join(directory, 'preferences.json'), JSON.stringify(savedPreferences));
  const app = new EventEmitter(), ipcMain = new EventEmitter();
  const windows = [], exits = [], attempts = [], errors = [], notifications = [], intervals = [], openedURLs = [], adapters = new Map(), handlers = new Map(), connectErrors = new Map();
  const menus = [], copied = [], revealed = [], menuErrors = [];
  let connection, conversations;
  class ConversationState extends conversationModule.ConversationState {
    constructor(options) { super(options); conversations = this; }
  }
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), getPath: () => directory, getVersion: () => 'test', getApplicationNameForProtocol: () => 'Test editor', exit: code => exits.push(code), dock: { setIcon() {} } });
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
        id, name: id, methods: [...providers.rendererMethods, 'fs/readFile'],
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
  const electron = {
    app, ipcMain, BrowserWindow, powerMonitor: new EventEmitter(), powerSaveBlocker: { start: () => 1, stop() {} },
    Menu: { buildFromTemplate: template => ({ popup: () => menus.push(Array.from(template)) }), setApplicationMenu() {} },
    shell: { openExternal: async url => { openedURLs.push(url); }, showItemInFolder: file => revealed.push(file) },
    clipboard: { writeText: text => copied.push(text) },
    dialog: { showErrorBox: (title, message) => menuErrors.push({ title, message }) }
  };
  const main = path.resolve(__dirname, '../main.cjs'), realRequire = createRequire(main);
  t.after(() => { app.emit('before-quit'); fs.rmSync(directory, { recursive: true, force: true }); });
  vm.runInNewContext(fs.readFileSync(main, 'utf8'), {
    require: name => name === 'electron' ? electron : name === './agent-pool.cjs' ? { ...pool, AgentPool: Connection } : name === './conversation-state.cjs' ? { ...conversationModule, ConversationState } : name === './links.cjs' ? { ...links, openFileLink: (value, options) => links.openFileLink(value, { ...options, sshHost: async settings => settings.host }) } : realRequire(name),
    __dirname: path.dirname(main), process: { platform: process.platform, argv: [] },
    console: { error: error => errors.push(String(error)) }, Buffer, setInterval: (...args) => { intervals.push(args[0]); return setInterval(...args); }, clearInterval, setImmediate
  }, { filename: main });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []); assert.deepEqual(exits, []); assert.equal(windows.length, 1);
  const event = { sender: windows[0].webContents, senderFrame: { url: pathToFileURL(windows[0].file).href } };
  return { file, directory, attempts, adapters, connection, conversations, notifications, intervals, openedURLs, connectErrors, menus, copied, revealed, menuErrors, quit: () => app.emit('before-quit'), send: (name, ...args) => { const request = { ...event }; ipcMain.emit(name, request, ...args); return request.returnValue; }, request: (name, ...args) => handlers.get(name)(event, ...args) };
}

test('file-link menu reveals existing local files and retains copy-only behavior for other links', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'local file.txt');
  fs.writeFileSync(file, 'hello');
  const context = { machine: 'access:local', cwd: '/old/project', threadId: 'mapped-chat' };
  f.conversations.fileMapping = threadId => threadId === context.threadId ? { root: f.directory, roots: ['/old/project'] } : null;
  await f.request('link-menu', 'local%20file.txt#L11C3', context);
  const menu = f.menus.at(-1);
  assert.deepEqual(menu.map(item => item.label), ['Copy link', 'Open containing folder']);
  menu[0].click(); await menu[1].click();
  assert.deepEqual(f.copied, [file + ':11:3']);
  assert.deepEqual(f.revealed, [file]);

  for (const link of ['https://example.com/a', 'missing.txt', '.']) {
    await f.request('link-menu', link, context);
    assert.deepEqual(f.menus.at(-1).map(item => item.label), ['Copy link']);
  }
  await f.request('connect', { mode: 'ssh', host: 'user@fixture-host', port: 22, cwd: '/remote/project' });
  await menu[1].click();
  assert.deepEqual(f.revealed, [file]);
  assert.match(f.menuErrors.at(-1).message, /machine changed/);
  await f.request('link-menu', pathToFileURL(file).href, { machine: 'access:user@fixture-host:22', cwd: '/remote/project' });
  assert.deepEqual(f.menus.at(-1).map(item => item.label), ['Copy link']);
});

test('a shortcut move keeps the old order until the outbox saves, including on a full disk', async t => {
  const initial = [{ id: 'a', label: 'A', prompt: 'Prompt A' }, { id: 'b', label: 'B', prompt: 'Prompt B' }, { id: 'c', label: 'C', prompt: 'Prompt C' }];
  const saved = { theme: 'system', startupProjects: {}, shortcuts: initial };
  const f = await fixture(t, undefined, ['codex'], saved);
  const { sync, shared } = f.conversations;
  Object.defineProperty(shared, 'enabled', { value: true, configurable: true });
  sync.soon = () => {};
  sync.load();
  const key = stateKey('shortcuts', 'access:local', 'shortcuts');
  await sync.applyEntry({ key, kind: 'shortcuts', machine: 'access:local', id: 'shortcuts', value: initial, revision: 1 });
  sync.save();
  sync.capture('pin', 'access:local', 'another-chat', true);
  const previousPending = structuredClone(sync.state.pending);
  const preferencesFile = path.join(f.directory, 'preferences.json');
  const outbox = sync.file + '.outbox', open = fs.openSync, write = fs.writeFileSync;
  let diskFull = false;
  const outboxOpen = t.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === outbox + '.tmp') diskFull = true;
    return open(...args);
  });
  const failedWrite = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (diskFull) throw Object.assign(new Error('Disk full writing shortcut outbox'), { code: 'ENOSPC' });
    return write(...args);
  });
  const move = { shortcutMove: { id: 'a', targetId: 'b', after: true } };
  assert.throws(() => f.request('save-preferences', move), { code: 'ENOSPC' });
  assert.equal(failedWrite.mock.callCount(), 2, 'A failed outbox save attempted another disk write to restore preferences');
  outboxOpen.mock.restore(); failedWrite.mock.restore();
  assert.deepEqual(f.request('preferences').shortcuts, initial);
  assert.equal(fs.existsSync(preferencesFile + '.tmp'), false);
  assert.deepEqual(sync.state.pending, previousPending);
  const reloaded = new sync.constructor({ directory: sync.directory, shared, apply: sync.apply });
  reloaded.load();
  assert.deepEqual(reloaded.state.pending, previousPending);
  const rename = fs.renameSync;
  const failedPublish = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === preferencesFile) throw new Error('Could not replace preferences');
    return rename(from, to);
  });
  const firstMove = [initial[1], initial[0], initial[2]];
  const queued = f.request('save-preferences', move);
  assert.equal(queued.shortcutMoveQueued, true);
  assert.deepEqual(queued.shortcuts, firstMove);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, 'utf8')).shortcuts, initial);
  assert.deepEqual(f.request('preferences').shortcuts, firstMove);
  const latest = [initial[1], initial[2], initial[0]];
  assert.deepEqual(f.request('save-preferences', { shortcutMove: { id: 'c', targetId: 'a', after: false } }).shortcuts, latest);
  const restarted = new sync.constructor({ directory: sync.directory, shared, apply: sync.apply, applyShortcutMove: sync.applyShortcutMove });
  restarted.load();
  assert.deepEqual(restarted.pendingShortcutMove()?.value, latest);

  const pushed = [];
  shared.online = async () => {};
  t.mock.method(shared.bridge, 'call', async (method, params) => {
    if (method === 'state-pull') return { entries: [], cursor: 0, more: false };
    assert.equal(method, 'state-push');
    pushed.push(...params.operations);
    return params.operations.map(op => ({ opId: op.opId, revision: 2 }));
  });
  await sync.tick();
  assert.deepEqual(pushed.map(op => op.kind), ['pin'], 'An unwritable shortcut order blocked other sync or reached the server before saving locally');
  assert.deepEqual(f.request('preferences').shortcuts, latest);
  assert.equal(f.request('preferences').shortcutMoveQueued, true);
  failedPublish.mock.restore();

  Object.defineProperty(shared, 'enabled', { value: false });
  await f.conversations.tick();
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, 'utf8')).shortcuts, latest);
  assert.equal(f.request('preferences').shortcutMoveQueued, undefined);
  assert.deepEqual(sync.pendingShortcutMove()?.value, latest);
  Object.defineProperty(shared, 'enabled', { value: true });
  await sync.tick();
  assert.deepEqual(pushed.filter(op => op.kind === 'shortcuts').map(op => op.value), [latest]);
  assert.equal(sync.pendingShortcutMove(), null);
});

test('changed-file link IPC clamps remote lines through the owning provider and blocks malformed or stale reads', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  const options = { mode: 'ssh', host: 'user@fixture-host', port: 22, cwd: '/srv/project' };
  await f.request('connect', options);
  const context = { machine: 'access:user@fixture-host:22', provider: 'sample', cwd: '/srv/project', clampLine: true };
  const reads = [];
  let dataBase64 = Buffer.from('first\r\nsecond\rthird').toString('base64');
  f.adapters.get('codex').call = async () => { throw new Error('The file read reached the wrong provider'); };
  f.adapters.get('sample').call = async (method, params) => { reads.push({ method, params: { ...params } }); return { dataBase64 }; };
  await f.request('open-link', 'changed.ts:99:17', context);
  assert.deepEqual(reads, [{ method: 'fs/readFile', params: { path: '/srv/project/changed.ts' } }]);
  assert.equal(f.openedURLs[0], 'vscode://vscode-remote/ssh-remote+user%40fixture-host/srv/project/changed.ts:3:1');
  dataBase64 = '';
  await f.request('open-link', 'empty.ts:99:17', context);
  assert.equal(f.openedURLs[1], 'vscode://vscode-remote/ssh-remote+user%40fixture-host/srv/project/empty.ts:1:1');
  await f.request('open-link', 'explicit.ts:99:17', { ...context, clampLine: 'true' });
  assert.equal(reads.length, 2);
  assert.equal(f.openedURLs[2], 'vscode://vscode-remote/ssh-remote+user%40fixture-host/srv/project/explicit.ts:99:17');
  dataBase64 = 'not-valid-base64';
  await assert.rejects(f.request('open-link', 'malformed.ts:99', context), /Could not read the current file/);
  assert.equal(f.openedURLs.length, 3);
  const beforeStale = reads.length;
  await assert.rejects(async () => f.request('open-link', 'stale.ts:99', { ...context, machine: 'access:other-host:22' }), /machine changed/);
  assert.equal(reads.length, beforeStale);
  assert.equal(f.openedURLs.length, 3);

  let resolveRead;
  f.adapters.get('sample').call = (_method, _params) => new Promise(resolve => { resolveRead = resolve; });
  const pending = f.request('open-link', 'pending.ts:99', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveRead, 'function');
  await f.request('connect', { ...options, host: 'other-host' });
  resolveRead({ dataBase64: Buffer.from('first\nsecond').toString('base64') });
  await assert.rejects(pending, /connection changed|machine changed/i);
  assert.equal(f.openedURLs.length, 3);
});

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

test('scheduled editors require a matching edit lock and machine, preserve settings, and reject stale saves', async t => {
  const f = await fixture(t);
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const thread = { id: 'edit-scheduled-chat', cwd: f.directory };
  const message = { machine: 'access:local', thread, text: 'Original', images: [], input: [{ type: 'text', text: 'Original' }], access: { sandbox: 'read-only', approvalPolicy: 'on-request' }, mode: 'default', turnSettings: { threadId: thread.id, model: 'original-model' } };
  const task = f.request('schedule-message', message, 1);
  assert.throws(() => f.request('scheduled-task', task.id), /Reopen/);
  const lock = f.request('edit-lock', thread.id);
  const saved = f.request('scheduled-task', task.id, lock);
  assert.deepEqual(saved.message.turnSettings, message.turnSettings);
  const patch = { text: 'Edited', runAt: new Date(Date.now() + 7200000).toISOString(), skills: [] };
  assert.throws(() => f.request('edit-scheduled-task', task.id, patch, 'wrong-lock'), /Reopen/);
  const updated = f.request('edit-scheduled-task', task.id, patch, lock);
  assert.equal(updated.id, task.id); assert.equal(updated.prompt, 'Edited');
  assert.deepEqual(updated.message.turnSettings, message.turnSettings);
  f.request('edit-lock', thread.id, lock);
  assert.throws(() => f.request('edit-scheduled-task', task.id, patch, lock), /Reopen/);
  const anotherLock = f.request('edit-lock', thread.id);
  await f.request('connect', { mode: 'ssh', host: 'another-test-server' });
  assert.throws(() => f.request('scheduled-task', task.id, anotherLock), /original machine/);
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


test('reading later history clears its older visible completion without clearing unseen new turns', async t => {
  const f = await fixture(t);
  const { SharedScheduleDatabase } = require('../shared-schedules-host.cjs');
  const database = new SharedScheduleDatabase(path.join(f.directory, 'markers.sqlite'));
  t.after(() => database.close());
  const machine = 'access:local', id = 'read-chat'; let sequence = 0, receipt;
  const current = () => database.request('state-get', { kind: 'completion', machine, id }, 'test-device').result;
  const publish = (value, observedTurn) => database.request('state-push', { operations: [{ kind: 'completion', machine, id, value, observedTurn, opId: 'marker-' + ++sequence, base: current()?.revision || 0 }] }, 'test-device').result[0];
  f.conversations.catalog = () => current()?.value;
  f.conversations.sync.capture = (_kind, _machine, _id, value, _seed, observedTurn) => { receipt = publish(value, observedTurn); };
  publish({ status: 'completed', turnId: 'older-visible-turn' });
  const seen = ['older-visible-turn', 'newest-visible-turn'];
  const ack = f.send('save-conversation-state', { machine }, { field: 'completion', threadId: id, value: null, turnId: 'newest-visible-turn', seenTurnIds: seen });
  assert.equal(ack.ok, true); assert.equal(receipt.conflict, undefined);
  assert.equal(current().value, null);
  publish({ status: 'completed', turnId: 'new-unseen-turn' });
  const stale = f.send('save-conversation-state', { machine }, { field: 'completion', threadId: id, value: null, turnId: 'newest-visible-turn', seenTurnIds: seen });
  assert.equal(stale.ok, true); assert.equal(receipt.conflict, true);
  assert.equal(current().value.turnId, 'new-unseen-turn');
  const before = sequence;
  for (const seenTurnIds of ['bad', [null], [''], ['x'.repeat(201)], Array(1001).fill('a-turn')]) {
    const invalid = f.send('save-conversation-state', { machine }, { field: 'completion', threadId: id, value: null, seenTurnIds });
    assert.match(invalid.error, /Invalid observed conversation turns/);
  }
  assert.equal(sequence, before);
});

test('app restart recovers interrupted run markers per machine and provider without resuming conversations', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const codex = f.adapters.get('codex'), sample = f.adapters.get('sample');
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'working-chat', turn: { id: 'old-turn' } } });
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'working-chat', turn: { id: 'current-turn' } } });
  codex.emit('notification', { method: 'turn/completed', params: { threadId: 'working-chat', turn: { id: 'old-turn', status: 'completed' } } });
  sample.emit('notification', { method: 'turn/started', params: { threadId: 'sample-chat', turn: { id: 'sample-turn' } } });
  codex.emit('notification', { method: 'turn/started', params: { threadId: 'finished-chat', turn: { id: 'finished-turn' } } });
  codex.emit('notification', { method: 'turn/completed', params: { threadId: 'finished-chat', turn: { id: 'finished-turn', status: 'completed' } } });
  const ack = f.send('save-conversation-state', { machine: 'access:local' }, { field: 'completion', threadId: 'working-chat', value: null });
  assert.equal(ack.ok, true);
  assert.equal(f.request('preferences').activeRuns['access:local']['working-chat'].turnId, 'current-turn');
  f.quit();
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'preferences.json'), 'utf8'));
  const restarted = await fixture(t, undefined, ['codex', 'sample'], saved), recovered = restarted.request('preferences');
  assert.equal(recovered.conversationStates['access:local'].completions['working-chat'], 'interrupted');
  assert.equal(recovered.conversationStates['access:local'].completions['agent:sample:thread:sample-chat'], 'interrupted');
  assert.equal(recovered.conversationStates['access:local'].completions['finished-chat'], undefined);
  assert.equal(recovered.activeRuns, undefined); assert.deepEqual(restarted.attempts, []);
  const cleared = restarted.send('save-conversation-state', { machine: 'access:local' }, { field: 'completion', threadId: 'working-chat', value: null, turnId: 'current-turn' });
  assert.equal(cleared.ok, true);
  assert.equal(restarted.request('preferences').conversationStates['access:local'].completions['working-chat'], undefined);
  assert.equal(restarted.request('preferences').conversationStates['access:local'].completions['agent:sample:thread:sample-chat'], 'interrupted');
});

test('accepted RPC run results are durable while early completions and shared servers cannot create restart false positives', async t => {
  const f = await fixture(t);
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const adapter = f.adapters.get('codex');
  const rpc = (phase, threadId, turnId, requestId) => adapter.emit('rpc', { phase, requestId, method: 'turn/start', threadId, ...(phase === 'finished' ? { result: { turn: { id: turnId, status: 'inProgress' } } } : {}) });
  rpc('started', 'accepted-chat', 'accepted-turn', 1); rpc('finished', 'accepted-chat', 'accepted-turn', 1);
  assert.equal(f.request('preferences').activeRuns['access:local']['accepted-chat'].turnId, 'accepted-turn');
  rpc('started', 'fast-chat', 'fast-turn', 2);
  adapter.emit('notification', { method: 'turn/completed', params: { threadId: 'fast-chat', turn: { id: 'fast-turn', status: 'completed' } } });
  rpc('finished', 'fast-chat', 'fast-turn', 2);
  adapter.emit('notification', { method: 'turn/started', params: { threadId: 'fast-chat', turn: { id: 'fast-turn' } } });
  assert.equal(f.request('preferences').activeRuns['access:local']['fast-chat'], undefined);
  assert.equal(adapter.disconnects, 0);
  const shared = await fixture(t);
  await shared.request('connect', { mode: 'ssh', host: 'fixture-shared-host', sharedServer: true });
  shared.adapters.get('codex').emit('notification', { method: 'turn/started', params: { threadId: 'surviving-chat', turn: { id: 'surviving-turn' } } });
  assert.equal(shared.request('preferences').activeRuns, undefined);
});

test('explicit edits repair context before reverting and leave history intact if repair fails', async t => {
  const f = await fixture(t);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const shared = f.conversations.shared, history = f.conversations.history, calls = [];
  Object.defineProperty(shared, 'enabled', { value: true });
  shared.lock = async () => 'edit-token';
  shared.verify = async token => { assert.equal(token, 'edit-token'); calls.push('lock'); };
  history.verify = async () => {};
  history.repairReasoning = async id => { assert.equal(id, 'edited-chat'); calls.push('repair'); };
  f.conversations.catalog = () => null;
  f.conversations.threadBinding = () => null;
  f.adapters.get('codex').call = async method => { calls.push(method); return {}; };
  await f.request('edit-lock', 'edited-chat');
  await f.request('rpc', 'thread/revert', { threadId: 'edited-chat', beforeTurnId: 'old-turn' }, { repairReasoning: true });
  assert.deepEqual(calls, ['lock', 'repair', 'lock', 'thread/revert']);
  calls.length = 0;
  history.repairReasoning = async () => { throw new Error('Repair could not be saved'); };
  await assert.rejects(f.request('rpc', 'thread/revert', { threadId: 'edited-chat', beforeTurnId: 'old-turn' }, { repairReasoning: true }), /Repair could not be saved/);
  assert.deepEqual(calls, ['lock']);
});

test('recovery IPC forwards exact Stop identity and operation type, cancels only through the history server and retries metadata without inference', async t => {
  const f = await fixture(t);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const calls = [], history = f.conversations.history;
  Object.defineProperty(f.conversations.shared, 'enabled', { value: true });
  Object.defineProperty(history, 'enabled', { value: true });
  history.verify = async (...args) => { calls.push({ method: 'verify', args }); };
  history.begin = async (...args) => { calls.push({ method: 'begin', args }); return { id: args[0] }; };
  history.started = async () => {};
  history.cancelRequest = async id => { calls.push({ method: 'cancel', id }); };
  f.conversations.threadBinding = () => null; f.conversations.catalog = () => null;
  f.conversations.status = () => ({ ownership: [] });
  f.adapters.get('codex').call = async (method, params) => { calls.push({ method, params }); return method === 'turn/interrupt' ? {} : { turn: { id: 'accepted-turn', status: 'completed' } }; };
  for (const method of ['turn/start', 'review/start', 'thread/compact/start']) await f.request('rpc', method, { threadId: 'owned-chat', ...(method === 'review/start' ? { delivery: 'inline' } : {}) }, { repairReasoning: true });
  assert.deepEqual(calls.filter(call => call.method === 'begin').map(call => structuredClone(call.args)), [['owned-chat', 'turn/start', { repairReasoning: true }], ['owned-chat', 'review/start', { repairReasoning: false, delivery: 'inline' }], ['owned-chat', 'thread/compact/start', { repairReasoning: false }]]);
  await f.request('rpc', 'review/start', { threadId: 'owned-chat', delivery: 'detached' });
  assert.deepEqual(structuredClone(calls.filter(call => call.method === 'begin').at(-1).args), ['owned-chat', 'review/start', { repairReasoning: false, delivery: 'detached' }]);
  await f.request('rpc', 'turn/start', { threadId: 'owned-chat' });
  await f.request('rpc', 'turn/start', { threadId: 'owned-chat' }, { repairReasoning: false });
  assert.deepEqual(calls.filter(call => call.method === 'begin').slice(-2).map(call => structuredClone(call.args)), [['owned-chat', 'turn/start', { repairReasoning: false }], ['owned-chat', 'turn/start', { repairReasoning: false }]]);
  await f.request('rpc', 'turn/interrupt', { threadId: 'owned-chat', turnId: 'exact-current-turn' });
  assert.deepEqual(calls.find(call => call.method === 'verify').args, ['owned-chat', true, 'exact-current-turn']);
  const beforeCancel = calls.length;
  await f.request('cancel-conversation-request', 'owned-chat');
  assert.deepEqual(calls.slice(beforeCancel), [{ method: 'cancel', id: 'owned-chat' }]);
  f.connection.disconnect();
  await f.request('cancel-conversation-request', 'owned-chat');
  assert.deepEqual(calls.at(-1), { method: 'cancel', id: 'owned-chat' }, 'server-only cancellation must remain available without a native agent');
  history.cancelRequest = async () => { throw new Error('Only the requester can cancel'); };
  await assert.rejects(f.request('cancel-conversation-request', 'owned-chat'), /Only the requester/);
  await assert.rejects(f.request('cancel-conversation-request', ''), /Select a local Codex/);
  let retried;
  f.conversations.sync.retry = key => { retried = key; return []; };
  const key = JSON.stringify(['note', 'access:local', 'owned-chat']);
  assert.deepEqual(f.request('retry-conversation-sync', key), []); assert.equal(retried, key);
  assert.throws(() => f.request('retry-conversation-sync', '["note"]'), /Invalid sync item/);
});

test('saved edit draft recovery is scoped to the selected machine and conversation', async t => {
  const f = await fixture(t);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const target = { machine: 'access:local', kind: 'edit-message', cwd: f.directory, threadId: 'recover-chat', itemId: 'removed-message' };
  for (const [draft, text] of [
    [target, 'Retained edit text'],
    [{ ...target, threadId: 'other-chat' }, 'Different conversation'],
    [{ ...target, machine: 'access:other-host:22' }, 'Different computer'],
    [{ ...target, kind: 'composer', itemId: null }, 'Existing composer draft']
  ]) assert.equal(f.send('save-draft', draft, { text }).error, undefined);
  const edits = await f.request('edit-drafts', target.threadId);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, 'Retained edit text');
  assert.equal(typeof edits[0].updatedAt, 'number');
  assert.equal(f.send('last-draft', target.machine).value.draft.text, 'Existing composer draft');
  await assert.rejects(async () => f.request('edit-drafts', ''), /Invalid conversation/);
});

test('atomic provider edits require the editor lock and route only to the owning provider', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const threadId = pool.agentId('sample', 'thread', 'native-edit-chat');
  const params = {
    threadId,
    beforeTurnId: pool.agentId('sample', 'turn', 'before-edit'),
    itemId: pool.agentId('sample', 'item', 'editable-query'),
    input: [{ type: 'text', text: 'Revised query' }]
  };
  const calls = [];
  f.adapters.get('sample').call = async (method, native) => {
    calls.push(method);
    assert.equal(native.threadId, 'native-edit-chat');
    assert.equal(native.beforeTurnId, 'before-edit');
    assert.equal(native.itemId, 'editable-query');
    return { thread: { id: native.threadId }, turn: { id: 'replacement-turn', status: 'inProgress' } };
  };
  await assert.rejects(f.request('rpc', 'thread/edit', params), /Reopen the message editor/);
  const lock = await f.request('edit-lock', threadId);
  const result = await f.request('rpc', 'thread/edit', params);
  await f.request('edit-lock', threadId, lock);
  await assert.rejects(f.request('rpc', 'thread/edit', params), /Reopen the message editor/);
  assert.deepEqual(calls, ['thread/edit']);
  assert.equal(result.thread.id, threadId);
  assert.equal(result.turn.id, pool.agentId('sample', 'turn', 'replacement-turn'));
});

test('providers without native archive support use a durable app archive and keep native history', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const native = { id: 'app-archive', name: 'Archive this provider chat', status: { type: 'idle' } };
  const id = pool.agentId('sample', 'thread', native.id), calls = [];
  let queuedMessageCount = 0;
  f.connection.registry.sample.methods = f.connection.registry.sample.methods.filter(method => method !== 'thread/archive');
  f.adapters.get('sample').call = async method => {
    calls.push(method);
    if (method === 'thread/read') return { thread: native, queuedMessageCount };
    if (method === 'thread/list') return { data: [native], nextCursor: null };
    throw new Error('App archiving must not call the native ' + method);
  };
  await f.request('rpc', 'thread/archive', { threadId: id });
  assert.deepEqual(calls, ['thread/read']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'preferences.json'))).archivedThreads['access:local'], [id]);
  assert.deepEqual((await f.request('rpc', 'thread/list', { provider: 'sample' })).data, []);
  native.id = 'running-chat'; native.status.type = 'active';
  await assert.rejects(f.request('rpc', 'thread/archive', { threadId: pool.agentId('sample', 'thread', native.id) }), /Stop the running/);
  native.id = 'queued-chat'; native.status.type = 'idle'; queuedMessageCount = 1;
  const queuedId = pool.agentId('sample', 'thread', native.id);
  f.request('set-pin', queuedId, true);
  await assert.rejects(f.request('rpc', 'thread/archive', { threadId: queuedId }), /Send or remove queued messages/);
  assert.ok(f.request('pins').includes(queuedId));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'preferences.json'))).archivedThreads['access:local'], [id]);

  queuedMessageCount = 0;
  const { shared } = f.conversations;
  Object.defineProperty(shared, 'enabled', { value: true });
  shared.summaries = () => [];
  let releaseRefresh;
  shared.refresh = () => new Promise(resolve => { releaseRefresh = resolve; });
  const pending = f.request('rpc', 'thread/archive', { threadId: queuedId });
  await new Promise(resolve => setImmediate(resolve));
  native.status.type = 'active'; releaseRefresh();
  await assert.rejects(pending, /Stop the running/);
  assert.ok(f.request('pins').includes(queuedId));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'preferences.json'))).archivedThreads['access:local'], [id]);
  const stale = f.request('rpc', 'thread/archive', { threadId: queuedId });
  await new Promise(resolve => setImmediate(resolve));
  const beforeStale = calls.length;
  f.connection.session = {}; releaseRefresh();
  await assert.rejects(stale, /Conversation connection changed/);
  assert.equal(calls.length, beforeStale);
});

test('archiving a missing local chat saves its shared tombstone without loading history or hiding native permission failures', async t => {
  const f = await fixture(t);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const { history, shared, sync } = f.conversations, calls = [], captured = [];
  Object.defineProperty(shared, 'enabled', { value: true });
  Object.defineProperty(history, 'enabled', { value: true });
  shared.refresh = async () => {}; shared.summaries = () => [];
  history.verify = async (id, stop, turn, options) => { assert.equal(options?.loadHistory, false); calls.push(id); };
  sync.capture = (...args) => captured.push(args);
  f.adapters.get('codex').call = async method => { assert.equal(method, 'thread/archive'); throw new Error('thread not loaded: empty-chat'); };
  await f.request('rpc', 'thread/archive', { threadId: 'empty-chat' });
  assert.deepEqual(calls, ['empty-chat']);
  assert.deepEqual(captured, [['thread', 'access:local', 'empty-chat', null]]);
  captured.length = 0;
  f.adapters.get('codex').call = async () => { throw new Error('Permission denied'); };
  await assert.rejects(f.request('rpc', 'thread/archive', { threadId: 'protected-chat' }), /Permission denied/);
  assert.equal(captured.length, 0);
  f.adapters.get('codex').call = async () => { throw new Error('thread not loaded: empty-chat'); };
  sync.capture = () => { throw new Error('Disk full'); };
  await assert.rejects(f.request('rpc', 'thread/archive', { threadId: 'empty-chat' }), /Disk full/);
});

test('native errors and restored failed turns record repair hints without starting or resending tasks', async t => {
  const f = await fixture(t, undefined, ['codex', 'sample']);
  f.conversations.tick = async () => {};
  await f.request('connect', { mode: 'local', localCwd: f.directory });
  const hints = [], calls = [], history = f.conversations.history;
  history.observeError = (id, error) => hints.push({ id, error });
  const error = { message: 'native encrypted reasoning error' };
  f.adapters.get('codex').emit('notification', { method: 'error', params: { threadId: 'native-chat', error } });
  f.adapters.get('codex').emit('notification', { method: 'turn/completed', params: { threadId: 'failed-chat', turn: { id: 'failed', status: 'failed', error } } });
  f.adapters.get('codex').emit('notification', { method: 'turn/completed', params: { threadId: 'healthy-chat', turn: { id: 'healthy', status: 'completed', error } } });
  f.adapters.get('sample').emit('notification', { method: 'error', params: { threadId: 'sample-chat', error } });
  f.adapters.get('codex').call = async (method, params) => { calls.push({ method, params }); return { data: [{ id: 'failed', status: 'failed', error }, { id: 'completed', status: 'completed', error }], nextCursor: null }; };
  await f.request('rpc', 'thread/turns/list', { threadId: 'restored-chat', limit: 25 });
  assert.deepEqual(hints.map(hint => hint.id), ['native-chat', 'failed-chat', 'restored-chat']);
  assert.ok(hints.every(hint => hint.error === error));
  assert.deepEqual(calls.map(call => call.method), ['thread/turns/list']);
});
