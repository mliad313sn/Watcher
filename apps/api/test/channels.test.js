import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ch from '../src/modules/alerts/channels.js';

const alert = {
  id: 'a1b2', tenant_id: 't1', device_name: 'core-sw-01', check_name: 'BGP Session',
  severity: 'critical', message: 'CRITICAL - BGP peer 10.0.4.254 down',
};
const ctx = {
  title: '[CRITICAL] core-sw-01 / BGP Session', alert, kind: 'alert',
  ackUrl: 'https://watcher.example/ack.html?t=tok',
  runbook: { name: 'BGP flap', steps: '1. check peer', links: [{ label: 'Wiki', url: 'https://wiki/bgp' }] },
};

test('Teams Adaptive Card (Power Automate) carries card, facts and actions', () => {
  const b = ch.teamsAdaptiveCard({ url: 'https://prod.logic.azure.com/wf' }, ctx);
  const card = b.body.attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.content.type, 'AdaptiveCard');
  const facts = card.content.body.find((x) => x.type === 'FactSet').facts;
  assert.ok(facts.some((f) => f.title === 'Device' && f.value === 'core-sw-01'));
  assert.deepEqual(card.content.actions.map((a) => a.title), ['Acknowledge', 'Open runbook']);
});

test('Teams MessageCard (legacy webhook) keeps OpenUri actions', () => {
  const b = ch.teamsMessageCard({ url: 'https://outlook.office.com/webhook/x' }, ctx);
  assert.equal(b.body['@type'], 'MessageCard');
  assert.equal(b.body.themeColor, 'D93F4C');
  assert.equal(b.body.potentialAction.length, 2);
});

test('Opsgenie: create carries alias for dedup; recovery closes by alias', () => {
  const create = ch.opsgenieAlert({ apiKey: 'k' }, ctx);
  assert.match(create.url, /\/v2\/alerts$/);
  assert.equal(create.headers.Authorization, 'GenieKey k');
  assert.equal(create.body.alias, 'watcher-a1b2');
  assert.equal(create.body.priority, 'P1');

  const close = ch.opsgenieAlert({ apiKey: 'k' }, { ...ctx, kind: 'recovery' });
  assert.match(close.url, /watcher-a1b2\/close\?identifierType=alias$/);
});

test('Jira issue: project/type/labels + basic auth from email:apiToken', () => {
  const b = ch.jiraIssue({ url: 'https://acme.atlassian.net/', projectKey: 'OPS',
    email: 'bot@acme.com', apiToken: 'tok' }, ctx);
  assert.equal(b.url, 'https://acme.atlassian.net/rest/api/2/issue');
  assert.match(b.headers.Authorization, /^Basic /);
  assert.equal(b.body.fields.project.key, 'OPS');
  assert.equal(b.body.fields.issuetype.name, 'Incident');
  assert.ok(b.body.fields.description.includes('Acknowledge: https://watcher.example'));
});

test('ServiceNow incident maps severity to urgency/impact with correlation_id', () => {
  const b = ch.servicenowIncident({ url: 'https://dev1.service-now.com', user: 'u', password: 'p' }, ctx);
  assert.equal(b.url, 'https://dev1.service-now.com/api/now/table/incident');
  assert.equal(b.body.urgency, '1');
  assert.equal(b.body.correlation_id, 'watcher-a1b2');
});

test('Discord embed encodes severity colour and fields', () => {
  const b = ch.discordMessage({ url: 'https://discord.com/api/webhooks/x' }, ctx);
  const e = b.body.embeds[0];
  assert.equal(e.color, 0xD93F4C);
  assert.ok(e.fields.some((f) => f.name === 'Acknowledge'));
});

test('Telegram escapes HTML in device output (injection-safe)', () => {
  const hostile = { ...ctx, alert: { ...alert, message: '<script>alert(1)</script> & more' } };
  const b = ch.telegramMessage({ botToken: 'bt', chatId: '42' }, hostile);
  assert.match(b.url, /api\.telegram\.org\/botbt\/sendMessage/);
  assert.ok(b.body.text.includes('&lt;script&gt;'));
  assert.ok(!b.body.text.includes('<script>'));
});

test('Google Chat cardsV2 has header, severity and buttons', () => {
  const b = ch.googleChatMessage({ url: 'https://chat.googleapis.com/v1/spaces/x' }, ctx);
  const card = b.body.cardsV2[0].card;
  assert.equal(card.header.subtitle, 'core-sw-01 / BGP Session');
  const buttons = card.sections[0].widgets.find((w) => w.buttonList)?.buttonList.buttons ?? [];
  assert.equal(buttons.length, 2);
});

test('SMTP message: html escapes content, text mirrors the summary', () => {
  const hostile = { ...ctx, alert: { ...alert, message: '<img onerror=x>' } };
  const m = ch.smtpMessage({ to: 'noc@acme.com' }, hostile);
  assert.equal(m.to, 'noc@acme.com');
  assert.ok(m.html.includes('&lt;img onerror=x&gt;'));
  assert.ok(m.text.includes('Acknowledge: https://watcher.example'));
});
