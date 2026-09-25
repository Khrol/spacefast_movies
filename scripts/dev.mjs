import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createApp, localDatabase, serve} from './local-server.mjs';
import {readSecrets} from '../server/worker.js';
import {localGoogle} from './local-google.mjs';

try {process.loadEnvFile('.env.local');} catch (error) {if (error.code !== 'ENOENT') throw error;}
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error('Build failed')) : resolve());
});
await mkdir('.local', {recursive: true});
const {binding, db} = await localDatabase('.local/diary.sqlite');
const google = process.argv.includes('--demo') ? await localGoogle(process.env.OWNER_EMAIL) : null;
const secrets = {...readSecrets(process.env), local: true, localGoogle: !!google, origin: 'http://localhost:9500'};
if (google) {secrets.googleClientId = google.clientId; secrets.ownerEmail ||= 'developer@gmail.com';}
const server = await serve(createApp({db, secrets, googleKeys: google?.keys}), {port: 9500, handleLocal: google?.handle});
console.log('Reel Together: http://localhost:9500\nLocal data stays in .local/diary.sqlite.');
console.log(google ? 'Local Google simulation is enabled. It uses no hosted accounts.' : 'Sign in with Google. Set GOOGLE_CLIENT_ID in .env.local, or use npm run dev -- --demo for local test accounts.');
async function stop() {await server.close(); binding.close(); process.exit(0);}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
