const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, shell, clipboard, powerMonitor, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { connectionKey, rendererMethods } = require('./providers.cjs');
const { AgentPool, agentTarget, poolOptions: connectionOptions } = require('./agent-pool.cjs');
const { PinStore } = require('./pins.cjs');
const { QueueStore } = require('./queues.cjs');
const { PreferencesStore } = require('./preferences.cjs');
const { readImage } = require('./images.cjs');
const { openWebLink, openFileLink, parseFileLink } = require('./links.cjs');
const { generateTitle, titleKey, readThreadForTitle } = require('./titles.cjs');
const { ScheduleStore, Scheduler } = require('./scheduler.cjs');
const { DiagnosticLog, TurnDiagnostics } = require('./diagnostics.cjs');
const { DraftStore, registerDraftIpc } = require('./drafts.cjs');
const { AgentWakeLock } = require('./wake-lock.cjs');

const connection = new AgentPool();
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const methods = new Set(rendererMethods);
let window;
let settings;
let settingsError = null;
const manualNames = new Set();
let titleQueue = Promise.resolve();
const smoke = process.argv.includes('--smoke-test');
const localSmoke = smoke && process.argv.includes('--local');
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), localSmoke ? 'remote-codex-local-smoke' : 'remote-codex-smoke'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });

function checkSender(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('Untrusted caller.');
}

