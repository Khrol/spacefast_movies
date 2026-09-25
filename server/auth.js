import {email, hash, fail} from './domain.js';

const IDENTITY_API = '/__zero/auth/api/';
const googleIssuers = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const spacefastUserId = subject => `sf_${hash(subject).slice(0, 32)}`;
const publicUser = account => ({uid: account.id, email: account.email, displayName: account.name});

// Validate the Space's Identity session on every request. No second app session
// or session cache can outlive suspension or revocation in Spacefast Users.
export class Auth {
  constructor(db, secrets, identityFetch = fetch) {this.db = db; this.secrets = secrets; this.fetch = identityFetch;}
  async identity(path, c, {body, csrf} = {}) {
    const origin = this.secrets.identityOrigin || this.secrets.origin;
    if (!origin) fail('Spacefast sign-in is not configured for this environment.', 503);
    const url = new URL(IDENTITY_API + path, origin);
    const headers = {'Accept': 'application/json', 'Content-Type': 'application/json'};
    // Forward cookies only to the fixed, server-configured origin.
    if (c && c.req.header('Cookie')) headers.Cookie = c.req.header('Cookie');
    if (csrf) headers['X-Identity-CSRF'] = csrf;
    if (body !== undefined) headers.Origin = url.origin;
    let response;
    try {
      response = await this.fetch(url, {method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    } catch {fail('Spacefast sign-in is temporarily unavailable. Please try again.', 503);}
    if ([401, 403].includes(response.status)) return null;
    if (!response.ok) fail('Spacefast sign-in is temporarily unavailable. Please try again.', 503);
    let data; try {data = (await response.json()).data;} catch {fail('Spacefast sign-in returned an invalid response.', 503);}
    if (!data || typeof data !== 'object') fail('Spacefast sign-in returned an invalid response.', 503);
    return data;
  }
  async config() {
    const data = await this.identity('config');
    if (!Array.isArray(data?.providers)) fail('Spacefast sign-in is not configured.', 503);
    return {auth_provider: 'spacefast', google_configured: data.providers.includes('google')};
  }
  async session(c) {
    if (!c.req.header('Cookie')) return null;
    const data = await this.identity('account', c);
    if (!data) return null;
    const {account, session} = data;
    if (!account || typeof account.id !== 'string' || !account.id || account.id.length > 512 ||
        !session || typeof session.id !== 'string' || !Number.isFinite(session.expires_at) || session.expires_at <= Date.now() / 1000 ||
        account.status !== 'active') return null;
    return data;
  }
  async account(c) {
    const data = await this.session(c);
    if (!data) return null;
    const identity = data.account;
    if (!Array.isArray(identity.providers) || !identity.providers.some(p => googleIssuers.has(p.issuer))) return null;
    const addresses = Array.isArray(identity.emails) ? identity.emails.filter(e => typeof e.email === 'string' && Number.isFinite(e.verified_at) && e.verified_at > 0) : [];
    const primary = addresses.find(e => e.primary) || addresses[0];
    if (!primary) return null;
    let address; try {address = email(primary.email);} catch {return null;}
    const uid = spacefastUserId(identity.id), ownerEmail = this.secrets.ownerEmail?.toLowerCase();
    const admin = await this.db.runTransaction(async tx => {
      const ref = this.db.doc('settings/spacefastOwner'), owner = (await tx.get(ref)).data();
      if (owner) return owner.subject === identity.id;
      if (ownerEmail && addresses.some(e => e.email.toLowerCase() === ownerEmail)) {
        tx.create(ref, {uid, subject: identity.id}); return true;
      }
      return false;
    });
    return {id: uid, email: address, name: String(identity.name || address.split('@')[0]).trim().slice(0, 100), admin};
  }
  async require(c) {const account = await this.account(c); if (!account) fail('Sign in with Google to use your diary.', 401); return account;}
  routes(app) {
    app.get('/auth/session', async c => {const account = await this.account(c); return c.json({user: account ? publicUser(account) : null});});
    app.post('/auth/logout', async c => {
      const session = await this.session(c);
      if (session) {
        if (typeof session.csrf !== 'string' || !session.csrf) fail('Spacefast sign-out is unavailable. Please try again.', 503);
        const result = await this.identity('sign-out', c, {body: {}, csrf: session.csrf});
        if (!result?.signed_out) fail('Spacefast sign-out failed. Please try again.', 503);
      }
      return c.json({signedOut: true});
    });
    app.all('/auth/*', c => c.json({message: 'Not found.'}, 404));
  }
}
