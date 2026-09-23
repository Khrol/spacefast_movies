import {Hono} from 'hono';
import {Auth, createMailer} from './auth.js';
import {AppError, fail, hash, text, email, bool, choice, id} from './domain.js';
import {Catalog} from './catalog.js';
import {DiaryStore, row} from './store.js';
import {Billing} from './billing.js';

export function createApp({db, secrets = {}, catalog = new Catalog(db, secrets), billing = new Billing(db, secrets), mailer = createMailer(secrets)}) {
  const app = new Hono(), router = new Hono(), store = new DiaryStore(db, catalog), auth = new Auth(db, secrets, mailer);
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('X-Content-Type-Options', 'nosniff');
    c.set('ip', c.req.header('CF-Connecting-IP') || 'unknown');
    const webhook = c.req.path.startsWith('/api/billing/webhook/');
    if (!['GET', 'HEAD'].includes(c.req.method) && !webhook) {
      const origin = c.req.header('Origin');
      const expected = secrets.origin || new URL(c.req.url).origin;
      if (origin !== expected || c.req.header('Sec-Fetch-Site') === 'cross-site') fail('This request did not come from your diary.', 403);
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) fail('Send a JSON object.', 415);
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).length > (webhook ? 512 * 1024 : 32 * 1024)) fail('Request too large.', 413);
      if (!webhook) {
        let parsed; try { parsed = raw === '' && c.req.method === 'DELETE' ? {} : JSON.parse(raw); } catch { fail('Send valid JSON.'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Send a JSON object.');
        c.set('body', parsed);
      }
    }
    await next();
  });
  auth.routes(router);
  router.post('/billing/webhook/:mode', async c => c.json(await billing.webhook(choice(c.req.param('mode'), ['test', 'live']), await c.req.text(), c.req.header('Stripe-Signature'))));
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
  routes.get('/config', async (_req, res) => {
    const settings = await store.settings();
    res.json({public_registration: settings.publicRegistration === true, billing_enabled: settings.billingEnabled === true});
  });
  routes.post('/invitations', async (req, res) => {
    await limit(`invitation:${req.ip}`, 5, 3600);
    if (req.body?.website) return res.json({received: true});
    const name = text(req.body?.name, 100, true), address = email(req.body?.email);
    await db.runTransaction(async tx => {
      const ref = db.doc(`invitations/${hash(address)}`);
      const old = await tx.get(ref);
      if (!old.exists) tx.create(ref, {name, email: address, status: 'pending', created_at: Date.now(), updated_at: Date.now()});
    });
    res.json({received: true});
  });
  router.use('*', async (c, next) => {
    const account = await auth.require(c);
    if (!account.verified) fail('Verify your email address before opening your diary.', 403);
    c.set('user', await store.profile({uid: account.id, email: account.email, name: account.name, email_verified: account.verified, admin: account.admin}));
    await next();
  });
  routes.get('/session', (req, res) => {
    const u = req.user; res.json({id: u.id, name: u.name, email: u.email, approved: u.approved, admin: u.admin});
  });
  router.use('*', async (c, next) => { await limit(`api:${c.get('user').id}`, 240, 60); await next(); });
  routes.get('/membership', async (req, res) => res.json(await billing.status(req.user)));
  routes.post('/billing/checkout', async (req, res) => res.json(await billing.checkout(req.user, req.body?.mode || 'live')));
  routes.post('/billing/portal', async (req, res) => res.json(await billing.portal(req.user, req.body?.mode || 'live')));
  routes.post('/billing/return', async (req, res) => res.json(await billing.returned(req.user, req.body?.mode || 'live', req.body?.session_id)));
  const adminRouter = new Hono(), admin = adapter(adminRouter);
  adminRouter.use('*', async (c, next) => { if (!c.get('user').admin) fail('Only the site administrator can do this.', 403); await next(); });
  admin.get('/overview', async (_req, res) => {
    const settings = await store.settings();
    res.json({settings: {public_registration: settings.publicRegistration === true, billing_enabled: settings.billingEnabled === true}, catalog_providers: catalog.providers(), billing: await billing.summary()});
  });
  admin.get('/users', async (req, res) => {
    let query = db.collection('users').orderBy('__name__').limit(50);
    if (req.query.after) query = query.startAfter(id(req.query.after));
    const result = await query.get();
    res.json({items: result.docs.map(s => { const u = row(s); return {id: u.id, name: u.name, email: u.email, approved: u.approved, complimentary: u.complimentary}; }), next: result.size === 50 ? result.docs.at(-1).id : null});
  });
  admin.put('/users/:id', async (req, res) => {
    const ref = db.doc(`users/${id(req.params.id)}`), update = {};
    if ('approved' in req.body) update.approved = bool(req.body.approved);
    if ('complimentary' in req.body) update.complimentary = bool(req.body.complimentary);
    if (!Object.keys(update).length) fail('Choose an account setting to update.');
    if (!(await ref.get()).exists) fail('Account not found.', 404);
    await ref.update(update); res.json({updated: true});
  });
  admin.get('/invitations', async (req, res) => {
    let query = db.collection('invitations').orderBy('__name__').limit(50);
    if (req.query.after) query = query.startAfter(id(req.query.after));
    const result = await query.get(); res.json({items: result.docs.map(row), next: result.size === 50 ? result.docs.at(-1).id : null});
  });
  admin.put('/invitations/:id', async (req, res) => {
    const status = choice(req.body.status, ['pending', 'handled', 'declined']);
    await db.doc(`invitations/${id(req.params.id)}`).update({status, updated_at: Date.now()}); res.json({updated: true});
  });
  admin.delete('/invitations/:id', async (req, res) => { await db.doc(`invitations/${id(req.params.id)}`).delete(); res.json({deleted: true}); });
  admin.post('/approve-email', async (req, res) => {
    const address = email(req.body.email), batch = db.batch();
    batch.set(db.doc(`approvedEmails/${hash(address)}`), {approved_at: Date.now()});
    const users = await db.collection('users').where('email', '==', address).get();
    for (const user of users.docs) batch.update(user.ref, {approved: true});
    await batch.commit(); res.json({approved: true});
  });
  admin.put('/settings', async (req, res) => { await db.doc('settings/app').set({publicRegistration: bool(req.body.public_registration)}, {merge: true}); res.json({updated: true}); });
  admin.post('/billing/setup', async (req, res) => res.json(await billing.setup(req.body.mode)));
  admin.post('/billing/enable', async (req, res) => res.json(await billing.enable(req.body.enabled)));
  router.route('/admin', adminRouter);
  router.use('*', async (c, next) => { if (!c.get('user').approved && !c.get('user').admin) fail('Your account is waiting for the site owner’s approval.', 403); await next(); });
  router.use('*', async (c, next) => { if (!(await billing.status(c.get('user'))).access) fail('An active membership is required. Open Membership to subscribe or manage billing.', 402); await next(); });
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
