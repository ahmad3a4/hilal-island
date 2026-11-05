'use strict';
// The Sound tab (output volume, screen brightness and a mixer with every app's volume and live
// level), the volume / brightness pop-up on the island, and scrolling on the island to change
// the volume. Loaded after app.js, whose S, ui, E, api and helpers it uses.

const pct = (v) => Math.round(clamp(Number(v) || 0, 0, 1) * 100);

function volumeIcon(level, muted) {
  if (muted || level <= 0) return 'volumeX';
  return level < 0.34 ? 'volume0' : level < 0.67 ? 'volume1' : 'volume';
}

// ---------------------------------------------------------------- Sound tab

function soundApps() {
  const apps = S.sound.mixer ? [...S.sound.mixer.apps] : null;
  // Steady order (by name, system sounds last), so rows don't jump while you use them.
  if (apps) apps.sort((a, b) => (a.system - b.system) || a.name.localeCompare(b.name));
  return apps;
}

function soundKey() {
  const m = S.sound.master;
  const b = S.sound.brightness;
  const apps = soundApps();
  return [m ? `${m.ok}:${m.device}` : 'none', b ? b.supported : 'none',
    apps ? apps.map((a) => `${a.pid}:${a.name}:${a.icon ? 1 : 0}`).join('|') : 'loading'].join('~');
}

function sliderHtml(kind, value, pid) {
  return `<input class="slider" type="range" min="0" max="100" step="1" value="${value}" data-sound="${kind}"${pid != null ? ` data-pid="${pid}"` : ''} style="--p:${value}%" aria-label="${kind}" />`;
}

function appRowHtml(a) {
  const pid = a.system ? 0 : a.pid;
  const vol = pct(a.volume);
  const icon = a.icon ? `<img src="${a.icon}" alt="" />` : ic(a.system ? 'bell' : 'music');
  return `<div class="mx-row${a.muted ? ' muted' : ''}" data-row="${pid}">
    <div class="mx-icon">${icon}</div>
    <div class="snd-main">
      <div class="snd-label"><b>${esc(a.name)}</b></div>
      <div class="snd-ctl">${sliderHtml('app', vol, pid)}<span class="snd-val" data-val="app-${pid}">${vol}</span></div>
      <div class="lvl" data-lvl="${a.system ? 'system' : a.pid}"><i></i></div>
    </div>
    <button class="icon-btn mx-mute${a.muted ? ' on' : ''}" data-act="sound-app-mute" data-pid="${pid}" title="${a.muted ? 'Unmute' : 'Mute'}">${ic(a.muted ? 'volumeX' : 'volume')}</button>
  </div>`;
}

function renderSound() {
  const v = E.views.sound;
  ui.soundKey = soundKey();
  const m = S.sound.master;
  const b = S.sound.brightness;
  if (!m || !m.ok) {
    v.innerHTML = `<div class="empty">${ic('volumeX')}<b>No sound output</b><span>Connect speakers or headphones and they show up here.</span></div>`;
    return;
  }
  const vol = pct(m.level);
  const apps = soundApps();
  const rows = !apps ? '<div class="mx-empty">Looking for apps...</div>'
    : apps.length ? apps.map(appRowHtml).join('') : '<div class="mx-empty">No app is using sound right now.</div>';
  v.innerHTML = `<div class="sound">
    <div class="snd-card">
      <div class="snd-row">
        <button class="snd-btn${m.muted ? ' off' : ''}" data-act="sound-mute" title="${m.muted ? 'Unmute' : 'Mute'}">${ic(volumeIcon(m.level, m.muted))}</button>
        <div class="snd-main">
          <div class="snd-label"><b>Volume</b><span>${esc(m.device || 'Speakers')}</span></div>
          <div class="snd-ctl">${sliderHtml('master', vol)}<span class="snd-val" data-val="master">${vol}</span></div>
          <div class="lvl" data-lvl="master"><i></i></div>
        </div>
      </div>
      ${b && b.supported ? `<div class="snd-row">
        <div class="snd-btn sun">${ic('sun')}</div>
        <div class="snd-main">
          <div class="snd-label"><b>Brightness</b><span>${b.method === 'wmi' ? 'Built-in screen' : 'Monitor'}</span></div>
          <div class="snd-ctl">${sliderHtml('brightness', b.level)}<span class="snd-val" data-val="brightness">${b.level}</span></div>
        </div>
      </div>` : ''}
    </div>
    <div class="s-title">${ic('sliders')}Apps</div>
    <div class="mx-list">${rows}</div>
  </div>`;
}

