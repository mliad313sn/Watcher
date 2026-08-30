/**
 * WebSocket hub.
 *
 * One Redis subscription per API process; every connected browser gets a
 * fan-out copy of the events it asked for. Clients send:
 *   {"subscribe": ["state", "alerts", "metrics"]}
 * and receive envelopes:
 *   {"channel": "alerts", "data": {...}}
 *
 * Hardening (issues #3, #4, WS-low):
 *   - Auth token is read from the `Sec-WebSocket-Protocol` header
 *     (client connects with `['bearer', <jwt>]`), not the URL query string,
 *     so it never lands in access logs. A `?token=` fallback remains for
 *     non-browser clients.
 *   - `state` and `alerts` events are filtered to the socket's tenant, so a
 *     viewer never receives another tenant's data.
 *   - Backpressure: events are dropped for a socket whose send buffer is
 *     backed up, instead of buffering unboundedly under an event storm.
 *   - Token expiry is enforced for the life of the connection.
 */
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { REDIS_KEYS } from '@watcher/shared';

const CHANNELS = {
  state: REDIS_KEYS.eventsState,
  alerts: REDIS_KEYS.eventsAlerts,
  metrics: REDIS_KEYS.eventsMetrics,
};

// Drop events for a socket once its outbound buffer exceeds this (bytes).
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB

function tenantOfEvent(name, data) {
  if (name === 'alerts') return data?.alert?.tenant_id ?? null;
  if (name === 'state') return data?.tenantId ?? null;
  return null; // metrics ticks are keyed by opaque device id — not tenant-filtered
}

function bearerFromRequest(request) {
  // Preferred: Sec-WebSocket-Protocol: "bearer, <jwt>"
  const proto = request.headers['sec-websocket-protocol'];
  if (proto) {
    const parts = proto.split(',').map((p) => p.trim());
    const idx = parts.indexOf('bearer');
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
  }
  // Fallback: ?token= (non-browser clients)
  try {
    return new URL(request.url, 'http://x').searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

export default fp(async function wsHub(fastify) {
  await fastify.register(websocket);

  /** Map<WebSocket, { subs: Set<string>, tenantId: string, exp: number }> */
  const clients = new Map();

  await fastify.redisSub.subscribe(...Object.values(CHANNELS));
  fastify.redisSub.on('message', (redisChannel, message) => {
    const name = Object.keys(CHANNELS).find((k) => CHANNELS[k] === redisChannel);
    if (!name) return;
    // A malformed message on the bus must never take the API down.
    let data;
    try { data = JSON.parse(message); }
    catch { fastify.log.warn({ redisChannel }, 'dropped malformed event on bus'); return; }
    const eventTenant = tenantOfEvent(name, data);
    const envelope = JSON.stringify({ channel: name, data });
    const nowS = Date.now() / 1000;

    for (const [socket, info] of clients) {
      if (!info.subs.has(name)) continue;
      if (socket.readyState !== socket.OPEN) continue;
      // Enforce token expiry mid-connection.
      if (info.exp && nowS > info.exp) { socket.close(4401, 'token expired'); continue; }
      // Tenant isolation for sensitive channels.
      if (eventTenant !== null && eventTenant !== info.tenantId) continue;
      // Backpressure: shed rather than buffer unboundedly.
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      socket.send(envelope);
    }
  });

  fastify.get('/ws', { websocket: true }, (socket, request) => {
    let claims;
    try {
      claims = fastify.jwt.verify(bearerFromRequest(request));
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }

    clients.set(socket, {
      subs: new Set(['state', 'alerts']),
      tenantId: claims.tenantId,
      exp: claims.exp,
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg.subscribe)) {
          const info = clients.get(socket);
          if (info) info.subs = new Set(msg.subscribe.filter((c) => c in CHANNELS));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', () => clients.delete(socket));
  });
}, { name: 'watcher-ws', dependencies: ['watcher-redis', 'watcher-auth'] });
