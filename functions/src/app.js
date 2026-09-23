import express from 'express';
import {AppError, fail, hash, text, email, bool, choice, id} from './domain.js';
import {Catalog} from './catalog.js';
import {DiaryStore, row} from './store.js';
import {Billing} from './billing.js';

export function createApp({db, auth, secrets = {}, catalog = new Catalog(db, secrets), billing = new Billing(db, secrets)}) {
  const app = express(), router = express.Router(), store = new DiaryStore(db, catalog);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => { res.set({'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff'}); next(); });
  router.post('/billing/webhook/:mode', express.raw({type: 'application/json', limit: '512kb'}), async (req, res) => {
    res.json(await billing.webhook(choice(req.params.mode, ['test', 'live']), req.rawBody || req.body, req.get('Stripe-Signature')));
  });
  router.use(express.json({limit: '32kb'}));
  router.use((req, _res, next) => {
    if (['POST', 'PUT'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) fail('Send a JSON object.');
    next();
  });
  const limit = async (key, count, seconds) => {
    const now = Date.now(), bucket = Math.floor(now / (seconds * 1000));
    const ref = db.doc(`rateLimits/${hash(`${key}:${bucket}`)}`);
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data()?.count || 0;
      if (current >= count) fail('Too many requests. Please try again later.', 429);
      tx.set(ref, {count: current + 1, expiresAt: new Date((bucket + 2) * seconds * 1000)});
    });
  };
  router.get('/health', (_req, res) => res.json({ok: true}));
  router.get('/config', async (_req, res) => {
    const settings = await store.settings();
    res.json({public_registration: settings.publicRegistration === true, billing_enabled: settings.billingEnabled === true});
  });
  router.post('/invitations', async (req, res) => {
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
  router.use(async (req, _res, next) => {
    const match = req.get('Authorization')?.match(/^Bearer (.+)$/);
    if (!match) fail('Please sign in to use your diary.', 401);
    let token;
    try { token = await auth.verifyIdToken(match[1], true); } catch { fail('Your session expired. Please sign in again.', 401); }
    if (!token.email_verified) fail('Verify your email address before opening your diary.', 403);
    req.user = await store.profile(token);
    next();
  });
  router.get('/session', (req, res) => {
    const u = req.user; res.json({id: u.id, name: u.name, email: u.email, approved: u.approved, admin: u.admin});
  });
  router.use(async (req, _res, next) => { await limit(`api:${req.user.id}`, 240, 60); next(); });
  router.get('/membership', async (req, res) => res.json(await billing.status(req.user)));
  router.post('/billing/checkout', async (req, res) => res.json(await billing.checkout(req.user, req.body?.mode || 'live')));
  router.post('/billing/portal', async (req, res) => res.json(await billing.portal(req.user, req.body?.mode || 'live')));
  router.post('/billing/return', async (req, res) => res.json(await billing.returned(req.user, req.body?.mode || 'live', req.body?.session_id)));
  const admin = express.Router();
  admin.use((req, _res, next) => { if (!req.user.admin) fail('Only the site administrator can do this.', 403); next(); });
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
  router.use('/admin', admin);
  router.use((req, _res, next) => { if (!req.user.approved && !req.user.admin) fail('Your account is waiting for the site owner’s approval.', 403); next(); });
  router.use(async (req, _res, next) => { if (!(await billing.status(req.user)).access) fail('An active membership is required. Open Membership to subscribe or manage billing.', 402); next(); });
  router.get('/bootstrap', async (req, res) => res.json(await store.bootstrap(req.user.id)));
  router.get('/entries', async (req, res) => res.json(await store.entries(req.user.id, req.query)));
  router.post('/entries', async (req, res) => res.status(201).json(await store.saveEntry(req.user.id, req.body)));
  router.put('/entries/:id', async (req, res) => res.json(await store.saveEntry(req.user.id, req.body, req.params.id)));
  router.delete('/entries/:id', async (req, res) => res.json(await store.deleteEntry(req.user.id, req.params.id)));
  router.post('/companions', async (req, res) => res.status(201).json(await store.saveCompanion(req.user.id, req.body)));
  router.put('/companions/:id', async (req, res) => res.json(await store.saveCompanion(req.user.id, req.body, req.params.id)));
  router.post('/household', async (req, res) => res.status(201).json(await store.createHousehold(req.user.id, req.body)));
  router.post('/household/join', async (req, res) => { await limit(`join:${req.user.id}`, 10, 300); res.json(await store.join(req.user.id, req.body)); });
  router.post('/household/invite', async (req, res) => res.json(await store.invite(req.user.id)));
  router.delete('/household/membership', async (req, res) => res.json(await store.leave(req.user.id)));
  router.delete('/household/members/:id', async (req, res) => res.json(await store.leave(req.user.id, id(req.params.id))));
  router.get('/search', async (req, res) => { await limit(`catalog:${req.user.id}`, 30, 60); res.json(await catalog.search(req.query.q, req.query.provider)); });
  router.get('/lookup', async (req, res) => { await limit(`catalog:${req.user.id}`, 30, 60); res.json(await catalog.lookup(req.query.id, req.query.provider)); });
  app.use('/api', router);
  app.use((_req, _res) => fail('Not found.', 404));
  app.use((error, _req, res, _next) => {
    if (error instanceof AppError) return res.status(error.status).json({message: error.message});
    if (error.type === 'entity.parse.failed') return res.status(400).json({message: 'Send valid JSON.'});
    if (error.type === 'entity.too.large') return res.status(413).json({message: 'Request too large.'});
    // Log a classification only: provider errors can embed keys or private data.
    console.error('API request failed:', error.name, error.code || 'internal');
    res.status(500).json({message: 'The server could not complete this request. Please try again.'});
  });
  return app;
}
