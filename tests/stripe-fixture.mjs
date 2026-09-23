import Stripe from 'stripe';
export class StripeFixture {
  constructor() { this.calls = []; this.data = {test: this.mode('test'), live: this.mode('live')}; this.fail = false; }
  mode(mode) {
    const state = {customers: new Map(), sessions: new Map(), subscriptions: new Map(), price: null, secret: `whsec_fixture_${mode}`, keys: new Map(), counter: 0};
    const create = (type, body, opts, factory) => {
      this.calls.push({mode, type, body: structuredClone(body)});
      if (opts?.idempotencyKey && state.keys.has(opts.idempotencyKey)) return state.keys.get(opts.idempotencyKey);
      const value = factory(); if (opts?.idempotencyKey) state.keys.set(opts.idempotencyKey, value); return value;
    };
    const client = {
      accounts: {retrieve: async () => ({id: `acct_${mode}`, charges_enabled: true})},
      products: {create: async (body, opts) => create('product', body, opts, () => ({id: `prod_${mode}`}))},
      prices: {create: async (body, opts) => create('price', body, opts, () => state.price = {id: `price_${mode}`, ...body}), retrieve: async () => state.price},
      webhookEndpoints: {create: async (body, opts) => create('webhook', body, opts, () => ({id: `we_${mode}`, secret: state.secret})), retrieve: async () => ({id: `we_${mode}`})},
      billingPortal: {configurations: {create: async () => ({id: `bpc_${mode}`})}, sessions: {create: async body => { this.calls.push({mode, type: 'portal', body}); return {url: 'https://billing.stripe.com/p/session/fixture'}; }}},
      customers: {create: async (body, opts) => create('customer', body, opts, () => { const customer = {id: `cus_${mode}${++state.counter}`, ...body}; state.customers.set(customer.id, customer); return customer; })},
      checkout: {sessions: {
        create: async (body, opts) => create('checkout', body, opts, () => { const session = {id: `cs_${mode}_${++state.counter}`, ...body, livemode: mode === 'live', status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.com/c/pay/${mode}${state.counter}`}; state.sessions.set(session.id, session); return session; }),
        retrieve: async key => state.sessions.get(key),
      }},
      subscriptions: {list: async ({customer}) => { if (this.fail) throw new Error('Provider offline'); return {data: structuredClone(state.subscriptions.get(customer) || []), has_more: false}; }},
      webhooks: new Stripe(`sk_${mode}_fixture`).webhooks,
    };
    return {...state, client, state};
  }
  factory = key => this.data[key.includes('_live_') ? 'live' : 'test'].client;
  complete(uid, mode = 'live') {
    const {state} = this.data[mode];
    const customer = [...state.customers.values()].find(c => c.metadata.firebase_uid === uid);
    const session = [...state.sessions.values()].find(s => s.customer === customer.id);
    session.status = 'complete'; session.payment_status = 'paid';
    state.subscriptions.set(customer.id, [{id: `sub_${mode}${state.counter}`, customer: customer.id, metadata: {firebase_uid: uid}, status: 'active', livemode: mode === 'live', cancel_at_period_end: false, items: {data: [{quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 86400, price: {...state.price, recurring: {interval: 'month', interval_count: 1}}}]}, latest_invoice: {status: 'paid', amount_paid: 100}}]);
    return session;
  }
  subscription(uid, mode = 'live') {
    const {state} = this.data[mode], customer = [...state.customers.values()].find(c => c.metadata.firebase_uid === uid);
    return state.subscriptions.get(customer.id)[0];
  }
  webhook(uid, mode = 'live', changes = {}, timestamp = Math.floor(Date.now() / 1000)) {
    const {state, client} = this.data[mode], customer = [...state.customers.values()].find(c => c.metadata.firebase_uid === uid);
    const payload = JSON.stringify({id: 'evt_fixture', livemode: mode === 'live', type: 'invoice.paid', data: {object: {customer: customer.id}}, ...changes});
    return {payload, signature: client.webhooks.generateTestHeaderString({payload, secret: state.secret, timestamp})};
  }
}
