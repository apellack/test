'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createAuth } = require('../src/auth');
const { createSlack } = require('../src/slack');
const { fixture } = require('./helpers');

const quiet = { error() {}, warn() {}, log() {} };

async function startServer(f, { authMode = 'dev' } = {}) {
  const app = createApp({
    db: f.db,
    auth: createAuth({ mode: authMode, secret: 'test-secret' }),
    slack: createSlack({ token: '', logger: quiet }),
    logger: quiet,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A tiny client that keeps the session cookie per "browser".
  function client(headers = {}) {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...headers, ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/json' }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
  }
  async function loginAs(email) {
    const c = client();
    const r = await c('POST', '/auth/login', { email });
    assert.equal(r.status, 200, `login ${email}`);
    return c;
  }
  return { server, client, loginAs };
}

test('auth: API requires a session; unknown emails cannot log in', async (t) => {
  const s = await startServer(fixture());
  t.after(() => s.server.close());
  const anon = s.client();
  assert.equal((await anon('GET', '/api/me')).status, 401);
  assert.equal((await anon('POST', '/auth/login', { email: 'nobody@example.com' })).status, 401);
  const forged = s.client({ cookie: 'lms_session=1.9999999999.forged' });
  assert.equal((await forged('GET', '/api/me')).status, 401);
});

test('header auth mode trusts the SSO proxy header', async (t) => {
  const s = await startServer(fixture(), { authMode: 'header' });
  t.after(() => s.server.close());
  const r = await s.client({ 'x-forwarded-email': 'ae1@example.com' })('GET', '/api/me');
  assert.equal(r.body.user.email, 'ae1@example.com');
  // The dev email login doesn't exist in header mode.
  assert.equal((await s.client()('POST', '/auth/login', { email: 'admin@example.com' })).status, 404);
});

test('admin end-to-end: import, build plan, assign, learner progresses, report + CSV', async (t) => {
  const f = fixture();
  const s = await startServer(f);
  t.after(() => s.server.close());
  const admin = await s.loginAs('admin@example.com');

  const imp = await admin('POST', '/api/users/import', 'email,name,team\nnew.seller@example.com,New Seller,Partners\n');
  assert.deepEqual(imp.body, { created: 1, updated: 0, errors: [] });

  const plan = await admin('POST', '/api/plans', { title: 'Partner Basics', items: [{ item_id: f.items.a.id }] });
  assert.equal(plan.status, 201);

  const assigned = await admin('POST', '/api/assignments', { planId: plan.body.id, filter: { team: 'Partners' }, dueAt: '2099-01-01' });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.body.created, 1);

  const learner = await s.loginAs('new.seller@example.com');
  const mine = await learner('GET', '/api/me/learning');
  assert.equal(mine.body[0].title, 'Partner Basics');
  const prog = await learner('POST', '/api/progress', { itemId: f.items.a.id, status: 'completed' });
  assert.equal(prog.body.completedAssignments.length, 1);

  const report = await admin('GET', `/api/reports/plans/${plan.body.id}`);
  assert.equal(report.body.learners[0].progress.percent, 100);
  const csv = await admin('GET', `/api/reports/plans/${plan.body.id}?format=csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /new.seller@example.com/);

  const all = await admin('POST', '/api/assignments', { itemId: f.items.b.id, allUsers: true, notify: false });
  assert.equal(all.body.created, 7);
});

test('permissions: learners cannot manage; managers are limited to their org', async (t) => {
  const f = fixture();
  const s = await startServer(f);
  t.after(() => s.server.close());
  const id = (e) => f.u(e).id;

  const learner = await s.loginAs('ae1@example.com');
  assert.equal((await learner('GET', '/api/users')).status, 403);
  assert.equal((await learner('POST', '/api/plans', { title: 'x' })).status, 403);
  assert.equal((await learner('POST', '/api/progress', { itemId: f.items.a.id, status: 'completed', userId: id('ae2@example.com') })).status, 403);
  assert.equal((await learner('GET', `/api/users/${id('ae2@example.com')}/learning`)).status, 403);

  const mid = await s.loginAs('mid@example.com');
  const users = await mid('GET', '/api/users');
  assert.deepEqual(users.body.map((u) => u.email).sort(), ['ae1@example.com', 'mid@example.com']);
  assert.equal((await mid('POST', '/api/assignments', { planId: f.plan.id, userIds: [id('emea@example.com')] })).status, 403);
  assert.equal((await mid('POST', '/api/users/import', 'email,name\nx@example.com,X\n')).status, 403);

  // Filter-based assignment is silently limited to the manager's own org.
  const r = await mid('POST', '/api/assignments', { planId: f.plan.id, filter: { region: 'AMER' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, 2); // mid + ae1, not boss or ae2
});

test('validation errors return 400 with a message', async (t) => {
  const s = await startServer(fixture());
  t.after(() => s.server.close());
  const admin = await s.loginAs('admin@example.com');
  const r = await admin('POST', '/api/content', { title: 'Bad', url: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /URL/);
});
