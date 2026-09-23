import {spawn} from 'node:child_process';
import {localEnvironment, root} from './environment.mjs';
const env = await localEnvironment();
function run(args, extra = {}) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, args, {cwd: root, env: {...env, ...extra}, stdio: 'inherit'}); child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Command failed with exit code ${code}.`)) : resolve()); }); }
await run(['node_modules/vite/bin/vite.js', 'build'], {VITE_USE_EMULATORS: 'true'});
try {
  await run(['node_modules/firebase-tools/lib/bin/firebase.js', 'emulators:exec', '--project', 'demo-reel-together', '--only', 'auth,firestore,functions,hosting', 'node --test --test-concurrency=1 tests/integration.test.mjs tests/browser.test.mjs']);
} finally {
  // Keep dist safe for a subsequent production deployment, even after test failures.
  await run(['node_modules/vite/bin/vite.js', 'build'], {VITE_USE_EMULATORS: 'false'});
}
