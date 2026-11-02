'use strict';
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, clipboard, powerMonitor,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Settings } = require('./settings');
const { Helper } = require('./helper');
const { DownloadManager } = require('./downloads');
const { PrayerScheduler, Reminders } = require('./scheduler');
const { METHODS, NAMES_AR, NAMES_EN } = require('./prayer');
const { CITIES, nearestCity } = require('./cities');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const WIN_W = 900;
const WIN_H = 540;
const VOICES = [
  { id: 'azan-1.ogg', label: 'Voice 1' },
  { id: 'azan-2.ogg', label: 'Voice 2' },
  { id: 'azan-3.mp3', label: 'Voice 3 (short)' },
];
const DOWNLOADABLE = new Set(('zip rar 7z tar gz tgz bz2 xz exe msi msix appx apk iso img dmg bin mp4 mkv avi mov webm wmv flv m4v ' +
  'mp3 m4a flac wav aac ogg opus pdf epub doc docx xls xlsx ppt pptx csv torrent jar deb rpm').split(' '));

// Demo mode (used to take screenshots without touching your music):
//   DI_DEMO="expand:prayer,reminder"  DI_CAPTURE_DIR=<folder>
const DEMO = process.env.DI_DEMO ? process.env.DI_DEMO.split(',').map((s) => s.trim()).filter(Boolean) : null;
const trace = (m) => { if (process.env.DI_LOG) { try { fs.appendFileSync(process.env.DI_LOG, `[main] ${m}\n`); } catch { /* ignore */ } } };
trace(`loaded, demo=${!!DEMO}`);

// This app runs all day in the background: an unexpected error must never pop up a
// modal error box (Electron's default). Log it to %APPDATA%\Hilal\error.log instead.
function logError(kind, err) {
  const text = `${new Date().toISOString()} ${kind}: ${(err && (err.stack || err.message)) || err}\n`;
  console.error(text.trim());
  trace(text.trim());
  try {
    const file = path.join(app.getPath('userData'), 'error.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, text);
  } catch { /* nowhere left to report it */ }
}
process.on('uncaughtException', (err) => logError('error', err));
process.on('unhandledRejection', (err) => logError('unhandled promise', err));

// Same id as "appId" in package.json, so the installer's shortcuts and the app match.
const APP_ID = 'io.github.ahmad3a4.hilal';
app.setAppUserModelId(APP_ID);
// Screenshots/tests can run with a throwaway profile (fresh default settings, separate instance).
if (process.env.DI_USER_DATA) app.setPath('userData', process.env.DI_USER_DATA);
// Keep our own azan audio out of the Windows media controls, so "pause everything" never pauses it.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

let win = null;
let tray = null;
let settings;
let helper;
let downloads;
let prayer;
let reminders;
let azanTimeout = null;
let quitting = false;
let demoNoMedia = false;
const state = { media: { current: null, sessions: [] }, fullscreen: false, azan: null, hiddenByUser: false, uiBusy: false };
const thumbs = new Map();

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

if (!app.requestSingleInstanceLock()) {
  trace('another instance is running; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    state.hiddenByUser = false;
    updateVisibility();
    send('ui:open', 'prayer');
  });
  app.whenReady().then(start);
}

function meta() {
  return {
    methods: Object.entries(METHODS).map(([id, m]) => ({ id, name: m.name, ar: m.ar })),
    cities: CITIES,
    voices: VOICES.map((v) => ({ ...v, url: pathToFileURL(path.join(ASSETS, 'audio', v.id)).href })),
    names: { ar: NAMES_AR, en: NAMES_EN },
    downloadsFolder: app.getPath('downloads'),
    version: app.getVersion(),
    debug: !!process.env.DI_DEBUG,
  };
}

function islandBounds() {
  const { x, y, width } = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(x + (width - WIN_W) / 2), y, width: WIN_W, height: WIN_H };
}

