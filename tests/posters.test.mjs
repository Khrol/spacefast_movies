import test from 'node:test';
import assert from 'node:assert/strict';
import {localDatabase, createApp} from '../scripts/local-server.mjs';
import {Posters} from '../server/posters.js';
import {posterPath} from '../src/posters.js';
import {contentSecurityPolicy} from '../scripts/headers.mjs';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x8AAAAASUVORK5CYII=', 'base64');
const source = 'https://kinopoiskapiunofficial.tech/images/posters/kp_small/430.jpg';
const request = (path, options) => new Request(`https://diary.test/api/posters/${path}`, options);

test('poster copies persist outside diary state and serve without external requests or sign-in', async t => {
  const {db, binding} = await localDatabase(); t.after(() => binding.close());
  await db.doc('catalogMovies/kinopoisk_430').set({poster_url: source});
  const calls = [];
  const posters = new Posters(db, async (url, options) => {calls.push({url, options}); return new Response(png);});
  const app = createApp({db, posters});
  const response = await app.fetch(request('kinopoisk/430'));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.match(response.headers.get('Cache-Control'), /public.*immutable/);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, source);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Accept']);

  await db.doc('catalogMovies/kinopoisk_430').delete();
  const restarted = new Posters(db, () => {throw new Error('Upstream no longer exists');});
  const next = await restarted.response('kinopoisk', '430', request('kinopoisk/430'));
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), png);
  const conditional = await restarted.response('kinopoisk', '430', request('kinopoisk/430', {headers: {'If-None-Match': response.headers.get('ETag')}}));
  assert.equal(conditional.status, 304); assert.equal(await conditional.text(), '');
  const head = await app.fetch(request('kinopoisk/430', {method: 'HEAD'}));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await app.fetch(new Request('https://diary.test/api/entries'))).status, 401);
  const {results} = await binding.prepare('SELECT payload FROM reel_state WHERE id = 1').all();
  assert.ok(!results[0].payload.includes(png.toString('base64')));
});

test('only registered catalog poster sources can be copied, including TMDB', async t => {
  const {db, binding} = await localDatabase(); t.after(() => binding.close());
  let calls = 0;
  const posters = new Posters(db, async url => {calls++; assert.equal(url, 'https://image.tmdb.org/t/p/w342/abc123.jpg'); return new Response(png);});
  for (const [provider, id] of [['other', '430'], ['kinopoisk', '0'], ['kinopoisk', '../430'], ['kinopoisk', '9007199254740992'], ['kinopoisk', '123']]) {
    await assert.rejects(posters.response(provider, id, request('kinopoisk/123?url=https://evil.test/a')), e => e.status === 404);
  }
  for (const url of ['https://127.0.0.1/a', 'https://evil.test/a.jpg', 'https://kinopoiskapiunofficial.tech/private/x', 'https://kinopoiskapiunofficial.tech/images/posters/x?secret=x']) {
    await db.doc('catalogMovies/kinopoisk_430').set({poster_url: url});
    await assert.rejects(posters.response('kinopoisk', '430', request('kinopoisk/430')), e => e.status === 404);
  }
  assert.equal(calls, 0);
  await db.doc('catalogMovies/tmdb_550').set({poster_path: '/abc123.jpg'});
  const response = await posters.response('tmdb', '550', request('tmdb/550'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png); assert.equal(calls, 1);
});

test('redirects, active content, and oversized responses never become stored posters', async t => {
  const {db, binding} = await localDatabase(); t.after(() => binding.close());
  await db.doc('catalogMovies/kinopoisk_430').set({poster_url: source});
  let streamed = false;
  for (const makeResponse of [
    () => new Response(null, {status: 302, headers: {Location: 'https://evil.test/private'}}),
    () => new Response('<svg onload="alert(1)"></svg>', {headers: {'Content-Type': 'image/png'}}),
    () => new Response(png, {headers: {'Content-Length': 1024 * 1024 + 1}}),
    () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000));}, cancel() {streamed = true;}})),
  ]) {
    const posters = new Posters(db, async () => makeResponse());
    await assert.rejects(posters.response('kinopoisk', '430', request('kinopoisk/430')), e => e.status === 502);
    assert.equal(await posters.stored('kinopoisk_430'), undefined);
  }
  assert.equal(streamed, true);
});

test('concurrent poster requests retain a single durable copy', async t => {
  const {db, binding} = await localDatabase(); t.after(() => binding.close());
  await db.doc('catalogMovies/kinopoisk_430').set({poster_url: source});
  const first = new Posters(db, async () => new Response(png)), second = new Posters(db, async () => new Response(png));
  const copies = await Promise.all([first, first, second].map(store => store.response('kinopoisk', '430', request('kinopoisk/430'))));
  for (const response of copies) assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await binding.prepare('SELECT COUNT(*) AS count FROM reel_posters').all()).results[0].count, 1);
});

test('old and new catalog metadata produces only same-origin poster paths', () => {
  assert.equal(posterPath({kinopoisk_id: 430, poster_url: source}), '/api/posters/kinopoisk/430');
  assert.equal(posterPath({tmdb_id: 550, poster_path: '/abc123.jpg'}), '/api/posters/tmdb/550');
  assert.equal(posterPath({poster_url: 'https://evil.test/a.jpg'}), '');
  assert.equal(posterPath({kinopoisk_id: '../430', poster_url: source}), '');
  assert.equal(posterPath({linked_kinopoisk_id: 430, poster_url: source}), '');
  assert.match(contentSecurityPolicy, /(?:^|; )img-src 'self' data:(?:;|$)/);
});
