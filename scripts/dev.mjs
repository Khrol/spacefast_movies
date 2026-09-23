import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {localEnvironment, root} from './environment.mjs';
const env = await localEnvironment();
const children = [];
function start(command, args, extra = {}) { const child = spawn(command, args, {cwd: root, env: {...env, ...extra}, stdio: 'inherit'}); children.push(child); return child; }
await new Promise((resolve, reject) => { const child = start(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {VITE_USE_EMULATORS: 'true'}); child.on('exit', code => code ? reject(new Error('Build failed.')) : resolve()); });
await mkdir(`${root}/.local/emulator-data`, {recursive: true});
const emulator = start(process.execPath, ['node_modules/firebase-tools/lib/bin/firebase.js', 'emulators:start', '--project', 'demo-reel-together', '--only', 'auth,firestore,functions,hosting', '--import', '.local/emulator-data', '--export-on-exit', '.local/emulator-data']);
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) if (child.exitCode === null) child.kill('SIGINT'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
emulator.on('exit', code => { stop(); process.exitCode = code || 0; });
for (let attempt = 0; attempt < 120 && emulator.exitCode === null; attempt++) {
  try {
    if ((await fetch('http://127.0.0.1:9500/api/health')).ok) {
      const seed = start(process.execPath, ['scripts/seed.mjs'], {GCLOUD_PROJECT: 'demo-reel-together', FIRESTORE_EMULATOR_HOST: '127.0.0.1:9502', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9503'});
      await new Promise(resolve => seed.on('exit', resolve));
      console.log('\nLocal app: http://127.0.0.1:9500\nThe diary persists in .local/emulator-data when stopped with Ctrl+C.\n');
      break;
    }
  } catch { /* Emulator startup is asynchronous. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
