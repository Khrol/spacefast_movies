import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp, localDatabase} from '../scripts/local-server.mjs';
import {verifyGoogleToken} from '../server/auth.js';
import {hash} from '../server/domain.js';
import {googleFixture} from './google-fixture.mjs';

const google = await googleFixture(), origin = 'https://cinema.example.test';
function client(app) {
  return async (path, body, cookie = '', from = origin) => {
    const response = await app.request(`${origin}/api/${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Origin: from, Cookie: cookie}, body: body === undefined ? undefined : JSON.stringify(body)});
    const cookies = response.headers.getSetCookie();
    return {status: response.status, data: await response.json(), cookie: (cookies.find(c => c.startsWith('__Host-reel_session=')) || cookies[0])?.split(';')[0], headers: response.headers};
  };
}
test('Google signatures, audience, issuer, expiry, nonce and verified email are mandatory', async () => {
  const nonce = 'nonce-123';
  assert.equal((await verifyGoogleToken(await google.token(nonce), google.clientId, nonce, google.keys)).subject, 'google-reader');
  for (const claims of [{aud: 'another-client'}, {iss: 'https://attacker.example'}, {exp: 1}, {iat: 1}, {nonce: 'wrong'}, {email_verified: false}, {email_verified: 'true'}, {sub: ''}, {azp: 'another-client'}, {exp: undefined}, {iat: undefined}]) {
    await assert.rejects(verifyGoogleToken(await google.token(nonce, claims), google.clientId, nonce, google.keys), error => error.status === 401);
  }
  const attacker = await googleFixture();
  await assert.rejects(verifyGoogleToken(await attacker.token(nonce), google.clientId, nonce, google.keys), error => error.status === 401);
  await assert.rejects(verifyGoogleToken('not-a-token', google.clientId, nonce, google.keys), error => error.status === 401);
});
test('new Google accounts get immediate private diary access, secure sessions and logout', async () => {
  const {db, binding} = await localDatabase();
  const app = createApp({db, secrets: {origin, googleClientId: google.clientId, ownerEmail: 'owner@gmail.com'}, googleKeys: google.keys}), call = client(app);
  const signin = async claims => {
    const challenge = await call('auth/google/challenge', {});
    return call('auth/google', {credential: await google.token(challenge.data.nonce, claims)}, challenge.cookie);
  };
  try {
    // Old configuration must not revive either access gate.
    await db.doc('settings/app').set({publicRegistration: false, billingEnabled: true});
    assert.equal((await call('auth/google/challenge', {}, '', 'https://attacker.example')).status, 403);
    const challenge = await call('auth/google/challenge', {}), credential = await google.token(challenge.data.nonce);
    assert.equal((await call('auth/google', {credential})).status, 401);
    assert.equal((await call('auth/google', {credential}, challenge.cookie, 'https://attacker.example')).status, 403);
    const concurrent = await Promise.all([call('auth/google', {credential}, challenge.cookie), call('auth/google', {credential}, challenge.cookie)]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 401]);
    const login = concurrent.find(r => r.status === 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    assert.match(login.cookie, /^__Host-reel_session=/);
    assert.equal((await call('session', undefined, login.cookie)).data.admin, false);
    assert.equal((await call('bootstrap', undefined, login.cookie)).status, 200);
    const entry = {movie: {title: 'My first film'}, status: 'watched', scope: 'personal', watched_on: '2024-01-01'};
    assert.equal((await call('entries', entry, login.cookie)).status, 201);
    const outsider = await signin({sub: 'google-outsider', email: 'outsider@example.com'});
    assert.equal(outsider.status, 200, 'Third-party addresses can join through Google');
    assert.equal((await call('entries', undefined, outsider.cookie)).data.total, 0);
    assert.equal((await call('admin/users', undefined, outsider.cookie)).status, 403);
    const returning = await signin({email: 'renamed@gmail.com'});
    assert.equal(returning.data.user.uid, login.data.user.uid, 'Stable Google subject owns the diary even when email changes');
    assert.equal((await call('entries', undefined, returning.cookie)).data.total, 1);
    await call('auth/logout', {}, returning.cookie);
    assert.equal((await call('entries', undefined, returning.cookie)).status, 401);
    const owner = await signin({sub: 'google-owner', email: 'owner@gmail.com'});
    assert.equal((await call('session', undefined, owner.cookie)).data.admin, true);
    assert.equal((await call('admin/users', undefined, owner.cookie)).status, 200);
    for (const path of ['auth/login', 'auth/signup', 'auth/setup', 'auth/reset', 'auth/complete-reset', 'auth/resend', 'billing/checkout', 'billing/webhook/live', 'membership', 'invitations']) assert.equal((await call(path, {})).status, 404, path);
    const expired = await call('auth/google/challenge', {});
    await db.doc(`authChallenges/${hash(expired.cookie.split('=')[1])}`).update({expiresAt: 1});
    assert.equal((await call('auth/google', {credential: await google.token(expired.data.nonce)}, expired.cookie)).status, 401);
  } finally {binding.close();}
});
test('legacy owner data is retained, passwords and old sessions are retired, email alone cannot take over an account', async () => {
  const {db, binding} = await localDatabase(), call = client(createApp({db, secrets: {origin, googleClientId: google.clientId, ownerEmail: 'owner@gmail.com'}, googleKeys: google.keys}));
  const signin = async claims => {const c = await call('auth/google/challenge', {}); return call('auth/google', {credential: await google.token(c.data.nonce, claims)}, c.cookie);};
  try {
    for (const [uid, address] of [['owner', 'owner@gmail.com'], ['external', 'person@example.com']]) {
      await db.doc(`accounts/${uid}`).set({id: uid, email: address, verified: true, admin: uid === 'owner', password: 'old-hash', sessionVersion: 'old'});
      await db.doc(`accountEmails/${hash(address)}`).set({uid});
      await db.doc(`users/${uid}`).set({name: 'Original name', email: address, approved: false, complimentary: false, household_id: 'existing-household', membership_epoch: 'keep-this'});
    }
    const legacyToken = 'a'.repeat(64);
    await db.doc(`authSessions/${hash(legacyToken)}`).set({uid: 'owner', version: 'old', expiresAt: Date.now() + 3600000});
    assert.equal((await call('auth/session', undefined, `__Host-reel_session=${legacyToken}`)).data.user, null);
    const owner = await signin({sub: 'google-owner', email: 'owner@gmail.com'});
    assert.equal(owner.data.user.uid, 'owner');
    assert.equal((await call('session', undefined, owner.cookie)).status, 200);
    const profile = (await db.doc('users/owner').get()).data();
    assert.equal(profile.household_id, 'existing-household'); assert.equal(profile.membership_epoch, 'keep-this');
    assert.equal(profile.approved, undefined); assert.equal(profile.complimentary, undefined);
    assert.equal((await db.doc('accounts/owner').get()).data().password, undefined);
    const external = await signin({sub: 'google-external', email: 'person@example.com'});
    assert.equal(external.status, 200); assert.notEqual(external.data.user.uid, 'external');
    const anotherGoogleId = await signin({sub: 'different-google-owner', email: 'owner@gmail.com'});
    assert.notEqual(anotherGoogleId.data.user.uid, 'owner', 'A linked account is never reassigned by email');
    assert.equal((await call('session', undefined, anotherGoogleId.cookie)).data.admin, false, 'Owner privileges stay bound to the first verified Google identity');
  } finally {binding.close();}
});
test('missing Google configuration fails closed', async () => {
  const {db, binding} = await localDatabase(), call = client(createApp({db, secrets: {origin}}));
  try {
    assert.equal((await call('config')).data.google_configured, false);
    assert.equal((await call('auth/google/challenge', {})).status, 503);
    assert.equal((await call('auth/google', {credential: 'forged'})).status, 503);
    assert.equal((await call('entries')).status, 401);
  } finally {binding.close();}
});
