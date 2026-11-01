'use strict';
// A small IDM-style download manager:
//  - several connections per file (byte ranges), with dynamic re-splitting
//  - pause / resume, also across app restarts
//  - parts are kept in a hidden ".hilal" folder and merged at the end
// plus a watcher that shows downloads running in Chrome/Edge/Firefox.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MIN_SEGMENT = 2 * 1024 * 1024;
const PARTS_DIR = '.hilal';
const MERGE_EXT = '.dipart';
const MAX_ITEMS = 60;
const BROWSER_TEMP = [
  { ext: '.crdownload', browser: 'Chrome' },
  { ext: '.part', browser: 'Firefox' },
  { ext: '.partial', browser: 'Browser' },
  { ext: '.opdownload', browser: 'Opera' },
];
const MIME_EXT = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/ogg': '.ogg', 'audio/wav': '.wav', 'application/pdf': '.pdf', 'application/zip': '.zip',
  'application/x-zip-compressed': '.zip', 'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar',
  'application/x-rar-compressed': '.rar', 'application/x-msdownload': '.exe', 'application/x-msi': '.msi',
  'application/x-iso9660-image': '.iso', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'text/plain': '.txt', 'application/json': '.json', 'application/epub+zip': '.epub',
  'application/vnd.android.package-archive': '.apk',
};

class HttpError extends Error {
  constructor(status) {
    super(`The server replied ${status}`);
    this.status = status;
    this.fatal = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

function sanitizeName(name) {
  let n = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n) n = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 16);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

function fromDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*([\w-]*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* use plain filename */ }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (!plain) return null;
  const raw = plain[1].trim();
  // Header values arrive as latin1, but many servers really send UTF-8 bytes.
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return utf8.includes('�') ? raw : utf8;
}

function nameFromUrl(u) {
  try {
    const last = new URL(u).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function uniquePath(dir, name, taken) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i ? `${base} (${i})${ext}` : name);
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + MERGE_EXT) && !taken.has(candidate.toLowerCase())) return candidate;
  }
  return path.join(dir, `${base} ${Date.now()}${ext}`);
}

function planSegments(size, connections) {
  const n = Math.max(1, Math.min(connections, Math.floor(size / MIN_SEGMENT) || 1));
  const chunk = Math.ceil(size / n);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    if (start >= size) break;
    segs.push({ id: i, start, end: Math.min(size, start + chunk) - 1, done: 0 });
  }
  return segs;
}

function friendlyError(err) {
  const code = (err && (err.code || (err.cause && err.cause.code))) || '';
  if (err instanceof HttpError) return err.status === 404 ? 'File not found on the server (404)' : err.message;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Can't reach the server - check your internet";
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'The connection was lost';
  if (code === 'ENOSPC') return 'The disk is full';
  if (code === 'EACCES' || code === 'EPERM') return 'No permission to save in that folder';
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(String(err && err.message))) return 'The site has a security certificate problem';
  return (err && err.message) || 'Download failed';
}

