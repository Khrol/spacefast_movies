import {mkdir, access, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function localEnvironment() {
  const config = path.join(root, '.local/config');
  const cache = path.join(root, '.local/cache');
  await Promise.all([mkdir(config, {recursive: true}), mkdir(cache, {recursive: true})]);
  const env = {...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, FIREBASE_EMULATORS_PATH: path.join(cache, 'emulators'), FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true', CI: 'true'};
  if (process.platform === 'darwin') {
    try { const java = execFileSync('/usr/libexec/java_home', ['-v', '21+'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); env.JAVA_HOME = java; env.PATH = `${java}/bin:${env.PATH}`; } catch { /* The CLI will explain if Java is missing. */ }
  }
  const secrets = path.join(root, 'functions/.secret.local');
  try { await access(secrets); } catch { await writeFile(secrets, 'APP_SECRETS={"origin":"http://127.0.0.1:9500"}\n', {mode: 0o600}); }
  return env;
}
