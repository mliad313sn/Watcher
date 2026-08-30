const form = document.getElementById('login');
const errorEl = document.getElementById('error');
let phase = 'login'; // 'login' | 'change'

// ── SSO return path: the OIDC callback lands here with the session token in
// the URL fragment (never the query string, so it stays out of server logs).
(function handleSsoFragment() {
  const frag = new URLSearchParams(location.hash.slice(1));
  const token = frag.get('sso_token');
  const ssoError = frag.get('sso_error');
  if (ssoError) {
    errorEl.textContent = ssoError;
    history.replaceState(null, '', location.pathname);
    return;
  }
  if (!token) return;
  history.replaceState(null, '', location.pathname); // scrub the token from the URL
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    localStorage.setItem('watcher.token', token);
    localStorage.setItem('watcher.user', JSON.stringify({
      id: claims.sub, username: claims.username, displayName: claims.username,
      role: claims.role, tenant: claims.tenant,
    }));
    location.href = '/index.html';
  } catch {
    errorEl.textContent = 'Sign-in failed — invalid session token.';
  }
})();

// ── Offer the SSO button when the server has an IdP configured.
(async function offerSso() {
  try {
    const res = await fetch('/api/auth/sso/config');
    if (!res.ok) return;
    const { oidc } = await res.json();
    if (!oidc) return;
    const btn = document.createElement('a');
    btn.href = '/api/auth/sso/login';
    btn.className = 'btn';
    btn.style.cssText = 'width:100%;justify-content:center;margin-top:10px;text-decoration:none';
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:17px" aria-hidden="true">shield</span>`
      + `Continue with ${oidc.label.replace(/[<>&]/g, '')}`;
    form.after(btn);
    const or = document.createElement('div');
    or.className = 'dim';
    or.style.cssText = 'text-align:center;font-size:11px;margin-top:10px;letter-spacing:.08em';
    or.textContent = '— OR —';
    form.after(or);
  } catch { /* no SSO — password form stands alone */ }
})();

form.addEventListener('submit', async (e) => {
  if (phase !== 'login') return; // change-password has its own handler
  e.preventDefault();
  errorEl.textContent = '';
  const currentPassword = document.getElementById('password').value;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: currentPassword,
      }),
    });
    if (res.status === 429) throw new Error('Too many attempts — try again shortly.');
    if (!res.ok) throw new Error('Invalid username or password');
    const { token, user, passwordChangeRequired } = await res.json();
    localStorage.setItem('watcher.token', token);
    localStorage.setItem('watcher.user', JSON.stringify(user));

    // Enforce rotation of the seeded/temporary password before the session is
    // usable (issue #7 — otherwise admin/admin stays live).
    if (passwordChangeRequired) {
      showChangePassword(token, currentPassword);
      return;
    }
    location.href = '/index.html';
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function showChangePassword(token, currentPassword) {
  phase = 'change';
  form.innerHTML = `
    <div class="row" style="justify-content:center;margin-bottom:6px;gap:10px">
      <span class="material-symbols-outlined" style="color:var(--accent);font-size:28px">lock_reset</span>
      <strong style="font-size:20px;color:var(--text-head)">Set a new password</strong>
    </div>
    <div class="label-caps" style="text-align:center;margin-bottom:14px">Required before first use</div>
    <label for="np">New password (min 8 chars)</label>
    <input id="np" type="password" autocomplete="new-password" minlength="8" required />
    <label for="np2">Confirm password</label>
    <input id="np2" type="password" autocomplete="new-password" minlength="8" required />
    <div id="cp-error" style="color:var(--critical);font-size:12px;margin-top:10px;min-height:16px"></div>
    <button class="btn primary" style="width:100%;justify-content:center;margin-top:8px">Update password</button>`;

  const err2 = form.querySelector('#cp-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err2.textContent = '';
    const np = form.querySelector('#np').value;
    if (np !== form.querySelector('#np2').value) {
      err2.textContent = 'Passwords do not match.';
      return;
    }
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword: np }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Could not update password');
      }
      location.href = '/index.html';
    } catch (e2) {
      err2.textContent = e2.message;
    }
  });
}
