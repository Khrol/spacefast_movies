import test from 'node:test';
import assert from 'node:assert/strict';
import {localDatabase} from '../scripts/local-server.mjs';

test('concurrent database instances cannot lose updates and failed transactions leave no writes', async () => {
  const {db, binding} = await localDatabase();
  try {
    const ref = db.doc('settings/counter'); await ref.set({count: 0});
    await Promise.all(Array.from({length: 10}, () => db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      await new Promise(resolve => setTimeout(resolve, 2));
      tx.update(ref, {count: data.count + 1});
    })));
    assert.equal((await ref.get()).data().count, 10);
    await assert.rejects(db.runTransaction(async tx => {tx.set(ref, {count: 100}); throw new Error('rollback');}));
    assert.equal((await ref.get()).data().count, 10);
    await db.doc('authTokens/expired').set({expiresAt: Date.now() - 1000});
    assert.equal((await db.doc('authTokens/expired').get()).exists, false);
  } finally {binding.close();}
});

test('a failed batch rolls back every write; merging preserves unrelated fields', async () => {
  const {db, binding} = await localDatabase();
  try {
    const ref = db.doc('users/alice'); await ref.set({name: 'Alice', approved: false});
    await ref.set({approved: true}, {merge: true});
    assert.deepEqual((await ref.get()).data(), {name: 'Alice', approved: true});
    const batch = db.batch(); batch.set(ref, {name: 'Changed'}); batch.update(db.doc('users/missing'), {approved: true});
    await assert.rejects(batch.commit());
    assert.equal((await ref.get()).data().name, 'Alice');
  } finally {binding.close();}
});
