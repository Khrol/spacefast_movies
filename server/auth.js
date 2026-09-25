import {createRemoteJWKSet, jwtVerify} from 'jose';
import {email, hash, newId, fail} from './domain.js';

const SESSION_AGE = 7 * 86400000, CHALLENGE_AGE = 10 * 60000;
const AUTH_VERSION = 3;
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
  let address;
  try {address = email(payload.email);} catch {fail('Google sign-in could not be verified. Please try again.', 401);}
  return {
    subject: payload.sub, email: address, name: String(payload.name || address.split('@')[0]).trim().slice(0, 100),
    // Google is authoritative for Gmail and verified Workspace addresses.
    // Other Google accounts can join, but cannot claim the initial owner role.
    authoritativeEmail: address.endsWith('@gmail.com') || (typeof payload.hd === 'string' && !!payload.hd),
  };
}

export class Auth {
  constructor(db, secrets, keys) { this.db = db; this.secrets = secrets; this.keys = keys; }
  config() { return {auth_provider: 'google', google_configured: !!this.secrets.googleClientId}; }
  async limit(key, count = 30, seconds = 600) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    await this.db.runTransaction(async tx => {
      const ref = this.db.doc(`rateLimits/${hash(`${key}:${bucket}`)}`), data = (await tx.get(ref)).data() || {};
      if ((data.count || 0) >= count) fail('Too many attempts. Please try again later.', 429);
      tx.set(ref, {count: (data.count || 0) + 1, expiresAt: (bucket + 2) * seconds * 1000});
    });
  }
  token(c) {
    const value = c.req.header('X-Reel-Session') || '';
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  }
  async account(c) {
    const token = this.token(c);
    if (!token) return null;
    const session = (await this.db.doc(`authSessions/${hash(token)}`).get()).data();
    if (!session || session.authVersion !== AUTH_VERSION || session.provider !== 'google' || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
    const account = (await this.db.doc(`accounts/${session.uid}`).get()).data();
    if (!account?.googleSubject || account.googleSubject !== session.subject || !account.sessionVersion || account.sessionVersion !== session.version) return null;
    return account;
  }
  async require(c) { const account = await this.account(c); if (!account) fail('Sign in with Google to use your diary.', 401); return account; }
  routes(app) {
    app.get('/auth/session', async c => { const account = await this.account(c); return c.json({user: account ? publicUser(account) : null}); });
    app.post('/auth/google/challenge', async c => {
      if (!this.secrets.googleClientId) fail('Google sign-in is not configured yet. Please try again later.', 503);
      await this.limit(`google-start:${c.get('ip')}`);
      const token = randomToken(), nonce = randomToken();
      await this.db.doc(`authChallenges/${hash(token)}`).set({nonce, authVersion: AUTH_VERSION, expiresAt: Date.now() + CHALLENGE_AGE});
      // This secret stays in the initiating page's memory. It must accompany
      // the signed nonce; a different page's challenge cannot redeem the JWT.
      return c.json({client_id: this.secrets.googleClientId, nonce, challenge: token});
    });
    app.post('/auth/google', async c => {
      if (!this.secrets.googleClientId) fail('Google sign-in is not configured yet. Please try again later.', 503);
      await this.limit(`google-login:${c.get('ip')}`);
      const challengeToken = c.get('body').challenge;
      if (typeof challengeToken !== 'string' || !/^[a-f0-9]{64}$/.test(challengeToken)) fail('Your sign-in expired. Please try again.', 401);
      const challengeRef = this.db.doc(`authChallenges/${hash(challengeToken)}`);
      const challenge = (await challengeRef.get()).data();
      if (!challenge || challenge.authVersion !== AUTH_VERSION || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) fail('Your sign-in expired. Please try again.', 401);
      const identity = await verifyGoogleToken(c.get('body').credential, this.secrets.googleClientId, challenge.nonce, this.keys);
      const sessionToken = randomToken();
      const account = await this.db.runTransaction(async tx => {
        const currentChallenge = (await tx.get(challengeRef)).data();
        if (!currentChallenge || currentChallenge.expiresAt <= Date.now() || currentChallenge.nonce !== challenge.nonce) fail('Your sign-in expired. Please try again.', 401);
        const identityRef = this.db.doc(`googleAccounts/${hash(identity.subject)}`);
        const linked = (await tx.get(identityRef)).data();
        const existing = linked ? (await tx.get(this.db.doc(`accounts/${linked.uid}`))).data() : null;
        if (linked && (!existing || existing.googleSubject !== identity.subject)) fail('This account is unavailable. Please contact the site owner.', 409);
        // Only an existing, verified Google subject mapping can reuse a diary.
        // Never link Spacefast or legacy accounts by matching their email.
        const ownerRef = this.db.doc('settings/googleOwner'), owner = (await tx.get(ownerRef)).data();
        const isOwner = owner ? owner.subject === identity.subject : identity.authoritativeEmail && identity.email === this.secrets.ownerEmail?.toLowerCase();
        const account = {
          id: existing?.id || newId(), googleSubject: identity.subject, email: identity.email, name: identity.name,
          admin: isOwner,
          sessionVersion: existing?.sessionVersion || newId(),
        };
        tx.set(this.db.doc(`accounts/${account.id}`), account);
        if (isOwner && !owner) tx.create(ownerRef, {uid: account.id, subject: identity.subject});
        tx.set(identityRef, {uid: account.id});
        tx.delete(challengeRef);
        const oldSession = this.token(c);
        if (oldSession) tx.delete(this.db.doc(`authSessions/${hash(oldSession)}`));
        tx.create(this.db.doc(`authSessions/${hash(sessionToken)}`), {uid: account.id, authVersion: AUTH_VERSION, version: account.sessionVersion, provider: 'google', subject: account.googleSubject, expiresAt: Date.now() + SESSION_AGE});
        return account;
      });
      return c.json({user: publicUser(account), session: sessionToken});
    });
    app.post('/auth/logout', async c => {
      const token = this.token(c); if (token) await this.db.doc(`authSessions/${hash(token)}`).delete();
      return c.json({signedOut: true});
    });
    app.all('/auth/*', c => c.json({message: 'Not found.'}, 404));
  }
}
