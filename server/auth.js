import {scryptAsync} from '@noble/hashes/scrypt.js';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js';
import {email, text, hash, newId, fail} from './domain.js';

const SESSION_AGE = 7 * 86400000;
const cookieName = '__Host-reel_session';
const publicUser = account => ({uid: account.id, email: account.email, displayName: account.name, emailVerified: account.verified});
export async function passwordHash(password, salt = newId()) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) fail('Use a password between 12 and 256 characters.');
  const derived = await scryptAsync(password, salt, {N: 32768, r: 8, p: 3, dkLen: 32, maxmem: 64 * 1024 * 1024});
  return `scrypt:32768:8:3:${salt}:${bytesToHex(derived)}`;
}
export function constantEqual(a, b) {
  const left = hexToBytes(hash(a)), right = hexToBytes(hash(b));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
export class Auth {
  constructor(db, secrets, mailer) { this.db = db; this.secrets = secrets; this.mailer = mailer; }
  async limit(key, count = 10, seconds = 600) {
    const now = Date.now(), bucket = Math.floor(now / (seconds * 1000));
    await this.db.runTransaction(async tx => {
      const ref = this.db.doc(`rateLimits/${hash(`${key}:${bucket}`)}`), data = (await tx.get(ref)).data() || {};
      if ((data.count || 0) >= count) fail('Too many attempts. Please try again later.', 429);
      tx.set(ref, {count: (data.count || 0) + 1, expiresAt: new Date((bucket + 2) * seconds * 1000)});
    });
  }
  cookie(c, token, age = SESSION_AGE / 1000) {
    const local = this.secrets.local === true;
    c.header('Set-Cookie', `${local ? 'reel_session' : cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${local ? '' : '; Secure'}`);
  }
  sessionToken(c) {
    const name = this.secrets.local === true ? 'reel_session' : cookieName;
    return c.req.header('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || '';
  }
  async account(c) {
    const token = this.sessionToken(c);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const session = (await this.db.doc(`authSessions/${hash(token)}`).get()).data();
    if (!session || session.expiresAt <= Date.now()) return null;
    const account = (await this.db.doc(`accounts/${session.uid}`).get()).data();
    if (!account || account.sessionVersion !== session.version) return null;
    return account;
  }
  async start(c, account) {
    const token = newId() + newId();
    await this.db.doc(`authSessions/${hash(token)}`).set({uid: account.id, version: account.sessionVersion, expiresAt: Date.now() + SESSION_AGE});
    this.cookie(c, token);
    return publicUser(account);
  }
  async require(c) { const account = await this.account(c); if (!account) fail('Please sign in to use your diary.', 401); return account; }
  async send(account, kind) {
    if (!this.mailer) fail('Email delivery is not configured. Please contact the site owner.', 503);
    const token = newId() + newId(), ref = this.db.doc(`authTokens/${hash(token)}`);
    await ref.set({uid: account.id, kind, version: account.sessionVersion, expiresAt: Date.now() + 3600000});
    const url = `${this.secrets.origin}/#${kind}=${token}`;
    try { await this.mailer({to: account.email, subject: kind === 'verify' ? 'Verify your Reel Together email' : 'Reset your Reel Together password', text: `Open this link to ${kind === 'verify' ? 'verify your email' : 'choose a new password'}:\n\n${url}\n\nThis link expires in one hour. If you did not request it, ignore this email.`}); }
    catch { await ref.delete(); fail('The email could not be delivered. Please try again later.', 503); }
  }
  routes(app) {
    app.get('/auth/session', async c => { const account = await this.account(c); return c.json({user: account ? publicUser(account) : null}); });
    app.get('/auth/setup', async c => c.json({available: !!this.secrets.setupHash && !(await this.db.doc('settings/ownerSetup').get()).exists}));
    app.post('/auth/setup', async c => {
      await this.limit(`setup:${c.get('ip')}`, 5, 3600);
      const body = await c.req.json();
      if (!this.secrets.ownerEmail || !this.secrets.setupHash || !constantEqual(hash(String(body.token || '')), this.secrets.setupHash)) fail('This setup link is invalid.', 403);
      const address = email(this.secrets.ownerEmail), uid = newId(), password = await passwordHash(body.password);
      const account = {id: uid, email: address, name: text(body.name || 'Cinema owner', 100, true), password, verified: true, admin: true, sessionVersion: newId()};
      await this.db.runTransaction(async tx => {
        const setup = this.db.doc('settings/ownerSetup');
        if ((await tx.get(setup)).exists || (await tx.get(this.db.doc(`accountEmails/${hash(address)}`))).exists) fail('The owner account has already been set up.', 409);
        tx.create(setup, {completedAt: Date.now()});
        tx.create(this.db.doc(`accounts/${uid}`), account);
        tx.create(this.db.doc(`accountEmails/${hash(address)}`), {uid});
      });
      return c.json({user: await this.start(c, account)});
    });
    app.post('/auth/signup', async c => {
      await this.limit(`signup:${c.get('ip')}`, 5, 3600);
      if (!this.mailer) fail('Account registration is waiting for email delivery to be configured. Please contact the site owner.', 503);
      const body = await c.req.json(), address = email(body.email), password = await passwordHash(body.password), uid = newId();
      const account = {id: uid, email: address, name: text(body.name, 100, true), password, verified: false, admin: false, sessionVersion: newId()};
      await this.db.runTransaction(async tx => {
        const lookup = this.db.doc(`accountEmails/${hash(address)}`);
        if ((await tx.get(lookup)).exists) fail('An account already uses this email. Sign in or reset your password.', 409);
        tx.create(lookup, {uid}); tx.create(this.db.doc(`accounts/${uid}`), account);
      });
      // The account remains recoverable through sign-in/resend if delivery fails.
      const user = await this.start(c, account);
      await this.send(account, 'verify');
      return c.json({user}, 201);
    });
    app.post('/auth/login', async c => {
      const body = await c.req.json(), address = email(body.email);
      await this.limit(`login-ip:${c.get('ip')}`, 30); await this.limit(`login:${address}`);
      const lookup = (await this.db.doc(`accountEmails/${hash(address)}`).get()).data();
      const account = lookup ? (await this.db.doc(`accounts/${lookup.uid}`).get()).data() : null;
      const salt = account?.password.split(':')[4] || '00000000000000000000000000000000';
      const validPassword = typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 256;
      const candidate = await passwordHash(validPassword ? body.password : 'invalid-password', salt);
      if (!validPassword || !account || !constantEqual(candidate, account.password)) fail('The email or password is incorrect.', 401);
      return c.json({user: await this.start(c, account)});
    });
    app.post('/auth/logout', async c => {
      const token = this.sessionToken(c); if (token) await this.db.doc(`authSessions/${hash(token)}`).delete();
      this.cookie(c, '', 0); return c.json({signedOut: true});
    });
    app.post('/auth/resend', async c => {
      const account = await this.require(c); await this.limit(`verify:${account.id}`, 3, 3600);
      if (!account.verified) await this.send(account, 'verify');
      return c.json({sent: true});
    });
    app.post('/auth/reset', async c => {
      const address = email((await c.req.json()).email);
      await this.limit(`reset:${c.get('ip')}`, 5, 3600); await this.limit(`reset-address:${address}`, 3, 3600);
      if (!this.mailer) fail('Email delivery is not configured. Please contact the site owner.', 503);
      const lookup = (await this.db.doc(`accountEmails/${hash(address)}`).get()).data();
      if (lookup) { const account = (await this.db.doc(`accounts/${lookup.uid}`).get()).data(); if (account) await this.send(account, 'reset'); }
      return c.json({sent: true});
    });
    for (const kind of ['verify', 'reset']) app.post(`/auth/complete-${kind}`, async c => {
      await this.limit(`complete:${c.get('ip')}`, 20);
      const body = await c.req.json();
      if (!/^[a-f0-9]{64}$/.test(body.token || '')) fail('This link is invalid or expired.');
      const password = kind === 'reset' ? await passwordHash(body.password) : null;
      const account = await this.db.runTransaction(async tx => {
        const tokenRef = this.db.doc(`authTokens/${hash(body.token)}`), token = (await tx.get(tokenRef)).data();
        if (!token || token.kind !== kind || token.expiresAt <= Date.now()) fail('This link is invalid or expired.');
        const ref = this.db.doc(`accounts/${token.uid}`), account = (await tx.get(ref)).data();
        if (!account || token.version !== account.sessionVersion) fail('This link is invalid or expired.');
        const updated = {...account, verified: true, ...(password ? {password, sessionVersion: newId()} : {})};
        tx.set(ref, updated); tx.delete(tokenRef); return updated;
      });
      return c.json({user: await this.start(c, account)});
    });
  }
}

export function createMailer(secrets) {
  if (!secrets.resendApiKey || !secrets.mailFrom) return null;
  return async message => {
    const response = await fetch('https://api.resend.com/emails', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secrets.resendApiKey}`}, body: JSON.stringify({from: secrets.mailFrom, ...message}), signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Mail delivery failed');
  };
}
