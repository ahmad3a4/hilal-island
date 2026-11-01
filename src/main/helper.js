'use strict';
// Runs HilalHelper.exe (the native bridge) and talks to it over stdin/stdout.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'native', 'HilalHelper.cs');

class Helper extends EventEmitter {
  /**
   * @param {{exe: string, buildIfMissing: boolean}} opts
   *   exe: path to HilalHelper.exe (native/bin in development, resources/native when installed)
   *   buildIfMissing: compile it from source when missing or outdated (development only)
   */
  constructor({ exe, buildIfMissing }) {
    super();
    this.exe = exe;
    this.buildIfMissing = buildIfMissing;
    this.proc = null;
    this.buffer = '';
    this.stopping = false;
    this.restarts = [];
    this.waiters = [];
  }

  async ensureBuilt() {
    if (!this.buildIfMissing) return fs.existsSync(this.exe);
    const stale = !fs.existsSync(this.exe)
      || (fs.existsSync(SOURCE) && fs.statSync(this.exe).mtimeMs < fs.statSync(SOURCE).mtimeMs);
    if (!stale) return true;
    try {
      require(path.join(ROOT, 'scripts', 'build-helper.js')).build({ quiet: true });
      return true;
    } catch (err) {
      this.emit('log', `native helper could not be built: ${err.message}`);
      return fs.existsSync(this.exe);
    }
  }

  async start() {
    if (!(await this.ensureBuilt())) return;
    this.stopping = false;
    this.proc = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => this.emit('log', String(d).trim()));
    this.proc.on('error', (err) => this.emit('log', `helper error: ${err.message}`));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      // Restart, but not in a tight loop.
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60e3);
      if (this.restarts.length >= 5) {
        this.emit('log', `helper keeps exiting (code ${code}); giving up for now`);
        return;
      }
      this.restarts.push(now);
      setTimeout(() => this.start(), 1500);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.waiters = this.waiters.filter((w) => {
        if (w.type !== msg.type) return true;
        clearTimeout(w.timer);
        w.resolve(msg);
        return false;
      });
      this.emit('message', msg);
      this.emit(msg.type, msg);
    }
  }

  send(cmd, ...args) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    const clean = [cmd, ...args].map((a) => String(a ?? '').replace(/[\t\r\n]/g, ' '));
    this.proc.stdin.write(`${clean.join('\t')}\n`);
    return true;
  }

  /** Sends a command and resolves with the next message of `replyType`. */
  request(cmd, args, replyType, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.send(cmd, ...args)) {
        reject(new Error('helper not running'));
        return;
      }
      const waiter = { type: replyType, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${cmd}: no reply`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  stop() {
    this.stopping = true;
    if (!this.proc) return;
    try {
      this.send('unmute');
      this.send('quit');
    } catch {
      // ignore
    }
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, 800);
  }
}

module.exports = { Helper };
