'use strict';
/* The island UI. Talks to the main process through window.island (see preload.js). */

const api = window.island;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ic = (name, cls) => window.icon(name, cls);

const S = {
  settings: null,
  meta: null,
  prayer: null,
  media: { current: null, sessions: [] },
  thumbs: new Map(),
  colors: new Map(),
  downloads: [],
  fullscreen: false,
  sound: { master: null, brightness: null, mixer: null }, // see sound.js
  system: null, // see system.js
  fps: null, // see system.js
  mic: null, // see sound.js
  playtime: null, // see system.js
};

const ui = {
  mode: 'compact',
  tab: 'prayer',
  lastTab: 'prayer',
  queue: [],
  current: null,
  azan: null,
  zItem: null,
  sheet: null,
  showAdjust: false,
  tasbih: { phase: 0, count: 0 },
  hover: false,
  inputFocused: false,
  islandSize: null,
  pinnedSession: null,
  preview: null,
};

const E = {
  island: $('#island'),
  compact: $('#compact'),
  expanded: $('#expanded'),
  bar: $('#bar'),
  views: {
    music: $('#view-music'),
    downloads: $('#view-downloads'),
    prayer: $('#view-prayer'),
    azkar: $('#view-azkar'),
    sound: $('#view-sound'),
    system: $('#view-system'),
    settings: $('#view-settings'),
  },
  reminder: $('#reminder'),
  azan: $('#azan'),
  toast: $('#toast'),
  osd: $('#osd'),
  bubble: $('#bubble'),
  audio: $('#azan-audio'),
};

