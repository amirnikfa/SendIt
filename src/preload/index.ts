import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from '../shared/models';
const bridge: Bridge = {
  load: () => ipcRenderer.invoke('app:load'),
  save: (state) => ipcRenderer.invoke('app:save', state),
  setZoom: (percent) => ipcRenderer.invoke('window:zoom', percent),
  execute: (id, input) => ipcRenderer.invoke('request:execute', id, input),
  cancel: (id) => ipcRenderer.invoke('request:cancel', id),
  pickFile: () => ipcRenderer.invoke('file:pick'),
  importFile: () => ipcRenderer.invoke('file:import'),
  importText: (text) => ipcRenderer.invoke('text:import', text),
  exportCollection: (collection) => ipcRenderer.invoke('collection:export', collection),
  exportEnvironment: (environment) => ipcRenderer.invoke('environment:export', environment),
  saveFile: (name, content, base64) => ipcRenderer.invoke('file:save', name, content, base64),
  backup: () => ipcRenderer.invoke('app:backup'),
  restore: () => ipcRenderer.invoke('app:restore'),
  cookies: () => ipcRenderer.invoke('cookies:list'),
  setCookie: (url, cookie) => ipcRenderer.invoke('cookies:set', url, cookie),
  deleteCookie: (domain, path, key) => ipcRenderer.invoke('cookies:delete', domain, path, key),
  oauth: (auth, settings) => ipcRenderer.invoke('auth:oauth', auth, settings),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onClosing: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('window:closing', handler);
    return () => {
      ipcRenderer.removeListener('window:closing', handler);
    };
  },
  liveConnect: (id, protocol, input) => ipcRenderer.invoke('live:connect', id, protocol, input),
  liveSend: (id, text) => ipcRenderer.invoke('live:send', id, text),
  liveDisconnect: (id) => ipcRenderer.invoke('live:disconnect', id),
  onLive: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) =>
      listener(value);
    ipcRenderer.on('live:event', handler);
    return () => {
      ipcRenderer.removeListener('live:event', handler);
    };
  },
};
contextBridge.exposeInMainWorld('workbench', bridge);
