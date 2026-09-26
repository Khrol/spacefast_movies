import {safePoster} from './catalog.js';
import {fail, hash} from './domain.js';

const TABLE = 'reel_posters', MAX_BYTES = 1024 * 1024;
const encode = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  fail('Poster unavailable.', 502);
}
async function imageBytes(response) {
  if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel();
    fail('Poster unavailable.', 502);
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {await reader.cancel(); fail('Poster unavailable.', 502);}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  return bytes;
}

export class Posters {
  constructor(db, fetcher = (...args) => fetch(...args)) {this.db = db; this.fetcher = fetcher; this.pending = new Map();}
  async initialize() {
    await this.db.binding.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id VARCHAR(80) PRIMARY KEY, content_type VARCHAR(32) NOT NULL, image_data LONGTEXT NOT NULL, byte_size INTEGER NOT NULL, etag VARCHAR(66) NOT NULL)`).run();
  }
  async stored(key) {
    const {results} = await this.db.binding.prepare(`SELECT content_type, image_data, byte_size, etag FROM ${TABLE} WHERE id = ?`).bind(key).all();
    return results[0];
  }
  async copy(key, provider) {
    const existing = await this.stored(key); if (existing) return existing;
    // Only authenticated catalog results register sources. This endpoint accepts
    // movie IDs, never caller-supplied URLs, headers, or catalog credentials.
    const movie = (await this.db.doc(`catalogMovies/${key}`).get()).data();
    const source = provider === 'kinopoisk' ? safePoster(movie?.poster_url) : /^\/[a-zA-Z0-9]+\.(jpg|png)$/.test(movie?.poster_path || '') ? `https://image.tmdb.org/t/p/w342${movie.poster_path}` : '';
    if (!source) fail('Poster not found.', 404);
    let bytes;
    try {
      const response = await this.fetcher(source, {redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {Accept: 'image/jpeg,image/png,image/webp'}});
      bytes = await imageBytes(response);
    } catch {fail('Poster unavailable.', 502);}
    const contentType = imageType(bytes), data = encode(bytes), etag = `"${hash(data)}"`;
    try {
      await this.db.binding.prepare(`INSERT INTO ${TABLE} (id, content_type, image_data, byte_size, etag) VALUES (?, ?, ?, ?, ?)`).bind(key, contentType, data, bytes.length, etag).run();
    } catch (error) {
      // Concurrent workers can copy the same film. Keep the first durable copy.
      const winner = await this.stored(key); if (winner) return winner;
      throw error;
    }
    return {content_type: contentType, image_data: data, byte_size: bytes.length, etag};
  }
  async response(provider, id, request) {
    if (!['kinopoisk', 'tmdb'].includes(provider) || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) fail('Poster not found.', 404);
    const key = `${provider}_${id}`;
    if (!this.pending.has(key)) this.pending.set(key, this.initialize().then(() => this.copy(key, provider)).finally(() => this.pending.delete(key)));
    const poster = await this.pending.get(key);
    const headers = {'Content-Type': poster.content_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'ETag': poster.etag, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin'};
    if (request.headers.get('If-None-Match') === poster.etag) return new Response(null, {status: 304, headers});
    return new Response(request.method === 'HEAD' ? null : decode(poster.image_data), {headers: {...headers, 'Content-Length': String(poster.byte_size)}});
  }
}
