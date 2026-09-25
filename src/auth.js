import {auth, api, setSession} from './api.js';
const listeners = new Set();
let googleScript;
function setUser(user, notify = true) {
  auth.currentUser = user;
  if (notify) for (const callback of listeners) void callback(user);
  return user;
}
export async function initializeAuth() {
  let user = null;
  try {({user} = await api('auth/session'));} catch (error) {if (error.status !== 401) throw error;}
  if (!user) setSession('');
  setUser(user, false);
}
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
export async function renderGoogleSignIn(container, onError, {demo = false} = {}) {
  const complete = async (credential, challenge) => {
    if (!container.isConnected || container.getAttribute('aria-busy') === 'true') return;
    container.setAttribute('aria-busy', 'true');
    try {
      const result = await api('auth/google', 'POST', {credential, challenge});
      setSession(result.session); setUser(result.user);
    }
    catch (error) {if (container.isConnected) onError(error);}
    finally {container.setAttribute('aria-busy', 'false');}
  };
  if (demo) {
    for (const person of ['developer', 'guest']) {
      const button = document.createElement('button');
      button.className = 'button primary'; button.textContent = `Local ${person}`;
      button.onclick = async () => {
        button.disabled = true;
        try {
          const challenge = await api('auth/google/challenge', 'POST', {});
          const {credential} = await api('dev/google', 'POST', {person, nonce: challenge.nonce});
          await complete(credential, challenge.challenge);
        } catch (error) {onError(error);} finally {button.disabled = false;}
      };
      container.append(button);
    }
    return;
  }
  container.textContent = 'Loading Google sign-in…';
  // Load the SDK first so a slow/blocked script cannot race a retry's nonce.
  await loadGoogle();
  if (!container.isConnected) return;
  const challenge = await api('auth/google/challenge', 'POST', {});
  if (!container.isConnected) return;
  container.replaceChildren();
  google.accounts.id.initialize({
    client_id: challenge.client_id, nonce: challenge.nonce, auto_select: false, ux_mode: 'popup',
    callback: ({credential}) => complete(credential, challenge.challenge),
  });
  let width = 0;
  const renderButton = () => {
    const nextWidth = Math.floor(Math.min(360, container.clientWidth));
    if (!nextWidth || nextWidth === width) return;
    width = nextWidth; container.replaceChildren();
    google.accounts.id.renderButton(container, {type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width});
  };
  renderButton();
  const resize = new ResizeObserver(() => {
    if (!container.isConnected) {resize.disconnect(); return;}
    renderButton();
  });
  resize.observe(container);
}
export async function signOut() {
  await api('auth/logout', 'POST', {});
  setSession('');
  window.google?.accounts?.id?.disableAutoSelect();
  setUser(null);
}
