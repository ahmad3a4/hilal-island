'use strict';
// Updates from GitHub releases: is there a newer version, download its installer (checked against
// the SHA-256 in the release notes), and start it. The installer closes Hilal and replaces it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'ahmad3a4/hilal-island';
const UA = 'Hilal-Updater';

function get(url, { json = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, { json, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub answered ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(20000, () => req.destroy(new Error('GitHub did not answer')));
    req.on('error', reject);
  });
}

async function getJson(url) {
  const res = await get(url, { json: true });
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

// "1.10.0" > "1.9.3"
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function check(current) {
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find((a) => /^Hilal-Setup-.*\.exe$/i.test(a.name));
  const sha = (/SHA-256:\s*`?([A-F0-9]{64})`?/i.exec(rel.body || '') || [])[1];
  return {
    current,
    latest: version,
    available: !!(version && asset && newer(version, current)),
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
    sha256: sha ? sha.toUpperCase() : null,
    page: rel.html_url,
  };
}

// Downloads the installer to the temp folder; onProgress(0..1).
async function download(info, onProgress) {
  const file = path.join(os.tmpdir(), info.asset.name);
  const res = await get(info.asset.url);
  const total = Number(res.headers['content-length']) || info.asset.size || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  let last = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    res.on('data', (chunk) => {
      hash.update(chunk);
      got += chunk.length;
      const now = Date.now();
      if (total && now - last > 250) {
        last = now;
        onProgress(got / total);
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  onProgress(1);
  const digest = hash.digest('hex').toUpperCase();
  if (info.sha256 && digest !== info.sha256) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw new Error("The download doesn't match the release (SHA-256), so it wasn't opened");
  }
  return file;
}

// Starts the installer on its own; the caller quits Hilal right after.
function launch(file) {
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { check, download, launch, newer };
