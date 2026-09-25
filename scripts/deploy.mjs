import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {packageApp} from './package.mjs';
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {stdio: 'inherit'});
  child.on('error', reject); child.on('exit', code => code ? reject(new Error(`Command exited ${code}`)) : resolve());
});
const sf = (args, body) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/spacefast/dist/cli.js', ...args, '--api-url', 'https://api.spacefast.com', '--json'], {stdio: ['pipe', 'pipe', 'inherit']});
  let output = ''; child.stdout.on('data', chunk => {output += chunk;});
  child.on('error', reject);
  child.on('exit', code => {
    if (code) {
      let reason = ''; try {const problem = JSON.parse(output); reason = problem.code || problem.error?.code || '';} catch {}
      reject(new Error(`Spacefast ${args[0]} failed (${code}, ${reason}); check the dashboard before retrying.`)); return;
    }
    try {resolve(JSON.parse(output));} catch {reject(new Error('Spacefast returned an invalid receipt.'));}
  });
  child.stdin.end(body ? JSON.stringify(body) : undefined);
});
const state = JSON.parse(await readFile('.spacefast/space.json', 'utf8'));
if (!state.space) throw new Error('Link the existing Space first; deployment never creates a replacement automatically.');
const linked = (await sf(['spaces', 'get', '--space', state.space, ...(state.team ? ['--team', state.team] : [])])).data.space;
if (!linked?.id?.startsWith('spc_')) throw new Error('The linked Space did not resolve to a stable ID.');
const spaceId = linked.id;
await run(['scripts/build.mjs']);
const archive = await packageApp();
const settingsPath = `/v1/spaces/${spaceId}/users/settings`;
const before = (await sf(['api', 'GET', settingsPath])).data;
// Authentication belongs to this app. Keep native Users disabled while retaining
// its saved provider settings, so a rollback can be configured without new secrets.
const desiredSettings = {...before.settings, enabled: false};
const receipt = await sf(['publish', archive, '--prebuilt', '--space', spaceId, '--wait', ...process.argv.slice(2).filter(arg => arg !== '--json')]);
const after = (await sf(['api', 'GET', settingsPath])).data;
if (JSON.stringify(desiredSettings) !== JSON.stringify(after.settings)) {
  // CLI 0.4.1 predates Users and drops this newer configuration on publish.
  // Restore only its known default reset, while our version is still live.
  // The settings digest also rejects a concurrent dashboard edit during restore.
  const detail = (await sf(['versions', 'get', receipt.data.versionId, '--space', spaceId])).data;
  const reset = !after.settings.enabled && after.settings.providers.google.mode === 'managed' && after.settings.providers.gravatar.enabled && after.settings.providers.spacefast.enabled;
  const unchanged = JSON.stringify(before.settings) === JSON.stringify(after.settings);
  if ((!reset && !unchanged) || detail.space.channels.live.versionId !== receipt.data.versionId) throw new Error('Users settings changed concurrently. Review the dashboard before publishing again.');
  await sf(['api', 'PATCH', settingsPath, '--input', '-'], {settings: desiredSettings, baseSettingsDigest: after.settingsDigest});
  // Restoring settings creates a config version with this same worker bundle.
  const final = (await sf(['runtime', 'status', '--space', spaceId])).data;
  receipt.data.publishedVersionId = receipt.data.versionId;
  receipt.data.liveVersionId = final.liveVersionId;
  receipt.data.nativeUsersDisabled = true;
}
console.log(JSON.stringify(receipt, null, 2));
