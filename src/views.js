import {api, escape} from './api.js';

let generation = 0;
export async function administration(userAfter = '') {
  window.dispatchEvent(new Event('reel-section'));
  const screen = document.getElementById('screen'), version = ++generation;
  screen.setAttribute('aria-busy', 'true'); screen.innerHTML = '<p class="loading">Opening…</p>';
  document.querySelectorAll('[data-view]').forEach(e => {e.classList.remove('active'); e.removeAttribute('aria-current');});
  try {
    const [overview, users] = await Promise.all([api('admin/overview'), api(`admin/users?after=${encodeURIComponent(userAfter)}`)]);
    if (version !== generation || !screen.isConnected) return;
    screen.innerHTML = `<section class="page-heading"><div><p class="eyebrow">YOUR LITTLE CINEMA</p><h1>Everyone has <em>a seat.</em></h1><p class="intro">Anyone can sign in with Google and start their own private diary.</p></div></section>
      <section class="household-card"><h2>Accounts</h2><div class="admin-list">${users.items.map(user => `<article><h3>${escape(user.name)}</h3><p>${escape(user.email)}</p></article>`).join('')}</div><div class="pagination">${userAfter ? '<button class="button secondary" id="first-users">First page</button>' : ''}${users.next ? `<button class="button secondary" id="next-users" data-after="${users.next}">Next accounts</button>` : ''}</div></section>
      <section class="household-card"><h2>Movie catalogs</h2><p>${overview.catalog_providers.length ? `Connected: ${overview.catalog_providers.map(p => escape(p.name)).join(', ')}.` : 'No catalogs connected. Manual movie titles and links still work.'}</p></section>`;
    screen.querySelector('#first-users')?.addEventListener('click', () => administration());
    screen.querySelector('#next-users')?.addEventListener('click', event => administration(event.target.dataset.after));
  } catch (error) {
    if (version === generation && screen.isConnected) screen.innerHTML = `<p role="alert">${escape(error.message)}</p><button id="retry-admin" class="button secondary">Try again</button>`;
    screen.querySelector('#retry-admin')?.addEventListener('click', () => administration());
  } finally {screen.setAttribute('aria-busy', 'false');}
}
window.addEventListener('reel-diary', () => {++generation;});
