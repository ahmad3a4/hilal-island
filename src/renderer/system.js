'use strict';
// The System tab (CPU, memory, GPU, network and drives, each with the last minute as a graph) and
// the optional CPU / GPU readout on the closed island. Loaded after app.js, whose S, ui, E, api
// and helpers it uses.

const SYS_POINTS = 60;
const sysHist = { cpu: [], mem: [], gpu: [], rx: [], tx: [] };

function sysBytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : digits)} ${units[i]}`;
}

const fmtRate = (n) => (n == null ? '--' : `${sysBytes(n)}/s`);

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const tempClass = (t) => (t == null ? '' : t >= 80 ? 'hot' : t >= 65 ? 'warm' : 'cool');

// "13th Gen Intel(R) Core(TM) i5-13400" -> "Intel Core i5-13400"
function shortCpu(model) {
  return (model || 'CPU').replace(/\((R|TM)\)/gi, '').replace(/\b\d+(st|nd|rd|th) Gen\b/i, '').replace(/\bCPU\b/i, '')
    .replace(/@.*$/, '').replace(/\s+/g, ' ').trim();
}

const memPct = (m) => Math.round(((m.total - m.free) / m.total) * 100);

function pushHistory(d) {
  const add = (key, v) => {
    const a = sysHist[key];
    a.push(v == null ? null : v);
    if (a.length > SYS_POINTS) a.shift();
  };
  add('cpu', d.cpu.usage);
  add('mem', memPct(d.mem));
  add('gpu', d.gpu ? d.gpu.util : null);
  add('rx', d.net ? d.net.rx : null);
  add('tx', d.net ? d.net.tx : null);
}

// An SVG line (and the area under it) for the last minute, newest on the right.
function sparkPaths(values, max) {
  const w = 120;
  const h = 32;
  const offset = SYS_POINTS - values.length;
  const pts = [];
  values.forEach((v, i) => {
    if (v == null) return;
    pts.push([((offset + i) / (SYS_POINTS - 1)) * w, h - 1 - Math.min(1, v / (max || 1)) * (h - 3)]);
  });
  if (pts.length < 2) return { line: '', area: '' };
  const line = `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`;
  return { line, area: `${line}L${pts[pts.length - 1][0].toFixed(1)},${h}L${pts[0][0].toFixed(1)},${h}Z` };
}

// ---------------------------------------------------------------- System tab

// The layout only changes when a GPU (or its temperature) shows up; once seen, it stays, so the
// tab isn't redrawn (and scrolled back to the top) while you look at it.
function systemKey() {
  const d = S.system;
  if (!d) return 'none';
  ui.sysGpu = ui.sysGpu || !!d.gpu;
  ui.sysGpuTemp = ui.sysGpuTemp || !!(d.gpu && d.gpu.temp != null);
  return [ui.sysGpu, ui.sysGpuTemp].join('~');
}

function sysCard(key, iconName, title, extra = '') {
  const paths = key === 'net'
    ? '<path class="area rx" data-area="rx"/><path class="line rx" data-line="rx"/><path class="line tx" data-line="tx"/>'
    : `<path class="area" data-area="${key}"/><path class="line" data-line="${key}"/>`;
  return `<div class="sys-card ${key}">
    <div class="sys-head"><span class="sys-ic">${ic(iconName)}</span><b>${title}</b>${extra}<span class="sys-big" data-v="${key}">--</span></div>
    <div class="sys-sub" data-sub="${key}">&nbsp;</div>
    <svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none">${paths}</svg>
  </div>`;
}

function disksHtml(disks) {
  if (!disks || !disks.length) return '<div class="mx-empty">Looking at your drives...</div>';
  return disks.map((dk) => {
    const used = dk.total ? (dk.total - dk.free) / dk.total : 0;
    const low = dk.total && dk.free / dk.total < 0.1;
    return `<div class="sys-disk${low ? ' low' : ''}">
      <b>${esc(dk.name)}</b><span class="sys-disk-label">${esc(dk.label || 'Local disk')}</span>
      <div class="sys-bar"><i style="width:${(used * 100).toFixed(1)}%"></i></div>
      <span class="sys-disk-free">${sysBytes(dk.free, 0)} free of ${sysBytes(dk.total, 0)}</span>
    </div>`;
  }).join('');
}

function renderSystem() {
  const v = E.views.system;
  ui.systemKey = systemKey();
  ui.disksKey = '';
  const d = S.system;
  if (!d) {
    v.innerHTML = `<div class="empty">${ic('activity')}<b>Reading your PC...</b><span>CPU, memory, GPU, network and drives show up here.</span></div>`;
    return;
  }
  v.innerHTML = `<div class="sys">
    <div class="sys-fps" data-fps>${fpsRowHtml()}</div>
    <div class="sys-grid">
      ${sysCard('cpu', 'cpu', 'CPU')}
      ${sysCard('mem', 'layers', 'Memory')}
      ${ui.sysGpu ? sysCard('gpu', 'monitor', 'GPU', ui.sysGpuTemp ? '<span class="sys-temp" data-v="gputemp"></span>' : '') : ''}
      ${sysCard('net', 'globe', 'Network')}
    </div>
    <div data-playtime></div>
    <div class="s-title">${ic('hardDrive')}Storage<span class="sys-up" data-v="uptime"></span></div>
    <div class="sys-disks" data-disks></div>
    <div data-devices></div>
  </div>`;
  updateSystem(true);
}

function updateSystem(fresh = false) {
  if (ui.mode !== 'expanded' || ui.tab !== 'system') return;
  if (fresh) {
    fpsRowState = '';
    updateFps();
  }
  const d = S.system;
  if (!d) return;
  if (!fresh && systemKey() !== ui.systemKey) {
    renderSystem();
    setGeometry();
    return;
  }
  const v = E.views.system;
  const set = (sel, text) => {
    const el = v.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  };
  const spark = (key, values, max) => {
    const p = sparkPaths(values, max);
    const line = v.querySelector(`[data-line="${key}"]`);
    const area = v.querySelector(`[data-area="${key}"]`);
    if (line) line.setAttribute('d', p.line);
    if (area) area.setAttribute('d', p.area);
  };

  set('[data-v="cpu"]', d.cpu.usage == null ? '--' : `${d.cpu.usage}%`);
  set('[data-sub="cpu"]', `${shortCpu(d.cpu.model)} · ${d.cpu.threads} threads`);
  spark('cpu', sysHist.cpu, 100);

  set('[data-v="mem"]', `${memPct(d.mem)}%`);
  set('[data-sub="mem"]', `${sysBytes(d.mem.total - d.mem.free)} of ${sysBytes(d.mem.total)}`);
  spark('mem', sysHist.mem, 100);

  if (d.gpu && ui.sysGpu) {
    set('[data-v="gpu"]', d.gpu.util == null ? '--' : `${d.gpu.util}%`);
    set('[data-sub="gpu"]', `${(d.gpu.name || 'GPU').replace(/^NVIDIA /, '')}${d.gpu.memTotal ? ` · ${sysBytes(d.gpu.memUsed)} of ${sysBytes(d.gpu.memTotal, 0)}` : ''}`);
    const temp = v.querySelector('[data-v="gputemp"]');
    if (temp) {
      temp.textContent = `${d.gpu.temp}°C`;
      temp.className = `sys-temp ${tempClass(d.gpu.temp)}`;
    }
    spark('gpu', sysHist.gpu, 100);
  }

  set('[data-v="net"]', d.net ? `↓ ${fmtRate(d.net.rx)}` : '--');
  set('[data-sub="net"]', d.net ? `↑ ${fmtRate(d.net.tx)} up` : ' ');
  const netMax = Math.max(64 * 1024, ...sysHist.rx.filter((x) => x != null), ...sysHist.tx.filter((x) => x != null));
  spark('rx', sysHist.rx, netMax);
  spark('tx', sysHist.tx, netMax);

  set('[data-v="uptime"]', `Up ${fmtUptime(d.uptime)}`);
  renderDevices();
  renderPlaytime();
  const disksKey = JSON.stringify(d.disks || []);
  if (disksKey !== ui.disksKey) {
    ui.disksKey = disksKey;
    const box = v.querySelector('[data-disks]');
    if (box) {
      box.innerHTML = disksHtml(d.disks);
      setGeometry();
    }
  }
}

// Readings are only taken while this tab is open (or the island shows them).
function syncSystemWatch() {
  const on = ui.mode === 'expanded' && ui.tab === 'system';
  if (on === !!ui.systemWatching) return;
  ui.systemWatching = on;
  api.systemWatch(on);
}

// ------------------------------------------------------ readout on the island

function sysReadoutHtml() {
  if (!S.settings || !S.settings.system || !S.settings.system.islandReadout) return '';
  const second = S.system && S.system.gpu && S.system.gpu.temp != null ? 'GPU' : 'RAM';
  return `<span class="c-sys"><span><small>CPU</small><b data-sys="cpu">--</b></span><span><small>${second}</small><b data-sys="second">--</b></span></span>`;
}

function updateSysReadout() {
  const d = S.system;
  const cpu = E.compact.querySelector('[data-sys="cpu"]');
  if (!cpu || !d) return;
  cpu.textContent = d.cpu.usage == null ? '--' : `${d.cpu.usage}%`;
  const second = E.compact.querySelector('[data-sys="second"]');
  if (!second) return;
  if (d.gpu && d.gpu.temp != null) {
    second.textContent = `${d.gpu.temp}°`;
    second.className = tempClass(d.gpu.temp);
  } else {
    second.textContent = `${memPct(d.mem)}%`;
    second.className = '';
  }
}

api.on('system', (d) => {
  const hadGpuTemp = !!(S.system && S.system.gpu && S.system.gpu.temp != null);
  S.system = d;
  pushHistory(d);
  updateSystem();
  // The readout's second value switches between GPU and RAM if a GPU temperature appears.
  if (hadGpuTemp !== !!(d.gpu && d.gpu.temp != null)) renderCompact();
  updateSysReadout();
});

// ------------------------------------------------------------------- FPS

const fpsClass = (n) => (n == null || n <= 0 ? '' : n < 30 ? 'low' : n < 60 ? 'mid' : '');

function fpsHelp(f) {
  if (f.available === true) return '';
  if (f.reason === 'permission') {
    return f.requested ? 'Almost done: sign out of Windows and back in, and FPS starts working'
      : 'Windows needs your OK once to count frames, like Game Bar does (asks for admin, then a sign-out)';
  }
  return f.available === false ? `FPS isn't available on this PC (${f.reason || 'unknown'})` : 'Checking...';
}

