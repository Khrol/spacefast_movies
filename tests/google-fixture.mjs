import {generateKeyPair, exportJWK, createLocalJWKSet, SignJWT} from 'jose';

export async function googleFixture() {
  const {publicKey, privateKey} = await generateKeyPair('RS256');
  const clientId = 'test-client.apps.googleusercontent.com';
  const keys = createLocalJWKSet({keys: [{...await exportJWK(publicKey), kid: 'test-google', alg: 'RS256', use: 'sig'}]});
  return {
    clientId, keys,
    token(nonce, claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({iss: 'https://accounts.google.com', aud: clientId, sub: 'google-reader', email: 'reader@gmail.com', email_verified: true, name: 'Reader', nonce, iat: now, exp: now + 3600, ...claims})
        .setProtectedHeader({alg: 'RS256', kid: 'test-google'}).sign(privateKey);
    },
  };
}
