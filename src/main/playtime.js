'use strict';
// Play time: how long each game is open in fullscreen, per day, kept for five weeks in
// %APPDATA%\Hilal\playtime.json. A fullscreen app counts as a game when Windows' own game list
// (the one Game Bar uses) knows it, or it lives in a game library folder. Browsers and video
// players never count.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const KEEP_DAYS = 35;
const GAME_FOLDERS = /\\(steamapps|epic games|riot games|xboxgames|gog games|battle\.net|ea games|origin games|ubisoft game launcher|rockstar games|games)\\/i;
const NOT_GAMES = new Set([
  'msedge', 'chrome', 'firefox', 'opera', 'opera_gx', 'brave', 'vivaldi', 'iexplore', 'arc', 'thorium',
  'vlc', 'mpc-hc', 'mpc-hc64', 'mpc-be', 'mpc-be64', 'potplayer', 'potplayermini', 'potplayermini64', 'wmplayer',
  'video.ui', 'microsoft.media.player', 'applicationframehost', 'explorer', 'powerpnt', 'winword', 'excel',
  'teams', 'ms-teams', 'zoom', 'discord', 'spotify', 'obs64', 'code', 'devenv', 'hilal', 'electron', 'steamwebhelper',
]);

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

class PlayTime extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'playtime.json');
    this.data = { days: {}, games: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') this.data = { days: saved.days || {}, games: saved.games || {} };
    } catch { /* first run */ }
    this.known = new Set(); // exe paths from Windows' game list
    this.current = null; // { key, since }
    this.timer = null;
    this.loadKnownGames();
    setInterval(() => this.loadKnownGames(), 30 * 60e3).unref();
  }

  // Windows remembers the games Game Bar has seen (HKCU\System\GameConfigStore\Children).
  loadKnownGames() {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFile(reg, ['query', 'HKCU\\System\\GameConfigStore\\Children', '/s', '/v', 'MatchedExeFullPath'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return;
      const known = new Set();
      for (const line of String(out).split(/\r?\n/)) {
        const m = /MatchedExeFullPath\s+REG_\w+\s+(.+)$/.exec(line.trim());
        if (m) known.add(m[1].trim().toLowerCase());
      }
      this.known = known;
    });
  }

  isGame(app) {
    if (!app || !app.exe) return false;
    const exe = app.exe.toLowerCase();
    if (NOT_GAMES.has(exe)) return false;
    const file = (app.path || '').toLowerCase();
    return (file && this.known.has(file)) || GAME_FOLDERS.test(file);
  }

  // A fullscreen app came to the front (or fullscreen ended: app = null).
  onFullscreen(app) {
    const game = app && this.isGame(app) ? app : null;
    const key = game ? game.exe.toLowerCase() : null;
    if (this.current && this.current.key === key) return;
    this.stop();
    if (!game) return;
    const title = (game.title || '').trim();
    const name = title && title.length <= 40 ? title : (game.product || game.exe);
    this.data.games[key] = { name, path: game.path || '' };
    this.current = { key, since: Date.now() };
    this.timer = setInterval(() => this.flush(), 60e3);
    this.emit('change', { started: name });
  }

  stop() {
    if (!this.current) return;
    this.flush();
    const { key } = this.current;
    this.current = null;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('change', { stopped: key });
  }

  // Adds the time since the last flush to today (so a crash loses at most a minute).
  flush() {
    if (!this.current) return;
    const now = Date.now();
    const secs = Math.round((now - this.current.since) / 1000);
    this.current.since = now;
    if (secs <= 0 || secs > 2 * 3600) return; // e.g. the PC slept in between
    const day = dayKey();
    const today = this.data.days[day] || (this.data.days[day] = {});
    today[this.current.key] = (today[this.current.key] || 0) + secs;
    const keep = Object.keys(this.data.days).sort().slice(-KEEP_DAYS);
    this.data.days = Object.fromEntries(keep.map((k) => [k, this.data.days[k]]));
    this.save();
    this.emit('change', {});
  }

  save() {
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* try again next minute */ }
  }

  // Today and the last 7 days, per game, including the game being played right now.
  summary() {
    const live = this.current ? Math.round((Date.now() - this.current.since) / 1000) : 0;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(dayKey(d));
    }
    const today = days[6];
    const perGame = {};
    const week = days.map((day) => {
      const games = { ...(this.data.days[day] || {}) };
      if (day === today && this.current) games[this.current.key] = (games[this.current.key] || 0) + live;
      let total = 0;
      for (const [key, secs] of Object.entries(games)) {
        total += secs;
        const g = perGame[key] || (perGame[key] = { key, today: 0, week: 0 });
        g.week += secs;
        if (day === today) g.today += secs;
      }
      return { day, secs: total };
    });
    const games = Object.values(perGame)
      .map((g) => ({ ...g, name: (this.data.games[g.key] || {}).name || g.key, path: (this.data.games[g.key] || {}).path || '', playing: !!(this.current && this.current.key === g.key) }))
      .sort((a, b) => b.today - a.today || b.week - a.week);
    return { week, games, today: week[6].secs, playing: this.current ? this.current.key : null };
  }
}

module.exports = { PlayTime };
