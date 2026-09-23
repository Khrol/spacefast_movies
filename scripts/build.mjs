import {build as viteBuild} from 'vite';
import {build as workerBuild} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';

await viteBuild();
await mkdir('dist/functions/api', {recursive: true});
// The file router sends only /api/* to the worker; static frontend files retain
// the platform's normal serving path. Bundle server code, never its source files.
await workerBuild({entryPoints: ['server/worker.js'], outfile: 'dist/functions/_worker.js', bundle: true, format: 'esm', platform: 'browser', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'], target: 'es2024', minify: true});
// Spacefast discovers literal method/default declarations before bundling.
await writeFile('dist/functions/api/[...rest].js', "import worker from '../_worker.js';\nexport default function handler(request, context) {return worker.fetch(request, context.env);}\n");
const config = JSON.parse(await readFile('sf.jsonc', 'utf8'));
// File-router discovery compiles the Functions entry. Keep runtime declarations
// out of the compiled archive so a prebuilt publish does not try to recompile it.
// package.mjs carries the capabilities in the typed Functions artifact metadata.
delete config.runtime;
await writeFile('dist/sf.jsonc', JSON.stringify(config, null, 2) + '\n');
await writeFile('dist/_headers', '/*\n  Cross-Origin-Opener-Policy: same-origin-allow-popups\n  Referrer-Policy: strict-origin-when-cross-origin\n');
