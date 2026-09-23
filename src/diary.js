import {api} from './api.js';
export function mountDiary() {
  'use strict';
  const root = document.getElementById('rt-app');
  if (!root) return;
  const screen = document.getElementById('screen');
  const dialog = document.getElementById('entry-dialog');
  const state = { view: 'watched', scope: 'mine', companion: 'all', query: '', page: 1, data: null, items: [], request: 0 };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = '<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="9" y="14" width="46" height="38" rx="5" stroke="currentColor" stroke-width="2"/><path d="M10 25h44M20 15l7 10m8-10 7 10M26 35l12 6-12 6V35Z" stroke="currentColor" stroke-width="2"/></svg>';
  let toastTimer, viewRequest = 0;
  const sectionChanged = () => { ++viewRequest; ++state.request; };
  window.ReelDiaryController?.abort();
  window.ReelDiaryController = new AbortController();
  window.addEventListener('reel-section', sectionChanged, {signal: window.ReelDiaryController.signal});
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }
  function syncAccount() {
    const data = state.data;
    document.getElementById('account-name').textContent = data.user.name;
    document.getElementById('avatar').textContent = data.user.name.slice(0, 1).toUpperCase();
    document.getElementById('count-watched').textContent = data.my_watched_count;
    document.getElementById('count-watchlist').textContent = data.counts.watchlist;
    document.querySelectorAll('[data-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.view === state.view);
      if (el.dataset.view === state.view) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  }
  function poster(movie, small = false) {
    if (/^https:\/\/(kinopoiskapiunofficial\.tech\/images\/posters\/|avatars\.mds\.yandex\.net\/get-kinopoisk-image\/|st\.kp\.yandex\.net\/images\/)[^?#]+$/.test(movie.poster_url || '')) {
      return `<div class="poster${small ? ' poster-small' : ''}"><img src="${escape(movie.poster_url)}" alt="${escape(movie.title)} poster" loading="lazy" referrerpolicy="no-referrer"></div>`;
    }
    if (/^\/[a-zA-Z0-9]+\.(jpg|png)$/.test(movie.poster_path || '')) {
      return `<div class="poster${small ? ' poster-small' : ''}"><img src="https://image.tmdb.org/t/p/w342${escape(movie.poster_path)}" alt="${escape(movie.title)} poster" loading="lazy" referrerpolicy="no-referrer"></div>`;
    }
    const hue = [...movie.title].reduce((n, c) => n + c.charCodeAt(0), 0) % 4;
    return `<div class="poster poster-art art-${hue}${small ? ' poster-small' : ''}" aria-hidden="true"><span class="poster-edition">THE PERSONAL COLLECTION</span><span class="poster-shape"></span><strong>${escape(movie.title)}</strong><span class="poster-year">${movie.release_year || movie.year || 'A NIGHT AT THE MOVIES'}</span></div>`;
  }
  function dateLabel(date) {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
  }
  function kinopoiskLink(movie) {
    const id = Number(movie.kinopoisk_id || movie.linked_kinopoisk_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return `<a class="kinopoisk-link" href="https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(movie.title)}" target="_blank" rel="noopener noreferrer">Find on Kinopoisk ↗</a>`;
    }
    const rating = movie.kinopoisk_rating;
    const checked = movie.catalog_checked_at ? ` · checked ${movie.catalog_checked_at.slice(0, 10)}` : '';
    return `<a class="kinopoisk-link catalog-rating" href="https://www.kinopoisk.ru/film/${id}/" target="_blank" rel="noopener noreferrer" title="Kinopoisk community rating via Kinopoisk API Unofficial${escape(checked)}">Kinopoisk${rating !== null && rating !== undefined ? ` <strong>${Number(rating).toFixed(1)}</strong><span>/10</span>` : ''} ↗</a>`;
  }
  function catalogLinks(movie) {
    const id = movie.imdb_id || movie.linked_imdb_id;
    const rating = movie.imdb_rating;
    const checked = movie.catalog_checked_at ? ` · checked ${movie.catalog_checked_at.slice(0, 10)}` : '';
    const imdb = /^tt[0-9]{7,10}$/.test(id || '') ? `<a class="kinopoisk-link catalog-rating imdb-link" href="https://www.imdb.com/title/${escape(id)}/" target="_blank" rel="noopener noreferrer" title="IMDb rating via Kinopoisk API Unofficial${escape(checked)}">IMDb${rating !== null && rating !== undefined ? ` <strong>${Number(rating).toFixed(1)}</strong><span>/10</span>` : ''} ↗</a>` : '';
    return `<div class="catalog-links">${kinopoiskLink(movie)}${imdb}</div>`;
  }
  function companyLabel(entry) {
    if (entry.status !== 'watched') return '';
    if (entry.watch_company === 'alone') return '<p class="attendees">Watched alone</p>';
    if (entry.watch_company === 'companions') return `<p class="attendees">With ${(entry.companions || []).map(c => escape(c.name)).join(', ')}</p>`;
    return entry.attendees ? `<p class="attendees">With ${escape(entry.attendees)}</p>` : '';
  }
  function card(entry) {
    return `<article class="movie-card">${poster(entry)}<div class="movie-info"><div class="movie-topline"><span class="scope-tag ${entry.scope}">${entry.scope === 'personal' ? 'JUST FOR ME' : entry.scope === 'linked' ? 'LINKED PEOPLE' : 'TOGETHER'}</span>${entry.rating ? `<span class="stars" aria-label="${entry.can_edit ? 'Your rating' : `${escape(entry.author_name)}’s rating`}: ${entry.rating} out of 5 stars">${'★'.repeat(entry.rating)}<span>${'☆'.repeat(5 - entry.rating)}</span></span>` : ''}</div><h3>${escape(entry.title)}</h3><p class="movie-meta">${entry.release_year || 'Year unknown'}${entry.watched_on ? ` <span>·</span> ${dateLabel(entry.watched_on)}` : ''}</p>${catalogLinks(entry)}${companyLabel(entry)}${entry.is_my_viewing && !entry.can_edit ? '<p class="participant-note">You watched this</p>' : ''}${entry.notes ? `<p class="movie-notes">${escape(entry.notes)}</p>` : ''}<div class="movie-actions">${entry.can_edit ? `<button class="text-button" data-edit="${entry.id}">${entry.status === 'watchlist' ? 'Log a viewing ↗' : 'Edit entry ↗'}</button>${entry.status === 'watchlist' ? `<button class="text-button muted" data-edit-list="${entry.id}">Edit</button>` : ''}` : `<span class="muted">Added by ${escape(entry.author_name)}</span>${entry.status === 'watchlist' ? `<button class="text-button" data-copy="${entry.id}">Log a viewing ↗</button>` : ''}`}</div></div></article>`;
  }
  function shell() {
    const watched = state.view === 'watched';
    return `<section class="page-heading"><div><p class="eyebrow">${watched ? 'COLLECT THE MOMENTS' : 'SOMETHING TO LOOK FORWARD TO'}</p><h1>${watched ? 'Your life in <em>movies.</em>' : 'For your next <em>movie night.</em>'}</h1><p class="intro">${watched ? 'A record of the films, the people, and the nights worth remembering.' : 'A few good reasons to put the phones down and press play.'}</p></div><button class="button primary" data-add>${watched ? '＋ Log a film' : '＋ Add a film'}</button></section>
      <section class="cinema-banner"><div class="banner-icon">${icon}</div><div><p class="eyebrow">${watched ? 'THE BEST SEAT IS NEXT TO YOUR PEOPLE' : 'THE POSSIBILITIES ARE ENDLESS'}</p><h2>${watched ? 'Make a little history together.' : 'What are we watching tonight?'}</h2><p>${watched ? 'Big-screen adventures. Sofa-sized traditions. Keep them all here.' : 'Save something for a quiet evening or the whole household.'}</p></div><div class="ticket-stub"><span>YOUR COLLECTION</span><strong>${String(watched ? state.data.my_watched_count : state.data.counts.watchlist).padStart(2, '0')}</strong><span>${watched ? 'VIEWINGS LOGGED' : 'FILMS TO WATCH'}</span></div></section>
      <section class="collection"><div class="collection-title"><h2>${watched ? 'The film diary' : 'The watchlist'}<span id="result-count"></span></h2><span class="little-note">${watched ? 'Every rewatch has a story.' : 'Good things on the horizon.'}</span></div><div class="filters"><div class="scope-filters" role="group" aria-label="Entry visibility">${[...(watched ? [['mine', 'My viewings']] : []), ['all', 'All films'], ['personal', 'Just for me'], ['household', 'Together']].map(([key, label]) => `<button class="filter ${state.scope === key ? 'selected' : ''}" data-scope="${key}" aria-pressed="${state.scope === key}">${label}</button>`).join('')}</div><form id="filter-form" role="search"><label class="sr-only" for="filter-query">Search your collection</label><input type="search" id="filter-query" placeholder="Find a film in your collection…" value="${escape(state.query)}"><button class="search-button" type="submit" aria-label="Search collection"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></form></div>${watched ? `<div class="companion-filter"><label for="companion-filter">Watched with</label><select id="companion-filter"><option value="all">Anyone / all viewings</option><option value="alone">Watched alone</option><option value="others">With other people</option>${state.data.companions.map(c => `<option value="${c.id}" ${String(c.id) === state.companion ? 'selected' : ''}>With ${escape(c.name)}${c.can_edit ? '' : ` · ${escape(c.owner_name)}`}</option>`).join('')}<option value="unspecified">Not specified</option></select><button class="text-button" data-view="companions">Manage companions ↗</button></div>` : ''}<div id="entries" class="movie-grid" aria-live="polite"></div><div id="pagination" class="pagination"></div></section>`;
  }
  async function loadEntries() {
    const revision = ++state.request;
    const target = document.getElementById('entries');
    if (!target) return;
    target.innerHTML = '<p class="loading">Opening the collection…</p>';
    try {
      const result = await api(`entries?${new URLSearchParams({ status: state.view, scope: state.scope, q: state.query, page: state.page, with: state.view === 'watched' ? state.companion : 'all' })}`);
      if (revision !== state.request || !target.isConnected) return;
      state.items = result.items;
      document.getElementById('result-count').textContent = ` / ${String(result.total).padStart(2, '0')}`;
      target.innerHTML = result.items.length ? result.items.map(card).join('') : `<div class="empty-state"><span class="empty-icon">${icon}</span><p class="eyebrow">${state.query ? 'NOT IN THE COLLECTION YET' : 'THE OPENING SCENE'}</p><h3>${state.query ? 'No films found.' : state.scope === 'household' && !state.data.household ? 'Movie nights are better together.' : state.view === 'watched' ? 'Your first memory starts here.' : 'A good night starts with a good film.'}</h3><p>${state.query ? 'Try another title or clear your search.' : state.scope === 'household' && !state.data.household ? 'Create or join a household to start a shared collection.' : state.view === 'watched' ? 'Log a film you loved, a family favorite, or last night’s discovery.' : 'Add a film you have been meaning to watch.'}</p><button class="button secondary" ${state.scope === 'household' && !state.data.household ? 'data-view="household"' : 'data-add'}>${state.scope === 'household' && !state.data.household ? 'Set up our household' : state.view === 'watched' ? 'Log your first film ↗' : 'Add a film ↗'}</button></div>`;
      document.getElementById('pagination').innerHTML = result.pages > 1 ? `<button class="button secondary" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${state.page} of ${result.pages}</span><button class="button secondary" data-page="${state.page + 1}" ${state.page >= result.pages ? 'disabled' : ''}>Next</button>` : '';
    } catch (error) {
      if (revision === state.request && target.isConnected) target.innerHTML = `<div class="empty-state" role="alert"><h3>We couldn’t open your collection.</h3><p>${escape(error.message)}</p><button class="button secondary" data-retry>Try again</button></div>`;
    }
  }
  async function refresh() {
    const revision = ++viewRequest;
    window.dispatchEvent(new Event('reel-diary'));
    const data = await api('bootstrap');
    if (revision !== viewRequest || !root.isConnected) return;
    state.data = data;
    syncAccount();
    screen.setAttribute('aria-busy', 'false');
    if (state.view === 'household') renderHousehold();
    else if (state.view === 'companions') renderCompanions();
    else {
      screen.innerHTML = shell();
      const filter = document.getElementById('companion-filter');
      if (filter) filter.value = state.companion;
      await loadEntries();
    }
  }
  function renderCompanions() {
    ++state.request;
    const companions = state.data.companions.filter(c => c.can_edit);
    const suggestions = ['My wife', 'My elder son'].filter(name => !companions.some(c => c.name.toLowerCase() === name.toLowerCase()));
    const members = (state.data.household?.members || []).filter(m => m.id !== state.data.user.id);
    screen.innerHTML = `<section class="page-heading"><div><p class="eyebrow">SAVE A SEAT</p><h1>Your movie-night <em>people.</em></h1><p class="intro">Keep a list of people you watch with. They don’t need an account.</p></div></section><section class="household-card"><h2>Viewing companions</h2><p>Optionally link a companion to someone in your household. Tagged household viewings will appear in their My viewings list. Personal entries stay private until you share them.</p><p class="helper">Renaming a label updates your earlier viewings. Changing or removing its linked account revokes personal entries shared through this label.</p><div class="companion-list">${companions.map(c => `<form class="companion-edit" data-companion-id="${c.id}"><label for="companion-name-${c.id}">Companion name</label><input id="companion-name-${c.id}" name="name" value="${escape(c.name)}" required maxlength="80"><label for="companion-account-${c.id}">Family account (optional)</label><select id="companion-account-${c.id}" name="linked_user_id"><option value="0">No linked account</option>${members.map(m => `<option value="${m.id}" ${c.linked_user_id === m.id ? 'selected' : ''}>${escape(m.name)}</option>`).join('')}</select>${!members.length ? '<p class="helper">Invite family members to your household to link their accounts.</p>' : ''}<label class="share-consent"><input name="share_existing" type="checkbox" ${c.linked_user_id ? '' : 'disabled'}><span>Share all earlier viewings tagged with this companion with the selected account, including personal notes and ratings.</span></label><p class="helper">This applies to existing viewings. Choose sharing separately when logging new ones. Uncheck this to leave earlier sharing unchanged.</p><button class="button secondary" type="submit">Save companion</button><p class="form-error" role="alert"></p></form>`).join('')}</div><form id="create-companion"><label for="new-companion-name">Add a companion</label><div class="search-row"><input id="new-companion-name" name="name" required maxlength="80" placeholder="A name or a label"><button class="button primary" type="submit">Add person</button></div><p class="form-error" role="alert"></p></form>${suggestions.length ? `<p class="helper">Quick additions:</p><div class="companion-suggestions">${suggestions.map(name => `<button class="button secondary" data-add-companion="${escape(name)}">＋ ${escape(name)}</button>`).join('')}</div>` : ''}</section>`;
    screen.querySelectorAll('.companion-edit select').forEach(select => select.addEventListener('change', () => {
      const consent = select.form.elements.namedItem('share_existing');
      consent.checked = false;
      consent.disabled = select.value === '0';
    }));
  }

  function renderHousehold() {
    ++state.request;
    const h = state.data.household;
    screen.innerHTML = `<section class="page-heading"><div><p class="eyebrow">SAVE A SEAT FOR YOUR PEOPLE</p><h1>Our little <em>cinema.</em></h1><p class="intro">Shared movie nights. A collection that belongs to all of you.</p></div></section>${h ? `<section class="household-card"><p class="eyebrow">YOUR HOUSEHOLD</p><h2>${escape(h.name)}</h2><p>Everyone here can see entries marked “Together”. Your “Just for me” entries stay private. Entries shared with linked companions are visible only to those accounts and their author.</p><ul class="members">${h.members.map(m => `<li><span class="avatar">${escape(m.name.slice(0, 1))}</span><strong>${escape(m.name)}</strong>${m.id === state.data.user.id ? '<span class="muted">You</span>' : h.is_owner ? `<button class="text-button danger" data-remove-member="${m.id}">Remove</button>` : ''}</li>`).join('')}</ul>${h.is_owner ? '<button class="button primary" id="make-invite">Create invitation code ↗</button><div id="invite-result" aria-live="polite"></div><p class="helper">Codes expire after 7 days. Creating a new code invalidates the previous one. Share it only with people you want to invite.</p>' : '<button class="text-button danger" id="leave-household">Leave household</button><p class="helper">Your household entries remain here after you leave. Account links and access to personal entries shared through them will be removed.</p>'}</section>` : `<div class="household-grid"><form id="create-household" class="household-card"><p class="eyebrow">START SOMETHING GOOD</p><h2>Make yourself at home.</h2><p>Create a household, then invite your people with a private code.</p><label for="household-name">Household name</label><input id="household-name" name="name" required maxlength="100" placeholder="The Friday Film Club"><button class="button primary" type="submit">Create household ↗</button><p class="form-error" role="alert"></p></form><form id="join-household" class="household-card"><p class="eyebrow">THERE’S A SEAT FOR YOU</p><h2>Join your people.</h2><p>Already have an invitation? Enter the code your household owner shared.</p><label for="invitation-code">Invitation code</label><input id="invitation-code" name="code" required pattern="[a-f0-9]{32}" maxlength="32" autocomplete="off" placeholder="Your 32-character code"><button class="button secondary" type="submit">Join household ↗</button><p class="form-error" role="alert"></p></form></div>`}`;
  }
  function openEntry(entry = null, editList = false, copy = false) {
    const editing = entry && !copy;
    const status = entry ? (editList ? 'watchlist' : 'watched') : state.view === 'watchlist' ? 'watchlist' : 'watched';
    let selectedMovie = entry && (entry.tmdb_id || entry.kinopoisk_id) ? { ...entry, year: entry.release_year } : null;
    let searchVersion = 0;
    const h = state.data.household;
    const scope = entry?.scope || (state.scope === 'household' && h ? 'household' : 'personal');
    dialog.innerHTML = `<form id="entry-form"><header class="dialog-heading"><div><p class="eyebrow">ADD TO YOUR STORY</p><h2 id="dialog-title">${editing && entry.status === 'watched' ? 'A night to remember.' : status === 'watched' ? 'What did you watch?' : 'Save it for movie night.'}</h2></div><button class="close-button" type="button" aria-label="Close dialog">×</button></header>
      ${state.data.catalog_enabled ? `<div class="catalog-search"><label for="catalog-source">Movie catalog</label><select id="catalog-source">${state.data.catalog_providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}</option>`).join('')}</select><label for="catalog-query">Find a movie</label><div class="search-row"><input id="catalog-query" type="search" placeholder="Search by Russian or original title…"><button class="button secondary" id="search-catalog" type="button">Search</button></div><div id="catalog-results" aria-live="polite"></div><p class="helper">Choose a result, or enter a title below. Kinopoisk ratings are separate from your own.</p></div>` : ''}
      <fieldset class="movie-links"><legend>Movie links <span>(optional)</span></legend>
        <label for="movie-kinopoisk">Kinopoisk link or ID</label><div class="search-row"><input id="movie-kinopoisk" name="kinopoisk_link" maxlength="500" placeholder="430 or https://www.kinopoisk.ru/film/430/" value="${escape(entry?.kinopoisk_id || entry?.linked_kinopoisk_id || '')}"><button class="button secondary" type="button" data-lookup="kinopoisk" aria-label="Load Kinopoisk details">Load details</button></div>
        <label for="movie-imdb">IMDb link or ID</label><div class="search-row"><input id="movie-imdb" name="imdb_link" maxlength="500" placeholder="tt0126029 or an IMDb title URL" value="${escape(entry?.imdb_id || entry?.linked_imdb_id || '')}"><button class="button secondary" type="button" data-lookup="imdb" aria-label="Load IMDb details">Load details</button></div>
        <p class="helper">${state.data.catalog_enabled ? 'Load details to fill the title, ratings, and matching IDs. You can also save links with a title you enter below.' : 'Links work without a catalog connection. Enter the film title below to save. To load details and ratings, the site owner can connect a catalog in Administration.'}</p><div id="lookup-result" aria-live="polite"></div>
      </fieldset>
      <div class="form-row movie-fields"><div><label for="movie-title">Film title</label><input id="movie-title" name="title" required maxlength="200" value="${escape(entry?.title || '')}" placeholder="A film worth remembering" autofocus></div><div><label for="movie-year">Release year <span>(optional)</span></label><input id="movie-year" name="year" type="number" min="1870" max="${new Date().getFullYear() + 5}" value="${entry?.release_year || ''}" placeholder="2024"></div></div>
      <div class="form-row"><div><label for="entry-status">Add to</label><select id="entry-status" name="status"><option value="watched" ${status === 'watched' ? 'selected' : ''}>Film diary — watched it</option><option value="watchlist" ${status === 'watchlist' ? 'selected' : ''}>Watchlist — for later</option></select></div><div><label for="entry-scope">Who can see this?</label><select id="entry-scope" name="scope"><option value="personal" ${scope === 'personal' ? 'selected' : ''}>Just for me — private</option>${h ? `<option value="household" ${scope === 'household' ? 'selected' : ''}>Together — ${escape(h.name)}</option><option value="linked" ${scope === 'linked' ? 'selected' : ''}>Linked companions — selected accounts</option>` : ''}</select></div></div>
      <div id="viewing-fields"><div class="form-row"><div><label for="watched-on">Date watched</label><input id="watched-on" name="watched_on" type="date" min="1870-01-01" max="${state.data.today}" value="${escape(entry?.watched_on || state.data.today)}"></div><div><label for="entry-rating">Your rating <span>(optional)</span></label><select id="entry-rating" name="rating"><option value="">Unrated</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${entry?.rating === n ? 'selected' : ''}>${'★'.repeat(n)} · ${['', 'Not for me', 'It was okay', 'A good watch', 'Loved it', 'An all-time favorite'][n]}</option>`).join('')}</select></div></div><label for="watch-company">Watched with</label><select id="watch-company" name="watch_company"><option value="unspecified">Not specified</option><option value="alone">Just me</option><option value="companions">With other people</option></select>
      <fieldset class="viewing-companions" id="viewing-companions" hidden><legend>Choose your companions</legend><div id="companion-choices" class="companion-choices"></div><div id="companion-suggestions" class="companion-suggestions"></div><label for="entry-new-companion">Add someone else</label><div class="search-row"><input id="entry-new-companion" maxlength="80" placeholder="A name or a label"><button class="button secondary" id="entry-add-companion" type="button">Add person</button></div><p id="companion-error" class="form-error" role="alert"></p></fieldset>
      ${entry?.attendees ? `<label for="entry-attendees">Previous “who watched” note</label><input id="entry-attendees" name="attendees" maxlength="200" value="${escape(entry.attendees)}">` : ''}</div>
      <fieldset id="sharing-fields" class="viewing-companions" hidden><legend>Share this viewing with</legend><div id="sharing-choices" class="companion-choices"></div><p class="helper">Only selected linked accounts will see this entry, including your notes and rating. Unselect someone to revoke access.</p></fieldset>
      <label for="entry-notes">A little note <span>(optional)</span></label><textarea id="entry-notes" name="notes" rows="3" maxlength="2000" placeholder="The scene you loved. Who fell asleep. The reason you’ll watch it again.">${escape(entry?.notes || '')}</textarea><p class="helper" id="privacy-note"></p><p class="form-error" id="entry-error" role="alert"></p>
      <footer class="dialog-footer">${editing ? '<button class="text-button danger" type="button" id="delete-entry">Delete entry</button>' : '<span></span>'}<div><button class="button secondary close-button" type="button">Cancel</button><button class="button primary" type="submit">Save film ↗</button></div></footer>${state.data.catalog_enabled ? '<p class="attribution">Movie catalogs: Kinopoisk API Unofficial and TMDB. Provider information is available under About &amp; credits.</p>' : ''}</form>`;
    const form = dialog.querySelector('form');
    const field = name => form.elements.namedItem(name);
    const selectedCompanions = new Set((entry?.companions || []).filter(c => c.can_edit).map(c => c.id));
    const sharedCompanions = new Set(entry?.shared_companion_ids || []);
    field('watch_company').value = entry?.watch_company || 'unspecified';
    const renderSharing = () => {
      const candidates = state.data.companions.filter(c => c.can_edit && c.linked_user_id && selectedCompanions.has(c.id) && field('watch_company').value === 'companions');
      const allowed = new Set(candidates.map(c => c.id));
      for (const id of sharedCompanions) if (!allowed.has(id)) sharedCompanions.delete(id);
      const target = document.getElementById('sharing-choices');
      target.innerHTML = candidates.length ? candidates.map(c => `<label class="companion-choice"><input type="checkbox" value="${c.id}" ${sharedCompanions.has(c.id) ? 'checked' : ''}>${escape(c.name)} → ${escape(c.linked_user_name)}</label>`).join('') : '<p class="helper">Select a viewing companion with a linked family account. You can link accounts in Watching companions.</p>';
      target.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
        if (input.checked) sharedCompanions.add(input.value); else sharedCompanions.delete(input.value);
      }));
    };
    const renderChoices = () => {
      const companions = state.data.companions.filter(c => c.can_edit);
      const choices = document.getElementById('companion-choices');
      choices.innerHTML = companions.map(c => `<label class="companion-choice"><input type="checkbox" value="${c.id}" ${selectedCompanions.has(c.id) ? 'checked' : ''}>${escape(c.name)}</label>`).join('');
      choices.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
        if (input.checked) selectedCompanions.add(input.value); else selectedCompanions.delete(input.value);
        renderSharing();
      }));
      renderSharing();
      const suggestions = ['My wife', 'My elder son'].filter(name => !companions.some(c => c.name.toLowerCase() === name.toLowerCase()));
      const target = document.getElementById('companion-suggestions');
      target.innerHTML = suggestions.map(name => `<button class="button secondary" type="button" data-suggest-companion="${escape(name)}">＋ ${escape(name)}</button>`).join('');
      target.querySelectorAll('button').forEach(button => button.addEventListener('click', () => addCompanion(button.dataset.suggestCompanion, button)));
    };
    const addCompanion = async (name, button) => {
      button.disabled = true;
      const errorTarget = document.getElementById('companion-error');
      errorTarget.textContent = '';
      try {
        const companion = await api('companions', 'POST', { name });
        if (!form.isConnected || !dialog.open) return;
        if (!state.data.companions.some(c => c.id === companion.id)) state.data.companions.push(companion);
        selectedCompanions.add(companion.id);
        document.getElementById('entry-new-companion').value = '';
        renderChoices();
      } catch (error) { if (errorTarget.isConnected) errorTarget.textContent = error.message; }
      finally { button.disabled = false; }
    };
    const addPerson = document.getElementById('entry-add-companion');
    addPerson.addEventListener('click', () => addCompanion(document.getElementById('entry-new-companion').value, addPerson));
    document.getElementById('entry-new-companion').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); addPerson.click(); }
    });
    renderChoices();
    const updateFields = () => {
      document.getElementById('viewing-fields').hidden = field('status').value !== 'watched';
      field('watched_on').required = field('status').value === 'watched';
      document.getElementById('viewing-companions').hidden = field('watch_company').value !== 'companions';
      const linkedOption = field('scope').querySelector('[value="linked"]');
      if (linkedOption) linkedOption.disabled = field('status').value !== 'watched';
      if (field('status').value !== 'watched' && field('scope').value === 'linked') field('scope').value = 'personal';
      document.getElementById('sharing-fields').hidden = field('scope').value !== 'linked';
      renderSharing();
      document.getElementById('privacy-note').textContent = field('scope').value === 'personal' ? 'Only you can see this entry, including its notes and rating.' : field('scope').value === 'linked' ? 'You are sharing your notes and rating with the selected linked accounts.' : 'Everyone in your household can see this entry, including its notes and rating.';
    };
    form.addEventListener('change', event => {
      if (['status', 'scope', 'watch_company'].includes(event.target.name)) updateFields();
    });
    for (const name of ['title', 'year', 'kinopoisk_link', 'imdb_link']) field(name).addEventListener('input', () => {
      selectedMovie = null; ++searchVersion;
      document.getElementById('lookup-result').textContent = '';
      const results = document.getElementById('catalog-results');
      if (results) results.textContent = '';
    });
    const selectMovie = movie => {
      selectedMovie = movie;
      field('title').value = movie.title;
      field('year').value = movie.year || '';
      field('kinopoisk_link').value = movie.kinopoisk_id || '';
      field('imdb_link').value = movie.imdb_id || '';
      ++searchVersion;
    };
    dialog.querySelectorAll('[data-lookup]').forEach(button => {
      const lookup = async () => {
        const version = ++searchVersion;
        const results = document.getElementById('lookup-result');
        const provider = button.dataset.lookup;
        const id = field(`${provider}_link`).value.trim();
        if (!id) { results.textContent = 'Enter a movie link or ID first.'; return; }
        button.disabled = true;
        results.textContent = 'Looking up this exact ID…';
        try {
          const movie = await api(`lookup?${new URLSearchParams({ provider, id })}`);
          if (version !== searchVersion || !results.isConnected || !dialog.open) return;
          selectMovie(movie);
          results.innerHTML = `<p>Selected ${escape(movie.title)} (${movie.year || 'year unknown'}).</p>${catalogLinks(movie)}`;
        } catch (error) {
          if (version === searchVersion && results.isConnected) results.textContent = error.message;
        } finally { button.disabled = false; }
      };
      button.addEventListener('click', lookup);
      field(`${button.dataset.lookup}_link`).addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); lookup(); }
      });
    });
    dialog.querySelectorAll('.close-button').forEach(button => button.addEventListener('click', () => dialog.close()));
    const catalogSearch = async () => {
      const version = ++searchVersion;
      const results = document.getElementById('catalog-results');
      const query = document.getElementById('catalog-query').value.trim();
      if (query.length < 2) { results.textContent = 'Enter at least two characters.'; return; }
      results.textContent = 'Finding your film…';
      try {
        const provider = document.getElementById('catalog-source').value;
        const movies = await api(`search?${new URLSearchParams({ q: query, provider })}`);
        if (version !== searchVersion || !results.isConnected || !dialog.open) return;
        results.innerHTML = movies.length ? movies.map((movie, i) => `<button class="catalog-result" type="button" data-result="${i}">${poster(movie, true)}<span><strong>${escape(movie.title)}</strong><small>${movie.year || 'Year unknown'}${movie.kinopoisk_rating !== null && movie.kinopoisk_rating !== undefined ? ` · Kinopoisk ${Number(movie.kinopoisk_rating).toFixed(1)}/10` : ''}</small></span><span>＋</span></button>`).join('') : '<p>No matches. You can enter the title manually.</p>';
        results.querySelectorAll('[data-result]').forEach(button => button.addEventListener('click', () => {
          selectMovie(movies[Number(button.dataset.result)]);
          document.getElementById('lookup-result').textContent = '';
          results.innerHTML = `<p>Selected ${escape(selectedMovie.title)}.</p>${catalogLinks(selectedMovie)}`;
        }));
      } catch (error) { if (version === searchVersion && results.isConnected) results.textContent = error.message; }
    };
    document.getElementById('search-catalog')?.addEventListener('click', catalogSearch);
    document.getElementById('catalog-source')?.addEventListener('change', () => { ++searchVersion; document.getElementById('catalog-results').textContent = ''; });
    document.getElementById('catalog-query')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); catalogSearch(); } });
    document.getElementById('delete-entry')?.addEventListener('click', async event => {
      if (!confirm(`Delete your entry for “${entry.title}”? This cannot be undone.`)) return;
      event.target.disabled = true;
      try {
        await api(`entries/${entry.id}`, 'DELETE'); dialog.close(); toast('Entry deleted.'); await refresh();
      } catch (error) { document.getElementById('entry-error').textContent = error.message; }
      finally { event.target.disabled = false; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      document.getElementById('entry-error').textContent = '';
      try {
        const body = {
          movie: selectedMovie || { title: field('title').value, year: Number(field('year').value), links: { kinopoisk: field('kinopoisk_link').value, imdb: field('imdb_link').value } },
          status: field('status').value, scope: field('scope').value, watched_on: field('watched_on').value,
          rating: field('rating').value ? Number(field('rating').value) : null, attendees: field('attendees')?.value || '', notes: field('notes').value,
          shared_companion_ids: field('scope').value === 'linked' ? [...sharedCompanions] : [],
          watch_company: field('watch_company').value, companion_ids: field('watch_company').value === 'companions' ? [...selectedCompanions] : [],
        };
        await api(editing ? `entries/${entry.id}` : 'entries', editing ? 'PUT' : 'POST', body);
        dialog.close(); state.view = body.status; state.scope = body.status === 'watched' ? 'mine' : 'all'; state.page = 1; state.companion = 'all';
        toast(body.status === 'watched' ? 'A memory saved. Here’s to the next one.' : 'One for your next movie night.');
        await refresh();
      } catch (error) { document.getElementById('entry-error').textContent = error.message; }
      finally { submit.disabled = false; }
    });
    updateFields();
    dialog.showModal();
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || dialog.contains(button)) return;
    try {
      if (button.dataset.view) {
        state.view = button.dataset.view; state.page = 1; state.query = ''; state.scope = state.view === 'watched' ? 'mine' : 'all'; state.companion = 'all';
        await refresh();
      } else if (button.dataset.addCompanion) {
        button.disabled = true;
        await api('companions', 'POST', { name: button.dataset.addCompanion });
        await refresh();
      } else if (button.hasAttribute('data-add')) openEntry();
      else if (button.dataset.edit || button.dataset.editList || button.dataset.copy) {
        const entry = state.items.find(item => item.id === (button.dataset.edit || button.dataset.editList || button.dataset.copy));
        openEntry(entry, !!button.dataset.editList, !!button.dataset.copy);
      } else if (button.dataset.scope) {
        state.scope = button.dataset.scope; state.page = 1;
        document.querySelectorAll('[data-scope]').forEach(el => { el.classList.toggle('selected', el.dataset.scope === state.scope); el.setAttribute('aria-pressed', String(el.dataset.scope === state.scope)); });
        await loadEntries();
      } else if (button.dataset.page) { state.page = Number(button.dataset.page); await loadEntries(); }
      else if (button.hasAttribute('data-retry')) await refresh();
      else if (button.id === 'make-invite') {
        button.disabled = true;
        const result = await api('household/invite', 'POST', {});
        document.getElementById('invite-result').innerHTML = `<label for="share-code">Share this code</label><input id="share-code" readonly value="${escape(result.code)}"><p class="helper">Have them sign in, open Our household, and enter this code.</p>`;
        document.getElementById('share-code').select();
      } else if (button.id === 'leave-household' || button.dataset.removeMember) {
        const leave = button.id === 'leave-household';
        if (!confirm(leave ? 'Leave this household? Your shared entries remain visible to its members.' : 'Remove this member? They will lose access to shared entries. Existing invitation codes will also stop working.')) return;
        button.disabled = true;
        await api(leave ? 'household/membership' : `household/members/${button.dataset.removeMember}`, 'DELETE');
        await refresh();
      }
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  root.addEventListener('change', async event => {
    if (event.target.id === 'companion-filter') {
      state.companion = event.target.value; state.page = 1; await loadEntries();
    }
  });
  root.addEventListener('submit', async event => {
    if (event.target.id === 'filter-form') {
      event.preventDefault(); state.query = document.getElementById('filter-query').value; state.page = 1; await loadEntries();
    } else if (event.target.id === 'create-companion' || event.target.classList.contains('companion-edit')) {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        const id = form.dataset.companionId;
        const body = { name: form.elements.namedItem('name').value };
        if (id) {
          body.linked_user_id = form.elements.namedItem('linked_user_id').value;
          body.share_existing = form.elements.namedItem('share_existing').checked;
        }
        const saved = await api(id ? `companions/${id}` : 'companions', id ? 'PUT' : 'POST', body);
        toast(saved.shared_count ? `Companion saved. ${saved.shared_count} earlier viewing(s) shared.` : id ? 'Companion updated on your viewings.' : 'Companion added.');
        await refresh();
      } catch (error) { form.querySelector('.form-error').textContent = error.message; }
      finally { submit.disabled = false; }
    } else if (['create-household', 'join-household'].includes(event.target.id)) {
      event.preventDefault();
      const form = event.target;
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        const create = form.id === 'create-household';
        await api(create ? 'household' : 'household/join', 'POST', Object.fromEntries(new FormData(form)));
        toast(create ? 'Your household is ready. Save a seat for your people.' : 'Welcome to the household.');
        await refresh();
      } catch (error) { form.querySelector('.form-error').textContent = error.message; }
      finally { submit.disabled = false; }
    }
  });
  return refresh().catch(error => {
    screen.setAttribute('aria-busy', 'false');
    screen.innerHTML = `<div class="empty-state" role="alert"><h1>Let’s try that again.</h1><p>${escape(error.message)}</p><p>If your session expired, reload this page or sign in again.</p><button class="button secondary" data-retry>Try again</button></div>`;
  });
}