const hidden = new Set();
function hideFolder(dir) {
  if (hidden.has(dir)) return;
  hidden.add(dir);
  try { spawn('attrib', ['+h', dir], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* cosmetic only */ }
}

class Task {
  constructor(item, manager) {
    this.item = item;
    this.m = manager;
    this.ctrl = new AbortController();
    this.stopReason = null;
    this.lastBytes = item.received || 0;
    this.lastTime = Date.now();
    this.firstResponse = null;
  }

  get signal() { return this.ctrl.signal; }

  stop(reason) {
    this.stopReason = reason;
    this.ctrl.abort(new Error(reason));
  }

  headers(extra = {}) {
    return { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...extra };
  }

  sample(now) {
    const dt = (now - this.lastTime) / 1000;
    if (dt <= 0) return;
    const bytes = this.item.received;
    const inst = Math.max(0, (bytes - this.lastBytes) / dt);
    this.item.speed = this.item.speed ? this.item.speed * 0.7 + inst * 0.3 : inst;
    this.lastBytes = bytes;
    this.lastTime = now;
    this.item.eta = this.item.size > 0 && this.item.speed > 1 ? (this.item.size - bytes) / this.item.speed : null;
  }

  async run() {
    const it = this.item;
    it.status = 'downloading';
    it.error = null;
    it.speed = 0;
    this.m.emitUpdate();
    try {
      const s = this.m.getSettings().downloads;
      if (!it.path) await this.probe(s.folder);
      if (it.resumable && it.size > 0) await this.runSegmented(s.connections);
      else await this.runStream();
      it.status = 'completed';
      it.finishedAt = Date.now();
      it.speed = 0;
      it.eta = 0;
      it.received = it.size;
      this.m.emit('completed', this.m.publicItem(it));
    } catch (err) {
      it.speed = 0;
      if (this.stopReason === 'paused') it.status = 'paused';
      else if (this.stopReason === 'canceled') {
        it.status = 'canceled';
        await this.m.cleanup(it);
      } else {
        it.status = 'failed';
        it.error = friendlyError(err);
      }
    }
  }

  async probe(folder) {
    const it = this.item;
    let res = await fetch(it.url, { headers: this.headers({ Range: 'bytes=0-0' }), redirect: 'follow', signal: this.signal });
    if (!res.ok && [400, 403, 405, 416, 501].includes(res.status)) {
      // Some servers dislike range requests: fall back to a plain download.
      try { await res.body?.cancel(); } catch { /* ignore */ }
      res = await fetch(it.url, { headers: this.headers(), redirect: 'follow', signal: this.signal });
    }
    if (!res.ok) throw new HttpError(res.status);

    it.finalUrl = res.url || it.url;
    let size = -1;
    let resumable = false;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (m) { size = Number(m[1]); resumable = size > 0; }
    } else {
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0) size = len;
    }

    let name = fromDisposition(res.headers.get('content-disposition')) || nameFromUrl(it.finalUrl) || it.name || 'download';
    if (!path.extname(name)) {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (MIME_EXT[type]) name += MIME_EXT[type];
    }
    name = sanitizeName(name);
    await fsp.mkdir(folder, { recursive: true });
    it.path = uniquePath(folder, name, this.m.takenPaths(it.id));
    it.name = path.basename(it.path);
    it.size = size;
    it.resumable = resumable;

    if (res.status === 206) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    } else {
      this.firstResponse = res; // reuse this response body for the download itself
    }
    this.m.save();
    this.m.emitUpdate();
  }

  partsDir() { return path.join(path.dirname(this.item.path), PARTS_DIR, this.item.id); }
  partPath(seg) { return path.join(this.partsDir(), `part-${seg.id}`); }

  async runSegmented(connections) {
    const it = this.item;
    await fsp.mkdir(this.partsDir(), { recursive: true });
    hideFolder(path.join(path.dirname(it.path), PARTS_DIR));
    if (!Array.isArray(it.segments) || !it.segments.length) it.segments = planSegments(it.size, connections);

    // Trust what's actually on disk (the app may have been closed mid-write).
    for (const seg of it.segments) {
      const len = seg.end - seg.start + 1;
      let onDisk = 0;
      try { onDisk = (await fsp.stat(this.partPath(seg))).size; } catch { /* no part yet */ }
      if (onDisk > len) {
        await fsp.truncate(this.partPath(seg), len);
        onDisk = len;
      }
      seg.done = onDisk;
    }
    it.received = it.segments.reduce((a, s) => a + s.done, 0);
    this.lastBytes = it.received;

    const active = new Set();
    let failure = null;
    const launch = (seg) => {
      const p = this.runSegment(seg)
        .catch((e) => { if (!failure) failure = e; this.ctrl.abort(e); })
        .finally(() => active.delete(p));
      active.add(p);
    };
    for (const seg of it.segments) if (seg.done < seg.end - seg.start + 1) launch(seg);
    while (active.size) {
      await Promise.race(active);
      if (failure || this.signal.aborted) break;
      // A connection is free: help the slowest part by splitting what's left of it.
      while (active.size < connections) {
        const seg = this.splitLargest();
        if (!seg) break;
        launch(seg);
      }
    }
    await Promise.allSettled([...active]);
    if (failure) throw failure;
    if (this.signal.aborted) throw this.signal.reason || new Error('aborted');
    await this.merge();
  }

  splitLargest() {
    const segs = this.item.segments;
    let best = null;
    let bestRemaining = 0;
    for (const s of segs) {
      const remaining = s.end - (s.start + s.done) + 1;
      if (remaining > bestRemaining) { best = s; bestRemaining = remaining; }
    }
    if (!best || bestRemaining < MIN_SEGMENT * 2) return null;
    const mid = best.start + best.done + Math.floor(bestRemaining / 2);
    const seg = { id: Math.max(...segs.map((s) => s.id)) + 1, start: mid, end: best.end, done: 0 };
    best.end = mid - 1; // the running connection stops here on its own
    segs.push(seg);
    return seg;
  }

  async runSegment(seg) {
    let attempt = 0;
    while (seg.start + seg.done <= seg.end) {
      if (this.signal.aborted) throw this.signal.reason || new Error('aborted');
      const local = new AbortController();
      const onAbort = () => local.abort();
      this.signal.addEventListener('abort', onAbort, { once: true });
      let fh = null;
      try {
        const from = seg.start + seg.done;
        const res = await fetch(this.item.finalUrl || this.item.url, {
          headers: this.headers({ Range: `bytes=${from}-${seg.end}` }),
          redirect: 'follow',
          signal: local.signal,
        });
        if (res.status !== 206) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          throw res.ok ? Object.assign(new Error('The server stopped supporting resume'), { fatal: true }) : new HttpError(res.status);
        }
        fh = await fsp.open(this.partPath(seg), 'a');
        for await (const chunk of res.body) {
          const remaining = seg.end - (seg.start + seg.done) + 1;
          if (remaining <= 0) break;
          const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          await fh.write(buf);
          seg.done += buf.length;
          this.item.received += buf.length;
          attempt = 0;
          if (buf.length < chunk.length) break;
        }
        if (seg.start + seg.done <= seg.end) throw new Error('The connection closed early');
      } catch (err) {
        if (this.signal.aborted) throw this.signal.reason || err;
        attempt += 1;
        if (err.fatal || attempt > 8) throw err;
        await sleep(Math.min(500 * 2 ** attempt, 15000), this.signal);
      } finally {
        this.signal.removeEventListener('abort', onAbort);
        local.abort(); // drop the connection if we stopped early (e.g. after a split)
        if (fh) await fh.close().catch(() => {});
      }
    }
  }

  async merge() {
    const it = this.item;
    const segs = [...it.segments].sort((a, b) => a.start - b.start);
    let expected = 0;
    for (const s of segs) {
      if (s.start !== expected || s.done !== s.end - s.start + 1) throw new Error('Some downloaded data is missing');
      expected = s.end + 1;
    }
    if (expected !== it.size) throw new Error('Some downloaded data is missing');

    it.status = 'merging';
    this.m.emitUpdate();
    const tmp = it.path + MERGE_EXT;
    if (segs.length === 1) {
      await fsp.rename(this.partPath(segs[0]), tmp);
    } else {
      const out = fs.createWriteStream(tmp);
      try {
        for (const s of segs) {
          for await (const chunk of fs.createReadStream(this.partPath(s), { highWaterMark: 1 << 20 })) {
            if (this.signal.aborted) throw this.signal.reason || new Error('aborted');
            if (!out.write(chunk)) await once(out, 'drain');
          }
        }
        out.end();
        await once(out, 'finish');
      } catch (e) {
        out.destroy();
        await fsp.rm(tmp, { force: true });
        throw e;
      }
    }
    await this.placeFinal(tmp);
    await fsp.rm(this.partsDir(), { recursive: true, force: true });
    await this.m.removeEmptyPartsRoot(path.dirname(it.path));
  }

  async runStream() {
    const it = this.item;
    let res = this.firstResponse;
    this.firstResponse = null;
    if (!res) res = await fetch(it.finalUrl || it.url, { headers: this.headers(), redirect: 'follow', signal: this.signal });
    if (!res.ok) throw new HttpError(res.status);
    const tmp = it.path + MERGE_EXT;
    it.received = 0;
    this.lastBytes = 0;
    const fh = await fsp.open(tmp, 'w');
    try {
      for await (const chunk of res.body) {
        await fh.write(chunk);
        it.received += chunk.length;
      }
    } finally {
      await fh.close().catch(() => {});
    }
    if (it.size > 0 && it.received < it.size) throw new Error('The connection closed early');
    if (it.size <= 0) it.size = it.received;
    await this.placeFinal(tmp);
  }

  async placeFinal(tmp) {
    const it = this.item;
    if (fs.existsSync(it.path)) {
      it.path = uniquePath(path.dirname(it.path), path.basename(it.path), this.m.takenPaths(it.id));
      it.name = path.basename(it.path);
    }
    await fsp.rename(tmp, it.path);
  }
}