// Values changed somewhere (keys, other apps, the mixer list): update the open tab in place.
function updateSound() {
  if (ui.mode !== 'expanded' || ui.tab !== 'sound') return;
  if (soundKey() !== ui.soundKey) {
    const list = E.views.sound.querySelector('.sound');
    const scroll = list ? list.scrollTop : 0;
    renderSound();
    const again = E.views.sound.querySelector('.sound');
    if (again) again.scrollTop = scroll;
    setGeometry();
    return;
  }
  const v = E.views.sound;
  const m = S.sound.master;
  if (m && m.ok) {
    setSlider('master', null, pct(m.level));
    const btn = v.querySelector('[data-act="sound-mute"]');
    if (btn) {
      btn.classList.toggle('off', !!m.muted);
      btn.innerHTML = ic(volumeIcon(m.level, m.muted));
      btn.title = m.muted ? 'Unmute' : 'Mute';
    }
  }
  const b = S.sound.brightness;
  if (b && b.supported) setSlider('brightness', null, b.level);
  for (const a of soundApps() || []) {
    const pid = a.system ? 0 : a.pid;
    setSlider('app', pid, pct(a.volume));
    const row = v.querySelector(`[data-row="${pid}"]`);
    if (row) row.classList.toggle('muted', !!a.muted);
    const mute = v.querySelector(`[data-act="sound-app-mute"][data-pid="${pid}"]`);
    if (mute) {
      mute.classList.toggle('on', !!a.muted);
      mute.innerHTML = ic(a.muted ? 'volumeX' : 'volume');
      mute.title = a.muted ? 'Unmute' : 'Mute';
    }
  }
}

function sliderKey(kind, pid) {
  return kind === 'app' ? `app-${pid}` : kind;
}

function setSlider(kind, pid, value) {
  const el = E.views.sound.querySelector(`.slider[data-sound="${kind}"]${pid != null ? `[data-pid="${pid}"]` : ''}`);
  if (!el) return;
  // Don't fight your hand: ignore echoes while you drag, and for a moment after.
  const touched = ui.soundTouched && ui.soundTouched[sliderKey(kind, pid)];
  if (el === ui.soundDragging || (touched && Date.now() - touched < 900)) return;
  el.value = value;
  el.style.setProperty('--p', `${value}%`);
  const out = E.views.sound.querySelector(`[data-val="${sliderKey(kind, pid)}"]`);
  if (out) out.textContent = value;
}

function showPeaks(p) {
  if (ui.mode !== 'expanded' || ui.tab !== 'sound' || !p) return;
  const v = E.views.sound;
  const set = (key, val) => {
    const el = v.querySelector(`[data-lvl="${key}"] > i`);
    if (el) el.style.width = `${Math.round(clamp(Number(val) || 0, 0, 1) * 100)}%`;
  };
  set('master', p.master);
  for (const [k, val] of Object.entries(p.apps || {})) set(k, val);
}

// Live levels are only read while the Sound tab is open.
function syncSoundWatch() {
  const on = ui.mode === 'expanded' && ui.tab === 'sound';
  if (on === !!ui.soundWatching) return;
  ui.soundWatching = on;
  api.sound('watch', on);
}

// Sliders send at most ~25 updates a second; the last value always goes out.
const soundOut = { timer: null, pending: null };

function sendSound(kind, value, pid) {
  ui.soundTouched = ui.soundTouched || {};
  ui.soundTouched[sliderKey(kind, pid)] = Date.now();
  soundOut.pending = { kind, value, pid };
  if (soundOut.timer) return;
  flushSound();
  soundOut.timer = setTimeout(function again() {
    soundOut.timer = null;
    if (soundOut.pending) {
      flushSound();
      soundOut.timer = setTimeout(again, 40);
    }
  }, 40);
}

