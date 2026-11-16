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
const { mapProjectPath } = require('./path-mapping.js');
const { generateTitle, titleKey, readThreadForTitle } = require('./titles.cjs');
const { ScheduleStore, Scheduler } = require('./scheduler.cjs');
const { SharedSchedules } = require('./shared-schedules.cjs');
const { serverKey, sharingOptions } = require('./shared-schedules.cjs');
const { ConversationState } = require('./conversation-state.cjs');
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
  const preferences = new PreferencesStore(path.join(app.getPath('userData'), 'preferences.json'));
  const schedules = new ScheduleStore(path.join(app.getPath('userData'), 'schedules.json'));
  const editLocks = new Map();
  ipcMain.handle('edit-lock', (event, threadId, token) => {
    checkSender(event);
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('Invalid conversation.');
    if (token) {
      if (editLocks.get(threadId) === token) { editLocks.delete(threadId); if (shared.enabled) return shared.unlock(token); }
      return;
    }
    if (!connection.ready) throw new Error('Connect to a coding agent first.');
    if (editLocks.has(threadId) || scheduler.dispatching.has(threadId)) throw new Error('This conversation is busy; try editing after the task finishes.');
    if (!shared.enabled) { const lock = randomUUID(); editLocks.set(threadId, lock); return lock; }
    const session = connection.session, machine = scheduleMachine();
    // Reserve locally before waiting on SSH, so a second editor cannot enter during the request.
    const reservation = randomUUID(); editLocks.set(threadId, reservation);
    return shared.lock(threadId).then(async lock => {
      if (connection.session !== session || scheduleMachine() !== machine || editLocks.get(threadId) !== reservation) {
        if (shared.enabled) await shared.unlock(lock);
        throw new Error('The conversation connection changed. Reopen the editor.');
      }
      editLocks.set(threadId, lock); return lock;
    }).catch(error => { if (editLocks.get(threadId) === reservation) editLocks.delete(threadId); throw error; });
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
  const shared = new SharedSchedules({
    file: path.join(app.getPath('userData'), 'shared-schedules.json'), store: schedules, connection,
    available: () => Boolean(window), machine: scheduleMachine, blocked: scheduler.blocked,
    dispatching: scheduler.dispatching, changed: schedulesChanged, log: (event, details) => diagnostic.write(event, details)
  });
  const conversationsChanged = () => {
    if (window && !window.isDestroyed()) window.webContents.send('notification', { method: 'conversations/synced', params: {} });
  };
  const conversations = new ConversationState({
    directory: path.join(app.getPath('userData'), 'conversation-sync'), shared, pins, drafts, preferences,
    machine: scheduleMachine, options: () => settings, connection, changed: conversationsChanged,
    log: (event, details) => diagnostic.write(event, details)
  });
  conversations.historyBlocked = id => editLocks.has(id) || scheduler.dispatching.has(id);
  conversations.history.background = true;
  shared.resolveTask = task => conversations.scheduledTask(task);
  shared.beforeSend = id => conversations.history.begin(id);
  shared.afterSend = (id, reservation, result) => conversations.history.started(id, reservation, result);
  shared.uncertainSend = (id, reservation) => conversations.history.uncertain(id, reservation);
  shared.cancelSend = (id, reservation) => conversations.history.end(id, reservation);
  registerDraftIpc(ipcMain, drafts, checkSender, error => diagnostic.write('draft.failed', { error: error.message }), (target, stale) => conversations.captureDraft(target, false, stale));
  const releaseEditors = provider => {
    for (const [threadId, token] of editLocks) if (!provider || agentTarget(threadId, 'thread').provider === provider) {
      editLocks.delete(threadId);
      if (shared.enabled) shared.unlock(token).catch(error => diagnostic.write('schedule.unlock.failed', { error: error.message }));
    }
  };
  const tickSchedules = () => Promise.all([shared.enabled ? shared.tick() : scheduler.tick(), conversations.tick().catch(error => conversations.sync.failed(error))]).catch(error => {
    console.error('Scheduled task error:', error.message);
    if (window && !window.isDestroyed()) window.webContents.send('notification', { method: 'error', params: { message: `Scheduled task error: ${error.message}` } });
  });
  const recoverAgents = () => { if (connection.ready) connection.recover().catch(error => diagnostic.write('provider.recovery.failed', { error: error.message })); };
  const scheduleTimer = setInterval(() => { tickSchedules(); recoverAgents(); }, 15000); scheduleTimer.unref();
  powerMonitor.on('resume', () => { shared.receiptChecks.clear(); tickSchedules(); });
  app.on('before-quit', () => { clearInterval(scheduleTimer); conversations.history.close(); conversations.sync.close(); shared.close(); });
  ipcMain.handle('conversation-sync', event => { checkSender(event); return conversations.status(); });
  ipcMain.handle('request-conversation', async (event, id) => {
    checkSender(event);
    if (typeof id !== 'string' || !id || id.length > 200 || !conversations.history.enabled) throw new Error('Select a local Codex conversation first.');
    if (conversations.history.importing.has(id)) throw new Error('Wait for this conversation’s history to finish loading before taking ownership.');
    const session = connection.session, machine = scheduleMachine(), namespace = shared.key;
    const current = () => { if (session !== connection.session || machine !== scheduleMachine() || namespace !== shared.key) throw new Error('Conversation connection changed.'); };
    if (!conversations.catalog('thread', id)?.project && !conversations.history.record(id)?.workspace) {
      const selected = await dialog.showOpenDialog(window, { title: 'Choose this conversation’s folder on this computer', properties: ['openDirectory'], defaultPath: settings.localCwd });
      current(); if (selected.canceled) return conversations.status();
      const root = fs.realpathSync(selected.filePaths[0]);
      if (!fs.statSync(root).isDirectory()) throw new Error('Choose an existing folder.');
      conversations.sync.state.localHistory[id] = { ...conversations.history.record(id), workspace: root }; conversations.sync.save();
    }
    current(); await conversations.history.request(id); setImmediate(tickSchedules); return conversations.status();
  });
  ipcMain.handle('resolve-sync-conflict', async (event, key, choice, version) => { checkSender(event); await conversations.sync.resolve(key, choice, version); return conversations.status(); });
  ipcMain.handle('map-sync-project', (event, id, root) => {
    checkSender(event);
    const binding = conversations.binding(id);
    if (conversations.history.importing.size || binding && binding.root !== root && (shared.running || editLocks.size || [...agents.values()].some(agent => agent.wakeLock.id !== null))) throw new Error('Finish loading history, running tasks and message edits before changing the project folder.');
    return conversations.bind(id, root);
  });
  ipcMain.handle('schedule-sharing', event => { checkSender(event); return shared.settings(); });
  ipcMain.handle('schedule-storage', event => { checkSender(event); return shared.storageInfo(); });
  ipcMain.handle('save-schedule-sharing', async (event, value) => {
    checkSender(event);
    if (scheduler.running || editLocks.size) throw new Error('Close message editors and wait for scheduled delivery before changing sharing.');
    if (conversations.sync.running || conversations.history.running || conversations.history.importing.size || serverKey(sharingOptions(value)) !== shared.key && conversations.sync.pending()) throw new Error('Finish syncing conversation changes before changing the sync destination.');
    const result = await shared.configure(value); setImmediate(tickSchedules); return result;
  });
  ipcMain.handle('sync-schedules', async event => { checkSender(event); await Promise.all([shared.tick(), conversations.tick()]); return shared.settings(); });
  ipcMain.handle('scheduled-tasks', event => { checkSender(event); return shared.summaries(); });
  ipcMain.handle('schedule-message', (event, message, hours) => {
    checkSender(event);
    if (!connection.ready || message?.machine !== scheduleMachine()) throw new Error('Connect to the message’s machine before scheduling it.');
    if (shared.enabled) return shared.create(message, hours);
    const task = schedules.enqueue(message, hours);
    schedulesChanged(); return task;
  });
  ipcMain.handle('cancel-scheduled-task', (event, id) => {
    checkSender(event);
    if (shared.owns(id)) return shared.mutation('cancel', { id });
    const task = schedules.cancel(id); schedulesChanged(); return task;
  });
  ipcMain.handle('dismiss-scheduled-task', async (event, id) => {
    checkSender(event);
    if (!shared.enabled || !shared.owns(id)) throw new Error('Reconnect shared schedules before dismissing a delivery.');
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Check scheduled delivery', message: 'Have you checked this conversation on the sending computer?',
      detail: 'Dismiss only after checking whether the message was sent and its run finished. This will not resend it. Later scheduled messages can then run.',
      buttons: ['Cancel', 'Dismiss after checking'], defaultId: 0, cancelId: 0
    });
    checkSender(event);
    if (result.response === 1) return shared.mutation('dismiss', { id });
  });
  const scheduledEdit = (id, token) => {
    const task = schedules.get(id);
    if (!task || task.status !== 'pending') throw new Error('This scheduled message is no longer pending.');
    if ((task.machine || 'access:local') !== scheduleMachine()) throw new Error('Open this scheduled message on its original machine.');
    if (!token || editLocks.get(task.threadId) !== token) throw new Error('Reopen the scheduled message editor before saving.');
    return task;
  };
  const sharedEdit = async (id, token) => {
    const threadId = [...editLocks].find(([, value]) => value === token)?.[0];
    if (!threadId) throw new Error('Reopen the scheduled message editor before saving.');
    await shared.verify(token);
    const task = await shared.bridge.call('get', { id, token });
    if (task.machine !== scheduleMachine() || task.threadId !== threadId) throw new Error('Open this scheduled message in its original conversation.');
    return task;
  };
  ipcMain.handle('scheduled-task', (event, id, token) => { checkSender(event); return shared.owns(id) ? sharedEdit(id, token) : scheduledEdit(id, token); });
  ipcMain.handle('edit-scheduled-task', (event, id, patch, token) => {
    checkSender(event);
    if (shared.owns(id)) return sharedEdit(id, token).then(() => shared.mutation('edit', { id, patch, token }));
    scheduledEdit(id, token);
    const task = schedules.edit(id, patch);
    schedulesChanged(); return task;
  });
  ipcMain.handle('preferences', event => { checkSender(event); return preferences.read(); });
  ipcMain.handle('save-preferences', (event, patch) => {
    checkSender(event); const result = preferences.update(patch);
    if (patch.messagePin) { const { machine, threadId, itemId, pinned, ...pin } = patch.messagePin; conversations.sync.capture('messagePin', machine, JSON.stringify([threadId, itemId]), pinned ? { itemId, ...pin } : null); }
    if (patch.shortcuts !== undefined) conversations.sync.capture('shortcuts', 'access:local', 'shortcuts', result.shortcuts);
    return result;
  });
  ipcMain.on('save-conversation-state', (event, conversationState, change) => {
    try {
      checkSender(event);
      if (change) {
        if (!['unread', 'completion'].includes(change.field) || typeof change.threadId !== 'string' || !change.threadId || change.threadId.length > 200 || change.field === 'unread' && typeof change.value !== 'boolean' || change.field === 'completion' && change.value !== null && !['completed', 'failed'].includes(change.value)) throw new Error('Invalid conversation marker change.');
        const saved = preferences.read().conversationStates?.[conversationState.machine] || { unread: [], completions: {} };
        const unread = new Set(saved.unread), completions = { ...saved.completions };
        if (change.field === 'unread') { if (change.value) unread.add(change.threadId); else unread.delete(change.threadId); }
        else { if (change.value) completions[change.threadId] = change.value; else delete completions[change.threadId]; }
        conversationState = { machine: conversationState.machine, unread: [...unread], completions };
      }
      preferences.update({ conversationState });
      if (change) {
        const value = change.field === 'completion' && change.value && typeof change.turnId === 'string' ? { status: change.value, turnId: change.turnId } : change.value;
        conversations.sync.capture(change.field, conversationState.machine, change.threadId, value, false, change.turnId);
      }
      event.returnValue = { ok: true };
    }
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
      if (context?.machine !== scheduleMachine()) throw new Error('The conversation’s machine changed. Open the file link again.');
      target = mapProjectPath(file, conversations.fileMapping(context?.threadId)) + (line ? `:${line}${column ? ':' + column : ''}` : '');
    }
    Menu.buildFromTemplate([{ label: 'Copy link', click: () => clipboard.writeText(target) }]).popup({ window });
  });
  let fileOpens = Promise.resolve();
  ipcMain.handle('open-link', (event, href, context) => {
    checkSender(event);
    if (typeof href === 'string' && /^https?:/i.test(href.trim())) return openWebLink(href, url => shell.openExternal(url));
    const options = settings; const session = connection.session, namespace = shared.key;
    const mapping = conversations.fileMapping(context?.threadId);
    const current = () => { if (settings !== options || connection.session !== session || context?.machine !== scheduleMachine() || shared.key !== namespace || conversations.fileMapping(context?.threadId)?.root !== mapping?.root) throw new Error('The conversation’s machine changed. Open the file link again.'); };
    current();
    const opener = preferences.read().fileOpener || 'vscode';
    const opening = fileOpens.then(() => openFileLink(href, {
      cwd: context?.cwd, settings: options, opener, mapPath: file => mapProjectPath(file, mapping), current, clampLine: context?.clampLine === true,
      readFile: async file => {
        current();
        const result = await connection.connectionFor(connection.providerFor({}, context)).call('fs/readFile', { path: file });
        current();
        const data = result.dataBase64;
        if (typeof data !== 'string' || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Could not read the current file to locate its changed line.');
        return Buffer.from(data, 'base64').toString('utf8');
      },
      openExternal: url => shell.openExternal(url), reveal: file => shell.showItemInFolder(file), application: url => app.getApplicationNameForProtocol(url)
    }));
    fileOpens = opening.catch(() => {});
    return opening;
  });
  ipcMain.handle('pins', event => { checkSender(event); return pins.get(settings); });
  ipcMain.handle('set-pin', (event, threadId, pinned) => {
    checkSender(event);
    if (!connection.ready) throw new Error('Connect to a coding agent first.');
    const result = pins.set(settings, threadId, pinned);
    conversations.sync.capture('pin', scheduleMachine(), threadId, pinned); return result;
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
      conversations.history.restore();
      setImmediate(tickSchedules);
      return { ...result, connected: connection.ready, options: publicSettings() };
    }
    if ([...agents.values()].some(agent => agent.wakeLock.id !== null)) throw new Error('Finish or stop running tasks before changing the connection.');
    releaseEditors();
    try {
      const result = await connection.connect(next);
      saveSettings(next);
      conversations.history.restore();
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
    const rpcMachine = scheduleMachine(), rpcSession = connection.session, rpcSyncKey = shared.key;
    if (shared.enabled && params?.threadId) {
      if (['thread/read', 'thread/turns/list', 'thread/items/read', 'thread/items/list', 'thread/fork'].includes(method)) await conversations.history.read(params.threadId);
      if (['thread/resume', 'turn/steer', 'turn/interrupt', 'thread/revert', 'thread/archive', 'thread/name/set', 'thread/settings/update', 'thread/metadata/update'].includes(method)) await conversations.history.verify(params.threadId, method === 'turn/interrupt');
      if (connection.session !== rpcSession || scheduleMachine() !== rpcMachine || shared.key !== rpcSyncKey) throw new Error('Conversation connection changed. Try again.');
    }
    if (shared.enabled && method === 'thread/list' && params?.projectId?.includes('sync-project:')) return { data: conversations.threads([], params.projectId, params.searchTerm), nextCursor: null };
    if (shared.enabled && ['thread/resume', 'turn/start', 'turn/steer', 'thread/revert', 'review/start'].includes(method) && params?.threadId) {
      const binding = conversations.threadBinding(params.threadId);
      if (binding && ['thread/resume', 'turn/start'].includes(method)) {
        params = { ...params, cwd: binding.root };
        if (binding.provider === 'codex' && method === 'thread/resume') params.runtimeWorkspaceRoots = [binding.root];
        if (params.sandboxPolicy?.type === 'workspaceWrite') params.sandboxPolicy = { ...params.sandboxPolicy, writableRoots: [binding.root] };
      }
    }
    if (method === 'thread/resume' && settings.mode === 'local') {
      const local = conversations.history.record(params.threadId);
      if (typeof local?.goalsEnabled === 'boolean') params = { ...params, config: { ...params.config, 'features.goals': local.goalsEnabled } };
    }
    if (scheduler.dispatching.has(params?.threadId) && ['turn/start', 'thread/resume', 'thread/archive', 'thread/revert'].includes(method)) {
      diagnostic.write('rpc.scheduler.busy', { method, threadId: params.threadId });
      throw new Error('A scheduled message is being sent to this chat; try again shortly.');
    }
    if (method === 'thread/archive') {
      if (shared.enabled) await shared.refresh();
      if (shared.summaries().some(task => task.threadId === params.threadId && (task.machine || 'access:local') === scheduleMachine() && (['pending', 'claimed', 'sending', 'unconfirmed'].includes(task.status) || task.active))) throw new Error('Cancel or check scheduled messages before archiving this chat.');
      const options = settings;
      const pinned = pins.get(options).includes(params.threadId);
      if (pinned) pins.set(options, params.threadId, false);
      let result;
      try { result = await connection.call(method, params, undefined, context); }
      catch (error) {
        if (pinned) {
          try { pins.set(options, params.threadId, true); }
          catch (pinError) { throw new Error(`Archive failed: ${error.message}. Could not restore its pin: ${pinError.message}`); }
        }
        throw error;
      }
      if (shared.enabled && shared.key === rpcSyncKey) {
        try {
          if (pinned) conversations.sync.capture('pin', rpcMachine, params.threadId, false);
          conversations.sync.capture('thread', rpcMachine, params.threadId, null);
        } catch (error) { conversations.sync.failed(error); }
      }
      return result;
    }
    if (method === 'thread/revert' && shared.enabled) {
      const token = editLocks.get(params.threadId);
      if (!token) throw new Error('Reopen the message editor before editing history.');
      await shared.verify(token);
    }
    if (method === 'thread/name/set') manualNames.add(JSON.stringify([settings.provider, settings.mode, settings.host, settings.port, params.threadId]));
    if (shared.enabled && method === 'project/list' && !params?.cursor) conversations.nativeProjects.clear();
    let result;
    const reservation = params?.threadId && ['turn/start', 'review/start', 'thread/compact/start'].includes(method) ? await conversations.history.begin(params.threadId) : null;
    try { result = await connection.call(method, params, undefined, context); }
    catch (error) {
      if (reservation) {
        conversations.history.uncertain(params.threadId, reservation);
        if (connection.ready && !/timeout|timed out|connection|closed|disconnect/i.test(error.message)) await conversations.history.end(params.threadId, reservation).catch(failure => conversations.sync.failed(failure));
      }
      if (shared.enabled && params?.threadId && conversations.catalog('thread', params.threadId) && /not found|does not exist|no such|unknown thread/i.test(error.message)) throw new Error(conversations.history.enabled ? 'This conversation’s history has not finished syncing. Keep its owning computer open and try again.' : 'This coding agent’s history is on another computer. Connect to its shared server to continue it.');
      throw error;
    }
    if (reservation) await conversations.history.started(params.threadId, reservation, result).catch(error => conversations.sync.failed(error));
    if (shared.enabled && shared.key === rpcSyncKey && scheduleMachine() === rpcMachine && connection.session === rpcSession) {
      try {
        if (method === 'project/list') result.data = result.nextCursor ? result.data.map(project => conversations.captureProject(project)) : conversations.projects(result.data);
        if (result.project) result.project = conversations.captureProject(result.project, true);
        if (method === 'thread/list') result.data = conversations.threads(result.data, params?.projectId, params?.searchTerm);
        if (result.thread) {
          result.thread = conversations.captureThread(result.thread);
          const record = conversations.catalog('thread', result.thread.id), binding = record?.project && conversations.binding(record.project);
          if (binding) result.thread = { ...result.thread, cwd: binding.root, projectId: binding.nativeId };
        }
      } catch (error) { conversations.sync.failed(error); }
    } else if (shared.key === rpcSyncKey && scheduleMachine() === rpcMachine && connection.session === rpcSession && ['project/create', 'project/update'].includes(method) && result?.project) {
      try { result.project = conversations.captureProject(result.project, true); }
      catch (error) { conversations.sync.failed(error); }
    }
    return result;
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
    if (['connection/closed', 'provider/closed'].includes(message.method)) shared.receiptChecks.clear();
    if (message.method === 'connection/closed') releaseEditors();
    if (message.method === 'provider/closed') releaseEditors(message.provider);
    if (message.method === 'turn/completed' && shared.enabled) { shared.completed(message.params); conversations.history.completed(message.params).catch(error => conversations.sync.failed(error)); setImmediate(tickSchedules); }
    if (message.method === 'thread/compacted' && shared.enabled) { conversations.history.queue.set(message.params.threadId, { id: message.params.threadId }); setImmediate(tickSchedules); }

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
    window.webContents.on('render-process-gone', () => releaseEditors());
    window.loadFile(path.join(__dirname, 'index.html'));
    window.on('closed', () => { releaseEditors(); connection.disconnect(); window = null; });
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
