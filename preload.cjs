const { contextBridge, ipcRenderer } = require('electron');
function draftRequest(operation, target, patch, expected) {
  const result = ipcRenderer.sendSync(operation, target, patch, expected);
  if (result.error) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('agent', {
  settings: () => ipcRenderer.invoke('settings'),
  providers: () => ipcRenderer.invoke('providers'),
  readImage: (file, context) => ipcRenderer.invoke('read-image', file, context),
  openLink: (href, context) => ipcRenderer.invoke('open-link', href, context),
  linkMenu: (href, context) => ipcRenderer.invoke('link-menu', href, context),
  preferences: () => ipcRenderer.invoke('preferences'),
  savePreferences: patch => ipcRenderer.invoke('save-preferences', patch),
  saveConversationState: (value, change) => {
    const result = ipcRenderer.sendSync('save-conversation-state', value, change);
    if (result.error) throw new Error(result.error);
  },
  queues: () => ipcRenderer.invoke('queues'),
  saveQueue: queue => ipcRenderer.invoke('save-queue', queue),
  draft: target => draftRequest('read-draft', target),
  hasDraft: target => draftRequest('has-draft', target),
  saveDraft: (target, patch, expected) => draftRequest('save-draft', target, patch, expected),
  clearDraft: (target, expected) => draftRequest('clear-draft', target, undefined, expected),
  moveDraft: (source, target) => draftRequest('move-draft', source, target),
  lastDraft: machine => draftRequest('last-draft', machine),
  scheduledTasks: () => ipcRenderer.invoke('scheduled-tasks'),
  scheduleSharing: () => ipcRenderer.invoke('schedule-sharing'),
  scheduleStorage: () => ipcRenderer.invoke('schedule-storage'),
  saveScheduleSharing: value => ipcRenderer.invoke('save-schedule-sharing', value),
  syncSchedules: () => ipcRenderer.invoke('sync-schedules'),
  conversationSync: () => ipcRenderer.invoke('conversation-sync'),
  resolveSyncConflict: (key, choice, version) => ipcRenderer.invoke('resolve-sync-conflict', key, choice, version),
  mapSyncProject: (id, root) => ipcRenderer.invoke('map-sync-project', id, root),
  scheduledTask: (id, token) => ipcRenderer.invoke('scheduled-task', id, token),
  editScheduledTask: (id, patch, token) => ipcRenderer.invoke('edit-scheduled-task', id, patch, token),
  scheduleMessage: (message, hours) => ipcRenderer.invoke('schedule-message', message, hours),
  cancelScheduledTask: id => ipcRenderer.invoke('cancel-scheduled-task', id),
  dismissScheduledTask: id => ipcRenderer.invoke('dismiss-scheduled-task', id),
  editLock: (threadId, token) => ipcRenderer.invoke('edit-lock', threadId, token),
  title: (threadId, prompt) => ipcRenderer.invoke('title', threadId, prompt),
  pins: () => ipcRenderer.invoke('pins'),
  setPin: (threadId, pinned) => ipcRenderer.invoke('set-pin', threadId, pinned),
  connect: options => ipcRenderer.invoke('connect', options),
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  rpc: (method, params, context) => ipcRenderer.invoke('rpc', method, params, context),
  log: (event, details) => ipcRenderer.send('diagnostic', event, details),
  respond: (id, result) => ipcRenderer.invoke('respond', id, result),
  onNotification: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  }
});
