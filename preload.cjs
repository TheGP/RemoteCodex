const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('codex', {
  settings: () => ipcRenderer.invoke('settings'),
  preferences: () => ipcRenderer.invoke('preferences'),
  savePreferences: patch => ipcRenderer.invoke('save-preferences', patch),
  queues: () => ipcRenderer.invoke('queues'),
  saveQueue: queue => ipcRenderer.invoke('save-queue', queue),
  title: (threadId, prompt) => ipcRenderer.invoke('title', threadId, prompt),
  pins: () => ipcRenderer.invoke('pins'),
  setPin: (threadId, pinned) => ipcRenderer.invoke('set-pin', threadId, pinned),
  connect: options => ipcRenderer.invoke('connect', options),
  chooseKey: () => ipcRenderer.invoke('choose-key'),
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  respond: (id, result) => ipcRenderer.invoke('respond', id, result),
  onNotification: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  }
});
