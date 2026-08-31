/**
 * Ecosystem channel payload builders — pure functions from
 * (action config, alert, context) to { url, headers, body } (or SMTP message),
 * so every integration's wire format is unit-testable without the network.
 *
 * The notifier stays a thin dispatcher; adding an ecosystem means adding a
 * builder here and a case in its switch. Everything a platform needs to
 * render a useful incident — severity, device, message, one-tap acknowledge
 * link, runbook — is included wherever the format allows.
 *
 * Context shape: { title, alert, ackUrl, runbook, kind } where kind is
 * 'alert' | 'escalation' | 'recovery'.
 */

const SEV_COLOR = { critical: 'D93F4C', warning: 'F0A030', info: '4A8EFF' };
const SEV_EMOJI = { critical: '🔴', warning: '🟠', info: '🔵' };

function factsOf({ alert, runbook }) {
  return [
    { label: 'Device', value: alert.device_name },
    ...(alert.check_name ? [{ label: 'Check', value: alert.check_name }] : []),
    { label: 'Severity', value: alert.severity },
    ...(runbook ? [{ label: 'Runbook', value: runbook.name }] : []),
  ];
}

function textSummary(ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  const rbLink = runbook?.links?.[0]?.url;
  return `${title}\n${alert.message}`
    + (ackUrl ? `\nAcknowledge: ${ackUrl}` : '')
    + (runbook ? `\nRunbook: ${runbook.name}${rbLink ? ' — ' + rbLink : ''}` : '');
}

/**
 * Microsoft Teams via Power Automate Workflows (the modern path — the old
 * O365 connectors are retired). Workflows accept an Adaptive Card wrapped in
 * an attachments envelope.
 */
export function teamsAdaptiveCard(action, ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  const rbLink = runbook?.links?.[0]?.url;
  return {
    url: action.url,
    body: {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard', version: '1.4',
          msteams: { width: 'Full' },
          body: [
            { type: 'TextBlock', size: 'Large', weight: 'Bolder', wrap: true,
              text: `${SEV_EMOJI[alert.severity] ?? ''} ${title}` },
            { type: 'TextBlock', wrap: true, text: alert.message },
            { type: 'FactSet', facts: factsOf(ctx).map((f) => ({ title: f.label, value: String(f.value) })) },
          ],
          actions: [
            ...(ackUrl ? [{ type: 'Action.OpenUrl', title: 'Acknowledge', url: ackUrl }] : []),
            ...(rbLink ? [{ type: 'Action.OpenUrl', title: 'Open runbook', url: rbLink }] : []),
          ],
        },
      }],
    },
  };
}

/** Legacy Teams incoming-webhook MessageCard (still common on-prem). */
export function teamsMessageCard(action, ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  const rbLink = runbook?.links?.[0]?.url;
  return {
    url: action.url,
    body: {
      '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
      summary: title,
      themeColor: SEV_COLOR[alert.severity] ?? SEV_COLOR.info,
      title,
      text: alert.message,
      sections: [{ facts: factsOf(ctx).map((f) => ({ name: f.label, value: String(f.value) })) }],
      potentialAction: [
        ...(ackUrl ? [{ '@type': 'OpenUri', name: 'Acknowledge', targets: [{ os: 'default', uri: ackUrl }] }] : []),
        ...(rbLink ? [{ '@type': 'OpenUri', name: 'Open runbook', targets: [{ os: 'default', uri: rbLink }] }] : []),
      ],
    },
  };
}

/** Opsgenie Alert API v2. */
export function opsgenieAlert(action, ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  if (ctx.kind === 'recovery') {
    return {
      url: `${action.url ?? 'https://api.opsgenie.com'}/v2/alerts/watcher-${alert.id}/close?identifierType=alias`,
      headers: { Authorization: `GenieKey ${action.apiKey}` },
      body: { note: 'Resolved in Watcher' },
    };
  }
  return {
    url: `${action.url ?? 'https://api.opsgenie.com'}/v2/alerts`,
    headers: { Authorization: `GenieKey ${action.apiKey}` },
    body: {
      message: title.slice(0, 130),
      alias: `watcher-${alert.id}`, // dedup key — updates, not duplicates
      description: textSummary(ctx),
      priority: alert.severity === 'critical' ? 'P1' : alert.severity === 'warning' ? 'P3' : 'P5',
      source: 'Watcher',
      tags: ['watcher', alert.severity, alert.device_name].filter(Boolean),
      details: {
        device: alert.device_name, check: alert.check_name ?? '',
        ackUrl: ackUrl ?? '', runbook: runbook?.name ?? '',
      },
    },
  };
}

/** Jira Cloud/DC issue creation (REST v2, basic or PAT auth prepared by caller). */
export function jiraIssue(action, ctx) {
  const { title, alert } = ctx;
  const auth = action.email && action.apiToken
    ? 'Basic ' + Buffer.from(`${action.email}:${action.apiToken}`).toString('base64')
    : action.bearer ? `Bearer ${action.bearer}` : undefined;
  return {
    url: `${String(action.url).replace(/\/$/, '')}/rest/api/2/issue`,
    headers: auth ? { Authorization: auth } : {},
    body: {
      fields: {
        project: { key: action.projectKey },
        issuetype: { name: action.issueType ?? 'Incident' },
        summary: title.slice(0, 250),
        description: textSummary(ctx),
        labels: ['watcher', alert.severity],
      },
    },
  };
}

