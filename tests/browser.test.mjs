import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
import {createApp, localDatabase, serve} from '../scripts/local-server.mjs';
import {googleFixture} from './google-fixture.mjs';
import {hash} from '../server/domain.js';
import {localGoogle} from '../scripts/local-google.mjs';
import {Catalog} from '../server/catalog.js';
import {Posters} from '../server/posters.js';
const {db, binding} = await localDatabase();
const google = await googleFixture();
let server;
let browser;
before(async () => {
  await db.doc('settings/app').set({billingEnabled: false, publicRegistration: false});
  server = await serve(createApp({db, secrets: {local: true, googleClientId: google.clientId, ownerEmail: 'ui-admin@example.test'}, googleKeys: google.keys}));
  browser = await chromium.launch({headless: true, ...(process.env.REEL_BROWSER_CHANNEL ? {channel: process.env.REEL_BROWSER_CHANNEL} : process.platform === 'darwin' ? {channel: 'chrome'} : {})});
  await mkdir('test-results', {recursive: true});
});
after(async () => { await browser?.close(); await server?.close(); binding.close(); });
async function googleBrowser(page, who, {expireFirst = false} = {}) {
  let first = expireFirst;
  await page.exposeFunction('testGoogleCredential', async nonce => {
    if (first) {
      first = false;
      const challenges = await db.collection('authChallenges').get();
      const challenge = challenges.docs.find(s => s.data().nonce === nonce);
      await challenge.ref.update({expiresAt: 1});
    }
    return google.token(nonce, {sub: `ui-${who}`, email: `ui-${who}@example.test`, name: who, hd: 'example.test'});
  });
  // Stub only Google's external SDK. The app still submits a signed JWT to its
  // real challenge/login endpoints and receives a real app session.
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({contentType: 'text/javascript', body: `
    window.google = {accounts: {id: {
      initialize(options) {this.options = options;},
      renderButton(container) {
        const button = document.createElement('button'); button.textContent = 'Continue with Google';
        button.onclick = async () => this.options.callback({credential: await window.testGoogleCredential(this.options.nonce)});
        container.append(button);
      },
      disableAutoSelect() {}
    }}};
  `}));
}
async function login(page, who) {
  await googleBrowser(page, who);
  await page.goto(server.base);
  await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
}
test('saved and searched posters load from our origin and reuse persistent copies', {timeout: 60000}, async () => {
  const local = await localDatabase(), upstream = new Map();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x8AAAAASUVORK5CYII=', 'base64');
  const kpSource = 'https://kinopoiskapiunofficial.tech/images/posters/kp_small/430.jpg';
  const movies = [
    {title: 'Shrek', year: 2001, kinopoisk_id: 430, poster_url: kpSource},
    {title: 'Fight Club', year: 1999, tmdb_id: 550, poster_path: '/abc123.jpg'},
    {title: 'Missing poster', year: 2000, kinopoisk_id: 431, poster_url: kpSource.replace('430', '431')},
  ];
  for (const movie of movies) await local.db.doc(`catalogMovies/${movie.kinopoisk_id ? 'kinopoisk_' + movie.kinopoisk_id : 'tmdb_' + movie.tmdb_id}`).set(movie);
  const secrets = {googleClientId: google.clientId, kinopoiskToken: 'fixture', tmdbToken: 'fixture'};
  const posters = new Posters(local.db, async url => {
    upstream.set(url, (upstream.get(url) || 0) + 1);
    return url.includes('431') ? new Response(null, {status: 404}) : new Response(png);
  });
  const catalog = new Catalog(local.db, secrets, async url => Response.json(url.hostname === 'api.themoviedb.org'
    ? {results: [{id: 550, title: 'Fight Club', release_date: '1999-01-01', poster_path: '/abc123.jpg'}]}
    : {items: [{kinopoiskId: 430, nameRu: 'Shrek', year: 2001, posterUrlPreview: kpSource}]}));
  const posterServer = await serve(createApp({db: local.db, secrets, posters, catalog, googleKeys: google.keys}));
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}}), page = await context.newPage(), externalImages = [];
  page.on('request', r => {if (r.resourceType() === 'image' && new URL(r.url()).origin !== posterServer.base) externalImages.push(r.url());});
  try {
    await googleBrowser(page, 'poster-reader');
    await page.goto(posterServer.base);
    await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
    const statuses = await page.evaluate(async movies => {
      const statuses = [];
      for (const movie of movies) statuses.push((await fetch('/api/entries', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Reel-Session': sessionStorage.getItem('reel_google_session')}, body: JSON.stringify({movie, status: 'watched', scope: 'personal', watched_on: '2020-01-01', watch_company: 'unspecified'})})).status);
      return statuses;
    }, movies);
    assert.deepEqual(statuses, [201, 201, 201]);
    await page.reload();
    await expect(page.locator('.movie-card')).toHaveCount(3);
    const copies = page.locator('.movie-card .poster-copy');
    await expect(copies).toHaveCount(2);
    await expect.poll(() => copies.evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
    assert.deepEqual((await copies.evaluateAll(images => images.map(img => new URL(img.src).pathname))).sort(), ['/api/posters/kinopoisk/430', '/api/posters/tmdb/550']);
    await expect(page.locator('.movie-card').filter({hasText: 'Missing poster'}).locator('.poster-art strong')).toContainText('Missing poster');
    await page.reload();
    await expect(page.locator('.movie-card')).toHaveCount(3);
    await page.getByRole('button', {name: '＋ Log a film', exact: true}).click();
    for (const provider of ['kinopoisk', 'tmdb']) {
      await page.locator('#catalog-source').selectOption(provider);
      await page.locator('#catalog-query').fill('test film');
      await page.locator('#search-catalog').click();
      const image = page.locator('#catalog-results .poster-copy');
      await expect(image).toHaveCount(1);
      await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
      assert.ok((await image.getAttribute('src')).startsWith('/api/posters/'));
    }
    assert.equal(upstream.get(kpSource), 1);
    assert.equal(upstream.get('https://image.tmdb.org/t/p/w342/abc123.jpg'), 1);
    assert.deepEqual(externalImages, []);
    await page.screenshot({path: 'test-results/local-posters.png', fullPage: true});
  } finally {await context.close(); await posterServer.close(); local.binding.close();}
});
test('Google is the only sign-in and a new account opens an empty diary immediately', {timeout: 60000}, async () => {
  const context = await browser.newContext(), page = await context.newPage();
  await googleBrowser(page, 'newcomer');
  await page.goto(server.base + '/#setup=retired-secret');
  await expect(page.getByRole('button', {name: 'Continue with Google', exact: true})).toBeVisible();
  assert.equal(new URL(page.url()).hash, '');
  await expect(page.locator('input[type=password], input[type=email]')).toHaveCount(0);
  await expect(page.getByText('Request an invitation', {exact: true})).toHaveCount(0);
  await page.screenshot({path: 'test-results/google-login-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'test-results/google-login-mobile.png', fullPage: true});
  await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
  await expect(page.locator('.movie-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Membership', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Continue with Google', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
  await context.close();
});
test('diary, household, consent sharing, account revocation, and mobile layout work in the browser', {timeout: 120000}, async () => {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}}), other = await browser.newContext();
  const page = await context.newPage(), wife = await other.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); wife.on('pageerror', error => errors.push(error.message));
  await login(page, 'author');
  await page.getByRole('button', {name: '＋ Log a film', exact: true}).click();
  await page.getByLabel('Film title', {exact: true}).fill('The Apartment');
  await page.getByLabel('Release year', {exact: false}).fill('1960');
  await page.getByLabel('Watched with', {exact: true}).last().selectOption('companions');
  await page.getByRole('button', {name: '＋ My wife', exact: true}).click();
  await expect(page.locator('#companion-choices')).toContainText('My wife');
  await page.getByLabel('A little note', {exact: false}).fill('A quiet evening together.');
  await page.getByRole('button', {name: 'Save film ↗', exact: true}).click();
  await expect(page.locator('.movie-card')).toContainText('The Apartment');
  await page.getByRole('button', {name: 'Our household', exact: false}).click();
  await page.getByLabel('Household name').fill('The Friday Film Club');
  await page.getByRole('button', {name: 'Create household ↗', exact: true}).click();
  await page.getByRole('button', {name: 'Create invitation code ↗', exact: true}).click();
  const code = await page.getByLabel('Share this code').inputValue();
  await login(wife, 'wife');
  await wife.getByRole('button', {name: 'Our household', exact: false}).click();
  await wife.getByLabel('Invitation code', {exact: true}).fill(code);
  await wife.getByRole('button', {name: 'Join household ↗', exact: true}).click();
  await expect(wife.getByRole('heading', {name: 'The Friday Film Club'})).toBeVisible();
  await page.getByRole('button', {name: 'Watching companions', exact: false}).click();
  await page.getByLabel('Family account (optional)').selectOption((await db.doc(`googleAccounts/${hash('ui-wife')}`).get()).data().uid);
  await page.getByLabel('Share all earlier viewings', {exact: false}).check();
  await page.getByRole('button', {name: 'Save companion', exact: true}).click();
  await expect(page.locator('#toast')).toContainText('earlier viewing');
  await wife.getByRole('button', {name: /Film diary/}).click();
  await expect(wife.locator('.movie-card')).toContainText('A quiet evening together.');
  await expect(wife.locator('.movie-card')).toContainText('You watched this');
  await page.getByRole('button', {name: /Film diary/}).click();
  await page.getByRole('button', {name: 'Edit entry ↗'}).click();
  await page.getByLabel('Who can see this?').selectOption('personal');
  await page.getByRole('button', {name: 'Save film ↗'}).click();
  await expect(page.locator('#entry-dialog')).not.toBeVisible();
  await wife.getByRole('button', {name: /Film diary/}).click();
  await expect(wife.locator('.movie-card')).toHaveCount(0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: 'test-results/diary-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: 'test-results/diary-mobile.png', fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout should not overflow horizontally');
  await expect(page.getByRole('button', {name: 'Membership', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: /Film diary/}).click();
  await expect(page.locator('.movie-card')).toHaveCount(1);
  assert.deepEqual(errors, []);
  await context.close(); await other.close();
});
test('administration lists accounts without approval or payment controls', {timeout: 60000}, async () => {
  const context = await browser.newContext(), page = await context.newPage();
  await login(page, 'admin');
  await page.getByRole('button', {name: 'Administration', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Accounts', exact: true})).toBeVisible();
  await expect(page.locator('#screen')).toContainText('ui-newcomer@example.test');
  await expect(page.locator('#screen input, #screen form')).toHaveCount(0);
  await expect(page.locator('#screen')).not.toContainText('Stripe');
  await expect(page.locator('#screen')).not.toContainText('membership');
  await context.close();
});
test('blocked Google SDK shows a retry and local demo exercises the app sessions', {timeout: 60000}, async () => {
  const context = await browser.newContext(), page = await context.newPage();
  await page.route('https://accounts.google.com/gsi/client', route => route.abort());
  await page.goto(server.base);
  await expect(page.getByRole('status')).toContainText('Google sign-in could not load');
  await expect(page.getByRole('button', {name: 'Refresh sign-in'})).toBeVisible();
  await page.unroute('https://accounts.google.com/gsi/client');
  await googleBrowser(page, 'retry-reader');
  await page.getByRole('button', {name: 'Refresh sign-in'}).click();
  await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
  await context.close();

  const local = await localDatabase(), demo = await localGoogle();
  const demoServer = await serve(createApp({db: local.db, secrets: {local: true, localGoogle: true, googleClientId: demo.clientId, ownerEmail: 'developer@gmail.com', origin: 'http://localhost:9500'}, googleKeys: demo.keys}), {port: 9500, handleLocal: demo.handle});
  const demoContext = await browser.newContext(), demoPage = await demoContext.newPage();
  try {
    await demoPage.goto('http://localhost:9500');
    await expect(demoPage.getByRole('status')).toContainText('Local demo');
    await demoPage.getByRole('button', {name: 'Local developer'}).click();
    await expect(demoPage.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
    await expect(demoPage.getByRole('button', {name: 'Administration', exact: true})).toBeVisible();
    await demoPage.getByRole('button', {name: 'Sign out', exact: true}).click();
    await demoPage.getByRole('button', {name: 'Local guest'}).click();
    await expect(demoPage.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
    await expect(demoPage.getByRole('button', {name: 'Administration', exact: true})).toHaveCount(0);
  } finally {await demoContext.close(); await demoServer.close(); local.binding.close();}
});

test('expired Google sign-in has a visible refresh button and the next attempt succeeds', {timeout: 60000}, async () => {
  const context = await browser.newContext(), page = await context.newPage();
  try {
    await googleBrowser(page, 'expired-reader', {expireFirst: true});
    await page.goto(server.base);
    await expect(page.getByRole('button', {name: 'Refresh sign-in'})).toBeVisible();
    await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
    await expect(page.getByRole('status')).toContainText('Your sign-in expired');
    await page.getByRole('button', {name: 'Refresh sign-in'}).click();
    await page.getByRole('button', {name: 'Continue with Google', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Your life in movies.'})).toBeVisible();
    const session = await page.evaluate(() => sessionStorage.getItem('reel_google_session'));
    await db.doc(`authSessions/${hash(session)}`).update({expiresAt: 1});
    await page.reload();
    await expect(page.getByRole('button', {name: 'Refresh sign-in'})).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('reel_google_session')), null);
  } finally {await context.close();}
});
