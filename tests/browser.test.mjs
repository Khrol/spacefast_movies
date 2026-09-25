import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
import {createApp, localDatabase, serve} from '../scripts/local-server.mjs';
import {googleFixture} from './google-fixture.mjs';
import {hash} from '../server/domain.js';
import {localGoogle} from '../scripts/local-google.mjs';
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
async function googleBrowser(page, who) {
  await page.exposeFunction('testGoogleCredential', nonce => google.token(nonce, {sub: `ui-${who}`, email: `ui-${who}@example.test`, name: who, hd: 'example.test'}));
  // Stub only Google's external SDK. The app still submits a signed JWT to its
  // real challenge/login endpoints and receives a real HttpOnly session cookie.
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
  await expect(page.getByRole('button', {name: 'Try Google sign-in again'})).toBeVisible();
  await page.unroute('https://accounts.google.com/gsi/client');
  await googleBrowser(page, 'retry-reader');
  await page.getByRole('button', {name: 'Try Google sign-in again'}).click();
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
