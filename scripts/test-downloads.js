// Tests the download manager against a local server that behaves like tricky real-world hosts:
// single-use links, servers that refuse ranges, anti-hotlinking, capped answers, web pages...
// Every finished file is checked byte for byte. Runs offline.
//
// Usage: npm run test:downloads
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DownloadManager } = require('../src/main/downloads');

const MB = 1024 * 1024;
const FILE = crypto.randomBytes(9 * MB + 12345);
const HASH = crypto.createHash('sha256').update(FILE).digest('hex');
const tokens = new Set();
let nextToken = 1;
let strictUsed = false;
const hits = {}; // path -> number of requests, to see how many connections were used

// Sends FILE, honouring Range unless told not to. `slow` trickles it out so a pause can catch it.
function serve(req, res, { ranges = true, cap = 0, slow = false } = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0;
  let end = FILE.length - 1;
  if (m && ranges) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(end, Number(m[2]));
    if (cap) end = Math.min(end, start + cap - 1);
    if (start > end) { res.writeHead(416); res.end(); return; }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${FILE.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
  } else {
    res.writeHead(200, { 'Content-Length': FILE.length, 'Content-Type': 'application/octet-stream', ...(ranges ? { 'Accept-Ranges': 'bytes' } : {}) });
  }
  const body = FILE.subarray(start, end + 1);
  if (!slow) { res.end(body); return; }
  let pos = 0;
  const tick = () => {
    if (res.destroyed) return;
    const chunk = body.subarray(pos, pos + 64 * 1024);
    pos += chunk.length;
    if (pos >= body.length) { res.end(chunk); return; }
    res.write(chunk);
    setTimeout(tick, 5);
  };
  tick();
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  hits[pathname] = (hits[pathname] || 0) + 1;
  const token = /^\/t\/(\d+)\/data\.bin$/.exec(pathname);
  if (token) { // a redirect target that works exactly once
    if (!tokens.delete(Number(token[1]))) { res.writeHead(404); res.end(); return; }
    serve(req, res);
    return;
  }
  const oneTimeRedirect = () => {
    const t = nextToken++;
    tokens.add(t);
    res.writeHead(302, { Location: `/t/${t}/data.bin` });
    res.end();
  };
  switch (pathname) {
    case '/plain.bin': serve(req, res); break;
    case '/slow.bin': serve(req, res, { slow: true }); break;
    case '/norange.bin': serve(req, res, { ranges: false }); break;
    case '/range404.bin': // answers 404 to any range request
      if (req.headers.range) { res.writeHead(404); res.end(); } else serve(req, res, { ranges: false });
      break;
    case '/referer.bin': // anti-hotlinking: needs a Referer
      if (!req.headers.referer) { res.writeHead(404); res.end(); } else serve(req, res);
      break;
    case '/capped.bin': serve(req, res, { cap: 700 * 1024 }); break; // at most 700 KB per answer
    case '/once': oneTimeRedirect(); break; // every visit hands out a fresh single-use address
    case '/strict': // the link itself works only once
      if (strictUsed) { res.writeHead(404); res.end(); } else { strictUsed = true; oneTimeRedirect(); }
      break;
    case '/page': res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>hello</body></html>'); break;
    default: res.writeHead(404); res.end();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilal-dl-test-'));
  const m = new DownloadManager({
    storeFile: path.join(dir, 'store.json'),
    getSettings: () => ({ downloads: { folder: dir, connections: 8, maxActive: 4, watchBrowser: false } }),
  });

  const waitFor = async (id, statuses, timeout = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const it = m.list().find((d) => d.id === id);
      if (it && statuses.includes(it.status)) return it;
      if (Date.now() - t0 > timeout) return it || { status: 'timeout' };
      await sleep(40);
    }
  };
  const sameBytes = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === HASH;

  const download = async (label, urlPath, extra = () => '') => {
    const it = m.add(base + urlPath);
    const done = await waitFor(it.id, ['completed', 'failed']);
    const ok = done.status === 'completed' && sameBytes(done.path);
    report(ok, label, ok ? extra() : `${done.status}: ${done.error || ''}`);
  };

  await download('normal file', '/plain.bin', () => `${hits['/plain.bin']} request(s)`);
  await download('server caps each answer at 700 KB', '/capped.bin');
  await download('server ignores ranges', '/norange.bin');
  await download('server answers 404 to range requests', '/range404.bin');
  await download('server needs a Referer (anti-hotlinking)', '/referer.bin');
  const before = nextToken;
  await download('redirect to single-use addresses', '/once', () => `${nextToken - before} fresh addresses`);
  await download('link that works only once', '/strict');

  const page = m.add(`${base}/page`);
  const pageDone = await waitFor(page.id, ['completed', 'failed']);
  report(pageDone.status === 'failed' && /web page/.test(pageDone.error || ''), 'web page link is explained', pageDone.error);

  const missing = m.add(`${base}/missing.zip`);
  const missingDone = await waitFor(missing.id, ['completed', 'failed']);
  report(missingDone.status === 'failed' && /404/.test(missingDone.error || ''), '404 is explained', missingDone.error);

  const slow = m.add(`${base}/slow.bin`);
  for (let i = 0; i < 400; i++) {
    const it = m.list().find((d) => d.id === slow.id);
    if (it && it.status === 'downloading' && it.received > FILE.length * 0.3) break;
    await sleep(25);
  }
  report(hits['/slow.bin'] > 1, 'a slow download gets extra connections', `${hits['/slow.bin']} connections`);
  m.action(slow.id, 'pause');
  const paused = await waitFor(slow.id, ['paused', 'failed', 'completed'], 10000);
  const pausedAt = paused.received;
  await sleep(300);
  m.action(slow.id, 'resume');
  const resumed = await waitFor(slow.id, ['completed', 'failed'], 60000);
  report(paused.status === 'paused' && resumed.status === 'completed' && sameBytes(resumed.path), 'pause and resume',
    `paused at ${Math.round((pausedAt / FILE.length) * 100)}%`);

  m.shutdown();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} test(s) failed` : '\nAll download tests passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
