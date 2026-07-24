/**
 * Discovery worker: services the watcher:discovery:queue list that the API
 * pushes job ids onto, running the shared DiscoveryEngine with real probes:
 *   ping        system ping (1 packet, 1s timeout) — no raw-socket privileges
 *   reverseDns  PTR lookup
 *   snmpIdentify sysName/sysDescr via the SNMP connector, trying each
 *               credential attached to the job until one answers
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import Redis from 'ioredis';
import { DiscoveryEngine } from '@watcher/shared/discovery-engine';
import { decryptCredential } from './credentials.js';

const execFileAsync = promisify(execFile);

export async function startDiscoveryWorker({ pg, redisUrl, log, connectors }) {
  // BRPOP blocks, so this loop needs its own connection.
  const queueRedis = new Redis(redisUrl);
  const snmp = connectors.get('snmp');

  const probes = {
    async ping(address) {
      try {
        await execFileAsync('ping', ['-c', '1', '-W', '1', address]);
        return true;
      } catch {
        return false;
      }
    },

    async reverseDns(address) {
      const names = await dns.reverse(address);
      return names[0] ?? null;
    },

    async snmpIdentify(address, job) {
      for (const credId of job.credential_ids ?? []) {
        try {
          const { rows } = await pg.query(
            "SELECT data_enc FROM credentials WHERE id = $1 AND protocol = 'snmp'", [credId]);
          if (!rows[0]) continue;
          const cred = decryptCredential(rows[0].data_enc);
          const identity = await snmp.identify(address, cred);
          if (identity) return identity;
        } catch {
          continue; // wrong community/creds for this device — try the next set
        }
      }
      return null;
    },
  };

  const engine = new DiscoveryEngine({ pg, log, probes });

  (async function loop() {
    for (;;) {
      try {
        const item = await queueRedis.brpop('watcher:discovery:queue', 30);
        if (!item) continue;
        const jobId = item[1];
        log.info({ jobId }, 'discovery job starting');
        const result = await engine.run(jobId);
        log.info({ jobId, ...result }, 'discovery job finished');
      } catch (err) {
        log.error({ err }, 'discovery worker iteration failed');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  log.info('discovery worker started');
}
