import {auth, api} from './api.js';
const listeners = new Set();
function setUser(user, notify = true) {
  auth.currentUser = user;
  if (notify) for (const callback of listeners) void callback(user);
  return user;
}
export async function initializeAuth() {setUser((await api('auth/session')).user, false);}
export function onAuthStateChanged(_auth, callback) {listeners.add(callback); void callback(auth.currentUser); return () => listeners.delete(callback);}
export function renderGoogleSignIn(container, onError) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'button primary'; button.textContent = 'Continue with Google';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'text-button'; cancel.textContent = 'Cancel sign-in'; cancel.hidden = true;
  container.replaceChildren(button, cancel);
  button.onclick = () => {
    const popup = window.open('/identity/provider/start?provider=google', 'reel-google-signin', 'popup,width=520,height=720');
    if (!popup) {onError(new Error('Allow the sign-in popup, then try again.')); return;}
    button.disabled = true;
    cancel.hidden = false;
    const started = Date.now();
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      if (!container.isConnected || Date.now() - started > 5 * 60000) {
        clearInterval(timer); button.disabled = false; cancel.hidden = true;
        if (container.isConnected) onError(new Error('Sign-in timed out. Please try again.'));
        return;
      }
      inFlight = true;
      try {
        const {user} = await api('auth/session');
        if (user) {clearInterval(timer); try {popup.close();} catch {} setUser(user);}
        // Cross-Origin-Opener-Policy can make popup.closed report true during
        // Google sign-in. Only a verified app session completes this flow.
      } catch (error) {clearInterval(timer); button.disabled = false; cancel.hidden = true; onError(error);}
      finally {inFlight = false;}
    }, 1200);
    cancel.onclick = () => {clearInterval(timer); button.disabled = false; cancel.hidden = true; try {popup.close();} catch {}};
  };
}
export async function signOut() {await api('auth/logout', 'POST', {}); setUser(null);}
