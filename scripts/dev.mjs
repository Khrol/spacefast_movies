import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createApp, localDatabase, serve} from './local-server.mjs';
import {readSecrets} from '../server/worker.js';
import {localIdentity} from './local-identity.mjs';

try {process.loadEnvFile('.env.local');} catch (error) {if (error.code !== 'ENOENT') throw error;}
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error('Build failed')) : resolve());
});
await mkdir('.local', {recursive: true});
const {binding, db} = await localDatabase('.local/diary.sqlite');
const identity = process.argv.includes('--demo') ? localIdentity(process.env.OWNER_EMAIL) : null;
const secrets = {...readSecrets(process.env), local: true, localIdentity: !!identity, origin: 'http://localhost:9500'};
const unavailable = async () => Response.json({data: {providers: []}});
const server = await serve(createApp({db, secrets, identityFetch: identity?.transport || unavailable}), {port: 9500, handleIdentity: identity?.handle});
console.log('Reel Together: http://localhost:9500\nLocal data stays in .local/diary.sqlite.');
console.log(identity ? 'Local identity simulation is enabled. It uses no hosted accounts.' : 'Spacefast Users runs on the hosted Space. For isolated test accounts, use npm run dev -- --demo.');
async function stop() {await server.close(); binding.close(); process.exit(0);}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
