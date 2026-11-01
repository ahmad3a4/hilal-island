// Starts the app with Electron. Used by "npm start".
// VS Code's terminal sets ELECTRON_RUN_AS_NODE=1, which would make Electron behave
// like plain Node, so we remove it for the child process.
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electron = require('electron'); // resolves to the path of electron.exe when run from Node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
