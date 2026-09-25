import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createApp, localDatabase, serve} from '../scripts/local-server.mjs';
import {Catalog} from '../server/catalog.js';
import {identityFixture} from './identity-fixture.mjs';
const identity = identityFixture(), uids = {};

const {db, binding} = await localDatabase();
const secrets = {origin: 'https://films.example.test', local: true, ownerEmail: 'owner@example.test', kinopoiskToken: 'fixture'};
const catalog = new Catalog(db, secrets, async url => new Response(JSON.stringify(url.pathname === '/api/v2.2/films/430' ? {kinopoiskId: 430, nameRu: 'Шрек', year: 2001, imdbId: 'tt0126029', ratingKinopoisk: 8, ratingImdb: 7.9, posterUrl: 'https://kinopoiskapiunofficial.tech/images/posters/kp/430.jpg'} : {items: [{kinopoiskId: 430, nameRu: 'Шрек', year: 2001, imdbId: 'tt0126029', ratingKinopoisk: 8}]}), {status: 200, headers: {'Content-Type': 'application/json'}}));
let server, base;
const tokens = {};
async function user(key, {admin = false, verified = true, approved = true} = {}) {
  const address = `${key}@example.test`;
  const uid = identity.account(`test-${key}`, address, {name: key, ...(verified ? {} : {providers: []})});
  uids[key] = uid;
  await db.doc(`users/${uid}`).set({name: key, email: address, approved, complimentary: false, household_id: '', membership_epoch: uid, created_at: Date.now()});
  tokens[key] = identity.login(`test-${key}`); return uid;
}
async function call(who, route, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}/api/${route}`, {method, headers: {'Content-Type': 'application/json', Origin: secrets.origin, ...(who ? {Cookie: tokens[who] || who} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json(), headers: response.headers};
}
async function ok(who, route, method = 'GET', body, expected = 200) { const result = await call(who, route, method, body); assert.equal(result.status, expected, JSON.stringify(result.data)); return result.data; }
const viewing = (title = 'A private film', more = {}) => ({movie: {title, year: 2001}, status: 'watched', scope: 'personal', watched_on: '2024-01-01', notes: 'Private notes', ...more});
before(async () => {
  await db.doc('settings/app').set({billingEnabled: true, publicRegistration: false});
  server = await serve(createApp({db, secrets, catalog, identityFetch: identity.transport})); base = server.base;
  await user('owner', {admin: true}); await user('author'); await user('wife'); await user('third'); await user('outsider'); await user('unverified', {verified: false}); await user('pending', {approved: false});
});
after(async () => { await server.close(); binding.close(); });

test('Google sessions are required, everyone has access, and administration stays private', async () => {
  assert.equal((await call(null, 'entries')).status, 401);
  assert.equal((await call('forged-token', 'entries')).status, 401);
  assert.equal((await call('unverified', 'session')).status, 401);
  assert.equal((await call('pending', 'entries')).status, 200);
  assert.equal((await call('author', 'admin/overview')).status, 403);
  assert.equal((await call('author', 'database')).status, 404);
  assert.equal((await call('author', 'admin/users')).status, 403);
  assert.equal((await call('owner', 'admin/users')).status, 200);
  for (const path of ['billing/checkout', 'billing/portal', 'billing/webhook/live', 'membership', 'admin/approve-email', 'admin/settings', 'admin/billing/enable', 'invitations']) assert.equal((await call('owner', path, 'POST', {})).status, 404, path);
});
test('private entries, validation, repeat viewings, and watchlist race protection', async () => {
  const entry = await ok('author', 'entries', 'POST', viewing(), 201);
  assert.equal((await ok('outsider', 'entries')).total, 0);
  assert.equal((await call('outsider', `entries/${entry.id}`, 'PUT', viewing('Stolen'))).status, 403);
  assert.equal((await call('outsider', `entries/${entry.id}`, 'DELETE')).status, 403);
  for (const patch of [{rating: 8}, {watched_on: '2023-02-29'}, {scope: 'household'}, {watch_company: 'companions', companion_ids: ['not-mine']}]) assert.equal((await call('author', 'entries', 'POST', viewing('Invalid', patch))).status, 400);
  await ok('author', 'entries', 'POST', viewing(), 201);
  assert.equal((await ok('author', 'entries?q=A%20private%20film')).total, 2);
  const watchlist = viewing('Next film', {status: 'watchlist'});
  const results = await Promise.all([call('author', 'entries', 'POST', watchlist), call('author', 'entries', 'POST', watchlist)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const watchId = results.find(r => r.status === 201).data.id;
  await ok('author', `entries/${watchId}`, 'PUT', viewing('Next film'));
  await ok('author', 'entries', 'POST', watchlist, 201);
  assert.equal((await ok('author', 'entries?status=watchlist')).total, 1);
  assert.equal((await call('author', 'entries?page=-1')).status, 400);
  assert.match((await call('author', 'entries')).headers.get('cache-control'), /no-store/);
});
test('catalog metadata is server verified and manual links never forge ratings', async () => {
  const result = await ok('author', 'lookup?provider=kinopoisk&id=430');
  assert.equal(result.title, 'Шрек');
  await ok('author', 'entries', 'POST', viewing('ignored', {movie: {...result, title: 'Forged title', kinopoisk_rating: 10, poster_url: 'https://evil.example/x.jpg'}}), 201);
  const saved = (await ok('author', 'entries?q=Шрек')).items[0];
  assert.equal(saved.kinopoisk_rating, 8); assert.equal(saved.title, 'Шрек');
  assert.equal((await call('author', 'entries', 'POST', viewing('Unverified catalog', {movie: {title: 'Fake', kinopoisk_id: 9999}}))).status, 400);
  await ok('author', 'entries', 'POST', viewing('Manual linked', {movie: {title: 'Manual linked', links: {kinopoisk: '430', imdb: 'tt0126029'}, kinopoisk_rating: 10}}), 201);
  const manual = (await ok('author', 'entries?q=Manual')).items[0];
  assert.equal(manual.linked_imdb_id, 'tt0126029'); assert.equal(manual.kinopoisk_rating, null);
});
test('companion sharing needs consent, cannot leak to household peers, and revokes on relink or rejoin', async () => {
  await ok('author', 'household', 'POST', {name: 'Our cinema'}, 201);
  let invitation = await ok('author', 'household/invite', 'POST', {});
  await ok('wife', 'household/join', 'POST', invitation); await ok('third', 'household/join', 'POST', invitation);
  assert.equal((await call('wife', 'household/invite', 'POST', {})).status, 403);
  let c = await ok('author', 'companions', 'POST', {name: 'My wife', linked_user_id: uids.wife}, 201);
  const body = viewing('Tagged private', {watch_company: 'companions', companion_ids: [c.id]});
  const entry = await ok('author', 'entries', 'POST', body, 201);
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  c = await ok('author', `companions/${c.id}`, 'PUT', {name: 'My wife', linked_user_id: uids.wife, share_existing: true});
  assert.equal(c.shared_count, 1);
  assert.equal((await ok('wife', 'entries?scope=mine&q=Tagged')).items[0].notes, 'Private notes');
  assert.equal((await ok('third', 'entries?q=Tagged')).total, 0);
  assert.equal((await call('wife', `entries/${entry.id}`, 'PUT', body)).status, 403);
  await ok('author', 'entries', 'POST', {...body, movie: {title: 'New private'}}, 201);
  assert.equal((await ok('wife', 'entries?q=New%20private')).total, 0);
  await ok('author', `entries/${entry.id}`, 'PUT', body);
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  await ok('author', `entries/${entry.id}`, 'PUT', {...body, scope: 'linked', shared_companion_ids: [c.id]});
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 1);
  await ok('author', `companions/${c.id}`, 'PUT', {name: 'My wife', linked_user_id: uids.third});
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  assert.equal((await ok('third', 'entries?q=Tagged')).total, 0);
  await ok('author', `companions/${c.id}`, 'PUT', {name: 'My wife', linked_user_id: uids.wife});
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  await ok('author', `companions/${c.id}`, 'PUT', {name: 'My wife', linked_user_id: uids.wife, share_existing: true});
  await ok('wife', 'household/membership', 'DELETE');
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  await ok('wife', 'household/join', 'POST', invitation);
  assert.equal((await ok('wife', 'entries?q=Tagged')).total, 0);
  await ok('author', `companions/${c.id}`, 'PUT', {name: 'My partner', linked_user_id: uids.wife, share_existing: true});
  await ok('author', 'entries', 'POST', viewing('Household viewing', {scope: 'household', watch_company: 'companions', companion_ids: [c.id]}), 201);
  assert.equal((await ok('wife', 'entries?scope=mine&q=Household')).total, 1);
  assert.equal((await ok('third', 'entries?scope=mine&q=Household')).total, 0);
  assert.equal((await ok('third', 'entries?scope=household&q=Household')).total, 1);
  const privateCompanion = await ok('author', 'companions', 'POST', {name: 'Private label'}, 201);
  assert.ok(!(await ok('third', 'bootstrap')).companions.some(c => c.id === privateCompanion.id));
  await ok('author', `household/members/${uids.wife}`, 'DELETE');
  assert.equal((await ok('wife', 'entries')).total, 0);
  assert.equal((await call('wife', 'household/join', 'POST', invitation)).status, 400);
  assert.equal((await call('author', 'household/membership', 'DELETE')).status, 400);
});
