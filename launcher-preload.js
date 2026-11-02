const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  list: () => ipcRenderer.invoke('launcher:list'),
  toggle: (type, id) => ipcRenderer.invoke('launcher:toggle', type, id),
  showInApp: (type, id) => ipcRenderer.invoke('launcher:show-app', type, id),
  hide: () => ipcRenderer.invoke('launcher:hide'),
  onOpen: (cb) => ipcRenderer.on('launcher:open', () => cb()),
});
