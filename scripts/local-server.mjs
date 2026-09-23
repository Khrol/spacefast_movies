import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {Database} from '../server/database.js';
import {createApp} from '../server/app.js';

export function sqliteBinding(filename = ':memory:') {
  const sql = new DatabaseSync(filename);
  return {
    close: () => sql.close(),
    prepare(query) {
      let values = [];
      const statement = {
        bind(...params) {values = params; return statement;},
        async all() {return {results: sql.prepare(query).all(...values)};},
        async run() {const result = sql.prepare(query).run(...values); return {success: true, meta: {changes: Number(result.changes)}};},
      };
      return statement;
    },
  };
}
export async function localDatabase(filename) {
  const binding = sqliteBinding(filename), db = new Database(binding, 'local-reel-together');
  await db.initialize();
  return {db, binding};
}
export function serve(app, {port = 0, staticRoot = resolve('dist')} = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (!url.pathname.startsWith('/api/')) {
        const requested = resolve(staticRoot, '.' + decodeURIComponent(url.pathname));
        if (requested !== staticRoot && !requested.startsWith(staticRoot + sep)) {res.writeHead(403).end(); return;}
        const path = url.pathname === '/' ? resolve(staticRoot, 'index.html') : requested;
        try {
          const content = await readFile(path);
          res.setHeader('Content-Type', {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'}[extname(path)] || 'application/octet-stream');
          res.end(content);
        } catch {res.writeHead(404).end('Not found');}
        return;
      }
      const request = new Request(url, {method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : {body: Readable.toWeb(req), duplex: 'half'})});
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500).end('Local server failed');}
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done))}));
  });
}
export {createApp};
