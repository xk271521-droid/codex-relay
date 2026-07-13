const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexRelayDesktop", {
  isDesktop: true,
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("desktop:set-launch-at-login", Boolean(enabled)),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
});
