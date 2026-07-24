/** REST + WebSocket client shared by every page. */

export function token() {
  return localStorage.getItem('watcher.token');
}

/** Redirect to login when unauthenticated — call at the top of each page. */
export function requireAuth() {
  if (!token()) location.href = '/login.html';
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('watcher.token');
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? detail.message ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Live event stream with auto-reconnect.
 * @param {string[]} channels e.g. ['state','alerts']
 * @param {(channel: string, data: any) => void} onEvent
 * @returns {() => void} close function
 */
export function liveEvents(channels, onEvent) {
  let socket;
  let closed = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws?token=${token()}`);
    socket.onopen = () => socket.send(JSON.stringify({ subscribe: channels }));
    socket.onmessage = (e) => {
      try {
        const { channel, data } = JSON.parse(e.data);
        onEvent(channel, data);
      } catch { /* ignore */ }
    };
    socket.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  }
  connect();
  return () => { closed = true; socket?.close(); };
}

/** Chip class for a Nagios state event / status hash. */
export function chipClassFor(obj) {
  if (obj.kind === 'host') return ['up', 'down', 'unreachable'][obj.state] ?? 'unknown';
  return ['ok', 'warning', 'critical', 'unknown'][obj.state] ?? 'unknown';
}
