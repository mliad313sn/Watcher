const form = document.getElementById('login');
const errorEl = document.getElementById('error');
let phase = 'login'; // 'login' | 'change'

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
