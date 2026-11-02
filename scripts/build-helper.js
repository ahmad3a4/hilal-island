// Compiles native/HilalHelper.cs with the C# compiler that ships with Windows
// (.NET Framework 4.x). No SDK or Visual Studio needed.
//
// Usage: node scripts/build-helper.js        (also called automatically on first launch)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native', 'HilalHelper.cs');
const outDir = path.join(root, 'native', 'bin');
const output = path.join(outDir, 'HilalHelper.exe');

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function findGacAssembly(name) {
  const win = process.env.WINDIR || 'C:\\Windows';
  const dir = path.join(win, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  if (!fs.existsSync(dir)) return null;
  for (const version of fs.readdirSync(dir)) {
    const dll = path.join(dir, version, `${name}.dll`);
    if (fs.existsSync(dll)) return dll;
  }
  return null;
}

function build({ quiet = false } = {}) {
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe (.NET Framework 4.x) was not found on this PC.');
  const win = process.env.WINDIR || 'C:\\Windows';
  const winmd = (n) => path.join(win, 'System32', 'WinMetadata', `Windows.${n}.winmd`);
  const systemRuntime = findGacAssembly('System.Runtime');
  const winrtInterop = findGacAssembly('System.Runtime.InteropServices.WindowsRuntime');
  if (!systemRuntime || !winrtInterop) throw new Error('.NET Framework facades not found in the GAC.');

  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    '-nologo', '-optimize+', '-target:exe', '-platform:anycpu',
    `-out:${output}`,
    `-r:${winmd('Foundation')}`,
    `-r:${winmd('Media')}`,
    `-r:${winmd('Storage')}`,
    `-r:${winmd('Devices')}`,
    `-r:${systemRuntime}`,
    `-r:${winrtInterop}`,
    '-r:System.Management.dll',
    source,
  ];
  try {
    const out = execFileSync(csc, args, { encoding: 'utf8', windowsHide: true });
    if (!quiet) console.log(out.trim() || 'ok');
  } catch (err) {
    const details = `${err.stdout || ''}${err.stderr || ''}`.trim();
    throw new Error(`Helper build failed:\n${details || err.message}`);
  }
  if (!quiet) console.log(`Built ${path.relative(root, output)}`);
  return output;
}

module.exports = { build, output, source };

if (require.main === module) {
  try {
    build();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
