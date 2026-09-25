import {Hono} from 'hono';
import {Auth} from './auth.js';
import {AppError, fail, hash, id} from './domain.js';
import {Catalog} from './catalog.js';
import {DiaryStore, row} from './store.js';

export function createApp({db, secrets = {}, catalog = new Catalog(db, secrets), googleKeys}) {
  const app = new Hono(), router = new Hono(), store = new DiaryStore(db, catalog), auth = new Auth(db, secrets, googleKeys);
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('X-Content-Type-Options', 'nosniff');
    c.set('ip', c.req.header('CF-Connecting-IP') || 'unknown');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = c.req.header('Origin');
      const expected = secrets.origin || new URL(c.req.url).origin;
      if (origin !== expected || c.req.header('Sec-Fetch-Site') === 'cross-site') fail('This request did not come from your diary.', 403);
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) fail('Send a JSON object.', 415);
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).length > 32 * 1024) fail('Request too large.', 413);
      let parsed; try { parsed = raw === '' && c.req.method === 'DELETE' ? {} : JSON.parse(raw); } catch { fail('Send valid JSON.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Send a JSON object.');
      c.set('body', parsed);
    }
    await next();
  });
  auth.routes(router);
  const routes = adapter(router);
  const limit = async (key, count, seconds) => {
    const now = Date.now(), bucket = Math.floor(now / (seconds * 1000));
    const ref = db.doc(`rateLimits/${hash(`${key}:${bucket}`)}`);
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data()?.count || 0;
      if (current >= count) fail('Too many requests. Please try again later.', 429);
      tx.set(ref, {count: current + 1, expiresAt: new Date((bucket + 2) * seconds * 1000)});
    });
  };
  routes.get('/health', (_req, res) => res.json({ok: true}));
  routes.get('/config', (_req, res) => res.json({...auth.config(), ...(secrets.localGoogle ? {local_google: true} : {})}));
  router.all('/billing/*', c => c.json({message: 'Not found.'}, 404));
  router.all('/membership', c => c.json({message: 'Not found.'}, 404));
  router.all('/invitations', c => c.json({message: 'Not found.'}, 404));
  router.use('*', async (c, next) => {
    const account = await auth.require(c);
    c.set('user', await store.profile({uid: account.id, email: account.email, name: account.name, admin: account.admin}));
    await next();
  });
  routes.get('/session', (req, res) => {
    const u = req.user; res.json({id: u.id, name: u.name, email: u.email, admin: u.admin});
  });
  router.use('*', async (c, next) => { await limit(`api:${c.get('user').id}`, 240, 60); await next(); });
  const adminRouter = new Hono(), admin = adapter(adminRouter);
  adminRouter.use('*', async (c, next) => { if (!c.get('user').admin) fail('Only the site administrator can do this.', 403); await next(); });
  admin.get('/overview', async (_req, res) => res.json({catalog_providers: catalog.providers()}));
  admin.get('/users', async (req, res) => {
    let query = db.collection('users').orderBy('__name__').limit(50);
    if (req.query.after) query = query.startAfter(id(req.query.after));
    const result = await query.get();
    res.json({items: result.docs.map(s => { const u = row(s); return {id: u.id, name: u.name, email: u.email}; }), next: result.size === 50 ? result.docs.at(-1).id : null});
  });
  router.route('/admin', adminRouter);
  routes.get('/bootstrap', async (req, res) => res.json(await store.bootstrap(req.user.id)));
  routes.get('/entries', async (req, res) => res.json(await store.entries(req.user.id, req.query)));
  routes.post('/entries', async (req, res) => res.status(201).json(await store.saveEntry(req.user.id, req.body)));
  routes.put('/entries/:id', async (req, res) => res.json(await store.saveEntry(req.user.id, req.body, req.params.id)));
  routes.delete('/entries/:id', async (req, res) => res.json(await store.deleteEntry(req.user.id, req.params.id)));
  routes.post('/companions', async (req, res) => res.status(201).json(await store.saveCompanion(req.user.id, req.body)));
  routes.put('/companions/:id', async (req, res) => res.json(await store.saveCompanion(req.user.id, req.body, req.params.id)));
  routes.post('/household', async (req, res) => res.status(201).json(await store.createHousehold(req.user.id, req.body)));
  routes.post('/household/join', async (req, res) => { await limit(`join:${req.user.id}`, 10, 300); res.json(await store.join(req.user.id, req.body)); });
  routes.post('/household/invite', async (req, res) => res.json(await store.invite(req.user.id)));
  routes.delete('/household/membership', async (req, res) => res.json(await store.leave(req.user.id)));
  routes.delete('/household/members/:id', async (req, res) => res.json(await store.leave(req.user.id, id(req.params.id))));
  routes.get('/search', async (req, res) => { await limit(`catalog:${req.user.id}`, 30, 60); res.json(await catalog.search(req.query.q, req.query.provider)); });
  routes.get('/lookup', async (req, res) => { await limit(`catalog:${req.user.id}`, 30, 60); res.json(await catalog.lookup(req.query.id, req.query.provider)); });
  app.route('/api', router);
  app.notFound(c => c.json({message: 'Not found.'}, 404));
  app.onError((error, c) => {
    c.header('Cache-Control', 'private, no-store');
    if (error instanceof AppError) return c.json({message: error.message}, error.status);
    console.error('API request failed:', error.name, error.code || 'internal');
    return c.json({message: 'The server could not complete this request. Please try again.'}, 500);
  });
  return app;
}

// Keep the original domain route contracts while adapting Web requests/responses.
function adapter(router) {
  return Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => router[method](path, async c => {
    const req = {user: c.get('user'), ip: c.get('ip'), body: c.get('body'), query: c.req.query(), params: c.req.param()};
    let status = 200, result;
    const res = {status(value) {status = value; return res;}, json(value) {result = c.json(value, status); return result;}};
    await handler(req, res);
    return result;
  })]));
}
