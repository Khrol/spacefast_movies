import {fail, text, hash, parseMovieId, choice} from './domain.js';

export function safePoster(value) {
  try {
    const url = new URL(value), paths = {'kinopoiskapiunofficial.tech': '/images/posters/', 'avatars.mds.yandex.net': '/get-kinopoisk-image/', 'st.kp.yandex.net': '/images/'};
    if (!['http:', 'https:'].includes(url.protocol) || !paths[url.hostname] || !url.pathname.startsWith(paths[url.hostname]) || url.username || url.password || url.port || url.search || url.hash || value.length > 500) return '';
    return `https://${url.hostname}${url.pathname}`;
  } catch { return ''; }
}
const rating = value => typeof value === 'number' && value >= 0 && value <= 10 ? Math.round(value * 10) / 10 : null;
export class Catalog {
  constructor(db, secrets, fetcher = fetch) { this.db = db; this.secrets = secrets; this.fetcher = fetcher; }
  providers() { return ['kinopoisk', 'tmdb'].filter(p => this.secrets[`${p}Token`]).map(p => ({id: p, name: p === 'kinopoisk' ? 'Kinopoisk — Russian titles & ratings' : 'TMDB'})); }
  async request(provider, path, params = {}) {
    const token = this.secrets[`${provider}Token`];
    if (!token) fail('The site owner has not connected this catalog. You can save titles and links manually.', 503);
    const url = new URL(path, provider === 'kinopoisk' ? 'https://kinopoiskapiunofficial.tech' : 'https://api.themoviedb.org');
    url.search = new URLSearchParams(params).toString();
    let response;
    try { response = await this.fetcher(url, {headers: {Accept: 'application/json', ...(provider === 'kinopoisk' ? {'X-API-KEY': token} : {Authorization: `Bearer ${token}`})}, signal: AbortSignal.timeout(10000), redirect: 'error'}); }
    catch { fail('The movie catalog could not connect. Try again or enter a title manually.', 502); }
    if (response.status === 404) fail('No film with that exact ID was found.', 404);
    if ([402, 429].includes(response.status)) fail('The catalog request limit was reached. Manual entry still works.', 429);
    if (!response.ok) fail('The catalog is unavailable or rejected its API key.', 502);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 400000) fail('Unexpected catalog response.', 502); chunks.push(chunk); }
    try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk])))); } catch { fail('Unexpected catalog response.', 502); }
  }
  async map(source, provider, imdb = '') {
    const kp = provider === 'kinopoisk', key = Number(source[kp ? 'kinopoiskId' : 'id']);
    const title = kp ? source.nameRu || source.nameOriginal || source.nameEn : source.title;
    if (!Number.isSafeInteger(key) || key < 1 || typeof title !== 'string' || !title.trim() || [...title].length > 200) return null;
    try { imdb = parseMovieId(source.imdbId || imdb, 'imdb'); } catch { imdb = ''; }
    const candidateYear = Number(kp ? source.year : source.release_date?.slice(0, 4));
    const year = Number.isInteger(candidateYear) && candidateYear >= 1870 && candidateYear <= new Date().getFullYear() + 5 ? candidateYear : 0;
    const movie = {title: title.trim(), year, tmdb_id: kp ? 0 : key, kinopoisk_id: kp ? key : 0, kinopoisk_rating: kp ? rating(source.ratingKinopoisk) : null, imdb_id: imdb, imdb_rating: kp && imdb ? rating(source.ratingImdb) : null, poster_path: !kp && /^\/[a-zA-Z0-9]+\.(jpg|png)$/.test(source.poster_path || '') ? source.poster_path : '', poster_url: kp ? safePoster(source.posterUrlPreview || source.posterUrl || '') : '', catalog_checked_at: new Date().toISOString(), linked_kinopoisk_id: 0, linked_imdb_id: ''};
    await this.db.doc(`catalogMovies/${provider}_${key}`).set(movie);
    return movie;
  }
  async cached(key, fn) {
    const ref = this.db.doc(`catalogCache/${hash(key)}`), cached = (await ref.get()).data();
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) return cached.value;
    const value = await fn();
    await ref.set({value, expiresAt: new Date(Date.now() + 3600000)});
    return value;
  }
  async search(query, provider) {
    choice(provider, ['kinopoisk', 'tmdb']); query = text(query, 200, true);
    if (query.length < 2) fail('Enter at least two characters.');
    return this.cached(`search:${provider}:${hash(this.secrets[`${provider}Token`] || '')}:${query}`, async () => {
      const kp = provider === 'kinopoisk';
      const data = await this.request(provider, kp ? '/api/v2.2/films' : '/3/search/movie', kp ? {keyword: query, type: 'FILM', page: 1} : {query, include_adult: 'false', language: 'ru-RU'});
      const list = data[kp ? 'items' : 'results']; if (!Array.isArray(list)) fail('Unexpected catalog response.', 502);
      return (await Promise.all(list.slice(0, 12).map(m => this.map(m, provider)))).filter(Boolean);
    });
  }
  async lookup(value, provider) {
    const key = parseMovieId(value, provider); if (!key) fail('Enter a movie ID first.');
    const source = provider === 'kinopoisk' || this.secrets.kinopoiskToken ? 'kinopoisk' : 'tmdb';
    return this.cached(`lookup:${provider}:${source}:${hash(this.secrets[`${source}Token`] || '')}:${key}`, async () => {
      const data = provider === 'kinopoisk' ? await this.request(source, `/api/v2.2/films/${key}`) : source === 'kinopoisk' ? await this.request(source, '/api/v2.2/films', {imdbId: key, type: 'FILM', page: 1}) : await this.request(source, `/3/find/${key}`, {external_source: 'imdb_id', language: 'ru-RU'});
      const list = provider === 'kinopoisk' ? [data] : data[source === 'kinopoisk' ? 'items' : 'movie_results'];
      if (!Array.isArray(list)) fail('Unexpected catalog response.', 502);
      const matches = list.filter(m => (!m.type || m.type === 'FILM') && (provider === 'kinopoisk' ? Number(m.kinopoiskId) === key : source === 'tmdb' || m.imdbId === key));
      if (matches.length !== 1) fail('No unambiguous match for this exact movie ID was found.', 404);
      const movie = await this.map(matches[0], source, provider === 'imdb' ? key : '');
      if (!movie) fail('Unexpected catalog response.', 502);
      return movie;
    });
  }
  async movie(body, uid, existing, tx) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Send a valid movie.');
    const title = text(body.title, 200, true), year = Number(body.year || 0);
    if (!Number.isInteger(year) || (year !== 0 && (year < 1870 || year > new Date().getFullYear() + 5))) fail('Enter a valid release year.');
    const provider = body.kinopoisk_id ? 'kinopoisk' : body.tmdb_id ? 'tmdb' : '';
    if (provider) {
      const key = Number(body[`${provider}_id`]);
      if (!Number.isSafeInteger(key) || key < 1) fail('Choose a valid catalog result.');
      const movieKey = `${provider}_${key}`;
      // Existing snapshots remain editable after the catalog is disconnected.
      const saved = (await tx.get(this.db.doc(`catalogMovies/${movieKey}`))).data();
      const trusted = existing?.movie_key === movieKey ? existing : saved;
      if (!trusted) fail('Search for this movie or load its details before saving.');
      const allowed = ['title', 'tmdb_id', 'kinopoisk_id', 'kinopoisk_rating', 'imdb_id', 'imdb_rating', 'poster_path', 'poster_url', 'catalog_checked_at', 'linked_kinopoisk_id', 'linked_imdb_id'];
      return {...Object.fromEntries(allowed.map(k => [k, trusted[k] ?? (k.includes('rating') ? null : '')])), release_year: trusted.year ?? trusted.release_year ?? 0, movie_key: movieKey};
    }
    const kp = parseMovieId(body.links?.kinopoisk ?? '', 'kinopoisk'), imdb = parseMovieId(body.links?.imdb ?? '', 'imdb');
    return {title, release_year: year, movie_key: `manual_${hash(`${uid}:${title.toLocaleLowerCase()}:${year}:${kp}:${imdb}`)}`, tmdb_id: 0, kinopoisk_id: 0, kinopoisk_rating: null, imdb_id: '', imdb_rating: null, poster_path: '', poster_url: '', catalog_checked_at: null, linked_kinopoisk_id: kp, linked_imdb_id: imdb};
  }
}
