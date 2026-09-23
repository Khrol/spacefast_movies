import {createRemoteJWKSet, jwtVerify} from 'jose';
import {email, hash, newId, fail} from './domain.js';

const SESSION_AGE = 7 * 86400000, CHALLENGE_AGE = 10 * 60000;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {timeoutDuration: 8000});
const publicUser = account => ({uid: account.id, email: account.email, displayName: account.name});
const randomToken = () => newId() + newId();

export async function verifyGoogleToken(credential, clientId, nonce, keys = googleKeys) {
  if (typeof credential !== 'string' || credential.length > 16000) fail('Google sign-in could not be verified. Please try again.', 401);
  let payload;
  try {
    ({payload} = await jwtVerify(credential, keys, {
      algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId,
      requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'], maxTokenAge: '10m', clockTolerance: 5,
    }));
  } catch { fail('Google sign-in could not be verified. Please try again.', 401); }
  if (payload.nonce !== nonce || payload.aud !== clientId || (payload.azp && payload.azp !== clientId) ||
      payload.email_verified !== true || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) {
    fail('Google sign-in could not be verified. Please try again.', 401);
  }
  const address = email(payload.email);
  return {
    subject: payload.sub, email: address, name: String(payload.name || address.split('@')[0]).trim().slice(0, 100),
    // Only Google-hosted email can reclaim a legacy account by email. Every
    // Google account, including third-party addresses, can start a new diary.
    authoritativeEmail: address.endsWith('@gmail.com') || (typeof payload.hd === 'string' && !!payload.hd),
  };
}

export class Auth {
  constructor(db, secrets, keys) { this.db = db; this.secrets = secrets; this.keys = keys; }
  async limit(key, count = 30, seconds = 600) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    await this.db.runTransaction(async tx => {
      const ref = this.db.doc(`rateLimits/${hash(`${key}:${bucket}`)}`), data = (await tx.get(ref)).data() || {};
      if ((data.count || 0) >= count) fail('Too many attempts. Please try again later.', 429);
      tx.set(ref, {count: (data.count || 0) + 1, expiresAt: (bucket + 2) * seconds * 1000});
    });
  }
  cookieName(kind) { return `${this.secrets.local === true ? '' : '__Host-'}reel_${kind}`; }
  cookie(c, kind, token, age) {
    c.header('Set-Cookie', `${this.cookieName(kind)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.secrets.local === true ? '' : '; Secure'}`, {append: true});
  }
  token(c, kind) {
    const name = this.cookieName(kind);
    const value = c.req.header('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || '';
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  }
  async account(c) {
    const token = this.token(c, 'session');
    if (!token) return null;
    const session = (await this.db.doc(`authSessions/${hash(token)}`).get()).data();
    if (!session || session.provider !== 'google' || session.expiresAt <= Date.now()) return null;
    const account = (await this.db.doc(`accounts/${session.uid}`).get()).data();
    if (!account?.googleSubject || account.googleSubject !== session.subject || account.sessionVersion !== session.version) return null;
    return account;
  }
  async require(c) { const account = await this.account(c); if (!account) fail('Sign in with Google to use your diary.', 401); return account; }
  routes(app) {
    app.get('/auth/session', async c => { const account = await this.account(c); return c.json({user: account ? publicUser(account) : null}); });
    app.post('/auth/google/challenge', async c => {
      if (!this.secrets.googleClientId) fail('Google sign-in is not configured yet. Please try again later.', 503);
      await this.limit(`google-start:${c.get('ip')}`);
      const token = randomToken(), nonce = randomToken();
      await this.db.doc(`authChallenges/${hash(token)}`).set({nonce, expiresAt: Date.now() + CHALLENGE_AGE});
      this.cookie(c, 'google', token, CHALLENGE_AGE / 1000);
      return c.json({client_id: this.secrets.googleClientId, nonce});
    });
    app.post('/auth/google', async c => {
      if (!this.secrets.googleClientId) fail('Google sign-in is not configured yet. Please try again later.', 503);
      await this.limit(`google-login:${c.get('ip')}`);
      const challengeToken = this.token(c, 'google');
      if (!challengeToken) fail('Your sign-in expired. Please try again.', 401);
      const challengeRef = this.db.doc(`authChallenges/${hash(challengeToken)}`);
      const challenge = (await challengeRef.get()).data();
      if (!challenge || challenge.expiresAt <= Date.now()) fail('Your sign-in expired. Please try again.', 401);
      const identity = await verifyGoogleToken(c.get('body').credential, this.secrets.googleClientId, challenge.nonce, this.keys);
      const sessionToken = randomToken();
      const account = await this.db.runTransaction(async tx => {
        const currentChallenge = (await tx.get(challengeRef)).data();
        if (!currentChallenge || currentChallenge.expiresAt <= Date.now() || currentChallenge.nonce !== challenge.nonce) fail('Your sign-in expired. Please try again.', 401);
        const identityRef = this.db.doc(`googleAccounts/${hash(identity.subject)}`);
        const linked = (await tx.get(identityRef)).data();
        let existing = linked ? (await tx.get(this.db.doc(`accounts/${linked.uid}`))).data() : null;
        if (linked && (!existing || existing.googleSubject !== identity.subject)) fail('This account is unavailable. Please contact the site owner.', 409);
        if (!linked && identity.authoritativeEmail) {
          const legacyLookup = this.db.doc(`accountEmails/${hash(identity.email)}`);
          const legacy = (await tx.get(legacyLookup)).data();
          const candidate = legacy ? (await tx.get(this.db.doc(`accounts/${legacy.uid}`))).data() : null;
          if (candidate?.verified === true && !candidate.googleSubject) { existing = candidate; tx.delete(legacyLookup); }
        }
        const ownerRef = this.db.doc('settings/googleOwner'), owner = (await tx.get(ownerRef)).data();
        const isOwner = identity.authoritativeEmail && identity.email === this.secrets.ownerEmail?.toLowerCase() && (!owner || owner.subject === identity.subject);
        const account = {
          id: existing?.id || newId(), googleSubject: identity.subject, email: identity.email, name: identity.name,
          admin: existing?.admin === true || isOwner,
          sessionVersion: existing?.googleSubject ? existing.sessionVersion : newId(),
        };
        tx.set(this.db.doc(`accounts/${account.id}`), account);
        if (isOwner && !owner) tx.create(ownerRef, {uid: account.id, subject: identity.subject});
        tx.set(identityRef, {uid: account.id});
        tx.delete(challengeRef);
        const oldSession = this.token(c, 'session');
        if (oldSession) tx.delete(this.db.doc(`authSessions/${hash(oldSession)}`));
        tx.create(this.db.doc(`authSessions/${hash(sessionToken)}`), {uid: account.id, version: account.sessionVersion, provider: 'google', subject: account.googleSubject, expiresAt: Date.now() + SESSION_AGE});
        return account;
      });
      this.cookie(c, 'session', sessionToken, SESSION_AGE / 1000);
      this.cookie(c, 'google', '', 0);
      return c.json({user: publicUser(account)});
    });
    app.post('/auth/logout', async c => {
      const token = this.token(c, 'session'); if (token) await this.db.doc(`authSessions/${hash(token)}`).delete();
      this.cookie(c, 'session', '', 0); this.cookie(c, 'google', '', 0);
      return c.json({signedOut: true});
    });
    app.all('/auth/*', c => c.json({message: 'Not found.'}, 404));
  }
}
