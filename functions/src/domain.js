import {createHash, randomBytes} from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const fail = (message, status = 400) => { throw new AppError(message, status); };
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const newId = () => randomBytes(16).toString('hex');
export function text(value, max, required = false) {
  if (typeof value !== 'string' || [...value].length > max || (required && !value.trim())) fail(`Enter ${required ? 'a value' : 'text'} of at most ${max} characters.`);
  return value.trim().replace(/\u0000/g, '');
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail('Invalid identifier.');
  return value;
}
export function ids(value, max = 20) {
  if (!Array.isArray(value) || value.length > max) fail(`Select up to ${max} companions.`);
  return [...new Set(value.map(id))];
}
export function choice(value, options) {
  if (!options.includes(value)) fail('Choose a valid option.');
  return value;
}
export function bool(value) {
  if (typeof value !== 'boolean') fail('Expected true or false.');
  return value;
}
export function email(value) {
  const result = text(value, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('Enter a valid email address.');
  return result;
}
export const today = () => new Date().toLocaleDateString('en-CA', {timeZone: 'Europe/Vilnius'});
export function viewing(body) {
  const status = choice(body.status, ['watched', 'watchlist']);
  const scope = choice(body.scope, ['personal', 'household', 'linked']);
  if (status === 'watchlist' && scope === 'linked') fail('Only viewings can be shared with linked companions.');
  const data = {status, scope, notes: text(body.notes ?? '', 2000), attendees: text(body.attendees ?? '', 200), watched_on: null, rating: null, watch_company: 'unspecified', companion_ids: []};
  if (status === 'watched') {
    const date = body.watched_on;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < '1870-01-01' || date > today()) fail('Choose a valid viewing date, today or earlier.');
    data.watched_on = date;
    if (body.rating !== null && body.rating !== undefined && body.rating !== '') {
      if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) fail('Choose a rating from 1 to 5.');
      data.rating = body.rating;
    }
    data.watch_company = choice(body.watch_company ?? 'unspecified', ['unspecified', 'alone', 'companions']);
    data.companion_ids = ids(body.companion_ids ?? []);
    if ((data.watch_company === 'companions') !== (data.companion_ids.length > 0)) fail('Choose companions when watching with other people.');
  }
  return data;
}
export function parseMovieId(value, provider) {
  choice(provider, ['kinopoisk', 'imdb']);
  if (!['string', 'number'].includes(typeof value)) fail('Enter a movie ID or film URL.');
  let result = String(value).trim();
  if (!result) return provider === 'kinopoisk' ? 0 : '';
  if (result.length > 500) fail('Invalid movie link.');
  if (/^https?:/i.test(result)) {
    let url; try { url = new URL(result); } catch { fail('Invalid movie link.'); }
    const hosts = provider === 'kinopoisk' ? ['kinopoisk.ru', 'www.kinopoisk.ru'] : ['imdb.com', 'www.imdb.com', 'm.imdb.com'];
    const match = url.pathname.match(provider === 'kinopoisk' ? /^\/film\/([1-9][0-9]{0,7})\/?$/ : /^\/title\/(tt[0-9]{7,10})\/?$/);
    if (!hosts.includes(url.hostname) || url.port || url.username || url.password || !match) fail('Use a Kinopoisk film URL or an IMDb title URL.');
    result = match[1];
  }
  if (provider === 'kinopoisk' && /^[1-9][0-9]{0,7}$/.test(result) && Number(result) <= 15000000) return Number(result);
  if (provider === 'imdb' && /^tt[0-9]{7,10}$/.test(result) && Number(result.slice(2)) > 0) return result;
  fail(provider === 'imdb' ? 'Enter an IMDb ID beginning with tt.' : 'Enter a valid Kinopoisk film ID.');
}
export function activeLink(companion, profiles) {
  const owner = profiles.get(companion.user_id), target = profiles.get(companion.linked_user_id);
  return !!(target && owner && target.id !== owner.id && owner.household_id && owner.household_id === target.household_id && companion.linked_household_id === owner.household_id && companion.owner_epoch === owner.membership_epoch && companion.target_epoch === target.membership_epoch);
}
export function validGrant(entry, grant, companions, profiles) {
  const companion = companions.get(grant.companion_id);
  return !!(companion && entry.user_id === companion.user_id && entry.status === 'watched' && entry.companion_ids.includes(companion.id) && grant.user_id === companion.linked_user_id && grant.version === companion.link_version && activeLink(companion, profiles));
}
export function canSee(entry, viewer, companions, profiles) {
  return entry.user_id === viewer.id || (!!entry.household_id && entry.household_id === viewer.household_id) || (entry.grants ?? []).some(grant => grant.user_id === viewer.id && validGrant(entry, grant, companions, profiles));
}
export function watchKey(entry) {
  return entry.status === 'watchlist' ? hash(`${entry.household_id ? 'h:' + entry.household_id : 'u:' + entry.user_id}:${entry.movie_key}`) : null;
}