// ================================================================ formatting

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);
const is12h = () => !S.settings || S.settings.general.timeFormat !== '24h';
const DATE_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function fmtTime(ms) {
  const d = new Date(ms);
  const m = String(d.getMinutes()).padStart(2, '0');
  if (!is12h()) return `${String(d.getHours()).padStart(2, '0')}:${m}`;
  const h = d.getHours() % 12 || 12;
  return `${h}:${m} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const fmtCountdown = (ms) => fmtDuration(Math.ceil(Math.max(0, ms) / 1000));

function fmtBytes(b) {
  if (!(b >= 0)) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
const fmtSpeed = (bps) => `${fmtBytes(Math.round(bps))}/s`;

function minutesAr(n) {
  if (n === 1) return 'دقيقة';
  if (n === 2) return 'دقيقتين';
  if (n <= 10) return `${arNum(n)} دقائق`;
  return `${arNum(n)} دقيقة`;
}

const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
function patchFor(p, value) {
  const keys = p.split('.');
  const out = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = cur[k] = {};
  });
  return out;
}

// ================================================================ data helpers

function nextPrayer() {
  const p = S.prayer;
  if (!p) return null;
  const now = Date.now();
  const n = p.list.find((x) => x.time > now);
  return n || { key: 'fajr', name: 'الفجر', nameEn: 'Fajr', time: p.tomorrowFajr, azan: true, tomorrow: true };
}

function prayerCountdownActive() {
  const np = nextPrayer();
  const a = S.settings && S.settings.azan;
  if (!np || !np.azan || !a || !a.enabled || !a.prayers[np.key] || a.preAlertMinutes <= 0) return false;
  const left = np.time - Date.now();
  return left > 0 && left <= a.preAlertMinutes * 60e3;
}

function appName(aumid) {
  const a = String(aumid || '').toLowerCase();
  const known = [
    ['spotify', 'Spotify'], ['chrome', 'Chrome'], ['msedge', 'Edge'], ['firefox', 'Firefox'], ['zunemusic', 'Media Player'],
    ['vlc', 'VLC'], ['brave', 'Brave'], ['opera', 'Opera'], ['applemusic', 'Apple Music'], ['itunes', 'iTunes'],
    ['youtube', 'YouTube Music'], ['deezer', 'Deezer'], ['tidal', 'TIDAL'], ['soundcloud', 'SoundCloud'], ['anghami', 'Anghami'],
    ['foobar', 'foobar2000'], ['aimp', 'AIMP'], ['musicbee', 'MusicBee'], ['winamp', 'Winamp'], ['potplayer', 'PotPlayer'],
  ];
  for (const [k, v] of known) if (a.includes(k)) return v;
  if (/^[0-9a-f]{16}$/.test(a)) return 'Firefox';
  const bang = /!([^!]+)$/.exec(aumid || '');
  if (bang) return bang[1];
  const exe = /([^\\/]+?)(\.exe)?$/i.exec(aumid || '');
  return exe ? exe[1] : 'Media';
}

function activeSession() {
  const ss = S.media.sessions || [];
  if (ui.pinnedSession) {
    const p = ss.find((s) => s.id === ui.pinnedSession);
    if (p) return p;
  }
  return ss.find((s) => s.status === 'playing' && s.id === S.media.current)
    || ss.find((s) => s.status === 'playing')
    || ss.find((s) => s.id === S.media.current)
    || ss[0] || null;
}
const isPlaying = () => { const s = activeSession(); return !!s && s.status === 'playing'; };
const thumbUrl = (s) => (s && s.thumb ? S.thumbs.get(s.thumb) || null : null);

function sessionPos(s) {
  let p = s.pos || 0;
  if (s.status === 'playing' && s.upd) p += (Date.now() - s.upd) / 1000;
  return clamp(p, 0, s.dur > 0 ? s.dur : p);
}

const activeDownloads = () => S.downloads.filter((d) => d.status === 'downloading' || d.status === 'merging');
const totalSpeed = () => activeDownloads().reduce((a, d) => a + (d.speed || 0), 0);
function overallProgress() {
  const ds = activeDownloads().filter((d) => d.size > 0);
  if (!ds.length) return null;
  const size = ds.reduce((a, d) => a + d.size, 0);
  return clamp(ds.reduce((a, d) => a + d.received, 0) / size, 0, 1);
}

const KINDS = [
  [['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'm4v'], 'linear-gradient(165deg,#f8b26a 0%,#c0587a 55%,#4a2c80 100%)'],
  [['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg', 'opus'], 'linear-gradient(160deg,#f472b6,#8b5cf6 70%,#4c1d95)'],
  [['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'], 'linear-gradient(160deg,#f5a524,#b45309)'],
  [['iso', 'img', 'dmg', 'bin'], 'linear-gradient(160deg,#b7791f,#5b3713)'],
  [['exe', 'msi', 'msix', 'appx', 'apk', 'jar', 'deb', 'rpm'], 'linear-gradient(160deg,#60a5fa,#1d4ed8)'],
  [['pdf'], 'linear-gradient(160deg,#f87171,#b91c1c)'],
  [['doc', 'docx', 'txt', 'rtf', 'epub', 'md'], 'linear-gradient(160deg,#7aa7ff,#2747b0)'],
  [['xls', 'xlsx', 'csv'], 'linear-gradient(160deg,#4ade80,#15803d)'],
  [['ppt', 'pptx'], 'linear-gradient(160deg,#fb923c,#c2410c)'],
  [['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic'], 'linear-gradient(160deg,#2dd4bf,#0f766e)'],
];
function fileKind(name) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  const hit = KINDS.find(([exts]) => exts.includes(e));
  return { label: e ? e.toUpperCase().slice(0, 4) : 'FILE', tile: hit ? hit[1] : 'linear-gradient(160deg,#5b5b66,#2a2a30)' };
}

// ================================================================ geometry & modes

function setGeometry() {
  let w;
  let h;
  let r;
  switch (ui.mode) {
    case 'expanded': w = 680; h = E.expanded.offsetHeight; r = 30; break;
    case 'reminder': w = 780; h = E.reminder.offsetHeight; r = 38; break;
    case 'azan': w = 560; h = E.azan.offsetHeight; r = 40; break;
    case 'toast': w = 440; h = E.toast.offsetHeight; r = 28; break;
    case 'osd': w = 340; h = 44; r = 22; break;
    default: w = clamp(E.compact.offsetWidth, 110, 460); h = 36; r = 18;
  }
  h = Math.min(h, 524);
  E.island.style.width = `${w}px`;
  E.island.style.height = `${h}px`;
  E.island.style.borderRadius = `${r}px`;
  E.bubble.style.translate = `${w / 2 + 8}px 0`;
  ui.islandSize = { w, h };
  reportRects();
}

// Tells the app where the island (and its bubble) will be, so clicks there reach us and
// clicks anywhere else in this transparent window pass through to the apps underneath.
function reportRects() {
  if (!ui.islandSize) return;
  const { w, h } = ui.islandSize;
  const mid = window.innerWidth / 2;
  const island = { x: mid - w / 2, y: 8, w, h };
  const bubble = E.bubble.classList.contains('show') ? { x: mid + w / 2 + 8, y: 8, w: 36, h: 36 } : null;
  api.reportRects({ island, bubble });
}

function setMode(mode) {
  const changed = ui.mode !== mode;
  ui.mode = mode;
  E.island.dataset.mode = mode;
  E.island.classList.remove('peek');
  if (changed) api.uiState({ expanded: mode === 'expanded', mode });
  if (mode !== 'expanded') {
    ui.sheet = null;
    releaseFocus();
  }
  renderCompact();
  setGeometry();
  if (typeof syncSoundWatch === 'function') syncSoundWatch(); // sound.js
  if (typeof syncSystemWatch === 'function') syncSystemWatch(); // system.js
}

function contextualTab() {
  if (activeDownloads().length) return 'downloads';
  if (isPlaying()) return 'music';
  return ui.lastTab || 'prayer';
}

function expand(tab) {
  if (ui.mode === 'azan') return;
  if (ui.mode === 'reminder' || ui.mode === 'toast') ui.current = null;
  ui.tab = tab || contextualTab();
  if (ui.tab !== 'settings') ui.lastTab = ui.tab;
  renderExpanded();
  setMode('expanded');
  // Opened from the tray (mouse elsewhere)? Close again if it's never hovered.
  if (!ui.hover) scheduleCollapse(6000);
}

function collapse(reason = '') {
  clearTimeout(ui.collapseTimer);
  if (ui.mode === 'azan') return;
  if (S.meta && S.meta.debug) console.warn(`collapse: ${reason}`);
  ui.current = null;
  stopPreview();
  setMode('compact');
  setTimeout(processQueue, 500);
}

function scheduleCollapse(delay = 1100) {
  clearTimeout(ui.collapseTimer);
  ui.collapseTimer = setTimeout(() => {
    if (ui.mode === 'expanded' && !ui.hover && !ui.inputFocused && !ui.sheet) collapse(`timer ${delay}ms`);
  }, delay);
}

// Overlays (reminders, toasts) wait their turn and never interrupt the azan
// or an island you're using.
function present(kind, data) {
  if (kind === 'azan') {
    ui.queue = ui.queue.filter((q) => q.kind !== 'reminder');
    showAzan(data);
    return;
  }
  data.queuedAt = Date.now();
  if (ui.mode !== 'compact') {
    if (kind === 'reminder') ui.queue = ui.queue.filter((q) => q.kind !== 'reminder');
    ui.queue.push({ kind, data });
    return;
  }
  show(kind, data);
}

function show(kind, data) {
  if (kind === 'reminder') showReminder(data);
  else if (kind === 'toast') showToast(data);
}

function processQueue() {
  if (ui.mode !== 'compact') return;
  ui.queue = ui.queue.filter((q) => Date.now() - q.data.queuedAt < 3 * 60e3 && !(q.data.countdownTo && q.data.countdownTo < Date.now()));
  const next = ui.queue.shift();
  if (next) show(next.kind, next.data);
}

function dismissOverlay() {
  ui.current = null;
  setMode('compact');
  setTimeout(processQueue, 550);
}

// ================================================================ compact

function eqHtml(paused) {
  return `<div class="eq${paused ? ' paused' : ''}"><i></i><i></i><i></i><i></i></div>`;
}

function ringHtml(p) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const off = p == null ? c * 0.7 : c * (1 - p);
  return `<div class="ring${p == null ? ' spin' : ''}"><svg class="rsvg" viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="${r}"/><circle class="fill" cx="11" cy="11" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>${ic('arrowDown')}</div>`;
}

function activities() {
  const list = [];
  if (prayerCountdownActive()) list.push('countdown');
  if (activeDownloads().length) list.push('download');
  if (isPlaying()) list.push('music');
  return list;
}

function renderCompact() {
  if (!S.settings) return;
  const acts = activities();
  const primary = acts[0] || 'idle';
  let html;
  if (primary === 'countdown') {
    const np = nextPrayer();
    html = `<div class="compact" dir="rtl">${ic('moon', 'gold')}<span class="c-name">${esc(np.name)}</span><span class="c-sub">بعد</span><span class="c-count" dir="ltr">${fmtCountdown(np.time - Date.now())}</span></div>`;
  } else if (primary === 'download') {
    const ds = activeDownloads();
    const p = overallProgress();
    const name = ds.length > 1 ? `${ds.length} downloads` : ds[0].name;
    html = `<div class="compact">${ringHtml(p)}<span class="c-title">${esc(name)}</span><span class="c-gap"></span>`
      + `<span class="c-sub">${fmtSpeed(totalSpeed())}</span>${p != null ? `<span class="c-pct">${Math.floor(p * 100)}%</span>` : ''}</div>`
      + `${p != null ? `<div class="c-progress"><i style="width:${(p * 100).toFixed(1)}%"></i></div>` : ''}`;
  } else if (primary === 'music') {
    const s = activeSession();
    const art = thumbUrl(s);
    const color = S.colors.get(s.thumb) || '#ffffff';
    html = `<div class="compact" style="--accent:${color}"><div class="c-art"${art ? ` style="background-image:url('${art}')"` : ''}>${art ? '' : ic('music')}</div>`
      + `<span class="c-title">${esc(s.title || appName(s.aumid))}</span><span class="c-gap"></span>${eqHtml(false)}</div>`;
  } else {
    const np = nextPrayer();
    html = np
      ? `<div class="compact idle" dir="rtl">${ic('moon', 'gold')}<span class="c-name">${esc(np.name)}</span><span class="c-sub" dir="ltr">${fmtTime(np.time)}</span></div>`
      : '<div class="compact idle"><span class="c-idle-dot"></span></div>';
  }
  // CPU / GPU readout after the usual content, if turned on (system.js fills in the numbers)
  const readout = typeof sysReadoutHtml === 'function' ? sysReadoutHtml() : '';
  // a red mic in front while the microphone is muted
  const mic = S.mic && S.mic.muted ? `<span class="c-mic" title="Microphone muted">${ic('micOff')}</span>` : '';
  if (readout || mic) html = `<div class="c-row">${mic}${html}${readout}</div>`;
  if (html !== ui.compactHtml) {
    ui.compactHtml = html;
    E.compact.innerHTML = html;
    if (typeof updateSysReadout === 'function') updateSysReadout();
    if (ui.mode === 'compact') setGeometry();
  }
  renderBubble(ui.mode === 'compact' ? acts[1] : null);
}

function renderBubble(kind) {
  let html = '';
  if (kind === 'music') {
    const art = thumbUrl(activeSession());
    html = art ? `<div class="c-art" style="background-image:url('${art}')"></div>` : ic('music');
  } else if (kind === 'download') {
    html = ringHtml(overallProgress());
  } else if (kind === 'countdown') {
    html = ic('moon');
  }
  if (html !== ui.bubbleHtml) {
    ui.bubbleHtml = html;
    E.bubble.innerHTML = html;
  }
  E.bubble.dataset.kind = kind || '';
  if (E.bubble.classList.contains('show') !== !!html) {
    E.bubble.classList.toggle('show', !!html);
    reportRects();
  }
}

// ================================================================ expanded

function statusInfo() {
  if (ui.flash && ui.flash.until > Date.now()) return { cls: 'sound', label: ui.flash.label }; // e.g. "Volume 40%"
  if (ui.azan) return { cls: 'prayer', label: 'Azan' };
  if (activeDownloads().length) return { cls: 'downloading', label: 'Downloading' };
  if (isPlaying()) return { cls: 'playing', label: 'Playing' };
  if (prayerCountdownActive()) return { cls: 'prayer', label: 'Prayer soon' };
  return { cls: '', label: 'Idle' };
}

function renderBar() {
  const st = statusInfo();
  const tabs = [['music', 'music', 'Music'], ['sound', 'volume', 'Sound'], ['downloads', 'download', 'Downloads'], ['prayer', 'moon', 'Prayer'], ['azkar', 'book', 'Azkar'], ['system', 'activity', 'System']];
  const dlDot = activeDownloads().length > 0 && ui.tab !== 'downloads';
  const html = `<div class="status-chip ${st.cls}"><span class="dot"></span>${st.label}</div>
    <nav class="tabs">${tabs.map(([id, iconName, label]) => `<button class="tab${ui.tab === id ? ' active' : ''}" data-act="tab" data-tab="${id}" title="${label}">${ic(iconName)}<span class="label">${label}</span>${id === 'downloads' && dlDot ? '<span class="badge-dot"></span>' : ''}</button>`).join('')}</nav>
    <button class="icon-btn${ui.tab === 'settings' ? ' on' : ''}" data-act="tab" data-tab="settings" title="Settings">${ic('settings')}</button>
    <div class="clock"><b id="clock-time"></b><span id="clock-date"></span></div>`;
  if (html !== ui.barHtml) {
    ui.barHtml = html;
    E.bar.innerHTML = html;
  }
  updateClock();
}

function updateClock() {
  const t = $('#clock-time');
  if (!t) return;
  const now = new Date();
  t.textContent = fmtTime(now.getTime());
  $('#clock-date').textContent = DATE_FMT.format(now);
}

function renderExpanded() {
  renderBar();
  for (const [k, v] of Object.entries(E.views)) v.classList.toggle('active', k === ui.tab);
  renderView(ui.tab);
  if (typeof syncSoundWatch === 'function') syncSoundWatch(); // sound.js
  if (typeof syncSystemWatch === 'function') syncSystemWatch(); // system.js
}

function renderView(tab) {
  if (tab === 'music') renderMusic();
  else if (tab === 'downloads') renderDownloads();
  else if (tab === 'prayer') renderPrayer();
  else if (tab === 'azkar') renderAzkar();
  else if (tab === 'sound') renderSound();
  else if (tab === 'system') renderSystem();
  else if (tab === 'settings') renderSettings(true);
}

// ---------------------------------------------------------------- music

function musicKey() {
  const s = activeSession();
  if (!s) return 'none';
  return [s.id, s.title, s.artist, s.status, s.thumb, S.thumbs.has(s.thumb), S.colors.get(s.thumb), s.canPrev, s.canNext, s.dur > 0,
    (S.media.sessions || []).map((x) => x.id).join('|')].join('~');
}

function renderMusic() {
  const v = E.views.music;
  const s = activeSession();
  ui.musicKey = musicKey();
  if (!s) {
    v.innerHTML = `<div class="empty">${ic('music')}<b>Nothing playing</b><span>Play something in Spotify, YouTube or any media app. It shows up here, and it pauses by itself when the azan starts.</span></div>`;
    return;
  }
  const art = thumbUrl(s);
  const color = S.colors.get(s.thumb) || '#ffffff';
  const sessions = S.media.sessions || [];
  const pos = sessionPos(s);
  v.innerHTML = `<div class="music" style="--accent:${color}">
    ${art ? `<div class="m-glow" style="background-image:url('${art}')"></div>` : ''}
    <div class="m-art"${art ? ` style="background-image:url('${art}')"` : ''}>${art ? '' : ic('music')}</div>
    <div class="m-info">
      <div class="m-top">
        <div class="m-app"><span class="dot"></span>${esc(appName(s.aumid))}${s.status !== 'playing' ? ' · Paused' : ''}</div>
        ${sessions.length > 1 ? `<div class="m-sessions">${sessions.slice(0, 4).map((x) => `<button class="m-session${x.id === s.id ? ' on' : ''}" data-act="session" data-id="${esc(x.id)}">${esc(appName(x.aumid))}</button>`).join('')}</div>` : ''}
      </div>
      <div class="m-title">${esc(s.title || 'Unknown title')}</div>
      <div class="m-artist">${esc(s.artist || s.album || '')}</div>
      ${s.dur > 0 ? `<div class="m-progress"><span id="m-pos">${fmtDuration(pos)}</span><div class="m-bar${s.canSeek ? ' seekable' : ''}" data-act="seek"><i id="m-fill" style="width:${((pos / s.dur) * 100).toFixed(2)}%"></i></div><span id="m-left">-${fmtDuration(s.dur - pos)}</span></div>` : ''}
      <div class="m-controls">
        <button class="m-btn" data-act="media" data-cmd="prev" title="Previous"${s.canPrev ? '' : ' disabled'}>${ic('prev')}</button>
        <button class="m-btn big" data-act="media" data-cmd="toggle" title="${s.status === 'playing' ? 'Pause' : 'Play'}">${ic(s.status === 'playing' ? 'pause' : 'play')}</button>
        <button class="m-btn" data-act="media" data-cmd="next" title="Next"${s.canNext ? '' : ' disabled'}>${ic('next')}</button>
      </div>
    </div>
  </div>`;
}

function updateMusicProgress() {
  const s = activeSession();
  const fill = $('#m-fill');
  if (!s || !fill || !(s.dur > 0)) return;
  const pos = sessionPos(s);
  fill.style.width = `${((pos / s.dur) * 100).toFixed(2)}%`;
  $('#m-pos').textContent = fmtDuration(pos);
  $('#m-left').textContent = `-${fmtDuration(s.dur - pos)}`;
}

function refreshMedia() {
  renderCompact();
  if (ui.mode !== 'expanded') return;
  renderBar();
  if (ui.tab === 'music') {
    if (musicKey() !== ui.musicKey) {
      renderMusic();
      setGeometry();
    } else {
      updateMusicProgress();
    }
  }
}

function extractColor(key, dataUrl) {
  if (S.colors.has(key)) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    let wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      const min = Math.min(d[i], d[i + 1], d[i + 2]);
      const sat = max ? (max - min) / max : 0;
      const w = sat * sat * (max > 60 ? 1 : 0.1) + 0.004;
      r += d[i] * w; gr += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
    }
    r /= wsum; gr /= wsum; b /= wsum;
    const m = Math.max(r, gr, b, 1);
    const k = m < 190 ? 190 / m : 1;
    S.colors.set(key, `rgb(${Math.min(255, Math.round(r * k))},${Math.min(255, Math.round(gr * k))},${Math.min(255, Math.round(b * k))})`);
    refreshMedia();
  };
  img.src = dataUrl;
}

// ---------------------------------------------------------------- downloads

function renderDownloads() {
  const v = E.views.downloads;
  if (!v.dataset.ready) {
    v.innerHTML = `
      <div class="dl-head"><div class="dl-summary" id="dl-summary"></div>
        <div class="actions"><button class="btn small ghost" data-act="dl-clear" id="dl-clear">Clear finished</button>
        <button class="btn small" data-act="dl-folder">${ic('folder')}Open folder</button></div></div>
      <form class="dl-add" id="dl-form" autocomplete="off">${ic('link')}<input id="dl-url" type="text" placeholder="Paste a link to download..." spellcheck="false" />
        <button class="btn primary small" type="submit">Download ${ic('arrowDown')}</button></form>
      <div class="dl-error" id="dl-error" hidden></div>
      <div class="dl-list" id="dl-list"></div>`;
    v.dataset.ready = '1';
    $('#dl-form').addEventListener('submit', onDownloadSubmit);
  }
  const act = activeDownloads();
  const summary = act.length
    ? `<b>${act.length} downloading</b> · ${fmtSpeed(totalSpeed())}`
    : S.downloads.length ? `${S.downloads.filter((d) => d.status === 'completed').length} finished` : 'Downloads';
  $('#dl-summary').innerHTML = summary;
  $('#dl-clear').hidden = !S.downloads.some((d) => ['completed', 'failed', 'canceled'].includes(d.status));
  const err = $('#dl-error');
  err.hidden = !ui.dlError;
  err.textContent = ui.dlError || '';
  renderDownloadList();
}

function dlButton(op, iconName, title) {
  return `<button class="icon-btn" data-act="dl" data-op="${op}" title="${title}">${ic(iconName)}</button>`;
}

function dlParts(d) {
  const p = d.size > 0 ? clamp(d.received / d.size, 0, 1) : null;
  const sizeTxt = d.size > 0 ? `${fmtBytes(d.received)} of ${fmtBytes(d.size)}` : fmtBytes(d.received);
  let bar = '';
  let meta = '';
  let actions = '';
  let width = p != null ? p * 100 : 0;
  switch (d.status) {
    case 'downloading':
      bar = p == null ? 'indeterminate' : '';
      meta = [sizeTxt, d.speed > 0 ? fmtSpeed(d.speed) : null, d.eta != null && Number.isFinite(d.eta) ? `${fmtDuration(d.eta)} left` : null].filter(Boolean).join(' · ');
      if (d.kind === 'browser') meta += ` <span class="tag">· in ${esc(d.browser || 'browser')}</span>`;
      else if (d.connections > 1) meta += ` <span class="tag">· ${d.connections} connections</span>`;
      actions = d.kind === 'direct' ? dlButton('pause', 'pause', 'Pause') + dlButton('cancel', 'x', 'Cancel') : '';
      break;
    case 'merging':
      bar = 'indeterminate';
      meta = 'Finishing...';
      break;
    case 'queued':
      bar = 'paused';
      meta = 'Waiting for a free slot...';
      actions = dlButton('cancel', 'x', 'Cancel');
      break;
    case 'paused':
      bar = 'paused';
      meta = `Paused · ${sizeTxt}`;
      actions = dlButton('resume', 'play', 'Resume') + dlButton('cancel', 'x', 'Cancel');
      break;
    case 'stalled':
      bar = 'paused';
      meta = `${sizeTxt} · paused in ${esc(d.browser || 'browser')}`;
      break;
    case 'failed':
      bar = 'failed';
      meta = `<span class="err">${esc(d.error || 'Download failed')}</span>`;
      actions = dlButton('retry', 'retry', 'Try again') + dlButton('remove', 'x', 'Remove');
      break;
    case 'canceled':
      bar = 'failed';
      width = 0;
      meta = 'Canceled';
      actions = dlButton('retry', 'retry', 'Start again') + dlButton('remove', 'x', 'Remove');
      break;
    case 'completed':
      bar = 'done';
      width = 100;
      meta = `${fmtBytes(d.size)} · Done${d.kind === 'browser' ? ` · ${esc(d.browser || 'browser')}` : ''}`;
      actions = dlButton('open', 'external', 'Open') + dlButton('show', 'folder', 'Show in folder') + dlButton('remove', 'x', 'Remove from list');
      break;
    default:
      meta = esc(d.status);
  }
  return { bar, meta, actions, width };
}

function renderDownloadList() {
  const list = $('#dl-list');
  if (!list) return;
  if (!S.downloads.length) {
    if (list.dataset.empty !== '1') {
      list.dataset.empty = '1';
      list.innerHTML = `<div class="empty" style="min-height:120px">${ic('download')}<b>No downloads yet</b><span>Paste a link above. Copy a file link anywhere and the island offers to download it. Downloads from Chrome, Edge and Firefox show up here too.</span></div>`;
    }
    return;
  }
  if (list.dataset.empty === '1') { list.innerHTML = ''; list.dataset.empty = ''; }
  const existing = new Map([...list.children].map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const d of S.downloads) {
    const parts = dlParts(d);
    const shape = [d.status, d.name, parts.actions, parts.bar].join('|');
    let el = existing.get(d.id);
    if (!el || el.dataset.shape !== shape) {
      const k = fileKind(d.name);
      const fresh = document.createElement('div');
      fresh.className = `dl-item${d.status === 'failed' ? ' failed' : ''}`;
      fresh.dataset.id = d.id;
      fresh.dataset.shape = shape;
      fresh.innerHTML = `<div class="ftile" style="--tile:${k.tile}">${esc(k.label)}</div>
        <div class="dl-main"><div class="dl-name" title="${esc(d.name)}">${esc(d.name)}</div>
        <div class="dl-bar ${parts.bar}"><i style="width:${parts.width.toFixed(1)}%"></i></div>
        <div class="dl-meta">${parts.meta}</div></div>
        <div class="dl-actions">${parts.actions}</div>`;
      if (el) el.replaceWith(fresh);
      el = fresh;
    } else {
      el.querySelector('.dl-bar > i').style.width = `${parts.width.toFixed(1)}%`;
      const meta = el.querySelector('.dl-meta');
      if (meta.innerHTML !== parts.meta) meta.innerHTML = parts.meta;
    }
    existing.delete(d.id);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== el) list.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

async function onDownloadSubmit(e) {
  e.preventDefault();
  const input = $('#dl-url');
  const url = input.value.trim();
  if (!url) return;
  const r = await api.downloads.add(url);
  ui.dlError = r.ok ? '' : r.error;
  if (r.ok) input.value = '';
  renderDownloads();
  setGeometry();
}

function refreshDownloads() {
  renderCompact();
  if (ui.mode !== 'expanded') return;
  renderBar();
  if (ui.tab === 'downloads') {
    renderDownloads();
    setGeometry();
  }
}

// ---------------------------------------------------------------- prayer

function renderPrayer() {
  const v = E.views.prayer;
  const p = S.prayer;
  if (!p) {
    v.innerHTML = `<div class="empty">${ic('moon')}<b>Calculating prayer times...</b></div>`;
    return;
  }
  const now = Date.now();
  const np = nextPrayer();
  const az = S.settings.azan;
  ui.prayerKey = `${np.key}-${np.time}-${p.computedAt}`;
  const rows = p.list.map((x) => {
    const cls = ['p-row', x.key === 'sunrise' ? 'sun' : '', !np.tomorrow && x.key === np.key ? 'next' : '', x.time <= now ? 'past' : ''].filter(Boolean).join(' ');
    const off = x.azan && (!az.enabled || !az.prayers[x.key]) ? ic('bellOff') : '';
    return `<div class="${cls}"><span class="t">${fmtTime(x.time)}</span><span class="n" dir="rtl">${esc(x.name)}${off}</span></div>`;
  }).join('');
  const loc = S.settings.location;
  v.innerHTML = `<div class="prayer">
    <div>
      <div class="p-list">${rows}</div>
      <div class="p-foot">${ic('pin')}<button data-act="tab" data-tab="settings" title="Change location">${esc(loc.name)} · ${esc(p.method.name)}</button></div>
    </div>
    <div class="p-card">
      <div class="crescent"><svg viewBox="0 0 100 100"><path fill="currentColor" d="M64 8a44 44 0 1 0 0 84a36 36 0 1 1 0-84z"/></svg></div>
      <div class="label">الصلاة القادمة</div>
      <div class="name">${esc(np.name)}</div>
      <div class="count" id="p-count">${fmtCountdown(np.time - now)}</div>
      <div class="at">${np.tomorrow ? 'غدًا' : 'اليوم'} <span dir="ltr">${fmtTime(np.time)}</span></div>
      <div class="bottom">
        <div class="hijri">${p.hijri ? esc(p.hijri.text) : ''}</div>
        <button class="bell-pill${az.enabled ? '' : ' off'}" data-act="toggle-azan" title="Azan alerts on/off">${ic(az.enabled ? 'bell' : 'bellOff')}التنبيهات</button>
      </div>
    </div>
  </div>`;
}

function updatePrayerCountdown() {
  const np = nextPrayer();
  if (!np) return;
  if (`${np.key}-${np.time}-${S.prayer.computedAt}` !== ui.prayerKey) {
    renderPrayer();
    return;
  }
  const el = $('#p-count');
  if (el) el.textContent = fmtCountdown(np.time - Date.now());
}

// ---------------------------------------------------------------- azkar

const TASBIH = [['سبحان الله', 33], ['الحمد لله', 33], ['الله أكبر', 34]];

function reminderRef(item) {
  if (!item) return '';
  if (item.type === 'ayah') return `${esc(item.surahName)} ${arNum(item.from)}${item.to > item.from ? `–${arNum(item.to)}` : ''}`;
  return [item.note, item.source].filter(Boolean).map(esc).join(' · ');
}

function ayahHtml(item) {
  const many = item.verses.length > 1;
  const body = item.verses.map((v) => `${esc(v.text)}${many ? `<span class="ayah-no">${arNum(v.n)}</span>` : ''}`).join(' ');
  return `<span class="orn">﴿</span>${body}<span class="orn">﴾</span>`;
}

const badgeFor = (type) => ({ ayah: ['آية', 'moon'], dhikr: ['ذكر', 'sparkle'], dua: ['دعاء', 'hand'] })[type] || ['ذكر', 'sparkle'];

function renderAzkar() {
  const v = E.views.azkar;
  if (!ui.zItem) {
    api.reminder.pick().then((item) => {
      if (!item) return;
      ui.zItem = item;
      if (ui.mode === 'expanded' && ui.tab === 'azkar') { renderAzkar(); setGeometry(); }
    });
  }
  const item = ui.zItem;
  const t = ui.tasbih;
  const [label, target] = TASBIH[t.phase];
  const r = 56;
  const c = 2 * Math.PI * r;
  const [badge, badgeIcon] = badgeFor(item ? item.type : 'dhikr');
  const len = item ? (item.type === 'ayah' ? item.verses.map((x) => x.text).join(' ') : item.text).length : 0;
  const size = len > 260 ? 16 : len > 190 ? 18 : len > 120 ? 20 : 23;
  v.innerHTML = `<div class="azkar">
    <div class="z-card">
      <div class="z-top">
        <span class="badge small">${ic(badgeIcon)}${badge}</span>
        <div style="display:flex;gap:4px">
          <button class="btn small ghost" data-act="z-next">${ic('refresh')}Another</button>
          <button class="btn small gold" data-act="z-popup" title="Show it as a pop-up">${ic('sparkle')}Pop up</button>
        </div>
      </div>
      <div class="z-text" style="font-size:${size}px">${item ? (item.type === 'ayah' ? ayahHtml(item) : esc(item.text)) : ''}</div>
      <div class="z-ref">${reminderRef(item)}</div>
    </div>
    <div class="tasbih">
      <button class="t-ring" data-act="tasbih" title="Tap to count">
        <svg viewBox="0 0 124 124"><circle class="track" cx="62" cy="62" r="${r}"/><circle class="fill" id="t-fill" cx="62" cy="62" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - t.count / target)).toFixed(2)}"/></svg>
        <div class="t-inner"><div class="t-count" id="t-count">${t.count}</div><div class="t-of">of ${target}</div></div>
      </button>
      <div class="t-label">${label}</div>
      <button class="t-reset" data-act="tasbih-reset">Reset</button>
    </div>
    <div class="z-foot">
      <div class="left">${switchHtml('azkar.enabled')}<span>Pop up every</span>${segHtml('azkar.intervalMinutes', [[1, '1m'], [5, '5m'], [15, '15m'], [30, '30m'], [60, '1h']])}</div>
      <button class="btn small ghost" data-act="z-snooze">${ic('bellOff')}Pause for 1 hour</button>
    </div>
  </div>`;
}

function tasbihTap() {
  const t = ui.tasbih;
  const target = TASBIH[t.phase][1];
  t.count += 1;
  if (t.count >= target) {
    t.phase = (t.phase + 1) % TASBIH.length;
    t.count = 0;
    playChime(0.25, [880, 1320]);
    renderAzkar();
    return;
  }
  const r = 56;
  const c = 2 * Math.PI * r;
  $('#t-count').textContent = t.count;
  $('#t-fill').setAttribute('stroke-dashoffset', (c * (1 - t.count / target)).toFixed(2));
}

// ---------------------------------------------------------------- settings controls

function switchHtml(p) {
  return `<button class="switch" role="switch" aria-checked="${!!getPath(S.settings, p)}" data-act="set-toggle" data-path="${p}"></button>`;
}

function segHtml(p, options) {
  const val = getPath(S.settings, p);
  return `<div class="seg">${options.map(([v, label]) => `<button class="${String(val) === String(v) ? 'on' : ''}" data-act="set-value" data-path="${p}" data-value="${esc(v)}" data-type="${typeof v}">${esc(label)}</button>`).join('')}</div>`;
}

const FORMATS = {
  days: (v) => (v === 0 ? 'None' : `${v > 0 ? '+' : ''}${v} day${Math.abs(v) === 1 ? '' : 's'}`),
  min: (v) => `${v > 0 ? '+' : ''}${v} min`,
  plain: (v) => String(v),
};

function stepperHtml(p, min, max, fmt = 'plain') {
  return `<div class="stepper"><button data-act="step" data-path="${p}" data-delta="-1" data-min="${min}" data-max="${max}" title="Less">${ic('minus')}</button>`
    + `<output data-path="${p}" data-fmt="${fmt}">${FORMATS[fmt](getPath(S.settings, p))}</output>`
    + `<button data-act="step" data-path="${p}" data-delta="1" data-min="${min}" data-max="${max}" title="More">${ic('plus')}</button></div>`;
}

function chipHtml(p, label, ar = false) {
  return `<button class="chip${ar ? ' ar' : ''}${getPath(S.settings, p) ? ' on' : ''}" data-act="set-toggle" data-path="${p}">${esc(label)}</button>`;
}

function rangeHtml(p, min, max, step) {
  const v = getPath(S.settings, p);
  return `<input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-path="${p}" style="--p:${((v - min) / (max - min)) * 100}%" />`;
}

function row(label, desc, control) {
  return `<div class="s-row"><div class="s-label"><b>${label}</b>${desc ? `<span>${desc}</span>` : ''}</div><div class="s-ctrl">${control}</div></div>`;
}

function section(title, iconName, rows, note = '') {
  return `<div class="s-section"><div class="s-title">${ic(iconName)}${title}</div><div class="s-group">${rows}</div>${note ? `<div class="s-note">${note}</div>` : ''}</div>`;
}

function settingsStructureKey() {
  const s = S.settings;
  return [s.location.cityId === 'custom', s.azan.voice === 'custom', s.azan.fajrVoice === 'custom', ui.showAdjust, s.azan.customFile, s.azan.fajrCustomFile, s.downloads.folder, ui.sheet && ui.sheet.id, !!s.general.islandOffset, s.general.lockPosition, S.fps && S.fps.available, S.fps && S.fps.requested, S.mic && S.mic.muted, S.mic && S.mic.ok, S.mic && S.mic.shortcutOk, s.mic.shortcut, ui.recShortcut, ui.recPreview, ui.recError].join('|');
}

function renderSettings(force = false) {
  const v = E.views.settings;
  const key = settingsStructureKey();
  if (!force && key === ui.settingsKey) {
    syncSettings();
    return;
  }
  ui.settingsKey = key;
  const s = S.settings;
  const scroller = v.querySelector('.settings');
  const scroll = scroller ? scroller.scrollTop : 0;
  const method = (S.meta.methods.find((m) => m.id === s.prayer.method) || {}).name || s.prayer.method;
  const voices = S.meta.voices.map((x) => [x.id, x.label.replace(' (short)', '')]);
  const fileName = (f) => (f ? f.split(/[\\/]/).pop() : '');
  const NAMES = S.meta.names.ar;

  const location = section('Location & prayer times', 'pin', [
    row('City', `${s.location.ar ? `<bdi>${esc(s.location.ar)}</bdi> · ` : ''}<span dir="ltr">${s.location.lat.toFixed(4)}, ${s.location.lon.toFixed(4)}</span>`,
      `<button class="select-btn" data-act="sheet" data-sheet="city"><span>${esc(s.location.name)}</span>${ic('chevronDown')}</button>
       <button class="btn small" data-act="detect-location" id="detect-btn">${ic('locate')}Detect</button>`),
    s.location.cityId === 'custom' ? row('Coordinates', 'Latitude and longitude in degrees',
      `<input class="text-in" type="text" data-coord="lat" value="${s.location.lat}" /><input class="text-in" type="text" data-coord="lon" value="${s.location.lon}" />`) : '',
    row('Calculation method', 'Picked automatically from your city; change it if your mosque differs',
      `<button class="select-btn" data-act="sheet" data-sheet="method"><span>${esc(method)}</span>${ic('chevronDown')}</button>`),
    row('Asr time', 'Hanafi starts Asr later', segHtml('prayer.asr', [['Standard', 'Standard'], ['Hanafi', 'Hanafi']])),
    row('Hijri date', 'Shift it if your country sighted the moon a day earlier or later', stepperHtml('prayer.hijriOffset', -3, 3, 'days')),
    row('Time format', '', segHtml('general.timeFormat', [['12h', '12-hour'], ['24h', '24-hour']])),
    row('Fine-tune times', 'Add or remove minutes to match your local mosque', `<button class="btn small" data-act="toggle-adjust">${ui.showAdjust ? 'Hide' : 'Adjust'}</button>`),
    ui.showAdjust ? `<div class="adjust-grid">${['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => `<div class="cell"><span class="ar">${NAMES[k]}</span>${stepperHtml(`prayer.adjust.${k}`, -30, 30, 'min')}</div>`).join('')}</div>` : '',
  ].join(''));

  const azan = section('Azan', 'bell', [
    row('Azan alerts', 'Play the azan and show it on the island at prayer time', switchHtml('azan.enabled')),
    row('Voice', s.azan.voice === 'custom' ? esc(fileName(s.azan.customFile)) : 'Choose a recording, or your own file',
      `${segHtml('azan.voice', [...voices, ['custom', 'My file...']])}<button class="icon-btn" data-act="preview" data-kind="main" title="Listen">${ic(ui.preview && ui.preview.kind === 'main' ? 'stop' : 'play')}</button>`),
    row('Fajr voice', s.azan.fajrVoice === 'custom' ? esc(fileName(s.azan.fajrCustomFile)) : 'Many people prefer a different azan for Fajr',
      `${segHtml('azan.fajrVoice', [['same', 'Same'], ...voices, ['custom', 'My file...']])}<button class="icon-btn" data-act="preview" data-kind="fajr" title="Listen">${ic(ui.preview && ui.preview.kind === 'fajr' ? 'stop' : 'play')}</button>`),
    row('Length', 'Short plays the first 30 seconds', segHtml('azan.mode', [['full', 'Full'], ['short', 'Short'], ['tone', 'Chime'], ['silent', 'Silent']])),
    row('Volume', '', rangeHtml('azan.volume', 0, 1, 0.05)),
    row('Heads-up before azan', 'A reminder and countdown before each prayer', segHtml('azan.preAlertMinutes', [[0, 'Off'], [5, '5m'], [10, '10m'], [15, '15m'], [20, '20m'], [30, '30m']])),
    row('Prayers', 'Turn the azan on or off per prayer', `<div class="chips">${['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => chipHtml(`azan.prayers.${k}`, NAMES[k], true)).join('')}</div>`),
    row('Pause music at azan', 'Pauses Spotify, YouTube and other media apps', switchHtml('azan.pauseMedia')),
    row('Mute other apps too', 'For apps that cannot be paused (games, some players); unmuted when the azan ends', switchHtml('azan.muteOthers')),
    row('Resume music afterwards', 'Off by default, so you can go and pray', switchHtml('azan.resumeAfter')),
    row('Dua after azan', 'Shows the dua after the azan finishes', switchHtml('azan.duaAfter')),
    row('Try it', 'Plays the azan now with these settings', `<button class="btn small gold" data-act="test-azan">${ic('play')}Test azan</button>`),
  ].join(''));

  const azkar = section('Ayat & azkar', 'book', [
    row('Pop-up reminders', 'A verse, dhikr or dua appears on the island now and then', switchHtml('azkar.enabled')),
    row('Every', '', segHtml('azkar.intervalMinutes', [[1, '1m'], [2, '2m'], [5, '5m'], [10, '10m'], [15, '15m'], [30, '30m'], [60, '1h']])),
    row('Stays on screen for', 'Hover over it to keep it open while you read', segHtml('azkar.durationSeconds', [[10, '10s'], [15, '15s'], [20, '20s'], [30, '30s'], [45, '45s'], [60, '60s']])),
    row('Show', '', `<div class="chips">${chipHtml('azkar.ayah', 'آيات', true)}${chipHtml('azkar.dhikr', 'أذكار', true)}${chipHtml('azkar.dua', 'أدعية', true)}</div>`),
    row('Quiet in fullscreen', 'No pop-ups while you watch or play in fullscreen', switchHtml('azkar.quietInFullscreen')),
    row('Show one now', '', `<button class="btn small gold" data-act="z-popup">${ic('sparkle')}Show</button>`),
  ].join(''), 'Quran text: Tanzil Uthmani (verbatim). Azkar from the authentic Sunnah collections.');

  const downloads = section('Downloads', 'download', [
    row('Save to', `<span class="path" title="${esc(s.downloads.folder)}">${esc(s.downloads.folder)}</span>`, `<button class="btn small" data-act="pick-folder">${ic('folder')}Change</button>`),
    row('Connections per file', 'More connections are usually faster', stepperHtml('downloads.connections', 1, 16)),
    row('Downloads at once', '', stepperHtml('downloads.maxActive', 1, 6)),
    row('Show browser downloads', 'Chrome, Edge and Firefox downloads appear on the island', switchHtml('downloads.watchBrowser')),
    row('Offer to download copied links', 'Copy a link to a file and the island asks to download it', switchHtml('downloads.clipboard')),
  ].join(''));

  const sound = section('Sound & display', 'volume', [
    row('Volume pop-up', 'The island shows the volume when you press the volume keys, instead of the Windows pop-up', switchHtml('general.volumeHud')),
    row('Scroll to change the volume', 'Scroll on the island; hold Shift to change the screen brightness', switchHtml('general.scrollVolume')),
  ].join(''));

  const fps = S.fps || {};
  const mic = S.mic || {};
  const microphone = section('Microphone', 'mic', [
    row('Mute shortcut', typeof shortcutHelp === 'function' ? shortcutHelp(mic) : '', typeof shortcutControlHtml === 'function' ? shortcutControlHtml() : ''),
    row('Microphone', mic.ok ? esc(mic.device || 'Default microphone') : 'No microphone found',
      mic.ok ? `<button class="btn small${mic.muted ? ' danger' : ''}" data-act="mic-toggle">${ic(mic.muted ? 'micOff' : 'mic')}${mic.muted ? 'Unmute' : 'Mute'}</button>` : ''),
    row('Sound when it changes', 'A short tone for muted and unmuted', switchHtml('mic.sound')),
    row('Show over games while muted', 'A small red mic in the corner of fullscreen games', switchHtml('mic.overlay')),
  ].join(''));

  const bluetooth = section('Bluetooth devices', 'bluetooth', [
    row('Show when a device connects', 'Your headphones or controller and their battery, for a few seconds', switchHtml('devices.connectPopup')),
    row('Warn when a battery is low', 'Once at 20% and again at 10%', switchHtml('devices.lowBattery')),
  ].join(''));

  const system = section('System', 'activity', [
    row('Show on the island', 'CPU use and GPU temperature (or memory) next to what the island shows', switchHtml('system.islandReadout')),
    fps.available === true
      ? row('FPS in games', 'A small counter over fullscreen games, instead of hiding the island', segHtml('system.fpsInGames', [['off', 'Off'], ['top-left', 'Top left'], ['top', 'Top'], ['top-right', 'Top right']]))
      : row('FPS counter', typeof fpsHelp === 'function' ? fpsHelp(fps) : '', fps.requested && fps.reason === 'permission' ? '' : '<button class="btn small" data-act="fps-allow">Allow</button>'),
  ].join(''));

  const general = section('General', 'settings', [
    row('Start with Windows', '', switchHtml('general.launchAtStartup')),
    row('Hide in fullscreen apps', 'Gets out of the way of games and videos (the azan still shows)', switchHtml('general.hideInFullscreen')),
    row('Position', s.general.lockPosition ? 'Locked. Turn off Lock position to move it' : 'Drag the island up or down, or set it here',
      `${rangeHtml('general.islandOffset', 0, Math.max(40, (window.screen.availHeight || 1040) - 540), 1).replace('<input', s.general.lockPosition ? '<input disabled' : '<input')}<button class="btn small" data-act="reset-position"${s.general.islandOffset && !s.general.lockPosition ? '' : ' disabled'}>Reset</button>`),
    row('Lock position', 'Keeps the island where it is, so it can\'t be dragged by accident', switchHtml('general.lockPosition')),
    row('Hide the island', 'Bring it back from the tray icon', `<button class="btn small" data-act="hide-island">${ic('eyeOff')}Hide</button>`),
    row('Quit', `Hilal ${esc(S.meta.version)}`, `<button class="btn small danger" data-act="quit">${ic('power')}Quit</button>`),
  ].join(''));

  v.innerHTML = `<div class="settings">${location}${azan}${azkar}${downloads}${sound}${microphone}${system}${bluetooth}${general}</div>${ui.sheet ? sheetHtml() : ''}`;
  const sc = v.querySelector('.settings');
  sc.scrollTop = scroll;
  if (ui.sheet) {
    const inp = v.querySelector('.sheet input');
    if (inp) inp.value = ui.sheet.query || '';
  }
}