function createWindow() {
  win = new BrowserWindow({
    ...islandBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false, // never steal focus; we enable it only while you type in a text box
    show: false,
    type: 'toolbar',
    title: 'Hilal',
    icon: path.join(ASSETS, 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, DEMO ? {} : { forward: true });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => updateVisibility());
  win.on('blur', () => send('window:blur'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', () => { if (!quitting) setTimeout(() => win && win.reload(), 1000); });
  win.webContents.on('console-message', (e, ...legacy) => {
    const level = e.level !== undefined ? e.level : legacy[0];
    const message = e.message !== undefined ? e.message : legacy[1];
    if (level === 'error' || level === 3) logError('ui', message);
    else if (level === 'warning' || level === 2 || process.env.DI_DEBUG) {
      console.log(`[ui:${level}] ${message}`);
      if (process.env.DI_LOG) fs.appendFileSync(process.env.DI_LOG, `[ui:${level}] ${message}\n`);
    }
  });
  if (DEMO) win.webContents.once('did-finish-load', () => runDemo());
}

function reposition() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(islandBounds());
}

function shouldHide() {
  if (state.azan || DEMO) return false;
  if (state.hiddenByUser) return true;
  return settings.get().general.hideInFullscreen && state.fullscreen;
}

function updateVisibility() {
  if (!win || win.isDestroyed()) return;
  if (shouldHide()) {
    if (win.isVisible()) win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

function showIsland() {
  state.hiddenByUser = false;
  updateVisibility();
  rebuildTrayMenu();
}

// ------------------------------------------------------------------ azan

function azanSound(key) {
  const a = settings.get().azan;
  let voice = a.voice;
  let custom = a.customFile;
  if (key === 'fajr' && a.fajrVoice !== 'same') {
    voice = a.fajrVoice;
    custom = a.fajrCustomFile;
  }
  const file = voice === 'custom' ? custom : path.join(ASSETS, 'audio', voice);
  const usable = file && fs.existsSync(file) ? file : path.join(ASSETS, 'audio', 'azan-1.ogg');
  return pathToFileURL(usable).href;
}

function testEvent(key = 'dhuhr') {
  // Show that prayer's real time for today (falls back to "now").
  const p = prayer && prayer.schedule && prayer.schedule.list.find((x) => x.key === key);
  return { key, name: p ? p.name : NAMES_AR[key], nameEn: NAMES_EN[key], time: p ? p.time : Date.now(), test: true };
}

// quiet: demo/screenshots only - no pausing, no muting, volume 0.
// volume: overrides the volume (used by the end-to-end test).
async function startAzan(event, { test = false, quiet = false, volume = null } = {}) {
  if (state.azan) return;
  const a = settings.get().azan;
  state.azan = { event, test, paused: [], muted: false };
  updateVisibility();
  rebuildTrayMenu();
  if (a.pauseMedia && !quiet) {
    try {
      const reply = await helper.request('pauseall', [], 'pausedall', 5000);
      if (state.azan) state.azan.paused = reply.ids || [];
    } catch (err) {
      console.warn('Could not pause media:', err.message);
    }
  }
  if (a.muteOthers && a.mode !== 'silent' && !quiet && state.azan) {
    const ours = app.getAppMetrics().map((m) => m.pid);
    if (helper.send('mute', ours.join(','))) state.azan.muted = true;
  }
  if (!state.azan) return;
  send('azan:start', {
    event, sound: azanSound(event.key), mode: a.mode, volume: quiet ? 0 : (volume ?? a.volume), test, paused: state.azan.paused.length,
  });
  clearTimeout(azanTimeout);
  azanTimeout = setTimeout(() => endAzan('timeout'), 7 * 60e3);
}

function endAzan(reason) {
  if (!state.azan) return;
  const az = state.azan;
  state.azan = null;
  clearTimeout(azanTimeout);
  if (az.muted) helper.send('unmute');
  const a = settings.get().azan;
  if (a.resumeAfter && az.paused.length) setTimeout(() => helper.send('resume', ...az.paused), 400);
  send('azan:end', { reason });
  updateVisibility();
  rebuildTrayMenu();
  if (reason === 'finished' && a.duaAfter) setTimeout(() => send('reminder', reminders.afterAzanItem()), 900);
}

// ------------------------------------------------------------------ tray

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'icons', 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Hilal');
  tray.on('click', () => {
    showIsland();
    send('ui:open', null);
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: state.hiddenByUser ? 'Show the island' : 'Hide the island',
      click: () => { state.hiddenByUser = !state.hiddenByUser; updateVisibility(); rebuildTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Show a verse or dhikr now', click: () => { showIsland(); reminders.showNow(); } },
    { label: 'Pause reminders for 1 hour', click: () => reminders.snooze(3600e3) },
    { type: 'separator' },
    { label: 'Test the azan', enabled: !state.azan, click: () => startAzan(testEvent('dhuhr'), { test: true }) },
    { label: 'Stop the azan', enabled: !!state.azan, click: () => endAzan('stopped') },
    { type: 'separator' },
    { label: 'Settings', click: () => { showIsland(); send('ui:open', 'settings'); } },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: s.general.launchAtStartup,
      click: (item) => settings.update({ general: { launchAtStartup: item.checked } }),
    },
    { type: 'separator' },
    { label: 'Quit Hilal', click: () => app.quit() },
  ]));
}

function applyLoginItem(enabled) {
  const opts = { openAtLogin: enabled, path: process.execPath };
  if (!app.isPackaged) opts.args = [ROOT];
  try { app.setLoginItemSettings(opts); } catch (err) { console.warn('Login item:', err.message); }
}

// ------------------------------------------------------------- clipboard

// Electron 44's clipboard.readText() returns a Promise (older versions return a string).
async function readClipboardText() {
  try {
    const v = clipboard.readText();
    const text = v && typeof v.then === 'function' ? await v : v;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

let lastClip = null;
let clipBusy = false;
function watchClipboard() {
  readClipboardText().then((t) => { lastClip = t; });
  setInterval(async () => {
    if (clipBusy || lastClip === null || !settings.get().downloads.clipboard) return;
    clipBusy = true;
    try {
      const text = await readClipboardText();
      if (!text || text === lastClip) return;
      lastClip = text;
      const t = text.trim();
      if (t.length > 2048 || /\s/.test(t)) return;
      let u;
      try { u = new URL(t); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      let file = '';
      try { file = decodeURIComponent(u.pathname.split('/').pop() || ''); } catch { file = u.pathname.split('/').pop() || ''; }
      const ext = path.extname(file).slice(1).toLowerCase();
      if (!DOWNLOADABLE.has(ext)) return;
      if (downloads.list().some((i) => i.url === u.href && i.status !== 'canceled')) return;
      send('clipboard:link', { url: u.href, name: file, host: u.hostname });
    } finally {
      clipBusy = false;
    }
  }, 1200);
}

// ------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('init', () => ({
    settings: settings.get(),
    meta: meta(),
    prayer: prayer.schedule,
    media: state.media,
    thumbs: Object.fromEntries(thumbs),
    downloads: downloads.list(),
    fullscreen: state.fullscreen,
  }));

  ipcMain.on('interactive', (_e, on) => {
    if (DEMO) return; // demo/screenshot runs ignore the mouse completely, so clicks can't change them
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
  });

  ipcMain.handle('focus-input', async (_e, on) => {
    if (!win || win.isDestroyed()) return false;
    if (on) {
      if (win.isFocusable() && win.isFocused()) return true;
      try { await helper.request('fgsave', [], 'fg', 800); } catch { /* still fine */ }
      win.setFocusable(true);
      win.focus();
      return true;
    }
    if (!win.isFocusable()) return false;
    const hadFocus = win.isFocused();
    win.setFocusable(false);
    if (hadFocus) helper.send('fgrestore');
    return true;
  });

  ipcMain.on('ui:state', (_e, s) => { state.uiBusy = !!(s && s.expanded); });

  ipcMain.on('media', (_e, { cmd, id, arg }) => {
    if (['toggle', 'play', 'pause', 'next', 'prev'].includes(cmd)) helper.send(cmd, id || '');
    else if (cmd === 'seek') helper.send('seek', id || '', Number(arg) || 0);
  });

  ipcMain.handle('dl:add', (_e, url) => {
    try { return { ok: true, item: downloads.add(url) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('dl:action', async (_e, { id, action }) => {
    const it = downloads.list().find((i) => i.id === id);
    if (!it) return null;
    if (action === 'open' && it.path) return shell.openPath(it.path);
    if (action === 'show' && it.path) { shell.showItemInFolder(it.path); return null; }
    if (action === 'copy-link' && it.url) { clipboard.writeText(it.url); lastClip = it.url; return null; }
    downloads.action(id, action);
    return null;
  });
  ipcMain.handle('dl:openFolder', () => shell.openPath(settings.get().downloads.folder));
  ipcMain.handle('dl:clear', () => downloads.clearFinished());

  ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));
  ipcMain.handle('settings:pickFile', async (_e, kind) => {
    const r = await dialog.showOpenDialog({
      title: kind === 'fajr' ? 'Choose a Fajr azan sound' : 'Choose an azan sound',
      filters: [{ name: 'Audio', extensions: ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'] }],
      properties: ['openFile'],
    });
    if (!r.canceled && r.filePaths[0]) {
      const file = r.filePaths[0];
      settings.update({ azan: kind === 'fajr' ? { fajrVoice: 'custom', fajrCustomFile: file } : { voice: 'custom', customFile: file } });
    }
    return settings.get();
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Save downloads to', defaultPath: settings.get().downloads.folder, properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) settings.update({ downloads: { folder: r.filePaths[0] } });
    return settings.get();
  });
  ipcMain.handle('location:detect', async () => {
    try {
      const r = await helper.request('locate', [], 'location', 25000);
      if (!r.ok) return { ok: false, error: r.error };
      const near = nearestCity(r.lat, r.lon);
      const close = near && near.distanceKm < 40;
      const location = close
        ? { cityId: near.id, name: near.name, ar: near.ar, lat: +r.lat.toFixed(4), lon: +r.lon.toFixed(4) }
        : { cityId: 'custom', name: 'My location', ar: 'موقعي', lat: +r.lat.toFixed(4), lon: +r.lon.toFixed(4) };
      const patch = { location };
      if (near && near.distanceKm < 400) patch.prayer = { method: near.method };
      settings.update(patch);
      return { ok: true, location, near: near ? near.name : null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('azan:stop', () => endAzan('stopped'));
  ipcMain.on('azan:ended', () => endAzan('finished'));
  ipcMain.on('azan:test', (_e, key) => startAzan(testEvent(key || 'dhuhr'), { test: true }));
  ipcMain.on('reminder:now', () => reminders.showNow());
  ipcMain.handle('reminder:pick', () => reminders.pick(true));
  ipcMain.on('reminder:snooze', (_e, minutes) => reminders.snooze((Number(minutes) || 60) * 60e3));
  ipcMain.on('app:hide', () => { state.hiddenByUser = true; updateVisibility(); rebuildTrayMenu(); });
  ipcMain.on('app:quit', () => app.quit());
}

// ------------------------------------------------------------------ start

// Hilal used to be called "Dynamic Island": bring its settings along, once.
function migrateFromOldName() {
  const oldDir = path.join(app.getPath('appData'), 'Dynamic Island');
  const newDir = app.getPath('userData');
  if (process.env.DI_USER_DATA || !fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
  try {
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['settings.json', 'downloads.json', 'reminders.json']) {
      if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
    }
    // Remove the old "start with Windows" entry; the new one is written from the copied settings.
    app.setLoginItemSettings({ openAtLogin: false, name: 'DynamicIsland.App' });
  } catch (err) {
    logError('migration', err);
  }
}

async function start() {
  trace('ready');
  migrateFromOldName();
  settings = new Settings(app);
  helper = new Helper({
    exe: app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'HilalHelper.exe')
      : path.join(ROOT, 'native', 'bin', 'HilalHelper.exe'),
    buildIfMissing: !app.isPackaged,
  });
  downloads = new DownloadManager({
    storeFile: path.join(app.getPath('userData'), 'downloads.json'),
    getSettings: () => settings.get(),
  });
  prayer = new PrayerScheduler(() => settings.get());
  reminders = new Reminders({
    dataDir: path.join(ASSETS, 'data'),
    stateFile: path.join(app.getPath('userData'), 'reminders.json'),
    getSettings: () => settings.get(),
    canShow: () => {
      if (state.azan) return 'later';
      if (state.hiddenByUser || !win || win.isDestroyed() || !win.isVisible()) return 'skip';
      if (state.fullscreen && settings.get().azkar.quietInFullscreen) return 'skip';
      try {
        if (powerMonitor.getSystemIdleState(300) !== 'active') return 'skip'; // away or locked
      } catch { /* ignore */ }
      if (state.uiBusy) return 'later';
      return 'show';
    },
  });

  registerIpc();
  prayer.start();
  trace('creating window');
  createWindow();
  createTray();
  trace('window + tray created');
  watchClipboard();
  downloads.watchBrowser(settings.get().downloads.watchBrowser, app.getPath('downloads'));
  if (!DEMO) {
    reminders.start();
    applyLoginItem(settings.get().general.launchAtStartup); // test runs never touch the registry
  }

  helper.on('media', (msg) => {
    if (demoNoMedia) return;
    state.media = { current: msg.current, sessions: msg.sessions };
    send('media', state.media);
  });
  helper.on('thumb', (msg) => {
    thumbs.set(msg.key, msg.data);
    while (thumbs.size > 30) thumbs.delete(thumbs.keys().next().value);
    send('thumb', msg);
  });
  helper.on('fullscreen', (msg) => {
    state.fullscreen = !!msg.value;
    updateVisibility();
    send('fullscreen', state.fullscreen);
  });
  helper.on('log', (m) => console.log('[helper]', m.msg || m));
  helper.start();

  prayer.on('schedule', (s) => send('prayer', s));
  prayer.on('pre-alert', (e) => send('prayer:pre-alert', e));
  prayer.on('azan', (e) => startAzan(e));
  reminders.on('show', (item) => send('reminder', item));
  downloads.on('update', (list) => send('downloads', list));
  downloads.on('completed', (item) => send('download:done', item));
  downloads.on('failed', (item) => send('download:failed', item));

  settings.on('change', (s, patch) => {
    send('settings', s);
    if (patch.location || patch.prayer) prayer.refresh();
    if (patch.downloads) {
      downloads.watchBrowser(s.downloads.watchBrowser, app.getPath('downloads'));
      downloads.schedule();
    }
    if (patch.general && 'launchAtStartup' in patch.general) applyLoginItem(s.general.launchAtStartup);
    if (patch.general && 'hideInFullscreen' in patch.general) updateVisibility();
    if (patch.azkar) reminders.resetTimer();
    rebuildTrayMenu();
  });

  powerMonitor.on('resume', () => prayer.onResume());
  powerMonitor.on('unlock-screen', () => prayer.refresh());
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

app.on('before-quit', () => {
  quitting = true;
  try { endAzan('quit'); } catch { /* ignore */ }
  if (downloads) downloads.shutdown();
  if (helper) helper.stop();
  if (settings) settings.saveNow();
});

app.on('window-all-closed', () => {
  // The island lives in the tray; closing windows doesn't quit the app.
});

// ------------------------------------------------------------------ demo

async function runDemo() {
  const dir = process.env.DI_CAPTURE_DIR;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  const log = (m) => { if (process.env.DI_LOG) fs.appendFileSync(process.env.DI_LOG, `[demo] ${m}\n`); };
  if (process.env.DI_LOG) setInterval(() => trace(`heartbeat ${new Date().toISOString().slice(11, 19)}`), 1000);
  for (const [i, step] of DEMO.entries()) {
    log(`step ${i}: ${step} (visible=${win.isVisible()})`);
    const cut = step.indexOf(':');
    const kind = cut < 0 ? step : step.slice(0, cut);
    const arg = cut < 0 ? '' : step.slice(cut + 1);
    if (kind === 'expand') send('ui:open', arg || 'prayer');
    if (kind === 'collapse') send('ui:open', '__collapse');
    if (kind === 'reminder') send('reminder', arg ? reminders.pools.ayah.find((x) => x.id === `q${arg}`) || reminders.pick(true) : reminders.pick(true));
    if (kind === 'dhikr') send('reminder', { ...reminders.pools.dhikr[Number(arg) || 0], type: 'dhikr', durationSeconds: 60 });
    if (kind === 'dua') send('reminder', { ...reminders.pools.dua[Number(arg) || 0], type: 'dua', durationSeconds: 60 });
    if (kind === 'azan') startAzan(testEvent(arg || 'dhuhr'), { test: true, quiet: true });
    if (kind === 'azanlook') startAzan({ ...testEvent(arg || 'dhuhr'), test: false }, { quiet: true }); // looks real, silent
    if (kind === 'azanreal') startAzan(testEvent(arg || 'dhuhr'), { test: true, volume: 0 }); // real pausing, silent audio
    if (kind === 'azanend') endAzan('stopped');
    if (kind === 'prealert') send('prayer:pre-alert', { ...testEvent(arg || 'asr'), time: Date.now() + 10 * 60e3, minutes: 10 });
    if (kind === 'clip') send('clipboard:link', { url: 'https://example.com/files/Linux-Workstation-24.04.iso', name: 'Linux-Workstation-24.04.iso', host: 'example.com' });
    if (kind === 'toast') send('download:done', { id: 'demo', name: 'Golden Hour - Live at the Lake (4K).mp4', path: null, size: 1.07e9 });
    if (kind === 'nomedia') { demoNoMedia = true; send('media', { current: null, sessions: [] }); }
    if (kind === 'democontent') {
      demoNoMedia = true;
      send('thumb', { key: 'demo-cover', data: demoCover() });
      send('media', {
        current: 'demo',
        sessions: [{
          id: 'demo', aumid: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', title: 'Golden Hour', artist: 'Morning Sessions',
          album: 'Live at the Lake', status: 'playing', pos: 83, dur: 214, upd: Date.now(),
          canPlay: true, canPause: true, canNext: true, canPrev: true, canSeek: true, thumb: 'demo-cover',
        }],
      });
    }
    if (kind === 'nodl') send('downloads', []);
    if (kind === 'dismiss') await win.webContents.executeJavaScript('dismissOverlay()');
    if (kind === 'scroll') await win.webContents.executeJavaScript(`document.querySelector('.settings').scrollTop = ${Number(arg) || 0}`);
    if (kind === 'fakedl') send('downloads', fakeDownloads());
    if (kind === 'wait') { await wait(Number(arg) || 1000); continue; }
    await wait(Number(process.env.DI_STEP_MS) || 1600);
    if (dir) {
      const alive = await Promise.race([win.webContents.executeJavaScript('document.getElementById("island").dataset.mode'), wait(3000).then(() => 'NO RESPONSE')]);
      const img = await Promise.race([win.webContents.capturePage(), wait(4000).then(() => null)]);
      log(`  ui mode=${alive}, captured=${!!img}`);
      if (img) {
        fs.mkdirSync(dir, { recursive: true });
        const base = path.join(dir, `${String(i).padStart(2, '0')}-${step.replace(/[^a-z0-9]+/gi, '_')}`);
        fs.writeFileSync(`${base}.png`, img.toPNG());
        // where the island (and the bubble next to it) is, so screenshots can be cropped
        const rects = await win.webContents.executeJavaScript(`(() => {
          const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
          const bubble = document.getElementById('bubble');
          return JSON.stringify({ island: r(document.getElementById('island')), bubble: bubble.classList.contains('show') ? r(bubble) : null, scale: window.devicePixelRatio });
        })()`);
        fs.writeFileSync(`${base}.json`, rects);
      }
    }
  }
  if (process.env.DI_DEMO_EXIT) app.quit();
}

// A generated "album cover" (sunset over a lake) for screenshots, so no real music shows up.
function demoCover() {
  const S = 256;
  const buf = Buffer.alloc(S * S * 4);
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = y / S;
      let r;
      let g;
      let b;
      if (t < 0.62) {
        const k = t / 0.62;
        r = mix(255, 210, k); g = mix(176, 88, k); b = mix(96, 140, k);
        const sun = Math.min(1, Math.max(0, 0.5 - (Math.hypot(x - S * 0.5, y - S * 0.56) - S * 0.17)));
        r = mix(r, 255, sun); g = mix(g, 228, sun); b = mix(b, 160, sun);
      } else {
        const k = (t - 0.62) / 0.38;
        r = mix(112, 34, k); g = mix(58, 22, k); b = mix(128, 64, k);
        const half = S * 0.15 * (1 - k);
        if (Math.abs(x - S * 0.5) < half && y % 9 < 3) { r = mix(r, 255, 0.55); g = mix(g, 196, 0.55); b = mix(b, 140, 0.55); }
      }
      const i = (y * S + x) * 4;
      buf[i] = Math.round(b);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(r);
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S }).toDataURL();
}

function fakeDownloads() {
  const MB = 1024 * 1024;
  return [
    { id: 'demo-1', kind: 'direct', name: 'Golden Hour - Live at the Lake (4K).mp4', size: 1100 * MB, received: 679 * MB, status: 'downloading', speed: 8.2 * MB, eta: 51, connections: 8, resumable: true },
    { id: 'demo-2', kind: 'direct', name: 'Linux-Workstation-24.04.iso', size: 5530 * MB, received: 1546 * MB, status: 'downloading', speed: 10.7 * MB, eta: 373, connections: 8, resumable: true },
    { id: 'demo-3', kind: 'direct', name: 'Morning Sessions - Golden Hour.mp3', size: 9.4 * MB, received: 9.4 * MB, status: 'completed', speed: 0, eta: 0, connections: 0 },
  ];
}