function flushSound() {
  const p = soundOut.pending;
  soundOut.pending = null;
  if (!p) return;
  if (p.kind === 'master') {
    api.sound('master', p.value / 100);
    if (S.sound.master) {
      S.sound.master.level = p.value / 100;
      if (p.value > 0) S.sound.master.muted = false;
    }
  } else if (p.kind === 'brightness') {
    api.sound('brightness', p.value);
    if (S.sound.brightness) S.sound.brightness.level = p.value;
  } else if (p.kind === 'app') {
    api.sound('app', p.value / 100, p.pid);
    const a = (S.sound.mixer ? S.sound.mixer.apps : []).find((x) => (x.system ? 0 : x.pid) === Number(p.pid));
    if (a) {
      a.volume = p.value / 100;
      if (p.value > 0) a.muted = false;
    }
  }
}

function onSliderInput(t) {
  const value = Number(t.value);
  t.style.setProperty('--p', `${value}%`);
  const out = E.views.sound.querySelector(`[data-val="${sliderKey(t.dataset.sound, t.dataset.pid)}"]`);
  if (out) out.textContent = value;
  sendSound(t.dataset.sound, value, t.dataset.pid);
}

document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('.slider[data-sound]')) onSliderInput(e.target);
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.matches && e.target.matches('.slider[data-sound]')) ui.soundDragging = e.target;
}, true);
document.addEventListener('pointerup', () => {
  if (!ui.soundDragging) return;
  const t = ui.soundDragging;
  ui.soundDragging = null;
  ui.soundTouched = ui.soundTouched || {};
  ui.soundTouched[sliderKey(t.dataset.sound, t.dataset.pid)] = Date.now();
}, true);

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'sound-mute' && S.sound.master) {
    S.sound.master.muted = !S.sound.master.muted;
    api.sound('mute', S.sound.master.muted);
    updateSound();
  } else if (t.dataset.act === 'sound-app-mute') {
    const pid = Number(t.dataset.pid);
    const a = (S.sound.mixer ? S.sound.mixer.apps : []).find((x) => (x.system ? 0 : x.pid) === pid);
    if (!a) return;
    a.muted = !a.muted;
    api.sound('appmute', a.muted, pid);
    updateSound();
  }
});

// ------------------------------------------------------------------ pop-up

function hudHtml(kind, value, muted) {
  const icon = kind === 'brightness' ? 'sun' : volumeIcon(value / 100, muted);
  return `<div class="osd ${kind}${muted ? ' muted' : ''}">${ic(icon)}<div class="osd-bar"><i style="width:${value}%"></i></div><span class="osd-val">${value}</span></div>`;
}

function showHud(kind, value, muted = false) {
  if (ui.mode === 'expanded') {
    // The island is open: the Sound tab shows it already; elsewhere, a short note in the status chip.
    if (kind === 'mic') {
      ui.flash = { label: muted ? 'Mic muted' : 'Mic on', until: Date.now() + 1600 };
      renderBar();
      clearTimeout(ui.flashTimer);
      ui.flashTimer = setTimeout(renderBar, 1650);
      return;
    }
    if (ui.tab !== 'sound') {
      ui.flash = { label: `${kind === 'brightness' ? 'Brightness' : muted ? 'Muted' : 'Volume'} ${muted ? '' : `${value}%`}`.trim(), until: Date.now() + 1600 };
      renderBar();
      clearTimeout(ui.flashTimer);
      ui.flashTimer = setTimeout(renderBar, 1650);
    }
    return;
  }
  if (ui.mode !== 'compact' && ui.mode !== 'osd') return; // never over the azan or a notice
  const box = E.osd.querySelector('.osd');
  if (kind === 'mic') {
    E.osd.innerHTML = `<div class="osd mic${muted ? ' muted' : ''}">${ic(muted ? 'micOff' : 'mic')}<span class="osd-text">${muted ? 'Microphone muted' : 'Microphone on'}</span></div>`;
  } else if (box && box.classList.contains(kind)) {
    box.classList.toggle('muted', !!muted);
    box.querySelector('.osd-bar > i').style.width = `${value}%`;
    box.querySelector('.osd-val').textContent = value;
    box.firstElementChild.outerHTML = ic(kind === 'brightness' ? 'sun' : volumeIcon(value / 100, muted));
  } else {
    E.osd.innerHTML = hudHtml(kind, value, muted);
  }
  if (ui.mode !== 'osd') setMode('osd');
  clearTimeout(ui.hudTimer);
  ui.hudTimer = setTimeout(hideHud, 1600);
}