function syncSettings() {
  const root = E.views.settings;
  for (const scope of [root, E.views.azkar]) {
    scope.querySelectorAll('[data-path]').forEach((el) => {
      const val = getPath(S.settings, el.dataset.path);
      if (el.classList.contains('switch')) el.setAttribute('aria-checked', String(!!val));
      else if (el.dataset.act === 'set-toggle') el.classList.toggle('on', !!val);
      else if (el.dataset.act === 'set-value') el.classList.toggle('on', String(val) === el.dataset.value);
      else if (el.tagName === 'OUTPUT') el.textContent = FORMATS[el.dataset.fmt || 'plain'](val);
      else if (el.type === 'range' && document.activeElement !== el) {
        el.value = val;
        el.style.setProperty('--p', `${((val - el.min) / (el.max - el.min)) * 100}%`);
      }
    });
  }
}

function sheetHtml() {
  const sh = ui.sheet;
  if (sh.id === 'city') {
    return `<div class="sheet"><div class="sheet-head"><b>City</b><label class="search">${ic('search')}<input type="text" id="sheet-q" placeholder="Search cities (English or Arabic)" spellcheck="false" /></label>
      <button class="icon-btn" data-act="sheet-close" title="Close">${ic('x')}</button></div><div class="sheet-list" id="sheet-list">${cityOptions(sh.query)}</div></div>`;
  }
  const opts = S.meta.methods.map((m) => `<button class="opt${m.id === S.settings.prayer.method ? ' on' : ''}" data-act="pick-method" data-id="${m.id}"><span>${esc(m.name)}</span><span class="ar">${esc(m.ar)}</span></button>`).join('');
  return `<div class="sheet"><div class="sheet-head"><b>Calculation method</b><span style="flex:1"></span><button class="icon-btn" data-act="sheet-close" title="Close">${ic('x')}</button></div><div class="sheet-list">${opts}</div></div>`;
}

