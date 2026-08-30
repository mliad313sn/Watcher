#!/usr/bin/env node
/**
 * Watcher OS agent — a single dependency-free script that pushes host metrics
 * (CPU, memory, load, disk, uptime) to a Watcher API using a scoped API token.
 *
 *   WATCHER_URL=https://watcher.example \
 *   WATCHER_TOKEN=wtk_… \
 *   WATCHER_DEVICE=$(hostname) \
 *   node watcher-agent.mjs
 *
 * Env:
 *   WATCHER_URL       API origin (required)
 *   WATCHER_TOKEN     scoped API token, operator role (required)
 *   WATCHER_DEVICE    inventory device name (default: os.hostname())
 *   WATCHER_INTERVAL  seconds between pushes (default 30; 0 = one-shot)
 *   WATCHER_DISKS     comma-separated mount points to report (default "/")
 *
 * Linux-first (/proc); degrades gracefully where a source is missing.
 * No install, no daemon manager opinions — run it under systemd, cron,
 * a container sidecar, or nothing at all.
 */
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';

const URL_ = process.env.WATCHER_URL;
const TOKEN = process.env.WATCHER_TOKEN;
const DEVICE = process.env.WATCHER_DEVICE || os.hostname();
const INTERVAL = Number(process.env.WATCHER_INTERVAL ?? 30);
const DISKS = (process.env.WATCHER_DISKS ?? '/').split(',').map((s) => s.trim()).filter(Boolean);

if (!URL_ || !TOKEN) {
  console.error('watcher-agent: WATCHER_URL and WATCHER_TOKEN are required');
  process.exit(2);
}

/** Read aggregate jiffies from /proc/stat. */
function cpuTimes() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const [, ...nums] = line.trim().split(/\s+/);
    const t = nums.map(Number);
    const idle = t[3] + (t[4] ?? 0); // idle + iowait
    const total = t.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}

function memUsedPct() {
  try {
    const info = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map((l) => l.split(':')).filter((p) => p[1])
      .map(([k, v]) => [k.trim(), parseInt(v, 10)]));
    const total = info.MemTotal, avail = info.MemAvailable ?? info.MemFree;
    if (!total) return null;
    return 100 * (1 - avail / total);
  } catch { return null; }
}

let prevCpu = cpuTimes();

async function collect() {
  const metrics = [];
  const push = (metric, value, instance) => {
    if (Number.isFinite(value)) metrics.push({ metric, value: Number(value.toFixed(3)), ...(instance ? { instance } : {}) });
  };

  const cur = cpuTimes();
  if (cur && prevCpu && cur.total > prevCpu.total) {
    const dTotal = cur.total - prevCpu.total;
    const dIdle = cur.idle - prevCpu.idle;
    push('cpu.util.pct', 100 * (1 - dIdle / dTotal));
  }
  prevCpu = cur ?? prevCpu;

  push('mem.used.pct', memUsedPct());
  push('load.1m', os.loadavg()[0]);
  push('uptime.s', os.uptime());

  for (const mount of DISKS) {
    try {
      const s = await statfs(mount);
      const usedPct = 100 * (1 - s.bavail / s.blocks);
      push('disk.used.pct', usedPct, mount);
    } catch { /* mount absent — skip */ }
  }
  return metrics;
}

async function send(metrics) {
  const res = await fetch(`${URL_.replace(/\/$/, '')}/api/metrics/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Token': TOKEN },
    body: JSON.stringify({ device: DEVICE, metrics }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function tick() {
  try {
    const metrics = await collect();
    if (metrics.length === 0) { console.error('watcher-agent: nothing to report'); return; }
    const { accepted } = await send(metrics);
    console.log(`watcher-agent: pushed ${accepted} metric(s) for ${DEVICE}`);
  } catch (err) {
    console.error(`watcher-agent: push failed — ${err.message}`);
  }
}

if (INTERVAL > 0) {
  // First CPU sample needs a delta window; prime then run forever.
  setTimeout(tick, 2000);
  setInterval(tick, INTERVAL * 1000);
  console.log(`watcher-agent: reporting ${DEVICE} to ${URL_} every ${INTERVAL}s`);
} else {
  // One-shot mode (cron): brief delay to get a real CPU delta.
  await new Promise((r) => setTimeout(r, 2000));
  await tick();
}