function hideHud() {
  if (ui.mode !== 'osd') return;
  if (ui.hover) {
    ui.hudTimer = setTimeout(hideHud, 700);
    return;
  }
  setMode('compact');
  setTimeout(processQueue, 450);
}

// ------------------------------------------------------------ scroll wheel
// Scrolling over the closed island is handled by the app itself (see syncWheelZone in main.js);
// here the wheel only moves the slider under the pointer in the Sound tab.

function nudgeSlider(t, up) {
  const step = t.dataset.sound === 'brightness' ? 5 : 2;
  const value = clamp(Number(t.value) + (up ? step : -step), 0, 100);
  t.value = value;
  onSliderInput(t);
}

E.island.addEventListener('wheel', (e) => {
  const delta = e.deltaY || e.deltaX; // Shift turns the wheel sideways in Chromium
  if (!delta) return;
  // In the Sound tab, the wheel moves the slider under the pointer.
  const slider = e.target.closest && e.target.closest('.slider[data-sound]');
  if (!slider) return;
  e.preventDefault();
  nudgeSlider(slider, delta < 0);
}, { passive: false });

// --------------------------------------------------------------- from the app

api.on('sound:volume', (m) => {
  S.sound.master = { ok: m.ok, level: m.level, muted: m.muted, device: m.device };
  updateSound();
  if (m.ok && (m.source === 'key' || m.source === 'wheel')) showHud('volume', pct(m.level), m.muted);
});

api.on('sound:mixer', (mx) => {
  S.sound.mixer = mx;
  updateSound();
});

api.on('sound:peaks', showPeaks);

api.on('brightness', (b) => {
  S.sound.brightness = { supported: b.supported, level: b.level, method: b.method };
  updateSound();
  if (!b.supported) return;
  if (b.source === 'wheel') showHud('brightness', b.level);
  // Brightness keys on a laptop (changes made from the Sound tab are already on screen).
  else if (b.source === 'change' && S.settings && S.settings.general.volumeHud !== false) showHud('brightness', b.level);
});

// ------------------------------------------------------------------ microphone

let micAudio = null;

// Two short notes: falling for muted, rising for unmuted.
function micTone(muted) {
  try {
    micAudio = micAudio || new AudioContext();
    const t0 = micAudio.currentTime + 0.01;
    (muted ? [880, 587] : [587, 880]).forEach((f, i) => {
      const o = micAudio.createOscillator();
      const g = micAudio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(micAudio.destination);
      o.start(t);
      o.stop(t + 0.18);
    });
  } catch { /* no sound */ }
}

api.on('mic', (m) => {
  const was = S.mic ? !!S.mic.muted : null;
  S.mic = m;
  if (was !== !!m.muted) {
    renderCompact(); // the red mic on the island
    if (typeof updateFps === 'function') updateFps(); // and over a game
  }
  if (ui.mode === 'expanded' && ui.tab === 'settings') renderSettings(true);
  // Your own press (shortcut, tray or button): say what happened.
  if (['key', 'tray', 'island'].includes(m.source)) {
    showHud('mic', 0, !!m.muted);
    if (!S.settings || S.settings.mic.sound !== false) micTone(!!m.muted);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="mic-toggle"]')) api.micToggle();
});

// ------------------------------------------------------- choosing the mute shortcut

// KeyboardEvent.code -> Electron's key name (by position, so it works with any keyboard layout).
const CODE_KEYS = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Return',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

