/**
 * Wiring for the event plane: build the pipeline, start whichever receivers
 * are configured, and hand back a stop function.
 *
 * Both receivers are OFF unless a port is configured. That is deliberate:
 * 162/udp and 514/udp are privileged ports, and a monitoring product that
 * silently opens two of them on every install is a product that gets
 * uninstalled by a security team. Turning them on is one environment
 * variable and one documented capability grant.
 */
import { EventPipeline } from './pipeline.js';
import { SyslogReceiver } from './syslog.js';
import { TrapReceiver } from './traps.js';
import { AutoClearSweeper } from './auto-clear.js';
import { FlowReceiver } from './flow.js';

/** Parse `name/level/authProto/authKey/privProto/privKey`, one user per entry. */
export function parseV3Users(spec) {
  if (!spec) return [];
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, level, authProtocol, authKey, privProtocol, privKey] = entry.split('/');
    return { name, level: level || 'authPriv', authProtocol, authKey, privProtocol, privKey };
  }).filter((u) => u.name);
}

export async function startReceivers({ pg, tsdb, redis, log }) {
  const trapPort = Number(process.env.TRAP_PORT ?? 0);
  const syslogPort = Number(process.env.SYSLOG_PORT ?? 0);
  const flowPort = Number(process.env.FLOW_PORT ?? 0);
  if (!trapPort && !syslogPort && !flowPort) {
    log.info('event receivers disabled (set TRAP_PORT, SYSLOG_PORT and/or FLOW_PORT to enable)');
    return { stop: async () => {}, pipeline: null };
  }

  const started = [];

  // Flow is its own path: records are folded at ingest and written as
  // conversations, and nothing about them can raise an alert — so it needs
  // neither the rule engine nor the sender allow-list.
  if (flowPort) {
    const flow = new FlowReceiver({
      port: flowPort,
      flushMs: Number(process.env.FLOW_FLUSH_MS ?? 60_000),
      maxKeys: Number(process.env.FLOW_MAX_CONVERSATIONS ?? 20_000),
    }, { pg, tsdb, log });
    await flow.start();
    started.push(flow);
  }

  if (!trapPort && !syslogPort) {
    return { pipeline: null, stop: async () => { for (const r of started) await r.stop?.(); } };
  }

  const pipeline = new EventPipeline({
    pg, tsdb, redis, log,
    limits: {
      limit: Number(process.env.EVENT_RATE_LIMIT ?? 200),
      windowMs: Number(process.env.EVENT_RATE_WINDOW_MS ?? 60_000),
    },
  });

  if (trapPort) {
    const traps = new TrapReceiver({
      port: trapPort,
      communities: String(process.env.TRAP_COMMUNITIES ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      users: parseV3Users(process.env.TRAP_V3_USERS),
    }, { pipeline, log });
    traps.start();
    started.push(traps);
  }

  if (syslogPort) {
    const syslog = new SyslogReceiver({
      port: syslogPort,
      udp: process.env.SYSLOG_UDP !== '0',
      tcp: process.env.SYSLOG_TCP !== '0',
    }, { pipeline, log });
    await syslog.start();
    started.push(syslog);
  }

  const sweeper = new AutoClearSweeper({ pg, redis, log });
  sweeper.start();

  // The API publishes here after a rule or source is edited, so a change
  // takes effect on the next event rather than after the cache TTL.
  const sub = redis.duplicate();
  await sub.subscribe('watcher:events:rules-changed');
  sub.on('message', () => pipeline.invalidate());

  return {
    pipeline,
    stop: async () => {
      sweeper.stop();
      await sub.quit().catch(() => {});
      for (const r of started) await r.stop?.();
      // Last, so anything still in flight is queued before the flusher drains.
      await pipeline.stop();
    },
  };
}
