import {build as viteBuild} from 'vite';
import {build as workerBuild} from 'esbuild';
import {mkdir, copyFile, writeFile} from 'node:fs/promises';

await viteBuild();
await mkdir('dist/functions/api', {recursive: true});
// The file router sends only /api/* to the worker; static frontend files retain
// the platform's normal serving path. Bundle server code, never its source files.
await workerBuild({entryPoints: ['server/worker.js'], outfile: 'dist/functions/_worker.js', bundle: true, format: 'esm', platform: 'browser', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'], target: 'es2024', minify: true});
// Spacefast discovers literal method/default declarations before bundling.
await writeFile('dist/functions/api/[...rest].js', "import worker from '../_worker.js';\nexport default function handler(request, context) {return worker.fetch(request, context.env);}\n");
await copyFile('sf.jsonc', 'dist/sf.jsonc');
