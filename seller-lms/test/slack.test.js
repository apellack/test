'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lms = require('../src/lms');
const { createSlack } = require('../src/slack');
const { fixture } = require('./helpers');

const quiet = { error() {}, warn() {}, log() {} };

// Fake Slack Web API that records calls.
function fakeSlack({ unknownEmails = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const method = url.replace('https://slack.com/api/', '');
    let json = { ok: true };
    if (method === 'users.lookupByEmail') {
      json = unknownEmails.includes(body.email) ? { ok: false, error: 'users_not_found' } : { ok: true, user: { id: `U_${body.email.split('@')[0]}` } };
    }
    return { json: async () => json };
  };
  const slack = createSlack({ token: 'xoxb-test', signingSecret: 'shh', announceChannel: '#wins', appUrl: 'https://lms.test', fetchImpl, logger: quiet });
  return { slack, calls, posts: () => calls.filter((c) => c.url.endsWith('chat.postMessage')) };
}

test('assignment DMs look up Slack ids by email and cache them', async () => {
  const f = fixture();
  const { slack, calls, posts } = fakeSlack({ unknownEmails: ['ae2@example.com'] });
  const result = lms.assign(f.db, { planId: f.plan.id, userIds: [f.u('ae1@example.com').id, f.u('ae2@example.com').id] });
  const r = await slack.notifyAssigned(f.db, result);
  assert.deepEqual(r, { sent: 1, failed: 1 });
  assert.equal(posts()[0].body.channel, 'U_ae1');
  assert.match(posts()[0].body.text, /Onboarding/);
  assert.equal(f.u('ae1@example.com').slack_user_id, 'U_ae1');
  assert.equal(calls.filter((c) => c.url.endsWith('lookupByEmail')).length, 2);
});

test('disabled Slack is a no-op', async () => {
  const f = fixture();
  const slack = createSlack({ token: '', fetchImpl: () => { throw new Error('should not call'); } });
  const result = lms.assign(f.db, { planId: f.plan.id, userIds: [f.u('ae1@example.com').id] });
  assert.deepEqual(await slack.notifyAssigned(f.db, result), { sent: 0, failed: 0 });
  assert.equal((await slack.sendReminders(f.db)).enabled, false);
});

test('reminders: learners with overdue/due-soon work, throttled; managers get a digest', async () => {
  const f = fixture();
  const { slack, posts } = fakeSlack();
  lms.assign(f.db, { planId: f.plan.id, userIds: [f.u('ae1@example.com').id], dueAt: lms.addDays(lms.today(), -3) });
  lms.assign(f.db, { planId: f.plan.id, userIds: [f.u('ae2@example.com').id], dueAt: lms.addDays(lms.today(), 2) });
  lms.assign(f.db, { planId: f.plan.id, userIds: [f.u('emea@example.com').id], dueAt: lms.addDays(lms.today(), 20) });

  const r = await slack.sendReminders(f.db);
  assert.deepEqual(r, { enabled: true, learners: 2, managers: 1 });
  const channels = posts().map((p) => p.body.channel).sort();
  assert.deepEqual(channels, ['U_ae1', 'U_ae2', 'U_mid']);
  assert.match(JSON.stringify(posts().find((p) => p.body.channel === 'U_ae1').body.blocks), /overdue/);

  // Running again the same day doesn't re-nag learners.
  const again = await slack.sendReminders(f.db);
  assert.equal(again.learners, 0);
});

function signed(slack, body, secret = 'shh', ts = Math.floor(Date.now() / 1000)) {
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig };
}

test('signature verification', () => {
  const { slack } = fakeSlack();
  const body = 'command=%2Flearn&user_id=U1';
  assert.equal(slack.verifySignature(body, signed(slack, body)), true);
  assert.equal(slack.verifySignature(body, signed(slack, body, 'wrong')), false);
  assert.equal(slack.verifySignature(body, signed(slack, body, 'shh', 1000)), false); // stale
  assert.equal(slack.verifySignature(body + 'x', signed(slack, body)), false);
});

test('/learn lists open work and the button marks items complete, announcing finished plans', async () => {
  const f = fixture();
  const { slack, calls, posts } = fakeSlack();
  const user = f.u('ae1@example.com');
  lms.updateUser(f.db, user.id, { slack_user_id: 'U_ae1' });
  lms.assign(f.db, { planId: f.plan.id, userIds: [user.id] });

  const unknown = slack.handleCommand(f.db, { user_id: 'U_nobody', text: '' });
  assert.match(unknown.text, /couldn't match/);

  const res = slack.handleCommand(f.db, { user_id: 'U_ae1', text: '' });
  const section = res.blocks.find((b) => b.accessory);
  assert.match(section.text.text, /Onboarding/);
  assert.equal(section.accessory.value, String(f.items.a.id));

  const click = (itemId) => slack.handleInteraction(f.db, {
    user: { id: 'U_ae1' }, response_url: 'https://hooks.slack.test/resp',
    actions: [{ action_id: 'complete_item', value: String(itemId) }],
  });
  await click(f.items.a.id);
  assert.equal(posts().length, 0);
  await click(f.items.b.id);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.channel, '#wins');
  assert.match(posts()[0].body.text, /<@U_ae1> completed the \*Onboarding\*/);
  assert.ok(calls.some((c) => c.url === 'https://hooks.slack.test/resp'));
});