app.whenReady().then(async () => {
  const agents = new Map();
  connection.on('connection', ({ provider, connection: driver }) => {
    const wakeLock = new AgentWakeLock(powerSaveBlocker, driver, working => driver.emit('diagnostic', { event: 'power.keep-awake', details: { working } }));
    agents.set(provider, { wakeLock, diagnostics: new TurnDiagnostics(driver) });
  });
  app.on('before-quit', () => { for (const agent of agents.values()) agent.wakeLock.clear(); });
  const diagnostic = new DiagnosticLog(path.join(app.getPath('userData'), 'logs'));
  diagnostic.write('app.started', { version: app.getVersion() });
  connection.on('diagnostic', entry => diagnostic.write(entry.event, entry.details));
  const diagnosticTimer = setInterval(() => { for (const agent of agents.values()) agent.diagnostics.check(); }, 15000); diagnosticTimer.unref();
  app.on('before-quit', () => clearInterval(diagnosticTimer));
  for (const event of ['suspend', 'resume']) powerMonitor.on(event, () => diagnostic.write('power.' + event));
  ipcMain.on('diagnostic', (event, name, details) => {
    try { checkSender(event); diagnostic.write('renderer.' + name, details); }
    catch (error) { diagnostic.write('renderer.log.rejected', { error: error.message }); }
  });
  const settingsFile = path.join(app.getPath('userData'), 'connection.json');
  settings = connectionOptions({ mode: 'local' }, connection.registry);
  try { settings = connectionOptions(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), connection.registry); } catch (error) {
    if (error.code !== 'ENOENT') {
      settingsError = `Saved connection settings could not be loaded: ${error.message}`;
      diagnostic.write('settings.load.failed', { error: error.message });
    }
  }
  if (smoke) settings = connectionOptions({ mode: localSmoke ? 'local' : 'ssh' }, connection.registry);
  const pins = new PinStore(path.join(app.getPath('userData'), 'pins.json'));
  const queues = new QueueStore(path.join(app.getPath('userData'), 'queues'));
  const drafts = new DraftStore(path.join(app.getPath('userData'), 'drafts'));
  registerDraftIpc(ipcMain, drafts, checkSender, error => diagnostic.write('draft.failed', { error: error.message }));
  const preferences = new PreferencesStore(path.join(app.getPath('userData'), 'preferences.json'));
  const schedules = new ScheduleStore(path.join(app.getPath('userData'), 'schedules.json'));
  const editLocks = new Map();
  ipcMain.handle('edit-lock', (event, threadId, token) => {
    checkSender(event);
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('Invalid conversation.');
    if (token) { if (editLocks.get(threadId) === token) editLocks.delete(threadId); return; }
    if (!connection.ready) throw new Error('Connect to a coding agent first.');
    if (editLocks.has(threadId) || scheduler.dispatching.has(threadId)) throw new Error('This conversation is busy; try editing after the task finishes.');
    const lock = randomUUID(); editLocks.set(threadId, lock); return lock;
  });
  const schedulesChanged = () => { if (window && !window.isDestroyed()) window.webContents.send('notification', { method: 'scheduler/updated', params: {} }); };
  const scheduleMachine = () => connectionKey(settings);
  const publicSettings = () => ({ ...settings, machine: scheduleMachine(), agents: connection.listProviders(settings), settingsError });
  const saveSettings = next => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(settingsFile + '.tmp', settingsFile);
    settings = next; settingsError = null;
  };
  const scheduler = new Scheduler({
    store: schedules, connection, available: () => Boolean(window), machine: scheduleMachine,
    blocked: threadId => editLocks.has(threadId) || queues.hasMessages(scheduleMachine() + ':' + threadId),
    changed: schedulesChanged
  });
  const tickSchedules = () => scheduler.tick().catch(error => {
    console.error('Scheduled task error:', error.message);
    if (window && !window.isDestroyed()) window.webContents.send('notification', { method: 'error', params: { message: `Scheduled task error: ${error.message}` } });
  });
  const recoverAgents = () => { if (connection.ready) connection.recover().catch(error => diagnostic.write('provider.recovery.failed', { error: error.message })); };
  const scheduleTimer = setInterval(() => { tickSchedules(); recoverAgents(); }, 15000); scheduleTimer.unref();
  powerMonitor.on('resume', tickSchedules);
  app.on('before-quit', () => clearInterval(scheduleTimer));
  ipcMain.handle('scheduled-tasks', event => { checkSender(event); return schedules.summaries(); });
  ipcMain.handle('schedule-message', (event, message, hours) => {
    checkSender(event);
    if (!connection.ready || message?.machine !== scheduleMachine()) throw new Error('Connect to the message’s machine before scheduling it.');
    const task = schedules.enqueue(message, hours);
    schedulesChanged(); return task;
  });
  ipcMain.handle('cancel-scheduled-task', (event, id) => { checkSender(event); const task = schedules.cancel(id); schedulesChanged(); return task; });
  ipcMain.handle('preferences', event => { checkSender(event); return preferences.read(); });
  ipcMain.handle('save-preferences', (event, patch) => { checkSender(event); return preferences.update(patch); });
  ipcMain.on('save-conversation-state', (event, conversationState) => {
    try { checkSender(event); preferences.update({ conversationState }); event.returnValue = { ok: true }; }
    catch (error) { event.returnValue = { error: error.message }; }
  });
  ipcMain.handle('queues', event => { checkSender(event); return queues.list(); });
  ipcMain.handle('save-queue', (event, queue) => {
    checkSender(event);
    try { queues.save(queue); diagnostic.write('queue.saved', { machine: queue.machine, threadId: queue.thread.id, queueLength: queue.messages.length, paused: queue.paused }); }
    catch (error) { diagnostic.write('queue.save.failed', { threadId: queue?.thread?.id, error: error.message }); throw error; }
  });
  ipcMain.handle('settings', event => { checkSender(event); return publicSettings(); });
  ipcMain.handle('providers', event => { checkSender(event); return connection.listProviders(settings); });
  ipcMain.handle('read-image', (event, file, context) => { checkSender(event); return readImage(connection.connectionFor(connection.providerFor({}, context)), file); });
  ipcMain.handle('link-menu', (event, href, context) => {
    checkSender(event);
    if (typeof href !== 'string' || !href.trim() || href.length > 8192 || /[\u0000-\u001f\u007f]/.test(href)) throw new Error('Invalid link.');
    let target = href.trim();
    if (!/^https?:/i.test(target)) {
      const { file, line, column } = parseFileLink(target, context?.cwd);
      target = file + (line ? `:${line}${column ? ':' + column : ''}` : '');
    }
    Menu.buildFromTemplate([{ label: 'Copy link', click: () => clipboard.writeText(target) }]).popup({ window });
  });
  let fileOpens = Promise.resolve();
  ipcMain.handle('open-link', (event, href, context) => {
    checkSender(event);
    if (typeof href === 'string' && /^https?:/i.test(href.trim())) return openWebLink(href, url => shell.openExternal(url));
    const options = settings; const session = connection.session;
    const current = () => { if (settings !== options || connection.session !== session || context?.machine !== scheduleMachine()) throw new Error('The conversation’s machine changed. Open the file link again.'); };
    current();
    const opener = preferences.read().fileOpener || 'vscode';
    const opening = fileOpens.then(() => openFileLink(href, {
      cwd: context?.cwd, settings: options, opener, current,
      openExternal: url => shell.openExternal(url), reveal: file => shell.showItemInFolder(file), application: url => app.getApplicationNameForProtocol(url)
    }));
    fileOpens = opening.catch(() => {});
    return opening;
  });
  ipcMain.handle('pins', event => { checkSender(event); return pins.get(settings); });
  ipcMain.handle('set-pin', (event, threadId, pinned) => {
    checkSender(event);
    if (!connection.ready) throw new Error('Connect to a coding agent first.');
    return pins.set(settings, threadId, pinned);
  });
  ipcMain.handle('choose-key', async event => {
    checkSender(event);
    const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'], defaultPath: path.join(app.getPath('home'), '.ssh') });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('connect', async (event, value) => {
    checkSender(event);
    const next = connectionOptions(value, connection.registry);
    const changes = connection.changes(next);
    if (connection.session && !changes.machineChanged) {
      if (changes.providers.some(provider => agents.has(provider) && agents.get(provider).wakeLock.id !== null)) throw new Error('Finish or stop this agent’s running tasks before changing its settings.');
      if (JSON.stringify(next) !== JSON.stringify(settings)) saveSettings(next);
      const result = changes.providers.length ? await connection.reconfigure(next) : await connection.recover();
      setImmediate(tickSchedules);
      return { ...result, connected: connection.ready, options: publicSettings() };
    }
    if ([...agents.values()].some(agent => agent.wakeLock.id !== null)) throw new Error('Finish or stop running tasks before changing the connection.');
    editLocks.clear();
    try {
      const result = await connection.connect(next);
      saveSettings(next);
      setImmediate(tickSchedules);
      return { ...result, options: publicSettings() };
    } catch (error) {
      connection.disconnect();
      connection.emit('notification', { method: 'connection/closed', params: { message: error.message } });
      throw error;
    }
  });
  ipcMain.handle('rpc', async (event, method, params, context) => {
    checkSender(event);
    if (!methods.has(method)) throw new Error('Unsupported agent operation.');
    if (!connection.ready) throw new Error('Connect to a coding agent first.');
    if (scheduler.dispatching.has(params?.threadId) && ['turn/start', 'thread/resume', 'thread/archive', 'thread/revert'].includes(method)) {
      diagnostic.write('rpc.scheduler.busy', { method, threadId: params.threadId });
      throw new Error('A scheduled message is being sent to this chat; try again shortly.');
    }
    if (method === 'thread/archive') {
      if (schedules.list(params.threadId).some(task => (task.machine || 'access:local') === scheduleMachine() && task.status === 'pending')) throw new Error('Cancel scheduled messages before archiving this chat.');
      const options = settings;
      const pinned = pins.get(options).includes(params.threadId);
      if (pinned) pins.set(options, params.threadId, false);
      try { return await connection.call(method, params, undefined, context); }
      catch (error) {
        if (pinned) {
          try { pins.set(options, params.threadId, true); }
          catch (pinError) { throw new Error(`Archive failed: ${error.message}. Could not restore its pin: ${pinError.message}`); }
        }
        throw error;
      }
    }
    if (method === 'thread/name/set') manualNames.add(JSON.stringify([settings.provider, settings.mode, settings.host, settings.port, params.threadId]));
    return connection.call(method, params, undefined, context);
  });
  ipcMain.handle('title', (event, threadId, prompt) => {
    checkSender(event);
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Invalid title request.');
    const options = settings;
    const nameKey = JSON.stringify([options.provider, options.mode, options.host, options.port, threadId]);
    const current = () => connection.ready && settings === options && !manualNames.has(nameKey);
    const task = titleQueue.catch(() => {}).then(async () => {
      if (!current()) return null;
      const before = await readThreadForTitle(connection, threadId, current);
      if (!before || !current()) return null;
      if (before.thread.name) return before.thread.name;
      const name = await generateTitle(prompt, titleKey(app.getPath('userData'), safeStorage));
      if (!current()) return null;
      const latest = await readThreadForTitle(connection, threadId, current);
      if (!latest || !current()) return null;
      if (latest.thread.name) return latest.thread.name;
      if (!current()) return null;
      await connection.call('thread/name/set', { threadId, name });
      return name;
    });
    titleQueue = task;
    return task;
  });
  ipcMain.handle('respond', (event, id, result) => { checkSender(event); return connection.respond(id, result); });
  connection.on('notification', message => {
    if (message.method === 'connection/closed') editLocks.clear();
    if (message.method === 'provider/closed') for (const threadId of editLocks.keys()) if (agentTarget(threadId, 'thread').provider === message.provider) editLocks.delete(threadId);
    if (['turn/started', 'turn/completed', 'thread/status/changed', 'error', 'connection/closed'].includes(message.method)) {
      const params = message.params || {};
      diagnostic.write('native.' + message.method, { provider: message.provider, threadId: params.threadId, turnId: params.turn?.id || params.turnId, status: params.turn?.status || params.status?.type, willRetry: params.willRetry, error: params.turn?.error?.message || params.error?.message || params.message });
    }
    if (message.id !== undefined && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(message.method)) {
      connection.rejectRequest(message.id).catch(error => diagnostic.write('request.decline.failed', { error: error.message }));
      message = { method: 'error', params: { message: `Unsupported agent request declined: ${message.method}` } };
    }
    if (window && !window.isDestroyed()) window.webContents.send('notification', message);
  });
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
  const createWindow = () => {
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 800, minHeight: 580, show: !smoke, title: 'Remote Codex', icon: path.join(__dirname, 'assets/icon.png'), backgroundColor: '#f9f9f6', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.on('render-process-gone', () => editLocks.clear());
    window.loadFile(path.join(__dirname, 'index.html'));
    window.on('closed', () => { editLocks.clear(); connection.disconnect(); window = null; });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Remote Codex', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
  if (smoke) require('./test/desktop.cjs')({ app, window });
}).catch(error => { console.error(error); app.exit(1); });
app.on('before-quit', () => connection.disconnect());
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
