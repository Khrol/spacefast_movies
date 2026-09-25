import {Database} from './database.js';
import {createApp} from './app.js';

export function readSecrets(env) {
  return {
    origin: env.APP_ORIGIN,
    ownerEmail: env.OWNER_EMAIL,
    kinopoiskToken: env.KINOPOISK_TOKEN,
    tmdbToken: env.TMDB_TOKEN,
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
