import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMovieId, viewing, activeLink, validGrant, canSee, watchKey} from '../server/domain.js';
import {Catalog, safePoster} from '../server/catalog.js';

test('catalog calls native fetch without binding it to the Catalog instance', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async function (url, options) {
    // Workers enforce the native receiver; Node's fetch accepts any receiver.
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    requests.push(url.hostname);
    return Response.json({ok: true});
  });
  const catalog = new Catalog(null, {kinopoiskToken: 'test-kp', tmdbToken: 'test-tmdb'});
  for (const provider of ['kinopoisk', 'tmdb']) assert.deepEqual(await catalog.request(provider, '/test'), {ok: true});
  assert.deepEqual(requests, ['kinopoiskapiunofficial.tech', 'api.themoviedb.org']);
});

test('catalog connection failures log the provider and error type without credentials', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const token = 'private-catalog-key';
  const catalog = new Catalog(null, {tmdbToken: token}, async () => {throw new TypeError(`Request failed with ${token}`);});
  await assert.rejects(catalog.request('tmdb', '/test'), error => error.status === 502 && !error.message.includes(token));
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Catalog connection failed:', 'tmdb', 'TypeError']]);
});

test('catalog requests support the hosted fetch API and never follow credential-bearing redirects', async () => {
  let redirect = false;
  const requests = [];
  const catalog = new Catalog(null, {kinopoiskToken: 'test-kp', tmdbToken: 'test-tmdb'}, async (url, options) => {
    // Spacefast supports manual/follow, but rejects redirect: error.
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode');
    requests.push({url, options});
    return redirect ? new Response('', {status: 302, headers: {Location: 'https://untrusted.example/collect'}}) : Response.json({ok: true});
  });
  for (const provider of ['kinopoisk', 'tmdb']) {
    assert.deepEqual(await catalog.request(provider, '/test'), {ok: true});
  }
  assert.equal(requests[0].options.headers['X-API-KEY'], 'test-kp');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-tmdb');
  redirect = true;
  for (const provider of ['kinopoisk', 'tmdb']) await assert.rejects(catalog.request(provider, '/test'), error => error.status === 502);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.options.redirect === 'manual' && ['kinopoiskapiunofficial.tech', 'api.themoviedb.org'].includes(r.url.hostname)));
});

test('movie IDs preserve IMDb zeros and reject untrusted URLs', () => {
  assert.equal(parseMovieId('https://www.imdb.com/title/tt0126029/?ref_=x', 'imdb'), 'tt0126029');
  assert.equal(parseMovieId('https://www.kinopoisk.ru/film/430/', 'kinopoisk'), 430);
  for (const value of ['https://evil.example/film/430/', 'https://www.kinopoisk.ru.evil.example/film/430/', 'https://user@kinopoisk.ru/film/430/', 'https://kinopoisk.ru:444/film/430/', -1, true, {}]) assert.throws(() => parseMovieId(value, 'kinopoisk'));
  assert.throws(() => parseMovieId('tt0000000', 'imdb'));
});
test('posters use only allowed HTTPS hosts and paths', () => {
  assert.equal(safePoster('http://kinopoiskapiunofficial.tech/images/posters/kp/430.jpg'), 'https://kinopoiskapiunofficial.tech/images/posters/kp/430.jpg');
  for (const url of ['https://evil.example/x.jpg', 'javascript:alert(1)', 'https://kinopoiskapiunofficial.tech/private/x', 'https://kinopoiskapiunofficial.tech/images/posters/x?token=x']) assert.equal(safePoster(url), '');
});
test('viewings validate real dates, ratings, notes, and companions', () => {
  const body = {status: 'watched', scope: 'personal', watched_on: '2024-02-29'};
  assert.equal(viewing(body).rating, null);
  for (const delta of [{watched_on: '2024-02-30'}, {watched_on: '2999-01-01'}, {rating: 6}, {rating: '5'}, {notes: 'x'.repeat(2001)}, {watch_company: 'companions'}, {companion_ids: ['x']}]) assert.throws(() => viewing({...body, ...delta}));
  assert.equal(viewing({...body, watch_company: 'companions', companion_ids: ['label']}).companion_ids[0], 'label');
});
test('private sharing requires current household epochs and explicit matching grants', () => {
  const profiles = new Map([['a', {id: 'a', household_id: 'h', membership_epoch: 'a1'}], ['b', {id: 'b', household_id: 'h', membership_epoch: 'b1'}], ['c', {id: 'c', household_id: 'h', membership_epoch: 'c1'}]]);
  const companion = {id: 'label', user_id: 'a', linked_user_id: 'b', linked_household_id: 'h', owner_epoch: 'a1', target_epoch: 'b1', link_version: 'v1'};
  const companions = new Map([['label', companion]]), grant = {companion_id: 'label', user_id: 'b', version: 'v1'};
  const entry = {user_id: 'a', status: 'watched', household_id: '', companion_ids: ['label'], grants: [grant]};
  assert.equal(activeLink(companion, profiles), true);
  assert.equal(canSee(entry, profiles.get('b'), companions, profiles), true);
  assert.equal(canSee(entry, profiles.get('c'), companions, profiles), false);
  assert.equal(canSee({...entry, grants: []}, profiles.get('b'), companions, profiles), false);
  profiles.get('b').membership_epoch = 'b2';
  assert.equal(validGrant(entry, grant, companions, profiles), false);
  profiles.get('b').membership_epoch = 'b1'; companion.link_version = 'v2';
  assert.equal(validGrant(entry, grant, companions, profiles), false);
});
test('watchlist uniqueness is separate from repeat viewings', () => {
  assert.equal(watchKey({status: 'watched'}), null);
  assert.equal(watchKey({status: 'watchlist', user_id: 'a', household_id: 'h', movie_key: 'tmdb_1'}), watchKey({status: 'watchlist', user_id: 'b', household_id: 'h', movie_key: 'tmdb_1'}));
});
