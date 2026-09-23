import {activeLink, validGrant, canSee, fail, text, id, ids, choice, bool, newId, hash, today, viewing, watchKey} from './domain.js';

export const row = snap => snap.exists ? {...snap.data(), id: snap.id} : null;
const rows = snap => snap.docs.map(row);
export class DiaryStore {
  constructor(db, catalog) { this.db = db; this.catalog = catalog; }
  ref(collection, key) { return this.db.collection(collection).doc(id(key)); }
  async profile(token) {
    return this.db.runTransaction(async tx => {
      const ref = this.ref('users', token.uid);
      const existing = row(await tx.get(ref));
      if (existing) {
        const {approved, complimentary, ...profile} = existing;
        if (approved !== undefined || complimentary !== undefined || profile.email !== token.email) tx.set(ref, {...profile, email: token.email});
        return {...profile, email: token.email, admin: token.admin === true};
      }
      const profile = {name: String(token.name || token.email?.split('@')[0] || 'Movie lover').slice(0, 100), email: token.email || '', household_id: '', membership_epoch: newId(), created_at: Date.now()};
      tx.create(ref, profile);
      return {...profile, id: token.uid, admin: token.admin === true};
    });
  }
  async context(tx, uid, entries = []) {
    const viewer = row(await tx.get(this.ref('users', uid)));
    if (!viewer) fail('Your account is unavailable.', 403);
    const own = rows(await tx.get(this.db.collection('companions').where('user_id', '==', uid)));
    const companions = new Map(own.map(c => [c.id, c]));
    const needed = [...new Set(entries.flatMap(e => e.companion_ids ?? []))].filter(key => !companions.has(key));
    for (let i = 0; i < needed.length; i += 100) {
      for (const snap of await tx.getAll(...needed.slice(i, i + 100).map(key => this.ref('companions', key)))) {
        const c = row(snap); if (c) companions.set(c.id, c);
      }
    }
    const profileIds = [...new Set([uid, ...entries.map(e => e.user_id), ...[...companions.values()].flatMap(c => [c.user_id, c.linked_user_id]).filter(Boolean)])];
    const profiles = new Map();
    for (let i = 0; i < profileIds.length; i += 100) {
      for (const snap of await tx.getAll(...profileIds.slice(i, i + 100).map(key => this.ref('users', key)))) {
        const user = row(snap); if (user) profiles.set(user.id, user);
      }
    }
    return {viewer, companions, profiles};
  }
  companion(c, uid, ctx) {
    const linked = activeLink(c, ctx.profiles) ? c.linked_user_id : '';
    return {id: c.id, user_id: c.user_id, name: c.name, can_edit: c.user_id === uid, owner_name: ctx.profiles.get(c.user_id)?.name || 'Former member', linked_user_id: linked, linked_user_name: ctx.profiles.get(linked)?.name || ''};
  }
  entry(e, uid, ctx) {
    const companions = e.companion_ids.map(key => ctx.companions.get(key)).filter(Boolean).map(c => this.companion(c, uid, ctx));
    const grants = (e.grants ?? []).filter(g => validGrant(e, g, ctx.companions, ctx.profiles));
    const {grants: _grants, shared_users: _users, movie_key: _key, ...safe} = e;
    return {...safe, scope: e.household_id ? 'household' : grants.length ? 'linked' : 'personal', companions, shared_companion_ids: e.user_id === uid ? grants.map(g => g.companion_id) : [], can_edit: e.user_id === uid, author_name: ctx.profiles.get(e.user_id)?.name || 'Former member', is_my_viewing: e.status === 'watched' && (e.user_id === uid || companions.some(c => c.linked_user_id === uid))};
  }
  async collection(uid) {
    return this.db.runTransaction(async tx => {
      const viewer = row(await tx.get(this.ref('users', uid)));
      if (!viewer) fail('Your account is unavailable.', 403);
      const queries = [this.db.collection('entries').where('user_id', '==', uid), this.db.collection('entries').where('shared_users', 'array-contains', uid)];
      if (viewer.household_id) queries.push(this.db.collection('entries').where('household_id', '==', viewer.household_id));
      const all = new Map();
      for (const query of queries) for (const entry of rows(await tx.get(query))) all.set(entry.id, entry);
      const ctx = await this.context(tx, uid, [...all.values()]);
      const entries = [...all.values()].filter(e => canSee(e, ctx.viewer, ctx.companions, ctx.profiles));
      const visibleCompanions = new Set(entries.flatMap(e => e.companion_ids));
      let household = null;
      if (viewer.household_id) {
        const h = row(await tx.get(this.ref('households', viewer.household_id)));
        if (h) {
          const members = rows(await tx.get(this.db.collection('users').where('household_id', '==', h.id))).map(u => ({id: u.id, name: u.name}));
          household = {id: h.id, name: h.name, is_owner: h.owner_id === uid, members};
        }
      }
      return {ctx, household, items: entries.map(e => this.entry(e, uid, ctx)), companions: [...ctx.companions.values()].filter(c => c.user_id === uid || visibleCompanions.has(c.id)).map(c => this.companion(c, uid, ctx)).sort((a, b) => a.name.localeCompare(b.name))};
    });
  }
  async bootstrap(uid) {
    const data = await this.collection(uid);
    return {user: {id: uid, name: data.ctx.viewer.name}, household: data.household, counts: {watched: data.items.filter(e => e.status === 'watched').length, watchlist: data.items.filter(e => e.status === 'watchlist').length}, my_watched_count: data.items.filter(e => e.is_my_viewing).length, companions: data.companions, today: today(), catalog_enabled: this.catalog.providers().length > 0, catalog_providers: this.catalog.providers()};
  }
  async entries(uid, filter) {
    const status = choice(filter.status || 'watched', ['watched', 'watchlist']);
    const scope = choice(filter.scope || 'all', ['all', 'mine', 'personal', 'household']);
    const query = text(filter.q ?? '', 200).toLocaleLowerCase();
    const company = filter.with || 'all';
    if (!['all', 'alone', 'unspecified', 'others'].includes(company)) id(company);
    const page = Number(filter.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 100000) fail('Invalid page.');
    const data = await this.collection(uid);
    const items = data.items.filter(e => e.status === status && e.title.toLocaleLowerCase().includes(query) &&
      (scope === 'all' || (scope === 'mine' ? e.is_my_viewing : scope === 'household' ? e.household_id === data.ctx.viewer.household_id && !!e.household_id : e.user_id === uid && e.scope === 'personal')) &&
      (company === 'all' || (['alone', 'unspecified', 'others'].includes(company) ? e.watch_company === (company === 'others' ? 'companions' : company) : e.companion_ids.includes(company))))
      .sort((a, b) => (b.watched_on || '').localeCompare(a.watched_on || '') || b.created_at - a.created_at || b.id.localeCompare(a.id));
    return {items: items.slice((page - 1) * 24, page * 24), total: items.length, pages: Math.ceil(items.length / 24), page};
  }
  async saveEntry(uid, body, entryId = null) {
    const data = viewing(body);
    const selected = ids(body.shared_companion_ids ?? []);
    const ref = this.ref('entries', entryId ? id(entryId) : newId());
    return this.db.runTransaction(async tx => {
      const old = row(await tx.get(ref));
      if (entryId && (!old || old.user_id !== uid)) fail('This entry belongs to another person or is unavailable.', 403);
      const ctx = await this.context(tx, uid);
      if (data.scope !== 'personal' && !ctx.viewer.household_id) fail('Create or join a household first.');
      if (data.companion_ids.some(key => ctx.companions.get(key)?.user_id !== uid)) fail('Select companions from your own list.');
      const movie = await this.catalog.movie(body.movie, uid, old, tx);
      const grants = data.scope === 'linked' ? selected.map(key => {
        const c = ctx.companions.get(key);
        if (!c || !data.companion_ids.includes(key) || !activeLink(c, ctx.profiles)) fail('Choose a companion linked to a current household member.');
        return {companion_id: key, user_id: c.linked_user_id, version: c.link_version};
      }) : [];
      if (data.scope === 'linked' && !grants.length) fail('Select at least one linked account.');
      const {scope: _scope, ...fields} = data;
      const entry = {...fields, ...movie, user_id: uid, household_id: data.scope === 'household' ? ctx.viewer.household_id : '', grants, shared_users: [...new Set(grants.map(g => g.user_id))], created_at: old?.created_at ?? Date.now(), updated_at: Date.now(), revision: newId()};
      const oldKey = old && watchKey(old), newKey = watchKey(entry);
      if (newKey) {
        const lock = row(await tx.get(this.ref('watchlistKeys', newKey)));
        if (lock && lock.entry_id !== ref.id) fail('That movie is already on this watchlist.', 409);
      }
      if (oldKey && oldKey !== newKey) tx.delete(this.ref('watchlistKeys', oldKey));
      if (newKey) tx.set(this.ref('watchlistKeys', newKey), {entry_id: ref.id});
      tx.set(ref, entry);
      return {id: ref.id};
    });
  }
  async deleteEntry(uid, key) {
    await this.db.runTransaction(async tx => {
      const ref = this.ref('entries', key), entry = row(await tx.get(ref));
      if (!entry || entry.user_id !== uid) fail('This entry belongs to another person or is unavailable.', 403);
      const lock = watchKey(entry); if (lock) tx.delete(this.ref('watchlistKeys', lock));
      tx.delete(ref);
    });
    return {deleted: true};
  }
  async saveCompanion(uid, body, key = null) {
    const name = text(body.name, 80, true), share = bool(body.share_existing ?? false);
    const saved = await this.db.runTransaction(async tx => {
      const ctx = await this.context(tx, uid);
      const own = [...ctx.companions.values()];
      const duplicate = own.find(c => c.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      const old = key ? ctx.companions.get(id(key)) : duplicate;
      if (key && !old) fail('This companion belongs to another person or is unavailable.', 403);
      if (key && duplicate && duplicate.id !== key) fail('You already have a companion with that name.', 409);
      if (!old && own.length >= 100) fail('You can keep up to 100 companions.');
      const linked = body.linked_user_id === '0' || body.linked_user_id === 0 ? '' : body.linked_user_id ?? (old && activeLink(old, ctx.profiles) ? old.linked_user_id : '');
      let target;
      if (linked) {
        target = row(await tx.get(this.ref('users', linked)));
        if (!target || linked === uid || !ctx.viewer.household_id || target.household_id !== ctx.viewer.household_id) fail('Choose another current member of your household.');
        ctx.profiles.set(linked, target);
      }
      if (share && !linked) fail('Choose a linked account before sharing earlier viewings.');
      if (!key && duplicate && (linked !== old.linked_user_id || share)) fail('Edit the existing companion to change sharing.', 409);
      const changed = !old || old.linked_user_id !== linked || (linked && !activeLink(old, ctx.profiles));
      const c = {user_id: uid, name, linked_user_id: linked, linked_household_id: linked ? ctx.viewer.household_id : '', owner_epoch: linked ? ctx.viewer.membership_epoch : '', target_epoch: target?.membership_epoch || '', link_version: changed ? newId() : old.link_version};
      const candidates = share ? rows(await tx.get(this.db.collection('entries').where('user_id', '==', uid)))
        .filter(e => e.status === 'watched' && !e.household_id && e.companion_ids.includes(old?.id))
        .map(e => ({id: e.id, revision: e.revision || ''})) : [];
      const ref = this.ref('companions', old?.id || newId());
      // All saves read the owner's document, so concurrent companion creation is serialized.
      tx.update(this.ref('users', uid), {companions_revision: newId()});
      tx.set(ref, c);
      return {...c, id: ref.id, candidates};
    });
    let sharedCount = 0;
    if (share) {
      const candidates = saved.candidates;
      for (let i = 0; i < candidates.length; i += 100) {
        sharedCount += await this.db.runTransaction(async tx => {
          const ctx = await this.context(tx, uid);
          const c = ctx.companions.get(saved.id);
          if (!c || c.link_version !== saved.link_version || !activeLink(c, ctx.profiles)) fail('The account link changed. Save again to share with the current account.', 409);
          const page = await tx.getAll(...candidates.slice(i, i + 100).map(e => this.ref('entries', e.id)));
          let count = 0;
          for (const [offset, snap] of page.entries()) {
            const e = row(snap);
            // A concurrent private edit wins over this earlier bulk-sharing choice.
            if (!e || (e.revision || '') !== candidates[i + offset].revision || e.user_id !== uid || e.household_id || e.status !== 'watched' || !e.companion_ids.includes(c.id)) continue;
            const grants = [...(e.grants ?? []).filter(g => g.companion_id !== c.id), {companion_id: c.id, user_id: c.linked_user_id, version: c.link_version}];
            tx.update(snap.ref, {grants, shared_users: [...new Set(grants.map(g => g.user_id))]}); count++;
          }
          return count;
        });
      }
    }
    const ctx = await this.db.runTransaction(tx => this.context(tx, uid));
    return {...this.companion(saved, uid, ctx), shared_count: sharedCount};
  }
  async createHousehold(uid, body) {
    const name = text(body.name, 100, true), key = newId();
    await this.db.runTransaction(async tx => {
      const ref = this.ref('users', uid), user = row(await tx.get(ref));
      if (user.household_id) fail('You already belong to a household.', 409);
      tx.create(this.ref('households', key), {name, owner_id: uid, invite_hash: '', invite_expires: 0, revision: newId()});
      tx.update(ref, {household_id: key, membership_epoch: newId()});
    });
    return {id: key};
  }
  async invite(uid) {
    const code = newId();
    await this.db.runTransaction(async tx => {
      const user = row(await tx.get(this.ref('users', uid)));
      if (!user.household_id) fail('Create a household first.');
      const ref = this.ref('households', user.household_id), h = row(await tx.get(ref));
      if (h.owner_id !== uid) fail('Only the household owner can create invitation codes.', 403);
      tx.update(ref, {invite_hash: hash(code), invite_expires: Date.now() + 7 * 86400000});
    });
    return {code};
  }
  async join(uid, body) {
    if (typeof body.code !== 'string' || !/^[a-f0-9]{32}$/.test(body.code)) fail('Enter your 32-character invitation code.');
    await this.db.runTransaction(async tx => {
      const ref = this.ref('users', uid), user = row(await tx.get(ref));
      if (user.household_id) fail('You already belong to a household.', 409);
      const found = rows(await tx.get(this.db.collection('households').where('invite_hash', '==', hash(body.code))));
      const h = found[0];
      if (!h || h.invite_expires < Date.now()) fail('This invitation is invalid or expired.');
      const members = await tx.get(this.db.collection('users').where('household_id', '==', h.id));
      if (members.size >= 30) fail('This household has reached its 30-member limit.');
      tx.update(ref, {household_id: h.id, membership_epoch: newId()});
      tx.update(this.ref('households', h.id), {revision: newId()});
    });
    return {joined: true};
  }
  async leave(uid, targetId = uid) {
    await this.db.runTransaction(async tx => {
      const actor = row(await tx.get(this.ref('users', uid)));
      if (!actor.household_id) fail('You are not in a household.');
      const href = this.ref('households', actor.household_id), h = row(await tx.get(href));
      const targetRef = this.ref('users', targetId), target = row(await tx.get(targetRef));
      if (!target || target.household_id !== h.id || (targetId !== uid && h.owner_id !== uid)) fail('You cannot remove this member.', 403);
      if (h.owner_id === targetId) fail('The household owner cannot leave their household.');
      tx.update(targetRef, {household_id: '', membership_epoch: newId()});
      // Epoch changes invalidate every old account link, even if this person rejoins.
      tx.update(href, {revision: newId(), ...(targetId !== uid ? {invite_hash: '', invite_expires: 0} : {})});
    });
    return {left: true};
  }
}