function cityOptions(query = '') {
  const q = query.trim().toLowerCase();
  const list = S.meta.cities.filter((c) => !q || c.name.toLowerCase().includes(q) || c.ar.includes(q) || c.country.toLowerCase() === q);
  if (!list.length) return '<div class="empty" style="min-height:120px"><span>No city found. Use Detect, or pick a nearby city and fine-tune the times.</span></div>';
  return list.map((c) => `<button class="opt${c.id === S.settings.location.cityId ? ' on' : ''}" data-act="pick-city" data-id="${c.id}"><span>${esc(c.name)} <small>${c.country}</small></span><span class="ar">${esc(c.ar)}</span></button>`).join('');
}

// ================================================================ reminder (ayah / dhikr)

function showReminder(item) {
  const [badge, badgeIcon] = badgeFor(item.type);
  const text = item.type === 'ayah' ? ayahHtml(item) : esc(item.text);
  const len = item.type === 'ayah' ? item.verses.map((v) => v.text).join(' ').length : item.text.length;
  const size = len > 300 ? 23 : len > 220 ? 26 : len > 150 ? 29 : len > 90 ? 32 : 35;
  const ref = reminderRef(item);
  ui.current = { kind: 'reminder', item };
  ui.zItem = item;
  E.reminder.style.setProperty('--dur', `${item.durationSeconds || 15}s`);
  E.reminder.innerHTML = `
    <div class="r-top">
      <button class="r-close" data-act="dismiss" title="Close">${ic('x')}</button>
      <span class="badge">${ic(badgeIcon)}${badge}</span>
    </div>
    <div class="r-text" style="--rsize:${size}px">${text}</div>
    ${ref ? `<div class="r-ref">${ref}</div>` : ''}
    <div class="r-progress"><i></i></div>`;
  E.reminder.querySelector('.r-progress > i').addEventListener('animationend', () => {
    if (ui.current && ui.current.item === item) dismissOverlay();
  }, { once: true });
  setMode('reminder');
}