class BrowserWatcher {
  constructor(manager) {
    this.m = manager;
    this.tracked = new Map();
    this.folder = null;
    this.watcher = null;
    this.timer = null;
    this.kickTimer = null;
    this.scanning = false;
  }

  start(folder) {
    this.stop();
    this.folder = folder;
    try {
      this.watcher = fs.watch(folder, { persistent: false }, () => this.kick());
      this.watcher.on('error', () => {});
    } catch { /* polling still works */ }
    this.loop();
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    this.watcher = null;
    clearTimeout(this.timer);
    clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
    for (const e of this.tracked.values()) this.m.dropBrowserItem(e.item.id);
    this.tracked.clear();
    this.folder = null;
  }

  kick() {
    if (this.kickTimer || !this.folder) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = null; this.scan(); }, 150);
  }

  loop() {
    if (!this.folder) return;
    this.scan().finally(() => {
      if (this.folder) this.timer = setTimeout(() => this.loop(), this.tracked.size ? 1000 : 4000);
    });
  }

  async scan() {
    if (this.scanning || !this.folder) return;
    this.scanning = true;
    try {
      const names = await fsp.readdir(this.folder);
      const now = Date.now();
      const seen = new Set();
      for (const name of names) {
        const lower = name.toLowerCase();
        const kind = BROWSER_TEMP.find((b) => lower.endsWith(b.ext));
        if (!kind) continue;
        const full = path.join(this.folder, name);
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (!st.isFile()) continue;
        let e = this.tracked.get(full);
        if (!e) {
          if (now - st.mtimeMs > 10 * 60e3) continue; // a leftover from an old, abandoned download
          const finalName = name.slice(0, -kind.ext.length);
          const unconfirmed = /^Unconfirmed \d+$/i.test(finalName);
          e = { full, finalName, unconfirmed, lastSize: st.size, lastChange: now };
          e.item = this.m.addBrowserItem({
            name: unconfirmed ? 'Preparing download...' : finalName,
            browser: kind.browser,
            received: st.size,
            path: path.join(this.folder, finalName),
          });
          this.tracked.set(full, e);
        }
        seen.add(full);
        if (st.size !== e.lastSize) e.lastChange = now;
        e.lastSize = st.size;
        this.m.updateBrowserItem(e.item.id, st.size, now - e.lastChange > 20e3);
      }
      for (const [full, e] of this.tracked) {
        if (seen.has(full)) continue;
        this.tracked.delete(full);
        const finalPath = path.join(this.folder, e.finalName);
        let size = null;
        try {
          const st = await fsp.stat(finalPath);
          if (st.isFile() && st.size > 0) size = st.size;
        } catch { /* canceled or renamed */ }
        if (size !== null && !e.unconfirmed) this.m.completeBrowserItem(e.item.id, finalPath, size);
        else this.m.dropBrowserItem(e.item.id);
      }
    } catch {
      // folder missing or unreadable: try again next round
    } finally {
      this.scanning = false;
    }
  }
}

