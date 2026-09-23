import {initializeApp} from 'firebase/app';
import {getAuth, connectAuthEmulator} from 'firebase/auth';

export let auth;
export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true' || import.meta.env.DEV;
export async function initializeFirebase() {
  let config;
  if (useEmulators) {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('This local preview build cannot run on a public domain. Build again for production.');
    config = {apiKey: 'demo-key', authDomain: 'demo-reel-together.firebaseapp.com', projectId: 'demo-reel-together', appId: 'demo-app'};
  } else if (import.meta.env.VITE_FIREBASE_API_KEY) {
    config = {apiKey: import.meta.env.VITE_FIREBASE_API_KEY, authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID, appId: import.meta.env.VITE_FIREBASE_APP_ID};
  } else {
    // Firebase Hosting supplies public configuration for its own project.
    const response = await fetch('/__/firebase/init.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Firebase is not configured. Use npm run dev locally, or deploy to your Firebase project.');
    try { config = await response.json(); } catch { throw new Error('Firebase configuration is unavailable. Create a Firebase web app before deploying.'); }
  }
  auth = getAuth(initializeApp(config));
  if (useEmulators) connectAuthEmulator(auth, 'http://127.0.0.1:9503', {disableWarnings: true});
  return auth;
}
export async function api(path, method = 'GET', body, anonymous = false) {
  const headers = {'Content-Type': 'application/json'};
  if (!anonymous && auth.currentUser) headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
  const response = await fetch(`/api/${path}`, {method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body)});
  let data; try { data = await response.json(); } catch { throw new Error('The server did not respond as expected. Please try again.'); }
  if (!response.ok) { const error = new Error(data.message || 'The request failed. Please try again.'); error.status = response.status; throw error; }
  return data;
}
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