// ================================================================ toasts

function showToast(t) {
  ui.current = { kind: 'toast', toast: t };
  E.toast.style.setProperty('--dur', `${t.duration || 7}s`);
  E.toast.innerHTML = `<div class="toast"${t.rtl ? ' dir="rtl"' : ''}>
      <div class="t-icon ${t.tone || ''}">${ic(t.icon || 'bell')}</div>
      <div class="t-body"><div class="t-title${t.rtl ? ' ar' : ''}">${esc(t.title)}</div>${t.text ? `<div class="t-text${t.rtl ? ' ar' : ''}${t.wrap ? ' wrap' : ''}">${esc(t.text)}</div>` : ''}</div>
      ${t.countdownTo ? `<div class="t-big" dir="ltr" id="t-countdown">${fmtCountdown(t.countdownTo - Date.now())}</div>` : ''}
      <div class="t-actions">${(t.actions || []).map((a, i) => (a.label
        ? `<button class="btn small${a.primary ? ' primary' : ''}" data-act="toast" data-i="${i}">${a.icon ? ic(a.icon) : ''}${esc(a.label)}</button>`
        : `<button class="icon-btn" data-act="toast" data-i="${i}" title="${esc(a.title || '')}">${ic(a.icon)}</button>`)).join('')}</div>
    </div><div class="t-progress"><i></i></div>`;
  E.toast.querySelector('.t-progress > i').addEventListener('animationend', () => {
    if (ui.current && ui.current.toast === t) dismissOverlay();
  }, { once: true });
  setMode('toast');
  if (t.chime && S.settings.azan.mode !== 'silent') playChime(clamp(S.settings.azan.volume, 0.1, 1) * 0.6, [660, 990]);
}

