import Stripe from 'stripe';
import {AppError, fail, choice, newId, id, hash} from './domain.js';

export const STRIPE_VERSION = '2025-03-31.basil';
export const BILLING_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
export function subscriptionStatus(subscription, config, uid) {
  const item = subscription.items?.data?.[0], price = item?.price, invoice = subscription.latest_invoice;
  const identity = subscription.metadata?.reel_uid === uid;
  const valid = identity && subscription.livemode === (config.mode === 'live') && subscription.status === 'active' && !subscription.pause_collection && subscription.items.data.length === 1 && item.quantity === 1 && price?.id === config.price && price.unit_amount === 100 && price.currency === 'eur' && price.recurring?.interval === 'month' && price.recurring.interval_count === 1 && invoice && typeof invoice === 'object' && invoice.status === 'paid' && invoice.amount_paid >= 100 && item.current_period_end > Date.now() / 1000;
  return valid ? {state: subscription.cancel_at_period_end ? 'ending' : 'active', paid_until: item.current_period_end} : {state: subscription.status === 'past_due' ? 'past_due' : 'inactive', paid_until: 0};
}
export class Billing {
  constructor(db, secrets, factory = key => new Stripe(key, {apiVersion: STRIPE_VERSION, maxNetworkRetries: 2, timeout: 15000, httpClient: Stripe.createFetchHttpClient()})) { this.db = db; this.secrets = secrets; this.factory = factory; }
  accountRef(uid, mode) { return this.db.doc(`billingAccounts/${choice(mode, ['test', 'live'])}_${id(uid)}`); }
  async config(mode) { return {...(await this.db.doc(`billingConfig/${choice(mode, ['test', 'live'])}`).get()).data(), mode}; }
  client(mode) {
    const key = this.secrets.stripe?.[mode]?.secretKey;
    if (!key || !key.startsWith(`sk_${mode}_`)) fail(`Stripe ${mode} mode is not connected.`, 503);
    return this.factory(key);
  }
  origin() {
    const origin = this.secrets.origin;
    let parsed; try { parsed = new URL(origin); } catch { fail('The site owner must configure the public site URL.', 503); }
    const local = this.secrets.local === true && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if ((!local && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('Configure a valid HTTPS site origin.', 503);
    return parsed.origin;
  }
  async setup(mode) {
    choice(mode, ['test', 'live']);
    const stripe = this.client(mode), account = await stripe.accounts.retrieve();
    if (mode === 'live' && !account.charges_enabled) fail('Stripe must enable live charges before connecting live billing.');
    const old = await this.config(mode), origin = this.origin();
    if (old.account && old.account !== account.id && !(await this.db.collection('billingAccounts').where('account', '==', old.account).limit(1).get()).empty) fail('Existing customer accounts use the previous Stripe account. Keep that connection to preserve their billing access.');
    if (old.account === account.id && old.origin === origin && old.price && old.webhook_secret) {
      await stripe.prices.retrieve(old.price); await stripe.webhookEndpoints.retrieve(old.webhook_id);
      return {ready: true, mode, account: account.id};
    }
    const prefix = hash(`${this.db.projectId}:${account.id}:${mode}:${origin}`).slice(0, 32);
    let price;
    if (old.account === account.id && old.price) {
      price = await stripe.prices.retrieve(old.price);
      if (price.unit_amount !== 100 || price.currency !== 'eur' || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) fail('The configured Stripe price is not the expected €1 monthly plan.');
    } else {
      const product = await stripe.products.create({name: 'Reel Together membership'}, {idempotencyKey: `${prefix}-product`});
      price = await stripe.prices.create({product: product.id, unit_amount: 100, currency: 'eur', recurring: {interval: 'month'}, tax_behavior: 'inclusive'}, {idempotencyKey: `${prefix}-price`});
    }
    const portal = old.account === account.id && old.portal ? {id: old.portal} : await stripe.billingPortal.configurations.create({business_profile: {headline: 'Reel Together membership'}, features: {customer_update: {enabled: true, allowed_updates: ['email', 'address']}, invoice_history: {enabled: true}, payment_method_update: {enabled: true}, subscription_cancel: {enabled: true, mode: 'at_period_end'}}}, {idempotencyKey: `${prefix}-portal`});
    const webhook = await stripe.webhookEndpoints.create({url: `${origin}/api/billing/webhook/${mode}`, enabled_events: BILLING_EVENTS, api_version: STRIPE_VERSION}, {idempotencyKey: `${prefix}-webhook`});
    if (!webhook.secret) fail('Stripe did not return a webhook signing secret. Configure a new webhook before continuing.', 503);
    await this.db.doc(`billingConfig/${mode}`).set({account: account.id, origin, price: price.id, portal: portal.id, webhook_id: webhook.id, webhook_secret: webhook.secret, checkout_proof: '', webhook_proof: ''});
    return {ready: true, mode, account: account.id};
  }
  async withLock(uid, mode, action) {
    const ref = this.accountRef(uid, mode), token = newId();
    const row = await this.db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data() ?? {};
      if (data.lock_until > Date.now()) fail('Billing is being refreshed. Please try again in a moment.', 409);
      tx.set(ref, {lock_token: token, lock_until: Date.now() + 180000}, {merge: true});
      const {lock_token: _token, lock_until: _until, ...account} = data;
      return account;
    });
    try { return await action(row, ref); }
    finally {
      await this.db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.lock_token === token) tx.update(ref, {lock_token: '', lock_until: 0});
      });
    }
  }
  async reconcile(uid, mode, row, ref) {
    const config = await this.config(mode);
    if (!config.account || !config.price) fail('Stripe is not prepared yet.', 503);
    if (!row.customer_id) return {...row, state: 'inactive', paid_until: 0, checked_at: Date.now(), has_subscription: false};
    if (row.account !== config.account) fail('The Stripe account changed. Ask the site owner to review your membership.', 503);
    let list;
    try { list = await this.client(mode).subscriptions.list({customer: row.customer_id, status: 'all', limit: 100, expand: ['data.latest_invoice']}); }
    catch { await ref.set({state: 'unavailable', paid_until: 0, checked_at: 0}, {merge: true}); fail('Stripe is temporarily unavailable. Please try again.', 503); }
    const current = list.data.filter(s => !['canceled', 'incomplete_expired'].includes(s.status));
    let state = {state: 'inactive', paid_until: 0};
    if (!list.has_more && current.length === 1) state = subscriptionStatus(current[0], config, uid);
    const updated = {...row, ...state, has_subscription: list.has_more || current.length > 0, checked_at: Date.now()};
    await ref.set(updated, {merge: true});
    return updated;
  }
  async status(user, force = false) {
    const enabled = (await this.db.doc('settings/app').get()).data()?.billingEnabled === true;
    let row = (await this.accountRef(user.id, 'live').get()).data() || {};
    let state = !enabled ? 'disabled' : user.admin ? 'administrator' : user.complimentary ? 'complimentary' : null;
    if (!state) {
      if (row.customer_id && (force || !row.checked_at || Date.now() - row.checked_at > 300000 || row.paid_until <= Date.now() / 1000)) row = await this.withLock(user.id, 'live', (current, ref) => this.reconcile(user.id, 'live', current, ref));
      state = row.paid_until > Date.now() / 1000 && ['active', 'ending'].includes(row.state) ? row.state : row.state === 'past_due' ? 'past_due' : 'inactive';
    }
    const access = ['disabled', 'administrator', 'complimentary', 'active', 'ending'].includes(state);
    return {enabled, access, state, paid_until: row.paid_until || 0, can_manage: !!row.customer_id, can_subscribe: enabled && user.approved && !access && !row.has_subscription};
  }
  async checkout(user, mode = 'live') {
    if (!user.approved && !user.admin) fail('Your account needs owner approval before subscribing.', 403);
    choice(mode, ['test', 'live']);
    if (mode === 'test' && !user.admin) fail('Only an administrator can run test checkout.', 403);
    const config = await this.config(mode), stripe = this.client(mode);
    if (!config.price || !config.account || !config.portal) fail('Stripe is not prepared yet.', 503);
    if (mode === 'live') {
      const status = await this.status(user);
      if (!status.enabled || user.complimentary || user.admin) fail('This account does not need a subscription.', 409);
    }
    return this.withLock(user.id, mode, async (row, ref) => {
      row = await this.reconcile(user.id, mode, row, ref);
      if (row.has_subscription) fail('You already have a subscription. Use Manage billing.', 409);
      if (!row.customer_id) {
        const customer = await stripe.customers.create({email: user.email, name: user.name, metadata: {reel_uid: user.id}}, {idempotencyKey: hash(`${this.db.projectId}:${config.account}:${mode}:${user.id}:customer`)});
        row = {...row, customer_id: customer.id, account: config.account};
        // Persist identity before exposing a payable checkout URL.
        const batch = this.db.batch();
        batch.set(ref, row, {merge: true});
        batch.set(this.db.doc(`billingCustomers/${mode}_${customer.id}`), {uid: user.id, account: config.account});
        await batch.commit();
      }
      if (row.checkout_id) {
        const existing = await stripe.checkout.sessions.retrieve(row.checkout_id);
        if (existing.status === 'open' && existing.url) return {url: existing.url};
      }
      // Persist the idempotency key before the external call so a lost response
      // cannot produce a second payable session on retry.
      const key = row.checkout_pending_key || newId();
      await ref.set({checkout_pending_key: key}, {merge: true});
      const origin = this.origin();
      const session = await stripe.checkout.sessions.create({mode: 'subscription', customer: row.customer_id, client_reference_id: user.id, line_items: [{price: config.price, quantity: 1}], subscription_data: {metadata: {reel_uid: user.id}}, success_url: `${origin}/?checkout_session={CHECKOUT_SESSION_ID}&billing_mode=${mode}`, cancel_url: `${origin}/?membership=1`, allow_promotion_codes: false, billing_address_collection: 'required', automatic_tax: {enabled: this.secrets.stripe?.automaticTax === true}}, {idempotencyKey: `${mode}-${key}`});
      await ref.set({checkout_id: session.id, checkout_pending_key: ''}, {merge: true});
      return {url: session.url};
    });
  }
  async returned(user, mode, sessionId) {
    choice(mode, ['test', 'live']);
    if (mode === 'test' && !user.admin) fail('Only an administrator can verify test checkout.', 403);
    if (typeof sessionId !== 'string' || !/^cs_[a-zA-Z0-9_]{1,200}$/.test(sessionId)) fail('Invalid checkout session.');
    return this.withLock(user.id, mode, async (row, ref) => {
      const session = await this.client(mode).checkout.sessions.retrieve(sessionId);
      if (session.id !== row.checkout_id || session.customer !== row.customer_id || session.client_reference_id !== user.id || session.livemode !== (mode === 'live') || session.mode !== 'subscription' || session.status !== 'complete' || session.payment_status !== 'paid') fail('This checkout has not verified payment for your account.', 403);
      const result = await this.reconcile(user.id, mode, row, ref);
      if (!['active', 'ending'].includes(result.state)) fail('Payment is not active yet. Please try again shortly.');
      if (mode === 'test') await this.db.doc('billingConfig/test').set({checkout_proof: row.account}, {merge: true});
      return {verified: true};
    });
  }
  async portal(user, mode = 'live') {
    choice(mode, ['test', 'live']);
    if (mode === 'test' && !user.admin) fail('Only an administrator can manage test billing.', 403);
    const row = (await this.accountRef(user.id, mode).get()).data(), config = await this.config(mode);
    if (!row?.customer_id || row.account !== config.account) fail('No billing account is connected.');
    const portal = await this.client(mode).billingPortal.sessions.create({customer: row.customer_id, configuration: config.portal, return_url: `${this.origin()}/?membership=1`});
    return {url: portal.url};
  }
  async webhook(mode, raw, signature) {
    const config = await this.config(mode);
    if (!config.webhook_secret) fail('Webhook not configured.', 503);
    let event;
    try { event = await this.client(mode).webhooks.constructEventAsync(raw, signature, config.webhook_secret, 300, Stripe.createSubtleCryptoProvider()); } catch { fail('Invalid webhook signature.'); }
    if (event.livemode !== (mode === 'live') || (event.account && event.account !== config.account)) fail('Wrong Stripe account or mode.');
    if (!BILLING_EVENTS.includes(event.type)) return {received: true};
    const customer = event.data?.object?.customer;
    if (typeof customer !== 'string' || !/^cus_[a-zA-Z0-9]+$/.test(customer)) return {received: true};
    const mapping = (await this.db.doc(`billingCustomers/${mode}_${customer}`).get()).data();
    if (!mapping || mapping.account !== config.account) return {received: true};
    // Refetch current Stripe state on every delivery; replayed old events cannot
    // restore canceled access. Failed refreshes return an error for Stripe retry.
    await this.withLock(mapping.uid, mode, (row, ref) => this.reconcile(mapping.uid, mode, row, ref));
    if (mode === 'test') await this.db.doc('billingConfig/test').set({webhook_proof: config.account}, {merge: true});
    return {received: true};
  }
  async enable(enabled) {
    if (typeof enabled !== 'boolean') fail('Expected true or false.');
    if (enabled) {
      const test = await this.config('test'), live = await this.config('live');
      if (!test.account || test.checkout_proof !== test.account || test.webhook_proof !== test.account) fail('Complete a real Stripe test checkout and verify webhook delivery first.');
      if (!live.price || !live.webhook_secret) fail('Connect live Stripe first.');
      const account = await this.client('live').accounts.retrieve();
      if (account.id !== live.account || !account.charges_enabled) fail('The connected live Stripe account must have charges enabled.');
    }
    await this.db.doc('settings/app').set({billingEnabled: enabled}, {merge: true});
    return {enabled};
  }
  async summary() {
    const result = {};
    for (const mode of ['test', 'live']) {
      const c = await this.config(mode);
      result[mode] = {key_configured: !!this.secrets.stripe?.[mode]?.secretKey, ready: !!(c.price && c.webhook_secret), checkout_verified: !!c.account && c.checkout_proof === c.account, webhook_verified: !!c.account && c.webhook_proof === c.account};
    }
    return result;
  }
}
