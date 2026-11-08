// Builds the Microsoft Store package (dist/Hilal-<version>.appx). Upload it in Partner Center; the
// Store signs it. The identity comes from Partner Center > Product identity, saved in store.json:
//   { "identityName": "...", "publisher": "CN=...", "publisherDisplayName": "...", "displayName": "<the reserved app name>" }
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const idFile = path.join(__dirname, '..', 'store.json');
if (!fs.existsSync(idFile)) {
  console.error('store.json is missing: copy the three values from Partner Center > Product identity into it.');
  process.exit(1);
}
const id = JSON.parse(fs.readFileSync(idFile, 'utf8'));

execFileSync(process.execPath, [path.join(__dirname, 'build-helper.js')], { stdio: 'inherit' });

const builder = require('electron-builder');
builder.build({
  targets: builder.Platform.WINDOWS.createTarget(['appx'], builder.Arch.x64),
  config: {
    win: { target: [{ target: 'appx', arch: ['x64'] }], icon: 'assets/icons/icon.ico' },
    appx: {
      identityName: id.identityName,
      publisher: id.publisher,
      publisherDisplayName: id.publisherDisplayName,
      displayName: id.displayName || 'Hilal', // must match the name reserved in Partner Center
      applicationId: 'Hilal',
      minVersion: '10.0.17763.0',
      maxVersionTested: '10.0.26100.0',
      backgroundColor: 'transparent',
      languages: ['en-US', 'ar'],
      capabilities: ['internetClient', 'location'], // downloads, and Settings > Location > Detect
      addAutoLaunchExtension: true, // Windows starts Hilal at sign-in (Task Manager > Startup apps)
      showNameOnTiles: false,
      artifactName: 'Hilal-${version}.${ext}',
    },
  },
}).then((files) => console.log(files.join('\n'))).catch((err) => { console.error(err); process.exit(1); });
