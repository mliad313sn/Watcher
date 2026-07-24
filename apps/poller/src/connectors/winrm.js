/**
 * Windows Server connector over WinRM (WS-Management SOAP).
 *
 * Deep Windows monitoring without agents: CPU, memory, disks, services, IIS
 * app pools and Active Directory health — all via CIM/WMI queries executed
 * through WinRM's WQL binding (no remote shell needed, though the shell path
 * is available for richer PowerShell collectors later).
 *
 * This is a minimal, dependency-free WS-Man client: enough of the SOAP
 * envelope to Enumerate + Pull a WQL query result. Auth: HTTP Basic over
 * HTTPS (5986) or NTLM via an upstream proxy — for production Kerberos,
 * front this with a gateway or swap the transport for a full client library;
 * the query layer above stays unchanged.
 *
 * Credential blob: { user, password, port?: 5985|5986, https?: boolean }
 */
import { randomUUID } from 'node:crypto';

const WQL = {
  cpu: "SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name='_Total'",
  memory: 'SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem',
  disks: "SELECT DeviceID, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3",
  services: "SELECT Name, State FROM Win32_Service WHERE StartMode='Auto'",
  iisAppPools: 'SELECT Name, PercentProcessorTime FROM Win32_PerfFormattedData_APPPOOLCountersProvider_APPPOOLWAS',
  iisRequests: 'SELECT Name, CurrentConnections, TotalMethodRequestsPerSec FROM Win32_PerfFormattedData_W3SVC_WebService',
  adDra: 'SELECT DRAPendingReplicationSynchronizations, DSDirectorySearchesPerSec FROM Win32_PerfFormattedData_DirectoryServices_DirectoryServices',
};

function soapEnvelope({ endpoint, wql, enumerationContext }) {
  const messageId = `uuid:${randomUUID()}`;
  const action = enumerationContext
    ? 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull'
    : 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate';
  const body = enumerationContext
    ? `<n:Pull xmlns:n="http://schemas.xmlsoap.org/ws/2004/09/enumeration">
         <n:EnumerationContext>${enumerationContext}</n:EnumerationContext>
         <n:MaxElements>512</n:MaxElements>
       </n:Pull>`
    : `<n:Enumerate xmlns:n="http://schemas.xmlsoap.org/ws/2004/09/enumeration">
         <w:Filter xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
                   Dialect="http://schemas.microsoft.com/wbem/wsman/1/WQL">${escapeXml(wql)}</w:Filter>
       </n:Enumerate>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">
  <s:Header>
    <a:To>${endpoint}</a:To>
    <a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>
    <w:ResourceURI s:mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/*</w:ResourceURI>
    <a:Action s:mustUnderstand="true">${action}</a:Action>
    <w:MaxEnvelopeSize s:mustUnderstand="true">512000</w:MaxEnvelopeSize>
    <a:MessageID>${messageId}</a:MessageID>
    <w:OperationTimeout>PT30S</w:OperationTimeout>
  </s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

function escapeXml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Very small extractor: pulls <p:Prop>value</p:Prop> pairs per item block. */
function parseItems(xml) {
  const items = [];
  const itemRe = /<w?:?Items?>([\s\S]*?)<\/w?:?Items?>|<n:Items>([\s\S]*?)<\/n:Items>/g;
  const blockRe = /<(?:\w+:)?(Win32_\w+|CIM_\w+)[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
  const propRe = /<(?:\w+:)?(\w+)(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?\1>/g;

  const scope = (itemRe.exec(xml)?.[1] ?? xml);
  let block;
  while ((block = blockRe.exec(scope)) !== null) {
    const obj = {};
    let prop;
    while ((prop = propRe.exec(block[2])) !== null) obj[prop[1]] = prop[2];
    items.push(obj);
  }
  return { items, context: xml.match(/<n:EnumerationContext>([^<]*)</)?.[1] ?? null, done: /EndOfSequence/.test(xml) };
}

export class WinrmConnector {
  constructor({ writer, log, fetchImpl = fetch }) {
    this.writer = writer;
    this.log = log;
    this.fetch = fetchImpl;
  }

  endpointFor(address, cred) {
    const https = cred.https ?? false;
    const port = cred.port ?? (https ? 5986 : 5985);
    return `${https ? 'https' : 'http'}://${address}:${port}/wsman`;
  }

  /** Run a WQL query, following Pull continuations. Returns array of objects. */
  async query(address, cred, wql) {
    const endpoint = this.endpointFor(address, cred);
    const auth = 'Basic ' + Buffer.from(`${cred.user}:${cred.password}`).toString('base64');
    const all = [];
    let context = null;

    for (let round = 0; round < 20; round++) {
      const res = await this.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml;charset=UTF-8',
          Authorization: auth,
        },
        body: soapEnvelope({ endpoint, wql, enumerationContext: context }),
      });
      if (!res.ok) throw new Error(`WinRM ${res.status} from ${address}`);
      const { items, context: next, done } = parseItems(await res.text());
      all.push(...items);
      if (done || !next) break;
      context = next;
    }
    return all;
  }

  /** Full poll: CPU, memory, disks, stopped auto-services, IIS, AD. */
  async poll(device, cred, cfg = {}) {
    const push = (metric, value, instance = '', tags) =>
      this.writer.push({ deviceId: device.id, metric, instance, value, tags });

    const cpu = await this.query(device.address, cred, WQL.cpu).catch(() => []);
    if (cpu[0]) push('cpu.util.pct', Number(cpu[0].PercentProcessorTime));

    const os = await this.query(device.address, cred, WQL.memory).catch(() => []);
    if (os[0]) {
      const total = Number(os[0].TotalVisibleMemorySize);
      const free = Number(os[0].FreePhysicalMemory);
      if (total > 0) push('mem.used.pct', ((total - free) / total) * 100);
    }

    const disks = await this.query(device.address, cred, WQL.disks).catch(() => []);
    for (const d of disks) {
      const size = Number(d.Size);
      if (size > 0) {
        push('disk.used.pct', ((size - Number(d.FreeSpace)) / size) * 100, d.DeviceID);
      }
    }

    const services = await this.query(device.address, cred, WQL.services).catch(() => []);
    const stopped = services.filter((s) => s.State !== 'Running');
    push('win.services.auto.stopped', stopped.length, '', {
      stopped: stopped.slice(0, 20).map((s) => s.Name),
    });

    if (cfg.iis) {
      const pools = await this.query(device.address, cred, WQL.iisAppPools).catch(() => []);
      for (const p of pools) {
        if (p.Name && p.Name !== '_Total') {
          push('iis.pool.cpu.pct', Number(p.PercentProcessorTime), p.Name);
        }
      }
      const sites = await this.query(device.address, cred, WQL.iisRequests).catch(() => []);
      for (const s of sites) {
        if (s.Name && s.Name !== '_Total') {
          push('iis.site.connections', Number(s.CurrentConnections), s.Name);
          push('iis.site.req.ps', Number(s.TotalMethodRequestsPerSec), s.Name);
        }
      }
    }

    if (cfg.activeDirectory) {
      const ad = await this.query(device.address, cred, WQL.adDra).catch(() => []);
      if (ad[0]) {
        push('ad.repl.pending', Number(ad[0].DRAPendingReplicationSynchronizations));
        push('ad.searches.ps', Number(ad[0].DSDirectorySearchesPerSec));
      }
    }
  }
}
