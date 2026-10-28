const { contextBridge, ipcRenderer } = require("electron");

const windowActions = new Set(["minimize", "maximize", "close"]);

contextBridge.exposeInMainWorld("arcadeWindow", {
  control(action) {
    if (windowActions.has(action)) ipcRenderer.send("arcade:window-control", action);
  },
  onMaximized(callback) {
    ipcRenderer.on("arcade:window-state", (_event, maximized) => callback(maximized));
  },
  onOpenTab(callback) {
    ipcRenderer.on("arcade:open-tab", (_event, url) => callback(url));
  },
  signInWithGoogle() {
    return ipcRenderer.invoke("arcade:google-sign-in");
  },
  readGameLibrary() {
    return ipcRenderer.invoke("arcade:library-read");
  },
  selectGameExecutable() {
    return ipcRenderer.invoke("arcade:library-select-executable");
  },
  addGame(game) {
    return ipcRenderer.invoke("arcade:library-add", game);
  },
  removeGame(gameId) {
    return ipcRenderer.invoke("arcade:library-remove", gameId);
  },
  launchGame(gameId) {
    return ipcRenderer.invoke("arcade:library-launch", gameId);
  },
  onGameLibraryUpdated(callback) {
    ipcRenderer.on("arcade:library-updated", (_event, library) => callback(library));
  },
  onGameLibraryError(callback) {
    ipcRenderer.on("arcade:library-error", (_event, message) => callback(message));
  },
  readSettings() {
    return ipcRenderer.invoke("arcade:settings-read");
  },
  saveSettings(settings) {
    return ipcRenderer.invoke("arcade:settings-save", settings);
  },
  openStoreGame(gameId) {
    return ipcRenderer.invoke("arcade:open-store-game", gameId);
  }
});