// "dynamic island - Visual Studio Code" or "FortniteClient-Win64-Shipping": the title reads better.
const fpsAppName = (f) => (f.title || f.app || 'The app in front');

function fpsRowHtml() {
  const f = S.fps || {};
  if (f.available !== true) {
    const allow = f.reason === 'permission' && !f.requested;
    return `<span class="sys-ic">${ic('gamepad')}</span><div class="sys-fps-text"><b>FPS</b><span>${esc(fpsHelp(f))}</span></div>`
      + (allow ? '<button class="btn small" data-act="fps-allow">Allow</button>' : '');
  }
  return `<span class="sys-ic">${ic('gamepad')}</span><div class="sys-fps-text"><b>FPS</b><span data-fps-app>${esc(fpsAppName(f))}</span></div>`
    + `<span class="sys-big"><span data-fps-num>--</span><small>FPS</small></span>`;
}

let fpsRowState = '';

function updateFps() {
  const f = S.fps || {};
  // the counter over a game
  const pill = document.getElementById('fps-pill');
  const where = S.settings ? S.settings.system.fpsInGames : 'off';
  const n = f.available === true && f.fps > 0 && where !== 'off' ? Math.round(f.fps) : null;
  const micOff = !!(S.mic && S.mic.muted && S.settings && S.settings.mic.overlay !== false);
  document.getElementById('fps-num').textContent = n == null ? '' : String(n);
  document.getElementById('fps-mic').innerHTML = micOff ? ic('micOff') : '';
  pill.className = `fps-pill ${n == null && !micOff ? 'idle' : fpsClass(n)}${micOff ? ' mic-off' : ''}${n == null ? ' no-fps' : ''}`;
  // or inside the island, when it stays on screen over a fullscreen game
  const inIsland = n != null && where === 'island' && !!S.fullscreen && !document.body.classList.contains('game');
  if (inIsland !== !!ui.compactFps) {
    ui.compactFps = inIsland;
    renderCompact();
  }
  fillIslandFps();
  // the System tab
  if (ui.mode !== 'expanded' || ui.tab !== 'system') return;
  const row = E.views.system.querySelector('[data-fps]');
  if (!row) return;
  const state = [f.available, f.reason, f.requested].join('|');
  if (state !== fpsRowState || !row.firstChild) {
    fpsRowState = state;
    row.innerHTML = fpsRowHtml();
  }
  if (f.available !== true) return;
  row.className = `sys-fps ${fpsClass(n)}`;
  const num = row.querySelector('[data-fps-num]');
  if (num) num.textContent = n == null ? '--' : String(n);
  const app = row.querySelector('[data-fps-app]');
  if (app) app.textContent = n == null ? `${fpsAppName(f)} isn't drawing frames right now` : fpsAppName(f);
}

