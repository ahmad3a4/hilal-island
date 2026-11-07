'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'settings', 'prayer', 'media', 'thumb', 'downloads', 'download:done', 'download:failed', 'reminder', 'azan:start', 'azan:end',
  'prayer:pre-alert', 'clipboard:link', 'fullscreen', 'window:blur', 'ui:open', 'toast', 'pointer', 'window:visible',
  'sound:volume', 'sound:mixer', 'sound:peaks', 'brightness', 'system', 'fps', 'game', 'devices', 'mic', 'playtime', 'pill', 'update:available', 'update:progress', 'kbd',
];

contextBridge.exposeInMainWorld('island', {
  init: () => ipcRenderer.invoke('init'),
  on(channel, callback) {
    if (!CHANNELS.includes(channel)) return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  reportRects: (rects) => ipcRenderer.send('island:rects', rects),
  moveIsland: (offset, done) => ipcRenderer.send('island:move', { offset, done: !!done }),
  activity: (message) => ipcRenderer.send('activity', message),
  focusInput: (on) => ipcRenderer.invoke('focus-input', !!on),
  uiState: (state) => ipcRenderer.send('ui:state', state),
  media: (cmd, id, arg) => ipcRenderer.send('media', { cmd, id, arg }),
  sound: (cmd, value, pid) => ipcRenderer.send('sound', { cmd, value, pid }),
  systemWatch: (on) => ipcRenderer.send('system:watch', !!on),
  fpsAllow: () => ipcRenderer.invoke('fps:allow'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  micToggle: () => ipcRenderer.send('mic:toggle'),
  micRecording: (on) => ipcRenderer.send('mic:recording', !!on),
  micSetShortcut: (accelerator) => ipcRenderer.invoke('mic:setShortcut', accelerator),
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
