/**
 * Writer for the Nagios external command file (named pipe).
 *
 * Format: [unix_timestamp] COMMAND;arg1;arg2;...
 * Reference: https://www.nagios.org/developerinfo/externalcommands/
 *
 * Watcher only ever *appends* single lines, exactly like the Nagios CGIs, so
 * it coexists safely with other tooling using the same pipe.
 */
import { open } from 'node:fs/promises';

function sanitize(arg) {
  // Semicolons delimit args and newlines delimit commands — strip both.
  return String(arg).replaceAll(/[;\n\r]/g, ' ');
}

export class NagiosCommandWriter {
  constructor(commandFile) {
    this.commandFile = commandFile;
  }

  async #write(command, ...args) {
    const ts = Math.floor(Date.now() / 1000);
    const line = `[${ts}] ${[command, ...args.map(sanitize)].join(';')}\n`;
    const handle = await open(this.commandFile, 'a');
    try {
      await handle.write(line);
    } finally {
      await handle.close();
    }
    return line.trim();
  }

  acknowledgeHost(host, user, comment, { sticky = true, notify = true } = {}) {
    return this.#write('ACKNOWLEDGE_HOST_PROBLEM',
      host, sticky ? 2 : 1, notify ? 1 : 0, 1, user, comment);
  }

  acknowledgeService(host, service, user, comment, { sticky = true, notify = true } = {}) {
    return this.#write('ACKNOWLEDGE_SVC_PROBLEM',
      host, service, sticky ? 2 : 1, notify ? 1 : 0, 1, user, comment);
  }

  removeHostAcknowledgement(host) {
    return this.#write('REMOVE_HOST_ACKNOWLEDGEMENT', host);
  }

  removeServiceAcknowledgement(host, service) {
    return this.#write('REMOVE_SVC_ACKNOWLEDGEMENT', host, service);
  }

  /** Force an immediate re-check. */
  recheckHost(host) {
    return this.#write('SCHEDULE_FORCED_HOST_CHECK', host, Math.floor(Date.now() / 1000));
  }

  recheckService(host, service) {
    return this.#write('SCHEDULE_FORCED_SVC_CHECK', host, service, Math.floor(Date.now() / 1000));
  }

  /** start/end are unix timestamps; fixed downtime. */
  scheduleHostDowntime(host, start, end, user, comment) {
    return this.#write('SCHEDULE_HOST_DOWNTIME',
      host, start, end, 1, 0, end - start, user, comment);
  }

  scheduleServiceDowntime(host, service, start, end, user, comment) {
    return this.#write('SCHEDULE_SVC_DOWNTIME',
      host, service, start, end, 1, 0, end - start, user, comment);
  }
}
