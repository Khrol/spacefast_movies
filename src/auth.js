import {auth, api} from './api.js';
const listeners = new Set();
function setUser(user, notify = true) {
  auth.currentUser = user ? {...user, async reload() {setUser((await api('auth/session')).user, false);}, async getIdToken() {return null;}} : null;
  if (notify) for (const callback of listeners) void callback(auth.currentUser);
  return auth.currentUser;
}
export async function initializeAuth() {setUser((await api('auth/session')).user, false);}
export function onAuthStateChanged(_auth, callback) {listeners.add(callback); void callback(auth.currentUser); return () => listeners.delete(callback);}
export async function signInWithEmailAndPassword(_auth, email, password) {return {user: setUser((await api('auth/login', 'POST', {email, password})).user)};}
export async function createUserWithEmailAndPassword(_auth, email, password, name) {return {user: setUser((await api('auth/signup', 'POST', {email, password, name})).user)};}
export async function sendEmailVerification() {await api('auth/resend', 'POST', {});}
export async function sendPasswordResetEmail(_auth, email) {await api('auth/reset', 'POST', {email});}
export async function signOut() {await api('auth/logout', 'POST', {}); setUser(null);}
export async function completeAccountAction(action, body) {setUser((await api(action === 'setup' ? 'auth/setup' : `auth/complete-${action}`, 'POST', body)).user);}