api.on('fps', (f) => {
  const before = S.fps ? [S.fps.available, S.fps.requested].join('|') : '';
  S.fps = f;
  updateFps();
  // Settings shows "Allow" or the FPS position depending on this.
  if (before !== [f.available, f.requested].join('|') && ui.mode === 'expanded' && ui.tab === 'settings') renderSettings(true);
});

api.on('game', ({ on, corner }) => {
  const was = document.body.classList.contains('game');
  document.body.classList.toggle('game', !!on);
  document.body.dataset.corner = corner || 'top-left';
  updateFps();
  if (was && !on && !document.body.classList.contains('away')) {
    // back from a game: the island was hidden, so measure it again
    ui.compactHtml = '';
    renderCompact();
    setGeometry();
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act="fps-allow"]');
  if (!t || t.disabled) return;
  t.disabled = true;
  t.textContent = 'Waiting for Windows...';
  const r = await api.fpsAllow();
  if (r && r.ok) {
    present('toast', { icon: 'check', tone: 'ok', title: 'Almost done', text: 'Sign out of Windows and back in, and FPS starts working.', wrap: true, duration: 12 });
  } else if (!(r && r.cancelled)) {
    present('toast', { icon: 'x', tone: 'bad', title: "FPS couldn't be turned on", text: 'Windows refused the change. Try again, or run Hilal as an administrator once.', wrap: true, duration: 10 });
  }
  t.disabled = false;
  t.textContent = 'Allow';
  updateFps();
  if (ui.mode === 'expanded' && ui.tab === 'settings') renderSettings(true);
});

