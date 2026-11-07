'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function createDefaults(app) {
  return {
    location: { cityId: 'eg-giza', name: 'Giza', ar: 'الجيزة', lat: 30.0131, lon: 31.2089 },
    prayer: {
      method: 'Egyptian',
      asr: 'Standard', // or 'Hanafi'
      highLat: 'TwilightAngle',
      hijriOffset: 0,
      adjust: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
    },
    azan: {
      enabled: true,
      voice: 'azan-1.ogg', // a bundled file name, or 'custom'
      customFile: '',
      fajrVoice: 'same',
      fajrCustomFile: '',
      mode: 'full', // 'full' | 'short' | 'tone' | 'silent'
      volume: 0.8,
      preAlertMinutes: 10,
      prayers: { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true },
      pauseMedia: true,
      muteOthers: false,
      resumeAfter: false,
      duaAfter: true,
    },
    azkar: {
      enabled: true,
      intervalMinutes: 5,
      durationSeconds: 15,
      ayah: true,
      dhikr: true,
      dua: true,
      quietInFullscreen: true,
    },
    downloads: {
      folder: app.getPath('downloads'),
      connections: 8,
      maxActive: 3,
      watchBrowser: true,
      clipboard: true,
    },
    mic: {
      shortcut: 'Control+Alt+K', // mutes the microphone in every app ('off' for none)
      sound: true, // a short tone when it changes
      overlay: true, // a red mic over fullscreen games while muted
    },
    devices: {
      connectPopup: true, // "AirPods connected · 80%" on the island
      lowBattery: true, // a warning at 20% and 10%
    },
    system: {
      islandReadout: false, // CPU use and GPU temperature on the closed island
      fpsInGames: 'top-left', // where the FPS counter goes over fullscreen games ('off' to hide)
      fpsRequested: false, // you allowed FPS once (Windows needs a sign-out before it takes effect)
    },
    general: {
      launchAtStartup: false,
      hideInFullscreen: true,
      timeFormat: '12h',
      islandOffset: 0, // how far below the top of the screen the island sits (drag it to change)
      lockPosition: false, // when on, dragging doesn't move the island
      checkUpdates: true, // look for a new version on GitHub once a day
      volumeHud: true, // the island shows volume changes instead of the Windows pop-up
      scrollVolume: true, // scroll on the island to change the volume (Shift for brightness)
    },
  };
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObject(v) && isObject(target[k]) ? merge(target[k], v) : v;
  }
  return out;
}

// A keyboard shortcut in Electron's format ("Control+Alt+K"). Letters, digits and other typing keys
// need two of Ctrl, Alt, Shift and Win, so they never take over shortcuts like Ctrl+C in other apps;
// F-keys, numpad keys, Insert, Scroll Lock and Print Screen can be used alone (but not Alt+F4).
const SHORTCUT_KEY = /^([A-Z0-9]|F([1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|Scrolllock|PrintScreen|Plus|num[0-9]|numadd|numsub|nummult|numdiv|numdec|[`\-=[\]\\;',./])$/;
const SOLO_KEY = /^(F([1-9]|1\d|2[0-4])|Insert|Scrolllock|PrintScreen|num.+)$/;
const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Super']);

function isShortcut(s) {
  if (typeof s !== 'string' || !s || s.length > 60) return false;
  const parts = s.split('+');
  const key = parts.pop();
  if (!SHORTCUT_KEY.test(key)) return false;
  if (new Set(parts).size !== parts.length || !parts.every((p) => MODIFIERS.has(p))) return false;
  if (SOLO_KEY.test(key)) return !(key === 'F4' && parts.length === 1 && parts[0] === 'Alt');
  return parts.length >= 2;
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Keeps values sane even if the JSON file was edited by hand.
function sanitize(s, d) {
  s.location.lat = clamp(s.location.lat, -90, 90, d.location.lat);
  s.location.lon = clamp(s.location.lon, -180, 180, d.location.lon);
  s.prayer.hijriOffset = Math.round(clamp(s.prayer.hijriOffset, -3, 3, 0));
  for (const k of Object.keys(d.prayer.adjust)) s.prayer.adjust[k] = Math.round(clamp(s.prayer.adjust[k], -60, 60, 0));
  s.azan.volume = clamp(s.azan.volume, 0, 1, d.azan.volume);
  s.azan.preAlertMinutes = Math.round(clamp(s.azan.preAlertMinutes, 0, 60, d.azan.preAlertMinutes));
  if (!['full', 'short', 'tone', 'silent'].includes(s.azan.mode)) s.azan.mode = 'full';
  s.azkar.intervalMinutes = clamp(s.azkar.intervalMinutes, 1, 240, d.azkar.intervalMinutes);
  s.azkar.durationSeconds = Math.round(clamp(s.azkar.durationSeconds, 5, 120, d.azkar.durationSeconds));
  s.downloads.connections = Math.round(clamp(s.downloads.connections, 1, 16, d.downloads.connections));
  s.downloads.maxActive = Math.round(clamp(s.downloads.maxActive, 1, 6, d.downloads.maxActive));
  if (typeof s.downloads.folder !== 'string' || !s.downloads.folder) s.downloads.folder = d.downloads.folder;
  if (!['12h', '24h'].includes(s.general.timeFormat)) s.general.timeFormat = '12h';
  s.general.islandOffset = Math.round(clamp(s.general.islandOffset, 0, 4000, 0));
  s.general.lockPosition = s.general.lockPosition === true;
  s.general.checkUpdates = s.general.checkUpdates !== false;
  s.system.islandReadout = s.system.islandReadout === true;
  if (s.system.fpsInGames === 'top') s.system.fpsInGames = 'island'; // 'Top' became 'In the island'
  if (!['off', 'island', 'top-left', 'top-right'].includes(s.system.fpsInGames)) s.system.fpsInGames = 'top-left';
  s.system.fpsRequested = s.system.fpsRequested === true;
  s.devices.connectPopup = s.devices.connectPopup !== false;
  if (s.mic.shortcut !== 'off' && !isShortcut(s.mic.shortcut)) s.mic.shortcut = 'Control+Alt+K';
  s.mic.sound = s.mic.sound !== false;
  s.mic.overlay = s.mic.overlay !== false;
  s.devices.lowBattery = s.devices.lowBattery !== false;
  return s;
}

class Settings extends EventEmitter {
  constructor(app) {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.defaults = createDefaults(app);
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run or unreadable file: use defaults
    }
    this.data = sanitize(merge(this.defaults, saved), this.defaults);
    this.saveTimer = null;
  }

  get() {
    return this.data;
  }

  update(patch) {
    this.data = sanitize(merge(this.data, patch), this.defaults);
    this.scheduleSave();
    this.emit('change', this.data, patch);
    return this.data;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save settings:', err.message);
    }
  }
}

module.exports = { Settings, isShortcut };
