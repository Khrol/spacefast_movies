import './app.css';
import './account.css';
import {onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signOut, initializeAuth, completeAccountAction} from './auth.js';
import {auth, api, escape} from './api.js';
import {welcome, shell} from './shell.js';
import {mountDiary} from './diary.js';
import {membership, administration} from './views.js';

const root = document.getElementById('app');
let publicConfig, bootVersion = 0, stopWatchingAuth;
const errorText = error => ({'auth/invalid-credential': 'The email or password is incorrect.', 'auth/too-many-requests': 'Too many attempts. Please try again later.', 'auth/email-already-in-use': 'An account already uses this email. Try signing in or resetting your password.', 'auth/weak-password': 'Use a stronger password with at least 12 characters.', 'auth/network-request-failed': 'Could not connect. Check your connection and try again.'}[error.code] || error.message || 'Please try again.');
function status(message) { const el = document.getElementById('auth-message'); if (el) el.textContent = message; }
function login(mode = 'login') {
  const signup = mode === 'signup', reset = mode === 'reset';
  root.innerHTML = welcome(`<p class="eyebrow">WELCOME TO YOUR LITTLE CINEMA</p><h2>${signup ? 'Save your seat.' : reset ? 'Let’s get you back in.' : 'Come on in.'}</h2><p>${signup ? 'Create an account, then verify your email.' : reset ? 'We’ll email you a link to choose a new password.' : 'Sign in to your private diary and household watchlist.'}</p>${publicConfig?.billing_enabled ? '<p>Membership is €1 per person, per month. The owner can grant complimentary access.</p>' : ''}<form id="auth-form">${signup ? '<label for="display-name">Your name</label><input id="display-name" name="name" required maxlength="100" autocomplete="name">' : ''}<label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email">${!reset ? `<label for="password">Password</label><input id="password" name="password" type="password" required ${signup ? 'minlength="12"' : ''} autocomplete="${signup ? 'new-password' : 'current-password'}">` : ''}<button class="button primary" type="submit">${signup ? 'Create account' : reset ? 'Send reset link' : 'Open my diary'}</button><p id="auth-message" class="form-error" role="status" aria-live="polite"></p></form>${mode !== 'login' ? '<button class="text-button" data-auth-view="login">Back to sign in</button>' : '<button class="text-button" data-auth-view="reset">Forgot your password?</button><p class="signup">New here? <button class="text-button" data-auth-view="signup">Create an account</button></p>'}${!publicConfig?.public_registration ? '<details class="invitation-request"><summary>Request an invitation</summary><p>The site owner reviews requests personally. Creating an account requires their approval.</p><form id="invitation-form"><label for="invite-name">Your name</label><input id="invite-name" name="name" maxlength="100" required autocomplete="name"><label for="invite-email">Email</label><input id="invite-email" name="email" type="email" maxlength="254" required autocomplete="email"><div class="honeypot" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div><button class="button secondary" type="submit">Request invitation</button><p class="form-error" role="status"></p></form></details>' : ''}`);
  document.getElementById('auth-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector('button'); button.disabled = true;
    const address = form.elements.email.value.trim();
    try {
      if (reset) { await sendPasswordResetEmail(auth, address); status('If an account exists for this email, a reset link is on its way.'); }
      else if (signup) {
        await createUserWithEmailAndPassword(auth, address, form.elements.password.value, form.elements.name.value.trim());
        verifyScreen(); status('Check your inbox for the verification link.');
      } else await signInWithEmailAndPassword(auth, address, form.elements.password.value);
    } catch (error) { status(errorText(error)); }
    finally { button.disabled = false; }
  });
  document.getElementById('invitation-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector('button'); button.disabled = true;
    try { await api('invitations', 'POST', Object.fromEntries(new FormData(form)), true); form.querySelector('[role=status]').textContent = 'Your request has been received. The owner will review it.'; }
    catch (error) { form.querySelector('[role=status]').textContent = errorText(error); }
    finally { button.disabled = false; }
  });
}
function verifyScreen() {
  root.innerHTML = welcome('<h2>Check your email.</h2><p>Verify your email address to open your diary.</p><button class="button primary" id="check-verification">I’ve verified my email</button><button class="text-button" id="resend-verification">Resend verification email</button><button class="text-button" data-signout>Sign out</button><p id="auth-message" class="form-error" role="status"></p>');
  document.getElementById('check-verification').onclick = async event => {
    event.target.disabled = true;
    try { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); if (auth.currentUser.emailVerified) await boot(auth.currentUser); else status('Your email is not verified yet. Open the link in your inbox, then try again.'); }
    catch (error) { status(errorText(error)); }
    finally { event.target.disabled = false; }
  };
  document.getElementById('resend-verification').onclick = async event => {
    event.target.disabled = true;
    try { await sendEmailVerification(auth.currentUser); status('Verification email sent.'); } catch (error) { status(errorText(error)); }
    finally { event.target.disabled = false; }
  };
}
async function boot(user) {
  const version = ++bootVersion;
  if (!user) { login(); return; }
  if (!user.emailVerified) { verifyScreen(); return; }
  try {
    const session = await api('session'); if (version !== bootVersion) return;
    if (!session.approved && !session.admin) {
      root.innerHTML = welcome('<h2>Your seat is nearly ready.</h2><p>Your account is waiting for the site owner’s approval. You can request an invitation from the sign-in page.</p><button class="button primary" id="check-approval">Check again</button><button class="text-button" id="pending-billing">Manage an existing subscription</button><p id="auth-message" role="status"></p><button class="text-button" data-signout>Sign out</button>');
      document.getElementById('check-approval').onclick = () => boot(auth.currentUser);
      document.getElementById('pending-billing').onclick = async () => {
        try { const result = await api('billing/portal', 'POST', {}); const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') throw new Error('Unexpected billing destination.'); location.assign(url.href); } catch (error) { status(errorText(error)); }
      }; return;
    }
    root.innerHTML = shell(session.admin);
    document.getElementById('account-name').textContent = session.name;
    window.ReelViews = {membership, admin: administration};
    await mountDiary();
    const params = new URLSearchParams(location.search);
    if (params.has('checkout_session')) {
      try { await api('billing/return', 'POST', {mode: params.get('billing_mode') || 'live', session_id: params.get('checkout_session')}); await membership('Payment verified. Thank you!'); }
      catch (error) { await membership(errorText(error)); }
      history.replaceState(null, '', '/');
    } else if (params.has('membership')) await membership();
  } catch (error) {
    root.innerHTML = welcome(`<h2>We couldn’t open your diary.</h2><p role="alert">${escape(errorText(error))}</p><button class="button primary" id="retry-session">Try again</button><button class="text-button" data-signout>Sign out</button>`);
    document.getElementById('retry-session').onclick = () => boot(auth.currentUser);
  }
}
root.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-signout')) { await signOut(auth); return; }
  if (button.dataset.authView) login(button.dataset.authView);
  if (button.dataset.section) { try { await window.ReelViews[button.dataset.section](); } catch (error) { alert(errorText(error)); } }
});
try {
  await initializeAuth(); publicConfig = await api('config', 'GET', undefined, true);
  if (!openAccountAction()) watchAuth();
  window.addEventListener('hashchange', openAccountAction);
} catch (error) {
  root.innerHTML = welcome(`<h2>Let’s get things ready.</h2><p role="alert">${escape(errorText(error))}</p><button class="button primary" id="reload">Try again</button>`);
  document.getElementById('reload').onclick = () => location.reload();
}

