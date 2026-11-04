const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CodexConnection, connectionOptions } = require('./transport.cjs');
const { PinStore } = require('./pins.cjs');
const { QueueStore } = require('./queues.cjs');
const { PreferencesStore } = require('./preferences.cjs');
const { generateTitle, titleKey, readThreadForTitle } = require('./titles.cjs');
const { AgentWakeLock } = require('./wake-lock.cjs');

const connection = new CodexConnection();
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const methods = new Set(['thread/list', 'thread/read', 'thread/resume', 'thread/start', 'thread/fork', 'thread/archive', 'thread/turns/list', 'thread/items/list', 'thread/name/set', 'thread/settings/update', 'thread/metadata/update', 'project/list', 'project/create', 'project/update', 'project/move', 'turn/start', 'turn/steer', 'turn/interrupt', 'model/list', 'account/read', 'fs/readDirectory', 'skills/list', 'collaborationMode/list', 'thread/compact/start', 'review/start', 'mcpServerStatus/list']);
let window;
let settings;
const manualNames = new Set();
let titleQueue = Promise.resolve();
const smoke = process.argv.includes('--smoke-test');
const localSmoke = smoke && process.argv.includes('--local');
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), localSmoke ? 'remote-codex-local-smoke' : 'remote-codex-smoke'));

function checkSender(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== page) throw new Error('Untrusted caller.');
}

app.whenReady().then(async () => {
  const wakeLock = new AgentWakeLock(powerSaveBlocker, connection, working => connection.emit('diagnostic', { event: 'power.keep-awake', details: { working } }));
  app.on('before-quit', () => wakeLock.clear());
  const settingsFile = path.join(app.getPath('userData'), 'connection.json');
  settings = connectionOptions({ mode: 'local' });
  try { settings = connectionOptions(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load saved connection:', error.message);
  }
  if (smoke) settings = connectionOptions({ mode: localSmoke ? 'local' : 'ssh' });
  const pins = new PinStore(path.join(app.getPath('userData'), 'pins.json'));
  const queues = new QueueStore(path.join(app.getPath('userData'), 'queues'));
  const preferences = new PreferencesStore(path.join(app.getPath('userData'), 'preferences.json'));
  ipcMain.handle('preferences', event => { checkSender(event); return preferences.read(); });
  ipcMain.handle('save-preferences', (event, patch) => { checkSender(event); return preferences.update(patch); });
  ipcMain.handle('queues', event => { checkSender(event); return queues.list(); });
  ipcMain.handle('save-queue', (event, queue) => { checkSender(event); queues.save(queue); });
  ipcMain.handle('settings', event => { checkSender(event); return settings; });
  ipcMain.handle('pins', event => { checkSender(event); return pins.get(settings); });
  ipcMain.handle('set-pin', (event, threadId, pinned) => {
    checkSender(event);
    if (!connection.ready) throw new Error('Connect to Codex first.');
    return pins.set(settings, threadId, pinned);
  });
  ipcMain.handle('choose-key', async event => {
    checkSender(event);
    const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'], defaultPath: path.join(app.getPath('home'), '.ssh') });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('connect', async (event, value) => {
    checkSender(event);
    const next = connectionOptions(value);
    const result = await connection.connect(next);
    settings = next;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(settingsFile + '.tmp', settingsFile);
    return result;
  });
  ipcMain.handle('rpc', (event, method, params) => {
    checkSender(event);
    if (!methods.has(method)) throw new Error('Unsupported Codex operation.');
    if (!connection.ready) throw new Error('Connect to Codex first.');
    if (method === 'thread/name/set') manualNames.add(JSON.stringify([settings.mode, settings.host, settings.port, params.threadId]));
    return connection.call(method, params);
  });
  ipcMain.handle('title', (event, threadId, prompt) => {
    checkSender(event);
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Invalid title request.');
    const options = settings;
    const nameKey = JSON.stringify([options.mode, options.host, options.port, threadId]);
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
  ipcMain.handle('respond', (event, id, result) => { checkSender(event); connection.respond(id, result); });
  connection.on('notification', message => {
    if (message.id !== undefined && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'].includes(message.method)) {
      connection.rejectRequest(message.id);
      message = { method: 'error', params: { message: `Unsupported Codex request declined: ${message.method}` } };
    }
    if (message.method === 'serverRequest/resolved') connection.requests.delete(message.params.requestId);
    if (window && !window.isDestroyed()) window.webContents.send('notification', message);
  });
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/icon.png'));
  const createWindow = () => {
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 800, minHeight: 580, show: !smoke, title: 'Remote Codex', icon: path.join(__dirname, 'assets/icon.png'), backgroundColor: '#f9f9f6', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.loadFile(path.join(__dirname, 'index.html'));
    window.on('closed', () => { connection.disconnect(); window = null; });
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
