import {auth, api} from './api.js';
const listeners = new Set();
let googleScript;
function setUser(user, notify = true) {
  auth.currentUser = user;
  if (notify) for (const callback of listeners) void callback(user);
  return user;
}
export async function initializeAuth() {setUser((await api('auth/session')).user, false);}
export function onAuthStateChanged(_auth, callback) {listeners.add(callback); void callback(auth.currentUser); return () => listeners.delete(callback);}
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!googleScript) googleScript = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {clearTimeout(timer); script.remove(); googleScript = null; reject(new Error('Google sign-in could not load. Check your connection and try again.'));};
    const timer = setTimeout(fail, 15000);
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = () => {clearTimeout(timer); window.google?.accounts?.id ? resolve() : fail();};
    script.onerror = fail;
    document.head.append(script);
  });
  return googleScript;
}
export async function renderGoogleSignIn(container, onError) {
  const [, challenge] = await Promise.all([loadGoogle(), api('auth/google/challenge', 'POST', {})]);
  if (!container.isConnected) return;
  google.accounts.id.initialize({
    client_id: challenge.client_id, nonce: challenge.nonce, auto_select: false, ux_mode: 'popup',
    callback: async ({credential}) => {
      if (!container.isConnected || container.getAttribute('aria-busy') === 'true') return;
      container.setAttribute('aria-busy', 'true');
      try {setUser((await api('auth/google', 'POST', {credential})).user);}
      catch (error) {if (container.isConnected) onError(error);}
      finally {container.setAttribute('aria-busy', 'false');}
    },
  });
  google.accounts.id.renderButton(container, {type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: Math.min(360, container.clientWidth)});
}
export async function signOut() {
  await api('auth/logout', 'POST', {});
  window.google?.accounts?.id?.disableAutoSelect();
  setUser(null);
}