// ------------------------------------------------------------ bluetooth devices

const DEVICE_ICON = { headphones: 'headphones', controller: 'gamepad', mouse: 'mouse', keyboard: 'keyboard', phone: 'smartphone', other: 'bluetooth' };
let devicesHtmlLast = '';

function devicesHtml() {
  const list = S.devices || [];
  if (!list.length) return '';
  const rows = [...list].sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name)).map((d) => {
    const b = d.battery;
    const low = b != null && b <= 20 && !d.charging;
    const battery = !d.connected ? '<span class="dev-state">Not connected</span>'
      : b == null ? '<span class="dev-state">Connected</span>'
        : `<div class="sys-bar dev-bar${low ? ' low' : ''}"><i style="width:${b}%"></i></div><span class="dev-pct${low ? ' low' : ''}">${d.charging ? ic('zap') : ''}${b}%</span>`;
    return `<div class="dev${d.connected ? '' : ' off'}"><span class="dev-ic">${ic(DEVICE_ICON[d.kind] || 'bluetooth')}</span><b>${esc(d.name)}</b>${battery}</div>`;
  }).join('');
  return `<div class="s-title">${ic('bluetooth')}Devices</div><div class="sys-devs">${rows}</div>`;
}

function renderDevices() {
  if (ui.mode !== 'expanded' || ui.tab !== 'system') return;
  const box = E.views.system.querySelector('[data-devices]');
  if (!box) return;
  const html = devicesHtml();
  if (html === devicesHtmlLast && box.innerHTML) return;
  devicesHtmlLast = html;
  box.innerHTML = html;
  setGeometry();
}

