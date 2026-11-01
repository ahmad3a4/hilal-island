'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'settings', 'prayer', 'media', 'thumb', 'downloads', 'download:done', 'reminder', 'azan:start', 'azan:end',
  'prayer:pre-alert', 'clipboard:link', 'fullscreen', 'window:blur', 'ui:open', 'toast',
];

contextBridge.exposeInMainWorld('island', {
  init: () => ipcRenderer.invoke('init'),
  on(channel, callback) {
    if (!CHANNELS.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  setInteractive: (on) => ipcRenderer.send('interactive', !!on),
  focusInput: (on) => ipcRenderer.invoke('focus-input', !!on),
  uiState: (state) => ipcRenderer.send('ui:state', state),
  media: (cmd, id, arg) => ipcRenderer.send('media', { cmd, id, arg }),
  downloads: {
    add: (url) => ipcRenderer.invoke('dl:add', url),
    action: (id, action) => ipcRenderer.invoke('dl:action', { id, action }),
    openFolder: () => ipcRenderer.invoke('dl:openFolder'),
    clear: () => ipcRenderer.invoke('dl:clear'),
  },
  settings: {
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    pickFile: (kind) => ipcRenderer.invoke('settings:pickFile', kind),
    pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
    detectLocation: () => ipcRenderer.invoke('location:detect'),
  },
  azan: {
    stop: () => ipcRenderer.send('azan:stop'),
    ended: () => ipcRenderer.send('azan:ended'),
    test: (key) => ipcRenderer.send('azan:test', key),
  },
  reminder: {
    now: () => ipcRenderer.send('reminder:now'),
    pick: () => ipcRenderer.invoke('reminder:pick'),
    snooze: (minutes) => ipcRenderer.send('reminder:snooze', minutes),
  },
  app: {
    hide: () => ipcRenderer.send('app:hide'),
    quit: () => ipcRenderer.send('app:quit'),
  },
});
