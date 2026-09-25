import {randomUUID} from 'node:crypto';

// Development-only simulator. Never imported by server/worker.js or published.
export function localIdentity(ownerEmail = 'developer@example.test') {
  const sessions = new Map();
  const people = {developer: {email: ownerEmail, name: 'Local developer'}, guest: {email: 'guest@example.test', name: 'Local guest'}};
  const current = headers => {
    const value = new Headers(headers).get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('reel_local_identity='))?.slice(20);
    return {token: value, session: sessions.get(value)};
  };
  const transport = async (url, options = {}) => {
    const path = new URL(url).pathname.split('/__zero/auth/api/')[1];
    if (path === 'config') return Response.json({data: {providers: ['google'], issuer: 'http://localhost:9500/identity'}});
    const {token, session} = current(options.headers);
    if (!session) return Response.json({error: {code: 'unauthenticated'}}, {status: 401});
    if (path === 'sign-out' && new Headers(options.headers).get('x-identity-csrf') === session.csrf) {
      sessions.delete(token); return Response.json({data: {signed_out: true}});
    }
    if (path !== 'account') return new Response('', {status: 404});
    const person = people[session.person];
    return Response.json({data: {account: {id: `local-${session.person}`, name: person.name, status: 'active', emails: [{email: person.email, primary: true, verified_at: 1}], providers: [{issuer: 'https://accounts.google.com'}]}, session: {id: token, expires_at: Date.now() / 1000 + 3600}, csrf: session.csrf}});
  };
  const handle = (req, res, url) => {
    if (url.pathname !== '/identity/provider/start') return false;
    const person = url.searchParams.get('person');
    if (Object.hasOwn(people, person)) {
      const token = randomUUID(); sessions.set(token, {person, csrf: randomUUID()});
      res.setHeader('Set-Cookie', `reel_local_identity=${token}; Path=/; HttpOnly; SameSite=Lax`);
      res.setHeader('Content-Type', 'text/html'); res.end('<h1>Local session ready</h1><p>Return to the diary window.</p>');
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Local sign-in simulator</h1><p>This creates a test session on this computer. No Google or Spacefast account is used.</p><a href="?provider=google&person=developer">Local developer</a><br><a href="?provider=google&person=guest">Local guest</a>');
    }
    return true;
  };
  return {transport, handle};
}
