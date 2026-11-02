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
    general: {
      launchAtStartup: false,
      hideInFullscreen: true,
      timeFormat: '12h',
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

module.exports = { Settings };