class DownloadManager extends EventEmitter {
  constructor({ storeFile, getSettings }) {
    super();
    this.storeFile = storeFile;
    this.getSettings = getSettings;
    this.items = [];
    this.tasks = new Map();
    this.saveTimer = null;
    this.browser = new BrowserWatcher(this);
    this.load();
    this.timer = setInterval(() => this.tick(), 500);
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      this.items = (data.items || []).filter((i) => i && i.id && !(i.kind === 'browser' && i.status !== 'completed'));
      for (const it of this.items) {
        if (['downloading', 'queued', 'merging'].includes(it.status)) it.status = 'paused';
        it.speed = 0;
        it.eta = null;
      }
    } catch {
      this.items = [];
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      const items = this.items.map(({ speed, eta, _last, ...rest }) => rest);
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const tmp = `${this.storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1), 'utf8');
      fs.renameSync(tmp, this.storeFile);
    } catch (err) {
      console.error('Could not save downloads:', err.message);
    }
  }

  publicItem(it) {
    return {
      id: it.id, kind: it.kind, browser: it.browser || null, url: it.url || null, name: it.name, path: it.path || null,
      size: it.size, received: it.received || 0, status: it.status, speed: it.speed || 0, eta: it.eta ?? null,
      error: it.error || null, resumable: !!it.resumable, createdAt: it.createdAt, finishedAt: it.finishedAt || null,
      connections: it.status === 'downloading' && Array.isArray(it.segments)
        ? it.segments.filter((s) => s.done < s.end - s.start + 1).length : (it.status === 'downloading' ? 1 : 0),
    };
  }

  list() { return this.items.map((it) => this.publicItem(it)); }

  emitUpdate() { this.emit('update', this.list()); }

  find(id) { return this.items.find((i) => i.id === id); }

  takenPaths(exceptId) {
    const set = new Set();
    for (const i of this.items) {
      if (i.id !== exceptId && i.path && i.kind === 'direct' && i.status !== 'completed' && i.status !== 'canceled') set.add(i.path.toLowerCase());
    }
    return set;
  }

  add(url) {
    let u;
    try { u = new URL(String(url).trim()); } catch { throw new Error('That does not look like a link'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be downloaded');
    const item = {
      id: crypto.randomUUID(), kind: 'direct', url: u.href, name: sanitizeName(nameFromUrl(u.href) || u.hostname),
      path: null, size: -1, received: 0, status: 'queued', createdAt: Date.now(), resumable: false, segments: null,
    };
    this.items.unshift(item);
    this.trim();
    this.save();
    this.emitUpdate();
    this.schedule();
    return this.publicItem(item);
  }

  trim() {
    const done = (i) => ['completed', 'canceled', 'failed'].includes(i.status);
    while (this.items.length > MAX_ITEMS) {
      const idx = this.items.map(done).lastIndexOf(true);
      if (idx < 0) break;
      this.items.splice(idx, 1);
    }
  }

  schedule() {
    const max = this.getSettings().downloads.maxActive;
    let active = this.tasks.size;
    for (const it of [...this.items].reverse()) {
      if (active >= max) break;
      if (it.kind === 'direct' && it.status === 'queued' && !this.tasks.has(it.id)) {
        this.startTask(it);
        active++;
      }
    }
  }

  startTask(it) {
    const task = new Task(it, this);
    this.tasks.set(it.id, task);
    task.run().finally(() => {
      this.tasks.delete(it.id);
      this.save();
      this.emitUpdate();
      this.schedule();
    });
  }

  action(id, action) {
    const it = this.find(id);
    if (!it) return;
    const task = this.tasks.get(id);
    switch (action) {
      case 'pause':
        if (task) task.stop('paused');
        else if (it.status === 'queued') it.status = 'paused';
        break;
      case 'resume':
      case 'retry':
        if (it.kind !== 'direct' || task) break;
        if (it.status === 'canceled') { it.segments = null; it.received = 0; it.path = null; }
        if (['paused', 'failed', 'canceled'].includes(it.status)) { it.status = 'queued'; it.error = null; }
        this.schedule();
        break;
      case 'cancel':
        if (task) task.stop('canceled');
        else if (it.kind === 'direct' && it.status !== 'completed') { it.status = 'canceled'; this.cleanup(it); }
        break;
      case 'remove':
        if (task) task.stop('canceled');
        else if (it.kind === 'direct' && it.status !== 'completed') this.cleanup(it);
        this.items = this.items.filter((i) => i !== it);
        break;
      default:
        return;
    }
    this.save();
    this.emitUpdate();
  }

  clearFinished() {
    this.items = this.items.filter((i) => !['completed', 'canceled', 'failed'].includes(i.status));
    this.save();
    this.emitUpdate();
  }

  async cleanup(it) {
    if (!it.path) return;
    const dir = path.dirname(it.path);
    await fsp.rm(path.join(dir, PARTS_DIR, it.id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(it.path + MERGE_EXT, { force: true }).catch(() => {});
    it.segments = null;
    it.received = 0;
    await this.removeEmptyPartsRoot(dir);
  }

  async removeEmptyPartsRoot(dir) {
    const root = path.join(dir, PARTS_DIR);
    try {
      if ((await fsp.readdir(root)).length === 0) await fsp.rmdir(root);
    } catch { /* not there */ }
  }

  // --- browser downloads ---
  watchBrowser(enabled, folder) {
    if (enabled) this.browser.start(folder);
    else this.browser.stop();
  }

  addBrowserItem({ name, browser, received, path: p }) {
    const now = Date.now();
    const item = { id: crypto.randomUUID(), kind: 'browser', browser, name, path: p, size: -1, received, status: 'downloading', createdAt: now, speed: 0, _last: { bytes: received, time: now } };
    this.items.unshift(item);
    this.emitUpdate();
    return item;
  }

  updateBrowserItem(id, received, stalled) {
    const it = this.find(id);
    if (!it) return;
    it.received = received;
    it.status = stalled ? 'stalled' : 'downloading';
  }

  completeBrowserItem(id, finalPath, size) {
    const it = this.find(id);
    if (!it) return;
    Object.assign(it, { status: 'completed', path: finalPath, name: path.basename(finalPath), size, received: size, speed: 0, finishedAt: Date.now() });
    delete it._last;
    this.trim();
    this.save();
    this.emitUpdate();
    this.emit('completed', this.publicItem(it));
  }

  dropBrowserItem(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this.emitUpdate();
  }

  tick() {
    const now = Date.now();
    let busy = false;
    for (const t of this.tasks.values()) {
      t.sample(now);
      busy = true;
    }
    for (const it of this.items) {
      if (it.kind !== 'browser' || !it._last) continue;
      if (it.status === 'downloading' || it.status === 'stalled') {
        const dt = (now - it._last.time) / 1000;
        if (dt > 0) {
          const inst = Math.max(0, (it.received - it._last.bytes) / dt);
          it.speed = it.status === 'stalled' ? 0 : (it.speed ? it.speed * 0.6 + inst * 0.4 : inst);
          it._last = { bytes: it.received, time: now };
        }
        busy = true;
      }
    }
    if (busy) {
      this.emitUpdate();
      if (now - (this.lastProgressSave || 0) > 5000) { this.lastProgressSave = now; this.save(); }
    }
  }

  shutdown() {
    clearInterval(this.timer);
    for (const t of this.tasks.values()) t.stop('paused');
    for (const it of this.items) if (it.kind === 'direct' && ['downloading', 'queued', 'merging'].includes(it.status)) it.status = 'paused';
    this.browser.stop();
    this.saveNow();
  }
}

module.exports = { DownloadManager, sanitizeName, fromDisposition };