function downloadDoneToast(item) {
  const actions = [];
  if (item.path) {
    actions.push({ label: 'Open', primary: true, run: () => api.downloads.action(item.id, 'open') });
    actions.push({ icon: 'folder', title: 'Show in folder', run: () => api.downloads.action(item.id, 'show') });
  }
  return { icon: 'check', tone: 'ok', title: 'Download complete', text: item.name, duration: 8, actions, tab: 'downloads' };
}

function downloadFailedToast(item) {
  return {
    icon: 'x', tone: 'bad', title: `Download failed: ${item.name}`, text: item.error, wrap: true, duration: 12, tab: 'downloads',
    actions: [
      { label: 'Retry', primary: true, run: () => api.downloads.action(item.id, 'retry') },
      { icon: 'x', title: 'Dismiss', run: () => {} },
    ],
  };
}

function preAlertToast(e) {
  return {
    icon: 'moon', tone: 'gold', rtl: true,
    title: `${e.name} بعد ${minutesAr(e.minutes)}`,
    text: 'استعد للصلاة',
    countdownTo: e.time,
    duration: 12,
    chime: true,
    tab: 'prayer',
  };
}

function clipboardToast(link) {
  return {
    icon: 'link', tone: 'blue', title: 'Download this file?', text: `${link.name} · ${link.host}`, duration: 12, tab: 'downloads',
    actions: [
      {
        label: 'Download', primary: true,
        run: async () => {
          const r = await api.downloads.add(link.url);
          if (!r.ok) present('toast', { icon: 'x', title: "Couldn't start the download", text: r.error, duration: 6 });
        },
      },
      { icon: 'x', title: 'Dismiss', run: () => {} },
    ],
  };
}

// ================================================================ azan

let audioCtx = null;
function playChime(volume = 0.5, notes = [660, 880, 1320]) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const t0 = audioCtx.currentTime + 0.02;
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.3 * volume), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 1.9);
    });
  } catch {
    // audio not available
  }
  return new Promise((r) => setTimeout(r, 2300));
}

