import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createApp, localDatabase, serve} from './local-server.mjs';
import {passwordHash} from '../server/auth.js';
import {hash} from '../server/domain.js';

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error('Build failed')) : resolve());
});
await mkdir('.local', {recursive: true});
const {db, binding} = await localDatabase('.local/diary.sqlite');
for (const [name, address, admin] of [['Owner', 'owner@example.test', true], ['Movie lover', 'moviebuff@example.test', false], ['Family', 'family@example.test', false]]) {
  const key = hash(address);
  if (!(await db.doc(`accountEmails/${key}`).get()).exists) {
    await db.doc(`accounts/${key}`).set({id: key, email: address, name, verified: true, admin, password: await passwordHash('movie-night-2026'), sessionVersion: 'local'});
    await db.doc(`accountEmails/${key}`).set({uid: key});
    await db.doc(`users/${key}`).set({name, email: address, approved: true, complimentary: false, household_id: '', membership_epoch: key, created_at: Date.now()});
  }
}
const server = await serve(createApp({db, secrets: {local: true, origin: 'http://127.0.0.1:9500'}}), {port: 9500});
console.log(`Reel Together: ${server.base}\nLocal accounts: owner@example.test, moviebuff@example.test, family@example.test\nLocal password: movie-night-2026`);
async function stop() {await server.close(); binding.close(); process.exit(0);}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
