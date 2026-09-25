import {randomUUID} from 'node:crypto';
import {spacefastUserId} from '../server/auth.js';

// A test transport implementing the published Identity account/config contract.
// Only tests inject it; production always calls the Space's Identity service.
export function identityFixture() {
  const accounts = new Map(), sessions = new Map(), requests = [];
  let providers = ['google'], failure = 0;
  function account(subject, address = `${subject}@example.test`, extra = {}) {
    const value = {id: subject, wp_user_id: accounts.size + 1, name: subject, status: 'active',
      emails: [{id: randomUUID(), email: address, primary: true, verified_at: Math.floor(Date.now() / 1000)}],
      providers: [{id: randomUUID(), issuer: 'https://accounts.google.com'}], ...extra};
    accounts.set(subject, value); return spacefastUserId(subject);
  }
  function login(subject) {
    const token = randomUUID();
    sessions.set(token, {subject, csrf: randomUUID(), id: randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 3600});
    return `identity_session=${token}`;
  }
  const transport = async (url, options = {}) => {
    const path = new URL(url).pathname.split('/__zero/auth/api/')[1], headers = new Headers(options.headers);
    requests.push({url: String(url), options});
    if (failure) return Response.json({error: {code: 'unavailable'}}, {status: failure});
    if (path === 'config') return Response.json({data: {providers, issuer: new URL('/identity', url).href}});
    const token = headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('identity_session='))?.slice(17);
    const session = sessions.get(token), value = session && accounts.get(session.subject);
    if (!session || !value || value.status !== 'active') return Response.json({error: {code: 'unauthenticated'}}, {status: 401});
    if (path === 'account') return Response.json({data: {account: value, session, csrf: session.csrf, mfa_enabled: false}});
    if (path === 'sign-out' && options.method === 'POST' && headers.get('x-identity-csrf') === session.csrf) {
      sessions.delete(token); return Response.json({data: {signed_out: true}});
    }
    return Response.json({error: {code: 'forbidden'}}, {status: 403});
  };
  return {accounts, sessions, requests, account, login, transport,
    providers(value) {providers = value;}, failure(value) {failure = value;}, revoke(cookie) {sessions.delete(cookie.split('=')[1]);}};
}
