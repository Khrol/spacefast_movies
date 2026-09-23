import {Database} from './database.js';
import {createApp} from './app.js';

export function readSecrets(env) {
  return {
    origin: env.APP_ORIGIN,
    ownerEmail: env.OWNER_EMAIL,
    setupHash: env.OWNER_SETUP_HASH,
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    kinopoiskToken: env.KINOPOISK_TOKEN,
    tmdbToken: env.TMDB_TOKEN,
    stripe: {test: {secretKey: env.STRIPE_TEST_SECRET_KEY}, live: {secretKey: env.STRIPE_LIVE_SECRET_KEY}, automaticTax: env.STRIPE_AUTOMATIC_TAX === 'true'},
  };
}
export default {
  async fetch(request, env) {
    if (!env.DB) return Response.json({message: 'The diary database is not connected.'}, {status: 503});
    const db = new Database(env.DB);
    try { await db.initialize(); }
    catch (error) { console.error('Database unavailable:', error.name); return Response.json({message: 'The diary database is temporarily unavailable.'}, {status: 503}); }
    return createApp({db, secrets: readSecrets(env)}).fetch(request);
  },
};
