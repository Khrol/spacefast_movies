import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp, localDatabase} from '../scripts/local-server.mjs';
import {identityFixture} from './identity-fixture.mjs';

const origin = 'https://cinema.example.test';
async function fixture() {
  const {db, binding} = await localDatabase(), identity = identityFixture();
  const app = createApp({db, secrets: {origin, ownerEmail: 'owner@gmail.com'}, identityFetch: identity.transport});
  const call = async (path, cookie = '', body, from = origin, extraHeaders = {}) => {
    const response = await app.request(`${origin}/api/${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Origin: from, Cookie: cookie, ...extraHeaders}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json(), headers: response.headers};
  };
  return {db, binding, identity, call};
}
test('Spacefast owns sessions; new Google users get isolated diaries with no app credentials', async () => {
  const {db, binding, identity, call} = await fixture();
  try {
    await db.doc('settings/app').set({publicRegistration: false, billingEnabled: true});
    const uid = identity.account('reader'), cookie = identity.login('reader');
    assert.equal((await call('config')).data.auth_provider, 'spacefast');
    const login = await call('auth/session', cookie);
    assert.equal(login.data.user.uid, uid); assert.equal(login.headers.get('set-cookie'), null);
    assert.equal((await call('bootstrap', cookie)).status, 200);
    assert.equal((await call('entries', cookie, {movie: {title: 'My first film'}, status: 'watched', scope: 'personal', watched_on: '2024-01-01'})).status, 201);
    identity.account('outsider'); const outsider = identity.login('outsider');
    assert.equal((await call('entries', outsider)).data.total, 0);
    assert.equal((await call('admin/users', outsider)).status, 403);
    identity.accounts.get('reader').emails[0].email = 'changed@example.test';
    assert.equal((await call('auth/session', cookie)).data.user.uid, uid);
    assert.equal((await call('entries', cookie)).data.total, 1);
    assert.equal((await db.collection('accounts').get()).size, 0);
    assert.equal((await db.collection('authSessions').get()).size, 0);
    assert.equal((await call('auth/logout', cookie, {}, 'https://attacker.example')).status, 403);
    assert.equal((await call('entries', cookie)).status, 200);
    assert.equal((await call('auth/logout', cookie, {})).status, 200);
    assert.equal((await call('entries', cookie)).status, 401);
    const outbound = identity.requests.find(r => r.url.endsWith('/sign-out'));
    assert.ok(outbound.options.headers['X-Identity-CSRF']);
    assert.equal(outbound.options.headers.Origin, origin);
  } finally {binding.close();}
});
test('suspension, revocation, expiry, unverified email and non-Google identities fail closed', async () => {
  const {binding, identity, call} = await fixture();
  try {
    identity.account('reader'); const cookie = identity.login('reader');
    assert.equal((await call('entries', cookie)).status, 200);
    identity.accounts.get('reader').status = 'suspended';
    assert.equal((await call('entries', cookie)).status, 401);
    identity.accounts.get('reader').status = 'active';
    identity.revoke(cookie); assert.equal((await call('entries', cookie)).status, 401);
    const expired = identity.login('reader'); identity.sessions.get(expired.split('=')[1]).expires_at = 1;
    assert.equal((await call('entries', expired)).status, 401);
    const fresh = identity.login('reader'); identity.accounts.get('reader').emails[0].verified_at = 0;
    assert.equal((await call('entries', fresh)).status, 401);
    identity.accounts.get('reader').emails[0].verified_at = Date.now() / 1000;
    identity.accounts.get('reader').providers = [{issuer: 'https://gravatar.com'}];
    assert.equal((await call('entries', fresh)).status, 401);
    assert.equal((await call('entries', 'identity_session=forged')).status, 401);
    assert.equal((await call('entries', '__Host-reel_session=' + 'a'.repeat(64), undefined, origin, {'X-User-Id': 'reader', Authorization: 'Bearer forged'})).status, 401);
    identity.failure(500); assert.equal((await call('entries', fresh)).status, 503);
    assert.ok(identity.requests.every(r => r.url.startsWith(origin + '/__zero/auth/api/')));
    assert.ok(identity.requests.every(r => r.options.redirect === 'error'));
  } finally {binding.close();}
});
test('owner privileges bind to one verified Spacefast identity, never an email reassignment', async () => {
  const {binding, identity, call} = await fixture();
  try {
    identity.account('owner', 'owner@gmail.com'); const owner = identity.login('owner');
    assert.equal((await call('session', owner)).data.admin, true);
    identity.account('impostor', 'owner@gmail.com'); const other = identity.login('impostor');
    assert.equal((await call('session', other)).data.admin, false);
    identity.accounts.get('owner').emails[0].email = 'new@gmail.com';
    assert.equal((await call('session', owner)).data.admin, true);
    assert.equal((await call('admin/users', owner)).status, 200);
    for (const path of ['auth/login', 'auth/signup', 'auth/setup', 'auth/reset', 'auth/google', 'auth/google/challenge', 'billing/checkout', 'billing/webhook/live', 'membership', 'invitations']) assert.equal((await call(path, '', {})).status, 404, path);
  } finally {binding.close();}
});
test('unconfigured Google is reported without exposing credentials; broken identity responses are rejected', async () => {
  const {binding, identity, call} = await fixture();
  try {
    identity.providers(['gravatar']); assert.equal((await call('config')).data.google_configured, false);
    assert.equal((await call('entries')).status, 401);
    identity.failure(502); assert.equal((await call('config')).status, 503);
  } finally {binding.close();}
});
