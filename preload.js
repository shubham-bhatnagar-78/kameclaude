const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  setClickThrough: (v) => ipcRenderer.send('set-click-through', v),
  showNotification: (text) => ipcRenderer.send('show-notification', text),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onAutoBlast: (fn) => ipcRenderer.on('auto-blast', () => fn()),
});
