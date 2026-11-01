// One-time setup: makes sure everything the app needs is in place.
// Usage: npm run setup          (also runs after "npm install")
//        npm run setup -- --start-menu   (also adds a Start menu shortcut)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const step = (msg) => console.log(`- ${msg}`);

function ensureElectron() {
  const dist = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(dist)) return dist;
  step('Downloading the Electron runtime (newer npm versions skip this step)...');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
  if (!fs.existsSync(dist)) throw new Error('Electron could not be downloaded. Check your internet connection and run "npm run setup" again.');
  return dist;
}

function ensureAssets() {
  const need = ['assets/fonts/AmiriQuran-Regular.ttf', 'assets/audio/azan-1.ogg'].some((f) => !fs.existsSync(path.join(root, f)));
  if (need) {
    step('Downloading fonts and azan recordings...');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'fetch-assets.js')], { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(root, 'assets', 'data', 'ayat.json'))) {
    step('Downloading Quran verses...');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'fetch-ayat.js')], { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(root, 'assets', 'icons', 'icon.ico'))) {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icons.js')], { stdio: 'inherit' });
  }
}

function createShortcut(lnk, electronExe) {
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DI_LNK)',
    '$s.TargetPath = $env:DI_EXE',
    '$s.Arguments = \'"\' + $env:DI_ROOT + \'"\'',
    '$s.WorkingDirectory = $env:DI_ROOT',
    '$s.IconLocation = $env:DI_ICON',
    '$s.Description = "Hilal: a dynamic island for Windows"',
    '$s.Save()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, DI_LNK: lnk, DI_EXE: electronExe, DI_ROOT: root, DI_ICON: path.join(root, 'assets', 'icons', 'icon.ico') },
    windowsHide: true,
  });
}

try {
  console.log('Setting up Hilal');
  const electronExe = ensureElectron();
  ensureAssets();
  step('Building the native helper (uses the C# compiler built into Windows)...');
  require('./build-helper').build({ quiet: true });
  step('Creating the "Hilal" shortcut in this folder...');
  createShortcut(path.join(root, 'Hilal.lnk'), electronExe);
  if (process.argv.includes('--start-menu')) {
    const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hilal.lnk');
    createShortcut(startMenu, electronExe);
    step('Added to the Start menu.');
  }
  console.log('Done. Double-click "Hilal" in this folder (or run "npm start").');
} catch (err) {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
}
