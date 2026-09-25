import './app.css';
import './account.css';
import {onAuthStateChanged, signOut, initializeAuth, renderGoogleSignIn} from './auth.js';
import {auth, api, escape} from './api.js';
import {welcome, shell} from './shell.js';
import {mountDiary} from './diary.js';
import {administration} from './views.js';

const root = document.getElementById('app');
let publicConfig, bootVersion = 0;
const errorText = error => error.message || 'Please try again.';
function login() {
  root.innerHTML = welcome('<p class="eyebrow">WELCOME TO YOUR LITTLE CINEMA</p><h2>Come on in.</h2><p>Continue with Google to start your free movie diary. New here? Your account is created automatically.</p><div id="google-signin" class="google-signin"></div><p id="auth-message" class="form-error" role="status" aria-live="polite"></p><button class="text-button" id="retry-google" hidden>Try Google sign-in again</button><p class="helper">Your diary is private. Choose what to share with your household and watching companions.</p>');
  const container = document.getElementById('google-signin'), message = document.getElementById('auth-message'), retry = document.getElementById('retry-google');
  if (publicConfig.local_identity) message.textContent = 'Local demo: sign-in is simulated and data stays on this computer.';
  const failed = error => {message.textContent = errorText(error); retry.hidden = false;};
  retry.onclick = () => login();
  if (!publicConfig.google_configured) {failed(new Error('Google sign-in is being set up. Please check back soon.')); return;}
  renderGoogleSignIn(container, failed);
}
async function boot(user) {
  const version = ++bootVersion;
  if (!user) { login(); return; }
  try {
    const session = await api('session'); if (version !== bootVersion) return;
    root.innerHTML = shell(session.admin);
    document.getElementById('account-name').textContent = session.name;
    window.ReelViews = {admin: administration};
    await mountDiary();
  } catch (error) {
    if (version !== bootVersion) return;
    root.innerHTML = welcome(`<h2>We couldn’t open your diary.</h2><p role="alert">${escape(errorText(error))}</p><button class="button primary" id="retry-session">Try again</button><button class="text-button" data-signout>Sign out</button>`);
    document.getElementById('retry-session').onclick = () => boot(auth.currentUser);
  }
}
root.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.hasAttribute('data-signout')) {await signOut(); return;}
    if (button.dataset.section) await window.ReelViews[button.dataset.section]();
  } catch (error) {alert(errorText(error));}
});
try {
  // Retired setup/reset URLs must not keep credentials in the address bar.
  if (['setup', 'verify', 'reset'].some(key => new URLSearchParams(location.hash.slice(1)).has(key))) history.replaceState(null, '', location.pathname + location.search);
  await initializeAuth(); publicConfig = await api('config');
  onAuthStateChanged(auth, boot);
} catch (error) {
  root.innerHTML = welcome(`<h2>Let’s get things ready.</h2><p role="alert">${escape(errorText(error))}</p><button class="button primary" id="reload">Try again</button>`);
  document.getElementById('reload').onclick = () => location.reload();
}
