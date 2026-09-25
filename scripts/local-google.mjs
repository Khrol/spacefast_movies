import {generateKeyPair, exportJWK, createLocalJWKSet, SignJWT} from 'jose';

// Development-only signing keys. This module is never bundled in the worker.
// Requests still exercise the production nonce, JWT and session validation.
export async function localGoogle(ownerEmail = 'developer@gmail.com') {
  const {publicKey, privateKey} = await generateKeyPair('RS256');
  const clientId = 'local-demo.apps.googleusercontent.com';
  const keys = createLocalJWKSet({keys: [{...await exportJWK(publicKey), kid: 'local-demo', alg: 'RS256', use: 'sig'}]});
  const people = {developer: {email: ownerEmail, name: 'Local developer'}, guest: {email: 'guest@gmail.com', name: 'Local guest'}};
  const handle = async (req, res, url) => {
    if (url.pathname !== '/api/dev/google') return false;
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (req.method !== 'POST' || origin !== 'http://localhost:9500' || req.headers.host !== 'localhost:9500' || req.headers['sec-fetch-site'] === 'cross-site' || !req.headers['content-type']?.startsWith('application/json')) {
      res.writeHead(403).end(JSON.stringify({message: 'Local demo requests only.'})); return true;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2048) {res.writeHead(413).end('{}'); return true;}
    }
    let data; try {data = JSON.parse(body);} catch {res.writeHead(400).end('{}'); return true;}
    if (!data || !Object.hasOwn(people, data.person) || typeof data.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(data.nonce)) {
      res.writeHead(400).end(JSON.stringify({message: 'Choose a local demo account.'})); return true;
    }
    const now = Math.floor(Date.now() / 1000);
    const credential = await new SignJWT({iss: 'https://accounts.google.com', aud: clientId, sub: `local-${data.person}`, ...people[data.person], email_verified: true, nonce: data.nonce, iat: now, exp: now + 600})
      .setProtectedHeader({alg: 'RS256', kid: 'local-demo'}).sign(privateKey);
    res.end(JSON.stringify({credential})); return true;
  };
  return {clientId, keys, handle};
}
