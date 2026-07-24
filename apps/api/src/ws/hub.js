/**
 * WebSocket hub.
 *
 * One Redis subscription per API process; every connected browser gets a
 * fan-out copy of the events it asked for. Clients send:
 *   {"subscribe": ["state", "alerts", "metrics"]}
 * and receive envelopes:
 *   {"channel": "alerts", "data": {...}}
 */
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { REDIS_KEYS } from '@watcher/shared';

const CHANNELS = {
  state: REDIS_KEYS.eventsState,
  alerts: REDIS_KEYS.eventsAlerts,
  metrics: REDIS_KEYS.eventsMetrics,
};

export default fp(async function wsHub(fastify) {
  await fastify.register(websocket);

  /** Map<WebSocket, Set<channelName>> */
  const clients = new Map();

  await fastify.redisSub.subscribe(...Object.values(CHANNELS));
  fastify.redisSub.on('message', (redisChannel, message) => {
    const name = Object.keys(CHANNELS).find((k) => CHANNELS[k] === redisChannel);
    if (!name) return;
    const envelope = JSON.stringify({ channel: name, data: JSON.parse(message) });
    for (const [socket, subs] of clients) {
      if (subs.has(name) && socket.readyState === socket.OPEN) {
        socket.send(envelope);
      }
    }
  });

  fastify.get('/ws', { websocket: true }, (socket, request) => {
    // Authenticate via ?token= since browsers cannot set WS headers.
    try {
      const token = new URL(request.url, 'http://x').searchParams.get('token');
      fastify.jwt.verify(token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }

    clients.set(socket, new Set(['state', 'alerts']));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg.subscribe)) {
          clients.set(socket, new Set(msg.subscribe.filter((c) => c in CHANNELS)));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', () => clients.delete(socket));
  });
}, { name: 'watcher-ws', dependencies: ['watcher-redis', 'watcher-auth'] });
