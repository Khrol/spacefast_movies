import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
if (process.env.GCLOUD_PROJECT !== 'demo-reel-together' || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Seed data is restricted to the local demo emulators.');
initializeApp({projectId: 'demo-reel-together'});
const db = getFirestore(), auth = getAuth();
for (const [uid, name, address, admin] of [['demo-owner', 'Cinema owner', 'owner@example.test', true], ['demo-moviebuff', 'Movie buff', 'moviebuff@example.test', false], ['demo-family', 'Family member', 'family@example.test', false]]) {
  try { await auth.getUser(uid); }
  catch (error) { if (error.code !== 'auth/user-not-found') throw error; await auth.createUser({uid, displayName: name, email: address, password: 'movie-night-2026', emailVerified: true}); }
  if (admin) await auth.setCustomUserClaims(uid, {admin: true});
  const ref = db.doc(`users/${uid}`);
  if (!(await ref.get()).exists) await ref.set({name, email: address, approved: true, complimentary: false, household_id: '', membership_epoch: uid, created_at: Date.now()});
}
console.log('Local demo accounts ready. Password: movie-night-2026');
