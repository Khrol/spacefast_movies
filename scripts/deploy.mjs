import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {packageApp} from './package.mjs';
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Command exited ${code}`)) : resolve());
});
const state = JSON.parse(await readFile('.spacefast/space.json', 'utf8'));
if (!state.space) throw new Error('Link the existing Space first; deployment never creates a replacement automatically.');
await run(['scripts/build.mjs']);
const archive = await packageApp();
await run(['node_modules/spacefast/dist/cli.js', 'publish', archive, '--prebuilt', '--space', state.space, '--api-url', 'https://api.spacefast.com', '--wait', ...process.argv.slice(2)]);
