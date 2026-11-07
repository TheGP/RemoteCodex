const { contextBridge, ipcRenderer } = require('electron');
function draftRequest(operation, target, patch) {
  const result = ipcRenderer.sendSync(operation, target, patch);
  if (result.error) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('codex', {
  settings: () => ipcRenderer.invoke('settings'),
  readImage: file => ipcRenderer.invoke('read-image', file),
  openLink: (href, context) => ipcRenderer.invoke('open-link', href, context),
  linkMenu: (href, context) => ipcRenderer.invoke('link-menu', href, context),
  preferences: () => ipcRenderer.invoke('preferences'),
  savePreferences: patch => ipcRenderer.invoke('save-preferences', patch),
  saveConversationState: value => {
    const result = ipcRenderer.sendSync('save-conversation-state', value);
    if (result.error) throw new Error(result.error);
  },
  queues: () => ipcRenderer.invoke('queues'),
  saveQueue: queue => ipcRenderer.invoke('save-queue', queue),
  draft: target => draftRequest('read-draft', target),
  saveDraft: (target, patch) => draftRequest('save-draft', target, patch),
  clearDraft: target => draftRequest('clear-draft', target),
  moveDraft: (source, target) => draftRequest('move-draft', source, target),
  lastDraft: machine => draftRequest('last-draft', machine),
  scheduledTasks: () => ipcRenderer.invoke('scheduled-tasks'),
  scheduleMessage: (message, hours) => ipcRenderer.invoke('schedule-message', message, hours),
  cancelScheduledTask: id => ipcRenderer.invoke('cancel-scheduled-task', id),
  editLock: (threadId, token) => ipcRenderer.invoke('edit-lock', threadId, token),
  title: (threadId, prompt) => ipcRenderer.invoke('title', threadId, prompt),
  pins: () => ipcRenderer.invoke('pins'),
  setPin: (threadId, pinned) => ipcRenderer.invoke('set-pin', threadId, pinned),
  connect: options => ipcRenderer.invoke('connect', options),
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  log: (event, details) => ipcRenderer.send('diagnostic', event, details),
  respond: (id, result) => ipcRenderer.invoke('respond', id, result),
  onNotification: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  }
});
