import {spawn} from 'node:child_process';
const args = process.argv.slice(2), project = args[args.indexOf('--project') + 1];
if (!args.includes('--project') || !project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || project.startsWith('demo-')) throw new Error('Usage: npm run deploy -- --project YOUR_FIREBASE_PROJECT_ID');
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Unset emulator environment variables before deploying.');
function run(bin, args, env = process.env) { return new Promise((resolve, reject) => { const child = spawn(bin, args, {stdio: 'inherit', env}); child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Command failed (${code}).`)) : resolve()); }); }
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {...process.env, VITE_USE_EMULATORS: 'false'});
await run(process.execPath, ['node_modules/firebase-tools/lib/bin/firebase.js', 'deploy', '--project', project, '--only', 'hosting,functions:reel-together,firestore']);
