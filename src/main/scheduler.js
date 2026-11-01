'use strict';
// Timers for the azan (with a heads-up a few minutes before) and for the
// rotating ayat / azkar reminders.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDaySchedule, upcomingAzans } = require('./prayer');

function prayerOptions(s) {
  return {
    lat: s.location.lat,
    lon: s.location.lon,
    method: s.prayer.method,
    asr: s.prayer.asr,
    highLat: s.prayer.highLat,
    adjust: s.prayer.adjust,
    hijriOffset: s.prayer.hijriOffset,
  };
}

class PrayerScheduler extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.fired = new Set();
    this.events = [];
    this.dayKey = null;
    this.timer = null;
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() { clearInterval(this.timer); }

  /** Recompute everything (settings changed, new day, PC woke up...). */
  refresh() {
    const now = new Date();
    const opts = prayerOptions(this.getSettings());
    this.schedule = getDaySchedule(now, opts);
    this.events = upcomingAzans(now, opts);
    this.dayKey = now.toDateString();
    // Anything already in the past when we (re)compute must not fire late.
    for (const e of this.events) {
      if (e.time < now.getTime() - 60e3) this.fired.add(`${e.dayKey}:${e.key}:azan`);
    }
    if (this.fired.size > 200) this.fired = new Set([...this.fired].slice(-60));
    this.emit('schedule', this.schedule);
  }

  /** The PC slept: don't play an azan that is long gone. */
  onResume() {
    const now = Date.now();
    for (const e of this.events) {
      if (e.time < now - 60e3) this.fired.add(`${e.dayKey}:${e.key}:azan`);
      const pre = e.time - this.getSettings().azan.preAlertMinutes * 60e3;
      if (pre < now - 60e3) this.fired.add(`${e.dayKey}:${e.key}:pre`);
    }
    this.refresh();
  }

  tick() {
    const nowDate = new Date();
    const now = nowDate.getTime();
    if (nowDate.toDateString() !== this.dayKey) this.refresh();
    if (this.schedule && now >= this.schedule.next.time) this.refresh();

    const s = this.getSettings().azan;
    for (const e of this.events) {
      if (!s.prayers[e.key]) continue;
      const preMin = s.preAlertMinutes;
      const preKey = `${e.dayKey}:${e.key}:pre`;
      const azanKey = `${e.dayKey}:${e.key}:azan`;
      if (preMin > 0 && !this.fired.has(preKey) && now >= e.time - preMin * 60e3 && now < e.time - 30e3) {
        this.fired.add(preKey);
        if (s.enabled) this.emit('pre-alert', { ...e, minutes: Math.round((e.time - now) / 60e3) });
      }
      if (!this.fired.has(azanKey) && now >= e.time && now < e.time + 60e3) {
        this.fired.add(azanKey);
        if (s.enabled) this.emit('azan', e);
      }
    }
  }
}

class Reminders extends EventEmitter {
  constructor({ dataDir, stateFile, getSettings, canShow }) {
    super();
    this.getSettings = getSettings;
    this.canShow = canShow;
    this.stateFile = stateFile;
    const ayat = JSON.parse(fs.readFileSync(path.join(dataDir, 'ayat.json'), 'utf8'));
    const azkar = JSON.parse(fs.readFileSync(path.join(dataDir, 'azkar.json'), 'utf8'));
    this.pools = {
      ayah: ayat.items.map((a) => ({
        id: `q${a.id}`, type: 'ayah', verses: a.verses, surahName: a.surahName, surah: a.surah, from: a.from, to: a.to,
      })),
      dhikr: azkar.items.filter((i) => i.type === 'dhikr'),
      dua: azkar.items.filter((i) => i.type === 'dua'),
    };
    this.afterAzan = azkar.afterAzan;
    this.state = { bags: {}, lastShown: 0 };
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
    this.pausedUntil = 0;
    this.nextAt = Date.now() + 60e3; // first one a minute after launch
    this.timer = null;
  }

  start() { this.timer = setInterval(() => this.tick(), 5000); }
  stop() { clearInterval(this.timer); }

  snooze(ms) {
    this.pausedUntil = Date.now() + ms;
    this.emit('snoozed', this.pausedUntil);
  }

  resetTimer() {
    this.nextAt = Date.now() + this.getSettings().azkar.intervalMinutes * 60e3;
  }

  tick() {
    const s = this.getSettings().azkar;
    const now = Date.now();
    if (!s.enabled || now < this.pausedUntil || now < this.nextAt) return;
    const verdict = this.canShow();
    if (verdict === 'later') { this.nextAt = now + 30e3; return; }
    this.resetTimer();
    if (verdict === 'skip') return;
    const item = this.pick();
    if (item) this.emit('show', item);
  }

  showNow() {
    const item = this.pick(true);
    if (item) this.emit('show', item);
    this.resetTimer();
  }

  /** Random type (weighted), then the next item from a shuffled "bag" so nothing repeats too soon. */
  pick(force = false) {
    const s = this.getSettings().azkar;
    const weights = { ayah: 5, dhikr: 3, dua: 2 };
    let types = Object.keys(weights).filter((t) => s[t] && this.pools[t].length);
    if (!types.length && force) types = ['ayah'];
    if (!types.length) return null;
    let r = Math.random() * types.reduce((a, t) => a + weights[t], 0);
    let type = types[0];
    for (const t of types) { r -= weights[t]; if (r <= 0) { type = t; break; } }

    const pool = this.pools[type];
    let bag = this.state.bags[type];
    if (!Array.isArray(bag) || !bag.length) {
      bag = pool.map((_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    const index = bag.shift();
    this.state.bags[type] = bag;
    this.state.lastShown = Date.now();
    this.persist();
    const item = pool[index] || pool[0];
    return { ...item, type, durationSeconds: s.durationSeconds };
  }

  afterAzanItem() {
    return { ...this.afterAzan, durationSeconds: Math.max(25, this.getSettings().azkar.durationSeconds) };
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
    } catch { /* not important */ }
  }
}

module.exports = { PrayerScheduler, Reminders, prayerOptions };