function watchAuth() {
  stopWatchingAuth?.();
  stopWatchingAuth = onAuthStateChanged(auth, boot);
}
function openAccountAction() {
  const params = new URLSearchParams(location.hash.slice(1));
  const action = ['setup', 'verify', 'reset'].find(key => params.has(key));
  if (!action) return false;
  stopWatchingAuth?.();
  ++bootVersion;
  const token = params.get(action);
  history.replaceState(null, '', location.pathname + location.search);
  accountAction(action, token);
  return true;
}
function accountAction(action, token) {
  const setup = action === 'setup', verify = action === 'verify';
  root.innerHTML = welcome(`<h2>${setup ? 'Your cinema starts here.' : verify ? 'Verify your email.' : 'Choose a new password.'}</h2><p>${setup ? 'Create your owner account to open Reel Together.' : verify ? 'Confirm your email address to continue.' : 'Use at least 12 characters to protect your diary.'}</p><form id="account-action">${setup ? '<label for="setup-name">Your name</label><input id="setup-name" name="name" required maxlength="100" autocomplete="name">' : ''}${verify ? '' : '<label for="new-password">New password</label><input id="new-password" name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password">'}<button class="button primary">${setup ? 'Open my cinema' : verify ? 'Verify email' : 'Save password'}</button><p id="auth-message" class="form-error" role="status"></p></form>`);
  document.getElementById('account-action').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector('button'); button.disabled = true;
    try {await completeAccountAction(action, {token, ...Object.fromEntries(new FormData(form))}); watchAuth();}
    catch (error) {status(errorText(error)); button.disabled = false;}
  };
}
