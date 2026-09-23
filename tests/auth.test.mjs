import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp, localDatabase} from '../scripts/local-server.mjs';
import {hash} from '../server/domain.js';

test('owner setup, signup, verification, reset, session revocation, and CSRF protection', {timeout: 60000}, async () => {
  const {db, binding} = await localDatabase(), mail = [], origin = 'https://cinema.example.test';
  const setupToken = 'a'.repeat(64), secrets = {origin, ownerEmail: 'owner@example.test', setupHash: hash(setupToken)};
  const app = createApp({db, secrets, mailer: async message => mail.push(message)});
  const call = async (path, body, cookie = '', from = origin) => {
    const response = await app.request(`${origin}/api/${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Origin: from, Cookie: cookie}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers};
  };
  try {
    assert.equal((await call('auth/setup', {token: 'wrong', password: 'strong-password-2026'})).status, 403);
    const owner = await call('auth/setup', {token: setupToken, name: 'Owner', password: 'strong-password-2026'});
    assert.equal(owner.status, 200); assert.match(owner.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/); assert.match(owner.headers.get('set-cookie'), /Secure/);
    assert.equal((await call('session', undefined, owner.cookie)).data.admin, true);
    assert.equal((await call('auth/setup', {token: setupToken, password: 'strong-password-2026'})).status, 409);
    assert.equal((await call('auth/signup', {email: 'reader@example.test', password: 'reader-password-2026', name: 'Reader'}, '', 'https://evil.example')).status, 403);
    const signup = await call('auth/signup', {email: 'reader@example.test', password: 'reader-password-2026', name: 'Reader'});
    assert.equal(signup.status, 201); assert.equal(signup.data.user.emailVerified, false);
    assert.equal((await call('entries', undefined, signup.cookie)).status, 403);
    const verifyToken = mail[0].text.match(/#verify=([a-f0-9]+)/)[1];
    const verified = await call('auth/complete-verify', {token: verifyToken});
    assert.equal(verified.data.user.emailVerified, true);
    assert.equal((await call('auth/complete-verify', {token: verifyToken})).status, 400);
    assert.equal((await call('session', undefined, verified.cookie)).data.approved, false);
    assert.equal((await call('admin/approve-email', {email: 'reader@example.test'}, owner.cookie)).status, 200);
    assert.equal((await call('entries', undefined, verified.cookie)).status, 200);
    assert.equal((await call('auth/login', {email: 'reader@example.test', password: 'wrong-password-2026'})).status, 401);
    const login = await call('auth/login', {email: 'reader@example.test', password: 'reader-password-2026'});
    assert.equal(login.status, 200);
    await call('auth/reset', {email: 'reader@example.test'});
    const resetToken = mail.at(-1).text.match(/#reset=([a-f0-9]+)/)[1];
    const reset = await call('auth/complete-reset', {token: resetToken, password: 'new-password-2026'});
    assert.equal(reset.status, 200);
    assert.equal((await call('entries', undefined, login.cookie)).status, 401);
    assert.equal((await call('auth/complete-reset', {token: resetToken, password: 'other-password-2026'})).status, 400);
    assert.equal((await call('entries', undefined, reset.cookie)).status, 200);
    await call('auth/logout', {}, reset.cookie);
    assert.equal((await call('entries', undefined, reset.cookie)).status, 401);
    const missing = await call('auth/reset', {email: 'missing@example.test'});
    assert.equal(missing.status, 200); assert.equal(mail.length, 2);
    const unknown = await call('auth/login', {email: 'missing@example.test', password: 'reader-password-2026'});
    assert.equal(unknown.status, 401);
  } finally {binding.close();}
});
