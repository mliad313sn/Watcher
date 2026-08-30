/** Shared runbook lookup for the API routes and the notifier enrichment. */
import { matchRunbook } from './match.js';

/** Resolve the best runbook for an alert (loads the device for kind/tags). */
export async function runbookForAlert(pg, alert) {
  const [{ rows: books }, device] = await Promise.all([
    pg.query('SELECT * FROM runbooks WHERE tenant_id = $1 AND enabled', [alert.tenant_id]),
    alert.device_id
      ? pg.query('SELECT kind, tags FROM devices WHERE id = $1', [alert.device_id]).then((r) => r.rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  return matchRunbook({ alert, device, runbooks: books });
}
