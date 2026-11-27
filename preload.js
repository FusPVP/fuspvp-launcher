// preload.js - Pont entre l'interface du launcher et le processus principal.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuspvp", {
  status: () => ipcRenderer.invoke("status"),
  version: () => ipcRenderer.invoke("version"),
  selfUpdate: () => ipcRenderer.invoke("selfUpdate"),
  install: () => ipcRenderer.invoke("install"),
  play: () => ipcRenderer.invoke("play"),
  cancelQueue: () => ipcRenderer.invoke("cancelQueue"),
  login: () => ipcRenderer.invoke("login"),
  cancelLogin: () => ipcRenderer.invoke("cancelLogin"),
  logout: () => ipcRenderer.invoke("logout"),
  saveSettings: (s) => ipcRenderer.invoke("saveSettings", s),
  openFolder: () => ipcRenderer.invoke("openFolder"),
  openLink: (key) => ipcRenderer.invoke("openLink", key),
  quit: () => ipcRenderer.invoke("quit"),
  minimize: () => ipcRenderer.invoke("minimize"),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, p) => cb(p)),
});