function codeToKey(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

const SOLO = /^(F([1-9]|1\d|2[0-4])|Insert|Scrolllock|PrintScreen|num.+)$/;
const KEY_LABELS = { Control: 'Ctrl', Super: 'Win', Scrolllock: 'Scroll Lock', PrintScreen: 'Print Screen', Return: 'Enter', PageUp: 'Page Up', PageDown: 'Page Down',
  numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .' };
const keyLabel = (k) => KEY_LABELS[k] || (/^num\d$/.test(k) ? `Num ${k.slice(3)}` : k);

function shortcutKeysHtml(accelerator) {
  return accelerator.split('+').map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`).join('');
}

function shortcutHelp(mic) {
  if (ui.recShortcut) return ui.recError || 'Press the keys you want. Esc cancels';
  if (mic.shortcutOk === false) return 'That shortcut is used by another app. Choose another one';
  return 'Mutes your microphone in every app at once, even in games';
}

function shortcutControlHtml() {
  const current = S.settings.mic.shortcut;
  if (ui.recShortcut) {
    return `<span class="kbd-chip rec">${ui.recPreview ? shortcutKeysHtml(ui.recPreview) + '<kbd class="more">...</kbd>' : '<span>Waiting for keys...</span>'}</span>`
      + '<button class="btn small" data-act="shortcut-cancel">Cancel</button>';
  }
  return `<span class="kbd-chip">${current === 'off' ? '<span>Off</span>' : shortcutKeysHtml(current)}</span>`
    + '<button class="btn small" data-act="shortcut-change">Change</button>'
    + (current !== 'off' ? '<button class="btn small ghost" data-act="shortcut-off">Off</button>' : '');
}

function refreshShortcutRow() {
  if (ui.mode === 'expanded' && ui.tab === 'settings') renderSettings(true);
}

async function startShortcutRecording() {
  ui.recShortcut = true;
  ui.recPreview = '';
  ui.recError = '';
  ui.inputFocused = true; // keep the island open while you press keys
  api.micRecording(true); // let go of the current shortcut, so pressing it records it
  await api.focusInput(true); // the island needs the keyboard for a moment
  refreshShortcutRow();
}

function stopShortcutRecording() {
  if (!ui.recShortcut) return;
  ui.recShortcut = false;
  ui.recPreview = '';
  api.micRecording(false);
  releaseFocus(); // hands the keyboard back to the app you were in
  refreshShortcutRow();
}

document.addEventListener('keydown', async (e) => {
  if (!ui.recShortcut) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.code === 'Escape') {
    ui.recError = '';
    stopShortcutRecording();
    return;
  }
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  const key = codeToKey(e.code);
  if (!key) {
    // only modifiers so far (or a key that can't be used): show what's held
    ui.recPreview = mods.join('+');
    ui.recError = /^(Control|Alt|Shift|Meta|OS)/.test(e.code) ? '' : "That key can't be used. Try another";
    refreshShortcutRow();
    return;
  }
  if (!SOLO.test(key) && mods.length < 2) {
    // one modifier with a letter is taken by other apps (Ctrl+C, Alt+F, ...)
    ui.recPreview = '';
    ui.recError = `Hold two of Ctrl, Alt and Shift with ${keyLabel(key)}, like Ctrl + Alt + ${keyLabel(key)}`;
    refreshShortcutRow();
    return;
  }
  if (key === 'F4' && mods.length === 1 && mods[0] === 'Alt') {
    ui.recPreview = '';
    ui.recError = 'Alt + F4 closes windows. Try another';
    refreshShortcutRow();
    return;
  }
  const accelerator = [...mods, key].join('+');
  const r = await api.micSetShortcut(accelerator);
  if (r && r.ok) {
    ui.recError = '';
    stopShortcutRecording();
  } else {
    ui.recPreview = '';
    ui.recError = r && r.reason === 'taken'
      ? `${accelerator.split('+').map(keyLabel).join(' + ')} is used by another app. Try another`
      : "That shortcut can't be used. Try another";
    refreshShortcutRow();
  }
}, true);

document.addEventListener('keyup', (e) => {
  if (!ui.recShortcut) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (mods.join('+') !== ui.recPreview) {
    ui.recPreview = mods.join('+');
    refreshShortcutRow();
  }
}, true);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'shortcut-change') startShortcutRecording();
  else if (t.dataset.act === 'shortcut-cancel') stopShortcutRecording();
  else if (t.dataset.act === 'shortcut-off') {
    await api.micSetShortcut('off');
    refreshShortcutRow();
  }
});

// clicked somewhere else: stop listening for keys
api.on('window:blur', () => stopShortcutRecording());
api.on('window:visible', (v) => { if (!v) stopShortcutRecording(); });
