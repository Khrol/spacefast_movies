import {fail} from './domain.js';

// The platform exposes a D1-shaped API backed by MySQL. A revision-checked
// snapshot preserves the original diary's multi-document transactions without
// relying on a connection staying pinned between HTTP database broker calls.
// This is deliberately a small-household store, not an unbounded shared service.
const TABLE = 'reel_state';
const MAX_BYTES = 8 * 1024 * 1024;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const validPath = path => {
  if (!/^[A-Za-z][A-Za-z0-9]*\/[A-Za-z0-9_-]{1,128}$/.test(path)) throw new Error('Invalid document path');
  return path;
};
class Snapshot {
  constructor(ref, value) { this.ref = ref; this.id = ref.id; this.exists = value !== undefined; this.value = value; }
  data() { return clone(this.value); }
}
class Reference {
  constructor(db, path) { this.db = db; this.path = validPath(path); this.id = path.split('/')[1]; }
  get() { return this.db.runTransaction(tx => tx.get(this)); }
  set(value, options) { return this.db.runTransaction(tx => tx.set(this, value, options)); }
  update(value) { return this.db.runTransaction(tx => tx.update(this, value)); }
  delete() { return this.db.runTransaction(tx => tx.delete(this)); }
}
class Query {
  constructor(db, name, filters = [], maximum = Infinity, after = '') { Object.assign(this, {db, name, filters, maximum, after}); }
  doc(id) { return this.db.doc(`${this.name}/${id}`); }
  where(field, operator, value) {
    if (!['==', 'array-contains'].includes(operator)) throw new Error('Unsupported query');
    return new Query(this.db, this.name, [...this.filters, [field, operator, value]], this.maximum, this.after);
  }
  orderBy(field) { if (field !== '__name__') throw new Error('Unsupported ordering'); return this; }
  limit(maximum) { return new Query(this.db, this.name, this.filters, maximum, this.after); }
  startAfter(after) { return new Query(this.db, this.name, this.filters, this.maximum, after); }
  get() { return this.db.runTransaction(tx => tx.get(this)); }
}
class Transaction {
  constructor(db, state) { this.db = db; this.state = state; this.dirty = false; }
  async get(ref) {
    if (ref instanceof Reference) return new Snapshot(ref, this.state[ref.path]);
    const docs = Object.keys(this.state).sort().filter(path => path.startsWith(`${ref.name}/`) && path.split('/')[1] > ref.after)
      .filter(path => ref.filters.every(([key, op, value]) => op === '==' ? this.state[path][key] === value : this.state[path][key]?.includes(value)))
      .slice(0, ref.maximum).map(path => new Snapshot(this.db.doc(path), this.state[path]));
    return {docs, size: docs.length, empty: !docs.length};
  }
  getAll(...refs) { return Promise.all(refs.map(ref => this.get(ref))); }
  set(ref, value, {merge = false} = {}) {
    this.state[ref.path] = clone(merge ? {...this.state[ref.path], ...value} : value); this.dirty = true;
  }
  create(ref, value) { if (this.state[ref.path] !== undefined) fail('This item already exists.', 409); this.set(ref, value); }
  update(ref, value) { if (this.state[ref.path] === undefined) fail('Item not found.', 404); this.set(ref, value, {merge: true}); }
  delete(ref) { delete this.state[ref.path]; this.dirty = true; }
}
export class Database {
  constructor(binding, projectId = 'reel-together') { this.binding = binding; this.projectId = projectId; }
  doc(path) { return new Reference(this, path); }
  collection(name) { return new Query(this, name); }
  async initialize() {
    await this.binding.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload LONGTEXT NOT NULL)`).run();
    const {results} = await this.binding.prepare(`SELECT revision FROM ${TABLE} WHERE id = 1`).all();
    if (!results.length) {
      try { await this.binding.prepare(`INSERT INTO ${TABLE} (id, revision, payload) VALUES (1, 0, ?)`).bind('{}').run(); }
      catch (error) {
        // A concurrent first request can create the singleton before this one.
        const check = await this.binding.prepare(`SELECT revision FROM ${TABLE} WHERE id = 1`).all();
        if (!check.results.length) throw error;
      }
    }
  }
  async runTransaction(callback) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const {results} = await this.binding.prepare(`SELECT revision, payload FROM ${TABLE} WHERE id = 1`).all();
      const record = results[0];
      if (!record) throw new Error('Database is not initialized');
      const tx = new Transaction(this, JSON.parse(record.payload));
      const result = await callback(tx);
      if (!tx.dirty) return result;
      // The original Firebase TTL policies become write-time expiry collection.
      const now = Date.now();
      for (const [path, value] of Object.entries(tx.state)) {
        if (/^(rateLimits|catalogCache|authSessions|authTokens)\//.test(path) && value.expiresAt && new Date(value.expiresAt).getTime() < now) delete tx.state[path];
      }
      const payload = JSON.stringify(tx.state);
      if (new TextEncoder().encode(payload).length > MAX_BYTES) fail('The diary storage limit has been reached. Contact the site owner.', 507);
      const update = await this.binding.prepare(`UPDATE ${TABLE} SET payload = ?, revision = revision + 1 WHERE id = 1 AND revision = ?`).bind(payload, record.revision).run();
      const changed = update.meta?.changes;
      if (changed === 1) return result;
      if (changed !== 0) throw new Error('Database broker did not return the affected row count');
      await new Promise(resolve => setTimeout(resolve, Math.min(5 * 2 ** attempt, 80) + Math.random() * 15));
    }
    fail('Your diary changed in another window. Please try again.', 409);
  }
  batch() {
    const calls = [];
    const batch = Object.fromEntries(['set', 'update', 'delete'].map(method => [method, (...args) => { calls.push([method, args]); return batch; }]));
    batch.commit = () => this.runTransaction(async tx => { for (const [method, args] of calls) tx[method](...args); });
    return batch;
  }
}
