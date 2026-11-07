'use strict';
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, clipboard, powerMonitor, globalShortcut,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { Settings, isShortcut } = require('./settings');
const { Helper } = require('./helper');
const { DownloadManager } = require('./downloads');
const { PrayerScheduler, Reminders } = require('./scheduler');
const { METHODS, NAMES_AR, NAMES_EN } = require('./prayer');
const { CITIES, nearestCity } = require('./cities');
const { PlayTime } = require('./playtime');
const updater = require('./updater');

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
// A short record of what the island did (shown, hidden, fullscreen apps, mouse presses) in
// %APPDATA%Hilalactivity.log, so "the island didn't respond" can be traced afterwards.
function activity(msg) {
  trace(msg);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  try {
    const file = path.join(app.getPath('userData'), 'activity.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${stamp} ${msg}
`);
  } catch { /* not important enough to report */ }
}
const rect = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width ?? r.w)}x${Math.round(r.height ?? r.h)}` : 'none');
process.on('uncaughtException', (err) => logError('error', err));
process.on('unhandledRejection', (err) => logError('unhandled promise', err));

// Same id as "appId" in package.json, so the installer's shortcuts and the app match.
const APP_ID = 'io.github.ahmad3a4.hilal';
app.setAppUserModelId(APP_ID);
// Screenshots/tests can run with a throwaway profile (fresh default settings, separate instance).
if (process.env.DI_USER_DATA) app.setPath('userData', process.env.DI_USER_DATA);
// HardwareMediaKeyHandling, MediaSessionService: keep our own azan audio out of the Windows media
// controls, so "pause everything" never pauses it.
// CalculateNativeWinOcclusion: Chromium hides part of a window it thinks is covered (a fullscreen
// game or video) and did not always bring it back, after which every click on the island was lost.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService,CalculateNativeWinOcclusion');

let win = null;
let islandShown = false; // is the island on screen (see updateVisibility)
let tray = null;
let settings;
let helper;
let downloads;
let prayer;
let reminders;
let azanTimeout = null;
let quitting = false;
let demoNoMedia = false;
let demoSound = false; // screenshots: sample mixer instead of this PC's apps
let demoSystem = null; // screenshots: sample system readings
const state = { media: { current: null, sessions: [] }, sound: { master: null, brightness: null }, uiMode: 'compact', fullscreen: false, azan: null, hiddenByUser: false, forceShow: false, uiBusy: false };
const thumbs = new Map();

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

if (!app.requestSingleInstanceLock()) {
  trace('another instance is running; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    showIsland();
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

// You can drag the island down from the top edge; the whole window must still fit on the screen.
let dragOffset = null; // while you drag it
let islandDragging = false;

function islandOffset() {
  const { height } = screen.getPrimaryDisplay().workArea;
  const want = dragOffset != null ? dragOffset : (settings ? settings.get().general.islandOffset : 0);
  return Math.round(Math.min(Math.max(Number(want) || 0, 0), Math.max(0, height - WIN_H)));
}

function islandBounds() {
  const { x, y, width } = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(x + (width - WIN_W) / 2), y: y + islandOffset(), width: WIN_W, height: WIN_H };
}

// Where the window waits while the island is hidden: just left of the leftmost screen, so it
// covers nothing (not even a fullscreen game).
function parkedBounds() {
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  return { x: left - WIN_W - 200, y: screen.getPrimaryDisplay().bounds.y, width: WIN_W, height: WIN_H };
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
  win.setIgnoreMouseEvents(true); // clicks pass through until the cursor is over the island (see watchPointer)
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
  win.setBounds(islandShown ? islandBounds() : parkedBounds());
}

// ------------------------------------------------------------------- fps

// Over a fullscreen game the island is replaced by a small FPS counter in a corner, if FPS is
// available (see Fps in the helper) and turned on. The window then shrinks to just that counter.
const OVERLAY_W = 132;
const OVERLAY_H = 52;
let gameOverlay = false;
let fpsOn = false;
const fpsState = { available: null, reason: '', app: '', title: '', fps: null };

function overlayCorner() {
  const corner = settings.get().system.fpsInGames;
  return corner === 'off' || corner === 'island' ? 'top-left' : corner; // the mic alone goes top left
}

function overlayBounds() {
  const b = screen.getPrimaryDisplay().bounds;
  const corner = overlayCorner();
  const x = corner === 'top-right' ? b.x + b.width - OVERLAY_W - 10
    : corner === 'top' ? Math.round(b.x + (b.width - OVERLAY_W) / 2) : b.x + 10;
  return { x, y: b.y + 8, width: OVERLAY_W, height: OVERLAY_H };
}

function gameOverlayWanted() {
  const s = settings.get();
  if (!state.fullscreen || state.hiddenByUser || state.azan) return false;
  // FPS in a corner: over every fullscreen game, whether the island stays or not
  if (fpsState.available === true && !['off', 'island'].includes(s.system.fpsInGames)) return true;
  // only a muted mic: when the island (which shows it too) is out of the way
  return !!(state.mic && state.mic.muted && s.mic.overlay && !islandShown);
}

// The counter lives in its own small click-through window in the chosen corner.
let pillWin = null;

function pillWindow() {
  if (pillWin && !pillWin.isDestroyed()) return pillWin;
  pillWin = new BrowserWindow({
    ...overlayBounds(),
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
    focusable: false,
    show: false,
    type: 'toolbar',
    title: 'Hilal FPS',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  pillWin.setIgnoreMouseEvents(true);
  pillWin.setAlwaysOnTop(true, 'screen-saver');
  pillWin.loadFile(path.join(ROOT, 'src', 'renderer', 'pill.html'));
  pillWin.webContents.on('did-finish-load', () => sendPill());
  return pillWin;
}

function sendPill() {
  if (!pillWin || pillWin.isDestroyed()) return;
  const s = settings.get();
  const fps = !['off', 'island'].includes(s.system.fpsInGames) && fpsState.available === true ? fpsState.fps : null;
  const micOff = !!(state.mic && state.mic.muted && s.mic.overlay);
  pillWin.webContents.send('pill', { fps, micOff, corner: overlayCorner() });
}

function syncPill() {
  if (!settings) return;
  const want = gameOverlayWanted();
  if (want && gameOverlay) {
    pillWin.setBounds(overlayBounds());
    sendPill();
    return;
  }
  if (want === gameOverlay) return;
  gameOverlay = want;
  if (want) {
    const w = pillWindow();
    w.setBounds(overlayBounds());
    w.showInactive();
    w.setAlwaysOnTop(true, 'screen-saver');
    sendPill();
    activity(`FPS counter shown (${overlayCorner()})`);
  } else if (pillWin && !pillWin.isDestroyed()) {
    pillWin.hide();
  }
  syncFpsWatch();
}

// Frames are counted only while the System tab is open or the counter is over a game.
// Frames are counted while the System tab is open, while the counter is over a game, or while
// the island itself stays over a fullscreen game ("Hide in fullscreen apps" off: FPS shows in it).
function syncFpsWatch() {
  if (!helper) return;
  const inIsland = islandShown && state.fullscreen && settings.get().system.fpsInGames === 'island';
  const want = fpsState.available === true && (systemTab || gameOverlay || inIsland);
  if (want === fpsOn) return;
  fpsOn = want;
  helper.send('fps', want ? '1' : '0');
}

function sendFps() {
  sendPill();
  send('fps', { ...fpsState, requested: settings.get().system.fpsRequested, inGames: settings.get().system.fpsInGames });
}

// Adds you to Windows' "Performance Log Users" group (by SID, so it works in any Windows
// language), which is what lets an app read frame timing without admin rights. Windows asks
// for an administrator's OK, and it takes effect after you sign out and back in.
async function allowFps() {
  const { execFile, spawn } = require('child_process');
  const sid = await new Promise((resolve) => {
    // Windows' own whoami (another one, e.g. Git's, can come first on the PATH)
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    execFile(whoami, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }, (err, out) => resolve(err ? null : (/"(S-1-[\d-]+)"/.exec(out) || [])[1]));
  });
  if (!sid) return { ok: false };
  const inner = `try { Add-LocalGroupMember -SID 'S-1-5-32-559' -Member '${sid}' -ErrorAction Stop; exit 0 } catch { if ("$_" -match 'already a member' -or $_.FullyQualifiedErrorId -like '*MemberExists*') { exit 0 }; exit 1 }`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit 2 }`;
  const code = await new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', outer], { windowsHide: true });
    p.on('exit', (c) => resolve(c));
    p.on('error', () => resolve(3));
  });
  activity(`FPS permission: ${code === 0 ? 'added to Performance Log Users' : code === 2 ? 'cancelled' : `failed (${code})`}`);
  if (code === 0) settings.update({ system: { fpsRequested: true } });
  if (helper) helper.send('fpsprobe');
  return { ok: code === 0, cancelled: code === 2 };
}

function shouldHide() {
  if (state.azan) return false;
  if (state.hiddenByUser) return true;
  if (DEMO) return false;
  if (state.forceShow) return false; // you asked for it from the tray, even over a fullscreen app
  return settings.get().general.hideInFullscreen && state.fullscreen;
}

// The window itself is shown once and never hidden again: "hiding" the island moves it off screen.
// Once a window has been hidden and shown, Windows asks it on every mouse press whether it wants to
// be activated, and because the island must never take focus, Chromium answers "no, and drop the
// press". That is why the island stopped responding to clicks after any fullscreen app.

function updateVisibility() {
  if (!win || win.isDestroyed()) return;
  const show = !shouldHide();
  const first = !win.isVisible();
  if (show === islandShown && !first) {
    syncPill();
    return;
  }
  islandShown = show;
  setPointerOver(false);
  win.setIgnoreMouseEvents(true);
  pointerOver = false;
  reposition(); // also puts it back if a game changed the screen resolution meanwhile
  if (first) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  if (show) activity(`island shown at ${rect(win.getBounds())}${state.forceShow ? ' (over a fullscreen app, from the tray)' : ''}`);
  else activity(`island hidden (${state.hiddenByUser ? 'from the tray' : 'fullscreen app'})`);
  send('window:visible', show);
  syncPill();
  rebuildTrayMenu();
  syncVolumeKeys();
  syncSysmon();
  syncFpsWatch();
}

// ------------------------------------------------------------ sound & brightness

// The island handles the volume keys (and shows its own pop-up) only while it is on screen;
// otherwise, e.g. in a fullscreen game, they go to Windows as usual.
let volumeKeysOn = null;
let wheelZone = null; // the island's area in screen pixels while scrolling there changes the volume
let soundWatching = false;
const fileIcons = new Map();

function syncVolumeKeys(force = false) {
  if (!helper) return;
  const on = !DEMO && islandShown && settings.get().general.volumeHud !== false;
  if (on === volumeKeysOn && !force) return;
  volumeKeysOn = on;
  helper.send('volkeys', on ? '1' : '0');
}

// Scrolling over the closed island changes the volume. The helper watches the wheel only while
// the pointer is over the island (Chromium doesn't reliably pass wheel events to this window).
function syncWheelZone() {
  if (!helper || !win || win.isDestroyed()) return;
  const r = islandRects.island;
  const want = pointerOver && islandShown && !DEMO && r && settings.get().general.scrollVolume !== false
    && (state.uiMode === 'compact' || state.uiMode === 'osd');
  if (!want) {
    if (wheelZone) helper.send('wheelzone', 'off');
    wheelZone = null;
    return;
  }
  const b = win.getBounds();
  const px = screen.dipToScreenRect(win, { x: Math.round(b.x + r.x), y: Math.round(b.y + r.y), width: Math.round(r.w), height: Math.round(r.h) });
  const key = `${px.x} ${px.y} ${px.width} ${px.height}`;
  if (key === wheelZone) return;
  wheelZone = key;
  helper.send('wheelzone', px.x, px.y, px.width, px.height);
}

// -------------------------------------------------------------- microphone

// A shortcut mutes the microphone in every app at once (the helper mutes the recording device).
state.mic = null;
let micShortcut = null; // the accelerator registered now
let micShortcutOk = true;

function syncMicShortcut() {
  const want = settings.get().mic.shortcut;
  if (want === micShortcut) return;
  if (micShortcut) globalShortcut.unregister(micShortcut);
  micShortcut = null;
  micShortcutOk = true;
  if (want !== 'off' && !DEMO) {
    try {
      micShortcutOk = globalShortcut.register(want, () => helper && helper.send('mictoggle', 'key'));
    } catch { micShortcutOk = false; }
    if (micShortcutOk) micShortcut = want;
    else activity(`mic shortcut ${want} is taken by another app`);
  }
  sendMic();
}

// Choosing a new shortcut in Settings: the old one is let go meanwhile, so pressing it records it.
function pauseMicShortcut(paused) {
  if (paused) {
    if (micShortcut) globalShortcut.unregister(micShortcut);
    micShortcut = null;
  } else {
    syncMicShortcut();
  }
}

// Takes the shortcut only if no other app has it.
function setMicShortcut(accelerator) {
  if (accelerator === 'off') {
    if (micShortcut) globalShortcut.unregister(micShortcut);
    micShortcut = null;
    micShortcutOk = true;
    settings.update({ mic: { shortcut: 'off' } });
    return { ok: true };
  }
  if (!isShortcut(accelerator)) return { ok: false, reason: 'invalid' };
  const before = micShortcut;
  if (before) globalShortcut.unregister(before);
  let ok = false;
  try { ok = globalShortcut.register(accelerator, () => helper && helper.send('mictoggle', 'key')); } catch { ok = false; }
  if (!ok) {
    if (before) {
      try { globalShortcut.register(before, () => helper && helper.send('mictoggle', 'key')); } catch { /* ignore */ }
    }
    return { ok: false, reason: 'taken' };
  }
  micShortcut = accelerator;
  micShortcutOk = true;
  settings.update({ mic: { shortcut: accelerator } });
  activity(`mic shortcut set to ${accelerator}`);
  return { ok: true };
}

function sendMic(source = '') {
  send('mic', { ...(state.mic || { ok: false, muted: false, device: '' }), source, shortcutOk: micShortcutOk });
}

function toggleMic(source) {
  if (helper) helper.send('mictoggle', source);
}

// ------------------------------------------------------------------ keyboard

let keyboardWatching = null;
function syncKeyboardWatch(force = false) {
  if (!helper) return;
  const k = settings.get().keyboard;
  const want = !DEMO && (k.language || k.capsLock);
  if (want === keyboardWatching && !force) return;
  keyboardWatching = want;
  helper.send('kbdwatch', want ? '1' : '0');
}

// ------------------------------------------------------------------- updates

// Settings > General > Updates, and a daily look (if allowed) that offers the new version.
let updateInfo = null;
let updating = false;

async function checkForUpdate(quietly) {
  try {
    updateInfo = await updater.check(app.getVersion());
    if (!quietly) activity(`update check: ${updateInfo.available ? `${updateInfo.latest} available` : 'up to date'}`);
    if (quietly && updateInfo.available) {
      activity(`update check: ${updateInfo.latest} available`);
      send('update:available', updateInfo);
    }
    return updateInfo;
  } catch (err) {
    return { error: err.message };
  }
}

async function installUpdate() {
  if (updating) return { error: 'Already downloading' };
  if (!updateInfo || !updateInfo.available) await checkForUpdate(false);
  if (!updateInfo || !updateInfo.available) return { error: 'No new version' };
  updating = true;
  try {
    activity(`update: downloading ${updateInfo.latest}`);
    const file = await updater.download(updateInfo, (p) => send('update:progress', p));
    activity(`update: starting the installer for ${updateInfo.latest}`);
    updater.launch(file);
    setTimeout(() => app.quit(), 800); // the installer replaces Hilal and starts it again
    return { ok: true };
  } catch (err) {
    activity(`update failed: ${err.message}`);
    return { error: err.message };
  } finally {
    updating = false;
  }
}

function scheduleUpdateChecks() {
  if (DEMO || process.env.DI_USER_DATA) return; // test runs never look
  const run = () => { if (settings.get().general.checkUpdates) checkForUpdate(true); };
  setTimeout(run, 60e3);
  setInterval(run, 24 * 3600e3);
}

// ------------------------------------------------------------------ play time

let playtime = null;

let demoPlaytime = false; // screenshots: sample play time instead of this PC's

async function sendPlaytime() {
  if (!playtime || demoPlaytime) return;
  const sum = playtime.summary();
  await Promise.all(sum.games.map(async (g) => { g.icon = await appIcon(g.path); }));
  send('playtime', sum);
}

// ------------------------------------------------------------ bluetooth devices

// Paired Bluetooth devices from the helper. When one connects the island says so (with its
// battery), and it warns once at 20% and again at 10%.
state.devices = [];
let devicesSeen = false;
const batteryWarned = new Map(); // device id -> lowest warning shown (20 or 10)

function deviceKind(d) {
  const n = (d.name || '').toLowerCase();
  if (d.major === 4 || /airpods|buds|headphone|headset|earbud|wh-|wf-|beats|jabra/.test(n)) return 'headphones';
  if ((d.major === 5 && d.minor != null && (d.minor & 0x0f) >= 1 && (d.minor & 0x0f) <= 2) || /controller|gamepad|dualsense|dualshock|xbox/.test(n)) return 'controller';
  if ((d.major === 5 && d.minor != null && (d.minor & 0x30) === 0x20) || /mouse/.test(n)) return 'mouse';
  if ((d.major === 5 && d.minor != null && (d.minor & 0x30) === 0x10) || /keyboard/.test(n)) return 'keyboard';
  if (d.major === 2 || /phone/.test(n)) return 'phone';
  return 'other';
}

const DEVICE_ICONS = { headphones: 'headphones', controller: 'gamepad', mouse: 'mouse', keyboard: 'keyboard', phone: 'smartphone', other: 'bluetooth' };

function onDevices(list) {
  const before = new Map(state.devices.map((d) => [d.id, d]));
  state.devices = list.map((d) => ({ ...d, name: (d.name || 'Bluetooth device').replace(/[\u2018\u2019]/g, "'"), kind: deviceKind(d) }));
  send('devices', state.devices);
  const s = settings.get().devices;
  for (const d of state.devices) {
    const was = before.get(d.id);
    // just connected (not on Hilal's first look, when everything "appears" at once)
    if (devicesSeen && d.connected && !(was && was.connected)) {
      activity(`bluetooth: ${d.name} connected${d.battery != null ? ` (${d.battery}%)` : ''}`);
      if (s.connectPopup) {
        send('toast', { icon: DEVICE_ICONS[d.kind], tone: 'blue', title: `${d.name} connected`, text: d.battery != null ? `Battery ${d.battery}%${d.charging ? ', charging' : ''}` : '', duration: 5, tab: 'system' });
      }
    }
    if (devicesSeen && !d.connected && was && was.connected) activity(`bluetooth: ${d.name} disconnected`);
    // low battery, once at 20% and once at 10% (again only after it's been charged)
    if (!d.connected || d.charging || d.battery == null || d.battery > 25) {
      batteryWarned.delete(d.id);
    } else if (s.lowBattery) {
      const level = d.battery <= 10 ? 10 : d.battery <= 20 ? 20 : 0;
      const shown = batteryWarned.get(d.id) || 100;
      if (level && level < shown) {
        batteryWarned.set(d.id, level);
        activity(`bluetooth: ${d.name} battery low (${d.battery}%)`);
        send('toast', { icon: DEVICE_ICONS[d.kind], tone: 'bad', title: `${d.name}: battery low`, text: `${d.battery}% left`, duration: 10, tab: 'system' });
      }
    }
  }
  devicesSeen = true;
}

// ------------------------------------------------------------- system monitor

// CPU and memory are read here; GPU, network and drives come from the helper. It all runs only
// while the System tab is open or the readout on the island is on, and the island is on screen.
let systemTab = false;
let sysTimer = null;
let cpuBefore = null;
const sysHelper = { gpu: null, net: null, disks: [] };

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sysmonTick() {
  if (demoSystem) {
    send('system', demoSystem());
    return;
  }
  const now = cpuTimes();
  const cpus = os.cpus();
  let usage = null;
  if (cpuBefore && now.total > cpuBefore.total) usage = Math.round(100 * (1 - (now.idle - cpuBefore.idle) / (now.total - cpuBefore.total)));
  cpuBefore = now;
  send('system', {
    cpu: { usage, model: cpus[0] ? cpus[0].model.trim() : '', threads: cpus.length },
    mem: { total: os.totalmem(), free: os.freemem() },
    gpu: sysHelper.gpu,
    net: sysHelper.net,
    disks: sysHelper.disks,
    uptime: os.uptime(),
  });
}

function syncSysmon() {
  if (!helper || !settings) return;
  const want = islandShown && (systemTab || settings.get().system.islandReadout);
  if (want === !!sysTimer) return;
  if (want) {
    cpuBefore = null;
    helper.send('sysmon', '1');
    sysmonTick();
    sysTimer = setInterval(sysmonTick, 1000);
  } else {
    clearInterval(sysTimer);
    sysTimer = null;
    helper.send('sysmon', '0');
  }
}

async function appIcon(file) {
  if (!file) return '';
  if (!fileIcons.has(file)) {
    let url = '';
    try { url = (await app.getFileIcon(file, { size: 'normal' })).toDataURL(); } catch { /* no icon */ }
    fileIcons.set(file, url);
  }
  return fileIcons.get(file);
}

// ---------------------------------------------------------- click-through
// The window is transparent and much bigger than the island, so clicks must pass through it
// everywhere except on the island itself. We follow the cursor from here rather than with
// Electron's "forwarded" mouse events, which stop arriving after the window has been hidden
// once (e.g. for a fullscreen app) and would leave the island unclickable.
let islandRects = { island: null, bubble: null }; // reported by the page, in window coordinates
let pointerOver = false;
let pointerTimer = null;
let fakeCursor = null; // demo/test runs only: a cursor position inside the window

function setPointerOver(over, cursor) {
  if (over === pointerOver) return;
  pointerOver = over;
  syncWheelZone();
  if (over) activity(`pointer over the island (cursor ${cursor ? `${cursor.x},${cursor.y}` : '?'}, window ${rect(win.getBounds())}, island ${rect(islandRects.island)})`);
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!over);
  send('pointer', over);
}

function watchPointer() {
  clearTimeout(pointerTimer);
  let delay = 250;
  if (islandDragging) {
    // The page has the mouse while you drag; don't make the window click-through under it.
    pointerTimer = setTimeout(watchPointer, 40);
    return;
  }
  if (win && !win.isDestroyed() && islandShown && (!DEMO || fakeCursor)) {
    const b = win.getBounds();
    const c = fakeCursor ? { x: b.x + fakeCursor.x, y: b.y + fakeCursor.y } : screen.getCursorScreenPoint();
    const x = c.x - b.x;
    const y = c.y - b.y;
    const inside = (r) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    setPointerOver(inside(islandRects.island) || inside(islandRects.bubble), c);
    // Check often only while the cursor is near the island; otherwise a few times a second is plenty.
    if (x > -120 && x < b.width + 120 && y > -60 && y < b.height + 120) delay = 40;
  }
  pointerTimer = setTimeout(watchPointer, delay);
}

function showIsland() {
  state.hiddenByUser = false;
  // If a fullscreen app is what keeps it hidden, show it anyway until that app is gone.
  if (state.fullscreen) state.forceShow = true;
  updateVisibility();
  rebuildTrayMenu();
}

function hideIsland() {
  state.hiddenByUser = true;
  state.forceShow = false;
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
      label: islandShown ? 'Hide the island' : 'Show the island',
      click: () => {
        if (islandShown) hideIsland();
        else showIsland();
      },
    },
    { type: 'separator' },
    {
      label: 'Microphone muted',
      type: 'checkbox',
      checked: !!(state.mic && state.mic.muted),
      enabled: !!(state.mic && state.mic.ok),
      click: () => toggleMic('tray'),
    },
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
    sound: state.sound,
    fps: { ...fpsState, requested: settings.get().system.fpsRequested, inGames: settings.get().system.fpsInGames },
    devices: state.devices,
    mic: { ...(state.mic || { ok: false, muted: false, device: '' }), shortcutOk: micShortcutOk },
  }));

  ipcMain.on('activity', (_e, m) => activity(`page: ${String(m).slice(0, 200)}`));

  // Dragging the island up or down: the page sends where it should be, and once more when you let go.
  ipcMain.on('island:move', (_e, m) => {
    const offset = Number(m && m.offset);
    if (!Number.isFinite(offset) || !win || win.isDestroyed()) return;
    dragOffset = offset;
    islandDragging = !(m && m.done);
    if (islandShown) win.setBounds(islandBounds());
    if (m && m.done) {
      const final = islandOffset();
      dragOffset = null;
      settings.update({ general: { islandOffset: final } });
      activity(`island moved to ${final}px from the top`);
      syncWheelZone();
    }
  });

  ipcMain.on('system:watch', (_e, on) => {
    systemTab = !!on;
    syncSysmon();
    if (systemTab && fpsState.available !== true && helper) helper.send('fpsprobe'); // maybe allowed since
    if (systemTab) sendPlaytime();
    syncFpsWatch();
  });
  ipcMain.handle('fps:allow', () => allowFps());
  ipcMain.handle('update:check', () => checkForUpdate(false));
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.on('mic:toggle', () => toggleMic('island'));
  ipcMain.on('mic:recording', (_e, on) => pauseMicShortcut(!!on));
  ipcMain.handle('mic:setShortcut', (_e, accelerator) => setMicShortcut(String(accelerator || '')));

  ipcMain.on('island:rects', (_e, rects) => {
    if (rects && typeof rects === 'object') islandRects = { island: rects.island || null, bubble: rects.bubble || null };
    syncWheelZone();
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

  ipcMain.on('ui:state', (_e, s) => {
    state.uiBusy = !!(s && s.expanded);
    state.uiMode = (s && s.mode) || (state.uiBusy ? 'expanded' : 'compact');
    syncWheelZone();
  });

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
  ipcMain.on('app:hide', () => hideIsland());
  ipcMain.on('sound', (_e, req) => {
    const { cmd } = req || {};
    const value = Number(req && req.value);
    const pid = Math.max(0, Math.floor(Number(req && req.pid) || 0));
    const level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    switch (cmd) {
      case 'watch':
        soundWatching = !!(req && req.value);
        helper.send('mixerwatch', soundWatching ? '1' : '0');
        break;
      case 'master': helper.send('vol', level.toFixed(3)); break;
      case 'mute': helper.send('volmute', req.value ? '1' : '0'); break;
      case 'step': helper.send('volstep', value > 0 ? '1' : value < 0 ? '-1' : '0', 'wheel'); break;
      case 'app': helper.send('appvol', pid, level.toFixed(3)); break;
      case 'appmute': helper.send('appmute', pid, req.value ? '1' : '0'); break;
      case 'brightness': {
        const b = Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)));
        if (state.sound.brightness) state.sound.brightness.level = b;
        helper.send('setbrightness', b);
        break;
      }
      default: break;
    }
  });
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
  activity(`Hilal ${app.getVersion()} started${DEMO ? ' (demo)' : ''}`);
  migrateFromOldName();
  settings = new Settings(app);
  playtime = new PlayTime(app.getPath('userData'));
  playtime.on('change', (e) => {
    if (e.started) activity(`play time: ${e.started} started`);
    if (systemTab) sendPlaytime();
  });
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
      if (state.hiddenByUser || !win || win.isDestroyed() || !islandShown) return 'skip';
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
  watchPointer();
  trace('window + tray created');
  syncMicShortcut();
  scheduleUpdateChecks();
  watchClipboard();
  downloads.watchBrowser(settings.get().downloads.watchBrowser, app.getPath('downloads'));
  if (!DEMO) {
    reminders.start();
    // Test runs (demo or a separate test profile) never touch the registry.
    if (!process.env.DI_USER_DATA) applyLoginItem(settings.get().general.launchAtStartup);
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
    state.fullscreenApp = msg.value ? msg.app || null : null;
    if (playtime) playtime.onFullscreen(state.fullscreenApp);
    state.fullscreen = !!msg.value;
    if (!state.fullscreen) state.forceShow = false; // the next fullscreen app hides it again
    activity(`fullscreen ${state.fullscreen ? 'on' : 'off'}: ${msg.window || '?'} (Windows state ${msg.state})`);
    updateVisibility();
    send('fullscreen', state.fullscreen);
    syncFpsWatch(); // also when the island stays on screen over the game
  });
  helper.on('ready', () => {
    // (Re)started: it knows nothing yet.
    helper.send('volget');
    helper.send('brightness');
    syncVolumeKeys(true);
    wheelZone = null;
    syncWheelZone();
    if (soundWatching) helper.send('mixerwatch', '1');
    if (sysTimer) helper.send('sysmon', '1');
    helper.send('micget');
    syncKeyboardWatch(true);
    fpsOn = false;
    helper.send('fpsprobe'); // can we count frames? (answers with an 'fps' message)
  });
  helper.on('volume', (msg) => {
    if (demoSound) return;
    state.sound.master = { ok: msg.ok, level: msg.level, muted: msg.muted, device: msg.device };
    send('sound:volume', { ...state.sound.master, source: msg.source });
  });
  helper.on('mixer', async (msg) => {
    if (demoSound) return;
    const ours = new Set(app.getAppMetrics().map((m) => m.pid)); // the azan is adjusted in Settings
    const apps = (msg.apps || []).filter((a) => !ours.has(a.pid));
    await Promise.all(apps.map(async (a) => { a.icon = await appIcon(a.path); }));
    send('sound:mixer', { device: msg.device, apps });
  });
  helper.on('peaks', (msg) => { if (!demoSound) send('sound:peaks', msg); });
  helper.on('devices', (msg) => onDevices(msg.list || []));
  helper.on('kbd', (msg) => {
    const k = settings.get().keyboard;
    if ((msg.what === 'lang' && k.language) || (msg.what === 'caps' && k.capsLock)) send('kbd', msg);
  });
  helper.on('mic', (msg) => {
    const was = state.mic ? state.mic.muted : null;
    state.mic = { ok: msg.ok, muted: msg.muted, device: msg.device };
    if (was !== null && was !== msg.muted) activity(`microphone ${msg.muted ? 'muted' : 'on'} (${msg.source})`);
    sendMic(msg.source);
    if (was !== msg.muted) {
      updateVisibility(); // the red mic over a game
      syncPill();
      rebuildTrayMenu();
    }
  });
  helper.on('fps', (msg) => {
    const was = fpsState.available;
    if (msg.available === false) {
      fpsState.available = false;
      fpsState.reason = msg.reason || '';
      fpsOn = false;
    } else {
      fpsState.available = true;
      fpsState.reason = '';
      if ('fps' in msg) Object.assign(fpsState, { app: msg.app || '', title: msg.title || '', fps: msg.fps });
    }
    if (was !== fpsState.available) {
      activity(`FPS ${fpsState.available ? 'available' : `not available (${fpsState.reason})`}`);
      updateVisibility();
      syncFpsWatch();
    }
    sendFps();
  });
  helper.on('sysmon', (msg) => {
    sysHelper.gpu = msg.gpu || null;
    sysHelper.net = msg.net || null;
    if (msg.disks) sysHelper.disks = msg.disks;
  });
  helper.on('brightness', (msg) => {
    state.sound.brightness = { supported: msg.supported, level: msg.level, method: msg.method };
    send('brightness', { ...state.sound.brightness, source: msg.source });
  });
  helper.on('log', (m) => { console.log('[helper]', m.msg || m); trace(`helper: ${m.msg || m}`); });
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
    if (patch.general && 'launchAtStartup' in patch.general && !process.env.DI_USER_DATA) applyLoginItem(s.general.launchAtStartup);
    if (patch.general && 'hideInFullscreen' in patch.general) {
      updateVisibility();
      syncFpsWatch();
    }
    if (patch.general && 'islandOffset' in patch.general && !islandDragging) {
      dragOffset = null;
      reposition();
    }
    if (patch.general && 'volumeHud' in patch.general) syncVolumeKeys();
    if (patch.general && 'scrollVolume' in patch.general) syncWheelZone();
    if (patch.keyboard) syncKeyboardWatch();
    if (patch.mic) {
      syncMicShortcut();
      if ('overlay' in patch.mic) updateVisibility();
    }
    if (patch.system) {
      syncSysmon();
      if ('fpsInGames' in patch.system) {
        updateVisibility();
        syncFpsWatch();
        syncPill();
      }
      sendFps();
    }
    if (patch.azkar) reminders.resetTimer();
    rebuildTrayMenu();
  });

  powerMonitor.on('resume', () => {
    prayer.onResume();
    if (playtime && state.fullscreen) playtime.onFullscreen(state.fullscreenApp);
  });
  powerMonitor.on('unlock-screen', () => {
    prayer.refresh();
    if (playtime && state.fullscreen) playtime.onFullscreen(state.fullscreenApp);
  });
  // asleep or locked isn't play time
  powerMonitor.on('suspend', () => playtime && playtime.stop());
  powerMonitor.on('lock-screen', () => playtime && playtime.stop());
  screen.on('display-metrics-changed', () => {
    reposition();
    activity(`screen changed: ${rect(screen.getPrimaryDisplay().bounds)} at ${screen.getPrimaryDisplay().scaleFactor}x`);
  });
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

app.on('before-quit', () => {
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  if (playtime) playtime.stop();
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
    log(`step ${i}: ${step} (visible=${islandShown})`);
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
    if (kind === 'hud') {
      if (arg === 'brightness') send('brightness', { supported: true, level: 70, method: 'ddc', source: 'wheel' });
      else send('sound:volume', { ok: true, level: 0.42, muted: arg === 'muted', device: 'Speakers', source: 'key' });
      await wait(400);
      await win.webContents.executeJavaScript('clearTimeout(ui.hudTimer)'); // keep it up for the screenshot
    }
    if (kind === 'mic') {
      // sample microphone state for screenshots (muted / on)
      state.mic = { ok: true, muted: arg === 'muted', device: 'Microphone (USB Audio)' };
      sendMic('key');
    }
    if (kind === 'playtimedemo') {
      demoPlaytime = true;
      // sample play time for screenshots
      const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return d.toISOString().slice(0, 10); };
      const week = [5400, 2700, 0, 7200, 3600, 1800, 5100].map((secs, i) => ({ day: day(6 - i), secs }));
      const exe = (p) => (fs.existsSync(p) ? p : '');
      const games = [
        { key: 'fortnite', name: 'Fortnite', today: 3900, week: 18300, playing: true, path: '' },
        { key: 'cs2', name: 'Counter-Strike 2', today: 1200, week: 6600, playing: false, path: '' },
        { key: 'roblox', name: 'Roblox', today: 0, week: 900, playing: false, path: '' },
      ];
      Promise.all(games.map(async (g) => { g.icon = await appIcon(exe(g.path)); })).then(() => send('playtime', { week, games, today: 5100, playing: 'fortnite' }));
    }
    if (kind === 'devices') {
      // sample Bluetooth events for screenshots and tests
      const pods = (connected, battery, charging = false) => ({ id: 'demo-pods', name: 'AirPods Pro', connected, battery, charging, major: 4, minor: 6 });
      const pad = (connected, battery) => ({ id: 'demo-pad', name: 'DualSense Wireless Controller', connected, battery, charging: false, major: 5, minor: 2 });
      const mouse = { id: 'demo-mouse', name: 'MX Master 3S', connected: true, battery: 64, charging: false, major: 5, minor: 32 };
      if (arg === 'start') onDevices([pods(false, null), pad(true, 55), mouse]);
      if (arg === 'connect') onDevices([pods(true, 80), pad(true, 55), mouse]);
      if (arg === 'low') onDevices([pods(true, 18), pad(true, 55), mouse]);
    }
    if (kind === 'kbd') send('kbd', arg === 'caps' ? { what: 'caps', caps: true } : arg === 'ar' ? { what: 'lang', code: 'ar', name: 'العربية' } : { what: 'lang', code: 'en', name: 'English' }); // screenshots
    if (kind === 'fsflag') { state.fullscreen = arg !== 'off'; send('fullscreen', state.fullscreen); } // screenshots: pretend a fullscreen game
    if (kind === 'fpsdemo') {
      // sample FPS for screenshots: "Fortnite" at around 150 FPS
      Object.assign(fpsState, { available: true, reason: '', app: 'FortniteClient-Win64-Shipping', title: 'Fortnite', fps: 150 });
      sendFps();
      setInterval(() => { fpsState.fps = 140 + Math.round(Math.random() * 25); sendFps(); }, 1000);
    }
    if (kind === 'gamepill') {
      // what a fullscreen game would show
      if (arg) settings.update({ system: { fpsInGames: arg } });
      state.fullscreen = true;
      syncPill();
    }
    if (kind === 'gameend') {
      state.fullscreen = false;
      syncPill();
    }
    if (kind === 'demosys') {
      // made-up but believable readings for the README screenshots
      const t0 = Date.now();
      const GB = 1024 ** 3;
      demoSystem = (back = 0) => {
        const t = (Date.now() - t0) / 1000 - back;
        const w = (f, p) => 0.5 + 0.5 * Math.sin(t * f + p);
        return {
          cpu: { usage: Math.round(18 + 14 * w(0.31, 0)), model: 'Intel(R) Core(TM) i7-12700 CPU', threads: 20 },
          mem: { total: 32 * GB, free: (13.4 - 0.4 * w(0.3, 1)) * GB },
          gpu: { name: 'NVIDIA GeForce RTX 4070', util: Math.round(46 + 20 * w(0.23, 2)), temp: 61, memUsed: 5.2 * GB, memTotal: 12 * GB },
          net: { rx: Math.round((2.6 + 1.6 * w(0.37, 3) * w(0.11, 1)) * 1024 * 1024), tx: Math.round((180 + 90 * w(0.29, 4)) * 1024) },
          disks: [{ name: 'C:', label: 'Windows', total: 1024 * GB, free: 412 * GB }, { name: 'D:', label: 'Games', total: 2000 * GB, free: 186 * GB }],
          uptime: 3 * 86400 + 5 * 3600 + 12 * 60,
        };
      };
      for (let i = 59; i > 0; i--) send('system', demoSystem(i)); // a minute of history
    }
    if (kind === 'demosound') {
      demoSound = true;
      const icon = async (exe) => (fs.existsSync(exe) ? appIcon(exe) : '');
      const pf = process.env.ProgramFiles || 'C:\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)';
      send('sound:volume', { ok: true, level: 0.64, muted: false, device: 'Speakers (Realtek(R) Audio)', source: 'demo' });
      send('brightness', { supported: true, level: 70, method: 'ddc', source: 'demo' });
      send('sound:mixer', {
        device: 'Speakers (Realtek(R) Audio)',
        apps: [
          { pid: 101, name: 'Microsoft Edge', volume: 0.8, muted: false, active: true, system: false, icon: await icon(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')) },
          { pid: 102, name: 'Spotify', volume: 0.55, muted: false, active: true, system: false, icon: '' },
          { pid: 103, name: 'Windows Media Player', volume: 0.35, muted: true, active: false, system: false, icon: await icon(path.join(pf, 'Windows Media Player', 'wmplayer.exe')) },
          { pid: 0, name: 'System sounds', volume: 1, muted: false, active: false, system: true, icon: '' },
        ],
      });
      // gently moving levels, like real audio
      const t0 = Date.now();
      setInterval(() => {
        const t = (Date.now() - t0) / 1000;
        const wave = (f, p) => 0.5 + 0.35 * Math.sin(t * f + p) + 0.1 * Math.sin(t * f * 3.1 + p);
        send('sound:peaks', { master: wave(5, 0) * 0.8, apps: { 101: wave(5, 0) * 0.7, 102: wave(7, 1) * 0.45, 103: 0, system: 0 } });
      }, 100);
    }
    if (kind === 'dismiss') await win.webContents.executeJavaScript('dismissOverlay()');
    if (kind === 'scrollsys') await win.webContents.executeJavaScript(`(document.querySelector('.sys') || {}).scrollTop = ${Number(arg) || 9999}`);
    if (kind === 'scroll') await win.webContents.executeJavaScript(`document.querySelector('.settings').scrollTop = ${Number(arg) || 0}`);
    if (kind === 'fakedl') send('downloads', fakeDownloads());
    // click-through tests: a simulated cursor (your real mouse is never moved) and hide/show cycles
    if (kind === 'cursor') {
      const r = islandRects.island;
      fakeCursor = arg === 'island' && r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 450, y: 500 };
      watchPointer();
    }
    if (kind === 'hide' || kind === 'show') {
      state.hiddenByUser = kind === 'hide';
      updateVisibility();
    }
    if (kind === 'probe') {
      await wait(300);
      const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
      const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h, int i);'; [W.U]::GetWindowLong([System.IntPtr]${hwnd}, -20)`;
      const ex = Number(require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim());
      const page = await win.webContents.executeJavaScript('JSON.stringify({ hover: ui.hover, mode: ui.mode })');
      log(`  probe ${arg}: visible=${islandShown} pointerOver=${pointerOver} clicksPassThrough=${(ex & 0x20) !== 0} page=${page}`);
      continue;
    }
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
