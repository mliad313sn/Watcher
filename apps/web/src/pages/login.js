document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    if (!res.ok) throw new Error('Invalid username or password');
    const { token, user } = await res.json();
    localStorage.setItem('watcher.token', token);
    localStorage.setItem('watcher.user', JSON.stringify(user));
    location.href = '/index.html';
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