function showAzan(d) {
  ui.azan = d;
  ui.current = { kind: 'azan' };
  const e = d.event;
  const loc = S.settings.location;
  E.azan.innerHTML = `<div class="az-glow"></div>
    <div class="az-top"><button class="r-close" data-act="azan-stop" title="Stop">${ic('x')}</button><span class="badge small">${ic('moon')}أذان</span></div>
    <div class="az-pre">${d.test ? 'تجربة الأذان' : 'حان الآن موعد أذان'}</div>
    <div class="az-name">${esc(e.name)}</div>
    <div class="az-wave${d.mode === 'silent' || d.volume === 0 ? ' still' : ''}">${'<i></i>'.repeat(11)}</div>
    <div class="az-meta"><span>${fmtTime(e.time)}</span><span>·</span><span class="ar">${esc(loc.ar || loc.name)}</span>${d.paused ? `<span>·</span>${ic('pause')}<span>${d.paused === 1 ? 'Music paused' : `${d.paused} apps paused`}</span>` : ''}</div>
    <div class="az-actions"><button class="btn gold ar" data-act="azan-stop">${ic('stop')}إيقاف الأذان</button></div>`;
  setMode('azan');
  playAzan(d);
}

function playAzan(d) {
  const a = E.audio;
  stopAudio();
  const done = () => finishAzan();
  if (d.mode === 'silent') {
    ui.azanTimer = setTimeout(done, 25000);
    return;
  }
  if (d.mode === 'tone') {
    playChime(d.volume).then(() => { ui.azanTimer = setTimeout(done, 6000); });
    return;
  }
  a.src = d.sound;
  a.volume = clamp(d.volume, 0, 1);
  a.onended = done;
  const fallback = () => { playChime(d.volume); ui.azanTimer = setTimeout(done, 8000); };
  a.onerror = fallback;
  a.play().catch(fallback);
  if (d.mode === 'short') ui.azanTimer = setTimeout(() => fadeOut(done), 30000);
}

function fadeOut(then) {
  const a = E.audio;
  if (a.paused) { then(); return; }
  const start = a.volume;
  const t0 = performance.now();
  const step = () => {
    const k = (performance.now() - t0) / 1500;
    if (k >= 1) {
      a.pause();
      a.volume = start;
      then();
      return;
    }
    a.volume = start * (1 - k);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stopAudio() {
  clearTimeout(ui.azanTimer);
  const a = E.audio;
  a.onended = null;
  a.onerror = null;
  try { a.pause(); } catch { /* ignore */ }
}

function finishAzan() {
  if (!ui.azan) return;
  stopAudio();
  ui.azan = null;
  api.azan.ended();
}

function stopAzanByUser() {
  if (!ui.azan) {
    if (ui.mode === 'azan') dismissOverlay();
    return;
  }
  ui.azan = null;
  fadeOut(() => stopAudio());
  api.azan.stop();
}

// voice preview in settings
function fileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return `file:///${parts.map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')}`;
}

function stopPreview() {
  if (!ui.preview) return;
  try { ui.preview.audio.pause(); } catch { /* ignore */ }
  clearTimeout(ui.preview.timer);
  ui.preview = null;
}

function togglePreview(kind) {
  const wasSame = ui.preview && ui.preview.kind === kind;
  stopPreview();
  if (!wasSame) {
    const a = S.settings.azan;
    let voice = kind === 'fajr' && a.fajrVoice !== 'same' ? a.fajrVoice : a.voice;
    let file = null;
    if (voice === 'custom') file = kind === 'fajr' && a.fajrVoice === 'custom' ? a.fajrCustomFile : a.customFile;
    const known = S.meta.voices.find((x) => x.id === voice);
    const url = file ? fileUrl(file) : known ? known.url : S.meta.voices[0].url;
    const audio = new Audio(url);
    audio.volume = clamp(a.volume, 0.05, 1);
    audio.play().catch(() => {});
    ui.preview = { kind, audio, timer: setTimeout(() => { stopPreview(); renderSettings(true); }, 20000) };
    audio.onended = () => { stopPreview(); renderSettings(true); };
  }
  renderSettings(true);
}

// ================================================================ interaction

// Hover comes from two places: the app, which follows the cursor and tells us when it is over
// the island ('pointer'), and the page's own mouse events. Both lead here, so either is enough.
function pointerEnter() {
  if (ui.hover) return;
  ui.hover = true;
  E.island.classList.add('hovering');
  clearTimeout(ui.collapseTimer);
  if (ui.mode === 'compact') E.island.classList.add('peek');
}

function pointerLeave() {
  if (!ui.hover) return;
  if (S.meta && S.meta.debug) console.warn('mouse left the island');
  ui.hover = false;
  E.island.classList.remove('peek', 'hovering');
  if (ui.mode === 'expanded') scheduleCollapse();
}

E.island.addEventListener('mouseenter', pointerEnter);
E.island.addEventListener('mouseleave', (e) => {
  // moving onto the bubble next to the island still counts as being on the island
  if (e.relatedTarget && E.bubble.contains(e.relatedTarget)) return;
  pointerLeave();
});

const TEXT_INPUT = 'input[type="text"], input[type="search"], textarea';
document.addEventListener('pointerdown', async (e) => {
  const input = e.target.closest(TEXT_INPUT);
  if (!input) return;
  if (document.activeElement === input) return;
  e.preventDefault();
  await api.focusInput(true);
  ui.inputFocused = true;
  input.focus();
}, true);

document.addEventListener('focusout', () => {
  setTimeout(() => {
    const a = document.activeElement;
    if (!a || !a.matches(TEXT_INPUT)) ui.inputFocused = false;
  }, 0);
});

function releaseFocus() {
  ui.inputFocused = false;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  api.focusInput(false);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ui.sheet) { ui.sheet = null; renderSettings(true); return; }
  if (ui.mode === 'expanded' || ui.mode === 'toast' || ui.mode === 'reminder') {
    if (ui.mode === 'expanded') collapse(); else dismissOverlay();
  }
});

// The closed island opens as soon as you press on it, not on "click": a click needs the press and
// the release to land on the same element, and the compact content is redrawn every second while a
// countdown or a download is showing, so a click that straddled a redraw used to be lost.
// The closed island opens when you let go - unless you dragged it, which moves it up or down.
// The island holds on to the pointer from press to release (pointer capture), so a click can't be
// lost when the content under it is redrawn in between (the prayer countdown redraws every second).
E.island.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  api.activity(`press on the island (${ui.mode})`);
  if (e.target.closest('[data-act]')) return; // buttons do their own thing on click
  if (ui.mode === 'compact' || ui.mode === 'osd') {
    ui.press = { id: e.pointerId, y: e.screenY, offset: (S.settings && S.settings.general.islandOffset) || 0, moved: false, target: 0, raf: 0 };
    try { E.island.setPointerCapture(e.pointerId); } catch { /* still works as a click */ }
    return;
  }
  // Pressing a notice (not one of its buttons) opens what it is about.
  if (ui.mode === 'toast' && ui.current && ui.current.toast) expand(ui.current.toast.tab);
});

E.island.addEventListener('pointermove', (e) => {
  const p = ui.press;
  if (!p || e.pointerId !== p.id) return;
  const dy = e.screenY - p.y;
  if (!p.moved && Math.abs(dy) < 5) return;
  if (S.settings && S.settings.general.lockPosition) {
    if (!p.locked) {
      p.locked = true;
      shakeIsland();
    }
    return;
  }
  if (!p.moved) {
    p.moved = true;
    E.island.classList.add('dragging');
    E.island.classList.remove('peek');
  }
  p.target = Math.round(p.offset + dy);
  if (!p.raf) {
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      if (ui.press === p) api.moveIsland(p.target, false);
    });
  }
});

function endPress(e, cancelled) {
  const p = ui.press;
  if (!p || (e && e.pointerId !== p.id)) return;
  ui.press = null;
  if (p.raf) cancelAnimationFrame(p.raf);
  E.island.classList.remove('dragging');
  if (p.moved) {
    api.moveIsland(p.target, true);
    return;
  }
  if (cancelled || p.locked) return;
  if (ui.mode === 'compact') expand();
  else if (ui.mode === 'osd') expand('sound');
}

// "Lock position" is on: a small shake says the island won't move.
function shakeIsland() {
  E.island.classList.remove('locked-shake');
  void E.island.offsetWidth; // restart the animation
  E.island.classList.add('locked-shake');
}
E.island.addEventListener('animationend', (e) => {
  if (e.animationName === 'locked-shake') E.island.classList.remove('locked-shake');
});

E.island.addEventListener('pointerup', (e) => endPress(e, false));
E.island.addEventListener('pointercancel', (e) => endPress(e, true));
E.island.addEventListener('lostpointercapture', (e) => endPress(e, true));

function openFromBubble() {
  const kind = E.bubble.dataset.kind;
  expand(kind === 'music' ? 'music' : kind === 'download' ? 'downloads' : 'prayer');
}
E.bubble.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  api.activity('press on the bubble');
  openFromBubble();
});
E.bubble.addEventListener('click', (e) => { if (e.detail === 0) openFromBubble(); }); // keyboard