api.on('devices', (list) => {
  S.devices = list;
  devicesHtmlLast = '';
  renderDevices();
});

// notices sent by the app (device connected, battery low)
api.on('toast', (t) => { if (t) present('toast', t); });

// -------------------------------------------------------------------- play time

const fmtPlay = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${Math.max(m, s > 0 ? 1 : 0)}m`;
};
let playtimeHtmlLast = '';

function playtimeHtml() {
  const p = S.playtime;
  if (!p || !p.games.length) return '';
  const max = Math.max(...p.week.map((d) => d.secs), 1);
  const bars = p.week.map((d, i) => {
    const label = i === 6 ? 'Today' : new Date(`${d.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
    return `<div class="pt-day${i === 6 ? ' today' : ''}" title="${fmtPlay(d.secs)}"><i style="height:${Math.max(3, (d.secs / max) * 100)}%"></i><span>${label}</span></div>`;
  }).join('');
  const games = p.games.slice(0, 5).map((g) => `<div class="pt-game">
      <span class="pt-ic">${g.icon ? `<img src="${g.icon}" alt="" />` : ic('controller')}</span>
      <b>${esc(g.name)}</b>${g.playing ? '<span class="pt-live">Playing</span>' : ''}
      <span class="pt-t">${fmtPlay(g.today)} <small>today</small></span><span class="pt-t muted">${fmtPlay(g.week)} <small>this week</small></span>
    </div>`).join('');
  return `<div class="s-title">${ic('controller')}Play time<span class="sys-up">Today ${fmtPlay(p.today)}</span></div>
    <div class="pt"><div class="pt-week">${bars}</div><div class="pt-games">${games}</div></div>`;
}

function renderPlaytime() {
  if (ui.mode !== 'expanded' || ui.tab !== 'system') return;
  const box = E.views.system.querySelector('[data-playtime]');
  if (!box) return;
  const html = playtimeHtml();
  if (html === playtimeHtmlLast && box.innerHTML) return;
  playtimeHtmlLast = html;
  box.innerHTML = html;
  setGeometry();
}

api.on('playtime', (p) => {
  S.playtime = p;
  playtimeHtmlLast = '';
  renderPlaytime();
});

// The FPS number inside the island (only there while a fullscreen game is in front).
function fillIslandFps() {
  const el = E.compact.querySelector('[data-fps-island]');
  if (!el) return;
  const f = S.fps || {};
  const n = f.fps > 0 ? Math.round(f.fps) : null;
  el.textContent = n == null ? '--' : String(n);
  el.parentElement.className = `c-fps ${fpsClass(n)}`;
}

// The game closed or went to the background: no FPS in the island any more.
api.on('fullscreen', () => updateFps());