/** ServiceNow incident via the Table API (basic auth prepared by caller). */
export function servicenowIncident(action, ctx) {
  const { title, alert } = ctx;
  const auth = action.user && action.password
    ? 'Basic ' + Buffer.from(`${action.user}:${action.password}`).toString('base64')
    : undefined;
  return {
    url: `${String(action.url).replace(/\/$/, '')}/api/now/table/incident`,
    headers: auth ? { Authorization: auth } : {},
    body: {
      short_description: title.slice(0, 160),
      description: textSummary(ctx),
      urgency: alert.severity === 'critical' ? '1' : alert.severity === 'warning' ? '2' : '3',
      impact: alert.severity === 'critical' ? '1' : '2',
      category: 'network',
      correlation_id: `watcher-${alert.id}`, // dedup handle for SN workflows
      comments: ctx.ackUrl ? `Acknowledge in Watcher: ${ctx.ackUrl}` : undefined,
    },
  };
}

/** Discord incoming webhook (embed). */
export function discordMessage(action, ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  return {
    url: action.url,
    body: {
      username: 'Watcher',
      embeds: [{
        title: `${SEV_EMOJI[alert.severity] ?? ''} ${title}`.slice(0, 256),
        description: alert.message?.slice(0, 2048),
        color: parseInt(SEV_COLOR[alert.severity] ?? SEV_COLOR.info, 16),
        fields: [
          ...factsOf(ctx).map((f) => ({ name: f.label, value: String(f.value), inline: true })),
          ...(ackUrl ? [{ name: 'Acknowledge', value: ackUrl, inline: false }] : []),
          ...(runbook?.links?.[0]?.url ? [{ name: 'Runbook', value: runbook.links[0].url, inline: false }] : []),
        ],
      }],
    },
  };
}

/** Telegram bot sendMessage. */
export function telegramMessage(action, ctx) {
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const { title, alert, ackUrl, runbook } = ctx;
  const rbLink = runbook?.links?.[0]?.url;
  return {
    url: `https://api.telegram.org/bot${action.botToken}/sendMessage`,
    body: {
      chat_id: action.chatId,
      parse_mode: 'HTML',
      text: `<b>${esc(SEV_EMOJI[alert.severity] ?? '')} ${esc(title)}</b>\n${esc(alert.message)}`
        + (ackUrl ? `\n\n<a href="${ackUrl}">Acknowledge</a>` : '')
        + (rbLink ? ` · <a href="${rbLink}">Runbook: ${esc(runbook.name)}</a>` : ''),
      disable_web_page_preview: true,
    },
  };
}

/** Google Chat incoming webhook (cardsV2). */
export function googleChatMessage(action, ctx) {
  const { title, alert, ackUrl, runbook } = ctx;
  const rbLink = runbook?.links?.[0]?.url;
  return {
    url: action.url,
    body: {
      cardsV2: [{
        cardId: `watcher-${alert.id}`,
        card: {
          header: { title, subtitle: `${alert.device_name}${alert.check_name ? ' / ' + alert.check_name : ''}` },
          sections: [{
            widgets: [
              { textParagraph: { text: alert.message } },
              { decoratedText: { topLabel: 'Severity', text: alert.severity } },
              ...(ackUrl || rbLink ? [{
                buttonList: { buttons: [
                  ...(ackUrl ? [{ text: 'Acknowledge', onClick: { openLink: { url: ackUrl } } }] : []),
                  ...(rbLink ? [{ text: 'Runbook', onClick: { openLink: { url: rbLink } } }] : []),
                ] },
              }] : []),
            ],
          }],
        },
      }],
    },
  };
}

/** Native SMTP message (handed to nodemailer, not #post). */
export function smtpMessage(action, ctx) {
  const { title, alert } = ctx;
  const sevColor = { critical: '#d93f4c', warning: '#b9791f', info: '#2f6fe0' }[alert.severity] ?? '#2f6fe0';
  const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return {
    to: action.to,
    subject: title,
    text: textSummary(ctx),
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px">
        <div style="border-left:4px solid ${sevColor};padding:10px 16px;background:#f6f8fb">
          <h2 style="margin:0 0 6px;font-size:17px">${esc(title)}</h2>
          <p style="margin:0;color:#444">${esc(alert.message)}</p>
        </div>
        <table style="font-size:13px;margin:12px 0;border-collapse:collapse">
          ${factsOf(ctx).map((f) => `<tr><td style="padding:2px 14px 2px 0;color:#777">${esc(f.label)}</td><td>${esc(f.value)}</td></tr>`).join('')}
        </table>
        ${ctx.ackUrl ? `<p><a href="${ctx.ackUrl}" style="background:#2f6fe0;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">Acknowledge</a></p>` : ''}
        ${ctx.runbook?.links?.[0]?.url ? `<p style="font-size:13px">Runbook: <a href="${ctx.runbook.links[0].url}">${esc(ctx.runbook.name)}</a></p>` : ''}
      </div>`,
  };
}