// Keep the app's idea of where the island is in step with the page.
window.addEventListener('resize', reportRects);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const s = S.settings;
  switch (act) {
    case 'tab':
      ui.tab = t.dataset.tab;
      if (ui.tab !== 'settings') ui.lastTab = ui.tab;
      ui.sheet = null;
      renderExpanded();
      setGeometry();
      break;
    case 'media':
      api.media(t.dataset.cmd, activeSession() && activeSession().id);
      break;
    case 'session':
      ui.pinnedSession = t.dataset.id;
      refreshMedia();
      break;
    case 'seek': {
      const sess = activeSession();
      if (!sess || !sess.canSeek || !(sess.dur > 0)) break;
      const rect = t.getBoundingClientRect();
      const k = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      api.media('seek', sess.id, (k * sess.dur).toFixed(1));
      break;
    }
    case 'dl': {
      const id = t.closest('.dl-item').dataset.id;
      api.downloads.action(id, t.dataset.op);
      break;
    }
    case 'dl-folder': api.downloads.openFolder(); break;
    case 'dl-clear': api.downloads.clear(); break;
    case 'toggle-azan': api.settings.update({ azan: { enabled: !s.azan.enabled } }); break;
    case 'dismiss': dismissOverlay(); break;
    case 'azan-stop': stopAzanByUser(); break;
    case 'toast': {
      const toast = ui.current && ui.current.toast;
      const action = toast && toast.actions && toast.actions[Number(t.dataset.i)];
      dismissOverlay();
      if (action && action.run) action.run();
      break;
    }
    case 'z-next':
      ui.zItem = await api.reminder.pick();
      renderAzkar();
      setGeometry();
      break;
    case 'z-popup':
      collapse();
      setTimeout(() => {
        if (ui.zItem && ui.tab === 'azkar') present('reminder', { ...ui.zItem, durationSeconds: s.azkar.durationSeconds });
        else api.reminder.now();
      }, 450);
      break;
    case 'z-snooze':
      api.reminder.snooze(60);
      present('toast', { icon: 'bellOff', title: 'Reminders paused for an hour', text: 'They come back by themselves', duration: 4 });
      collapse();
      break;
    case 'tasbih': tasbihTap(); break;
    case 'tasbih-reset': ui.tasbih = { phase: 0, count: 0 }; renderAzkar(); break;
    case 'set-toggle': {
      const p = t.dataset.path;
      const next = !getPath(s, p);
      if (t.classList.contains('switch')) t.setAttribute('aria-checked', String(next));
      else t.classList.toggle('on', next);
      await api.settings.update(patchFor(p, next));
      break;
    }
    case 'set-value': {
      const p = t.dataset.path;
      let value = t.dataset.type === 'number' ? Number(t.dataset.value) : t.dataset.value;
      if ((p === 'azan.voice' || p === 'azan.fajrVoice') && value === 'custom') {
        stopPreview();
        await api.settings.pickFile(p === 'azan.fajrVoice' ? 'fajr' : 'main');
        break;
      }
      if (value === 'true' || value === 'false') value = value === 'true';
      t.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t));
      await api.settings.update(patchFor(p, value));
      break;
    }
    case 'step': {
      const p = t.dataset.path;
      const v = clamp(Number(getPath(s, p)) + Number(t.dataset.delta), Number(t.dataset.min), Number(t.dataset.max));
      await api.settings.update(patchFor(p, v));
      break;
    }
    case 'sheet':
      ui.sheet = { id: t.dataset.sheet, query: '' };
      renderSettings(true);
      break;
    case 'sheet-close':
      ui.sheet = null;
      renderSettings(true);
      break;
    case 'pick-city': {
      const c = S.meta.cities.find((x) => x.id === t.dataset.id);
      ui.sheet = null;
      if (c) await api.settings.update({ location: { cityId: c.id, name: c.name, ar: c.ar, lat: c.lat, lon: c.lon }, prayer: { method: c.method } });
      renderSettings(true);
      break;
    }
    case 'pick-method':
      ui.sheet = null;
      await api.settings.update({ prayer: { method: t.dataset.id } });
      renderSettings(true);
      break;
    case 'detect-location': {
      t.disabled = true;
      t.innerHTML = `${ic('locate')}Detecting...`;
      const r = await api.settings.detectLocation();
      t.disabled = false;
      t.innerHTML = `${ic('locate')}Detect`;
      if (!r.ok) present('toast', { icon: 'pin', title: "Couldn't find your location", text: r.error, duration: 8 });
      renderSettings(true);
      break;
    }
    case 'toggle-adjust':
      ui.showAdjust = !ui.showAdjust;
      renderSettings(true);
      break;
    case 'preview': togglePreview(t.dataset.kind); break;
    case 'test-azan':
      stopPreview();
      collapse();
      api.azan.test('dhuhr');
      break;
    case 'pick-folder': await api.settings.pickFolder(); break;
    case 'hide-island': collapse(); api.app.hide(); break;
    case 'reset-position': api.settings.update({ general: { islandOffset: 0 } }); break;
    case 'quit': api.app.quit(); break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.classList.contains('range')) {
    t.style.setProperty('--p', `${((t.value - t.min) / (t.max - t.min)) * 100}%`);
    if (ui.preview) ui.preview.audio.volume = clamp(Number(t.value), 0.05, 1);
  }
  if (t.id === 'sheet-q') {
    ui.sheet.query = t.value;
    $('#sheet-list').innerHTML = cityOptions(t.value);
  }
  if (t.id === 'dl-url' && ui.dlError) {
    ui.dlError = '';
    $('#dl-error').hidden = true;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('range')) api.settings.update(patchFor(t.dataset.path, Number(t.value)));
  if (t.dataset.coord) {
    const lat = Number($('[data-coord="lat"]').value);
    const lon = Number($('[data-coord="lon"]').value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      api.settings.update({ location: { cityId: 'custom', name: 'Custom location', ar: 'موقع مخصص', lat, lon } });
    }
  }
});

// ================================================================ ticking clock

function tick() {
  updateClock();
  renderCompact();
  if (ui.mode === 'expanded') {
    renderBar();
    if (ui.tab === 'prayer') updatePrayerCountdown();
    if (ui.tab === 'music') updateMusicProgress();
  }
  const tc = $('#t-countdown');
  if (tc && ui.current && ui.current.toast && ui.current.toast.countdownTo) tc.textContent = fmtCountdown(ui.current.toast.countdownTo - Date.now());
}

// ================================================================ start

(async function init() {
  const st = await api.init();
  S.settings = st.settings;
  S.meta = st.meta;
  S.prayer = st.prayer;
  S.media = st.media || S.media;
  S.downloads = st.downloads || [];
  S.fullscreen = st.fullscreen;
  if (st.sound) Object.assign(S.sound, st.sound);
  if (st.fps) S.fps = st.fps;
  if (st.devices) S.devices = st.devices;
  if (st.mic) S.mic = st.mic;
  for (const [k, v] of Object.entries(st.thumbs || {})) {
    S.thumbs.set(k, v);
    extractColor(k, v);
  }

  api.on('settings', (s) => {
    S.settings = s;
    renderCompact();
    if (ui.mode === 'expanded') {
      if (ui.tab === 'settings') renderSettings();
      else if (ui.tab === 'prayer') renderPrayer();
      else if (ui.tab === 'azkar') syncSettings();
      setGeometry();
    }
  });
  api.on('prayer', (p) => {
    S.prayer = p;
    renderCompact();
    if (ui.mode === 'expanded' && ui.tab === 'prayer') renderPrayer();
  });
  api.on('media', (m) => {
    S.media = m;
    if (ui.pinnedSession && !(m.sessions || []).some((s) => s.id === ui.pinnedSession)) ui.pinnedSession = null;
    refreshMedia();
  });
  api.on('thumb', ({ key, data }) => {
    S.thumbs.delete(key);
    S.thumbs.set(key, data);
    while (S.thumbs.size > 40) S.thumbs.delete(S.thumbs.keys().next().value);
    S.colors.delete(key);
    extractColor(key, data);
    refreshMedia();
  });
  api.on('downloads', (list) => {
    S.downloads = list;
    refreshDownloads();
  });
  api.on('download:done', (item) => present('toast', downloadDoneToast(item)));
  api.on('download:failed', (item) => present('toast', downloadFailedToast(item)));
  api.on('reminder', (item) => { if (item) present('reminder', item); });
  api.on('azan:start', (d) => present('azan', d));
  api.on('azan:end', () => {
    stopAudio();
    ui.azan = null;
    if (ui.mode === 'azan') dismissOverlay();
  });
  api.on('prayer:pre-alert', (e) => present('toast', preAlertToast(e)));
  api.on('clipboard:link', (link) => present('toast', clipboardToast(link)));
  api.on('fullscreen', (v) => { S.fullscreen = v; });
  api.on('pointer', (over) => (over ? pointerEnter() : pointerLeave()));
  api.on('window:visible', (visible) => {
    // Nothing is drawn while the island is off screen (the music bars would otherwise keep
    // animating during a game). Coming back, measure everything again.
    document.body.classList.toggle('away', !visible);
    if (visible) {
      ui.compactHtml = '';
      renderCompact();
      if (ui.mode === 'expanded') renderExpanded();
      setGeometry();
      return;
    }
    // Hidden for a fullscreen app (or from the tray): come back as a calm, closed island.
    ui.hover = false;
    E.island.classList.remove('peek', 'hovering');
    if (ui.mode === 'expanded') collapse('window hidden');
  });
  api.on('window:blur', () => {
    ui.inputFocused = false;
    if (ui.mode === 'expanded' && !ui.hover) collapse('window lost focus');
  });
  api.on('ui:open', (tab) => {
    if (tab === '__collapse') collapse();
    else expand(tab || undefined);
  });

  renderCompact();
  setGeometry();
  setInterval(tick, 1000);
  document.fonts.ready.then(() => { ui.compactHtml = ''; renderCompact(); setGeometry(); });
})();
