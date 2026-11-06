const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('atlas', {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  saveSecrets: (namespace, values) => ipcRenderer.invoke('vault:save', namespace, values),
})
