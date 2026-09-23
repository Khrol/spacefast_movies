import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createApp, localDatabase, serve} from './local-server.mjs';
import {readSecrets} from '../server/worker.js';

try {process.loadEnvFile('.env.local');} catch (error) {if (error.code !== 'ENOENT') throw error;}
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error('Build failed')) : resolve());
});
await mkdir('.local', {recursive: true});
const {binding, db} = await localDatabase('.local/diary.sqlite');
const server = await serve(createApp({db, secrets: {...readSecrets(process.env), local: true, origin: 'http://localhost:9500'}}), {port: 9500});
console.log('Reel Together: http://localhost:9500\nSign in with Google. Local data stays in .local/diary.sqlite.');
if (!process.env.GOOGLE_CLIENT_ID) console.log('Set GOOGLE_CLIENT_ID in .env.local to enable sign-in; see README.md.');
async function stop() {await server.close(); binding.close(); process.exit(0);}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
