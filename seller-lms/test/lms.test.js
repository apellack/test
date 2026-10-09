'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lms = require('../src/lms');
const { fixture } = require('./helpers');

test('importUsers creates users and resolves managers regardless of row order', () => {
  const { db, u } = fixture();
  assert.equal(u('ae1@example.com').manager_id, u('mid@example.com').id);
  assert.equal(u('mid@example.com').manager_id, u('boss@example.com').id);
  assert.equal(u('ae1@example.com').team, 'Enterprise West');

  // Re-import updates in place; blank cells leave existing values alone; bad rows are reported.
  const report = lms.importUsers(db, [
    'email,name,team,manager_email',
    'AE1@example.com,Ae One Renamed,,',
    'not-an-email,Broken,,',
    'new@example.com,New Person,Partners,ghost@example.com',
  ].join('\n'));
  assert.equal(report.updated, 1);
  assert.equal(report.created, 1);
  assert.deepEqual(report.errors.map((e) => e.row), [3, 4]);
  assert.equal(u('ae1@example.com').name, 'Ae One Renamed');
  assert.equal(u('ae1@example.com').team, 'Enterprise West');
});

test('importUsers rejects a CSV without an email column', () => {
  const { db } = fixture();
  const report = lms.importUsers(db, 'name\nNobody\n');
  assert.equal(report.created, 0);
  assert.match(report.errors[0].error, /email/);
});

test('assign by filter applies plan default due date and skips duplicates', () => {
  const { db, plan, u, admin } = fixture();
  const r1 = lms.assign(db, { planId: plan.id, filter: { region: 'AMER', role: 'learner' }, assignedBy: admin.id });
  assert.deepEqual(r1.created.map((c) => c.user.email).sort(), ['ae1@example.com', 'ae2@example.com']);
  assert.equal(r1.created[0].assignment.due_at, lms.addDays(lms.today(), 30));

  const r2 = lms.assign(db, { planId: plan.id, userIds: [u('ae1@example.com').id, u('emea@example.com').id] });
  assert.equal(r2.created.length, 1);
  assert.equal(r2.skipped, 1);
});

test('assign validates input', () => {
  const { db, plan, items, u } = fixture();
  const id = u('ae1@example.com').id;
  assert.throws(() => lms.assign(db, { planId: plan.id, itemId: items.a.id, userIds: [id] }), /exactly one/);
  assert.throws(() => lms.assign(db, { planId: plan.id, userIds: [] }), /No users/);
  assert.throws(() => lms.assign(db, { planId: plan.id, userIds: [id], dueAt: '12/01/2026' }), /YYYY-MM-DD/);
  lms.updatePlan(db, plan.id, { archived: true });
  assert.throws(() => lms.assign(db, { planId: plan.id, userIds: [id] }), /archived/);
});

test('plan completes when all required items are done; optional items do not block', () => {
  const { db, plan, items, u } = fixture();
  const user = u('ae1@example.com');
  lms.assign(db, { planId: plan.id, userIds: [user.id] });
  lms.assign(db, { itemId: items.b.id, userIds: [user.id] });

  assert.deepEqual(lms.setProgress(db, user.id, items.a.id, 'completed'), []);
  let [planA] = lms.getUserLearning(db, user.id).filter((a) => a.kind === 'plan');
  assert.deepEqual(planA.progress, { total: 2, completed: 1, percent: 50 });

  // Completing "Deep dive" finishes both the plan and the standalone item assignment.
  const completed = lms.setProgress(db, user.id, items.b.id, 'completed');
  assert.equal(completed.length, 2);
  [planA] = lms.getUserLearning(db, user.id).filter((a) => a.kind === 'plan');
  assert.ok(planA.completed_at);
  assert.equal(planA.items.find((i) => i.id === items.c.id).status, 'not_started');

  // Un-completing reopens it.
  lms.setProgress(db, user.id, items.b.id, 'in_progress');
  [planA] = lms.getUserLearning(db, user.id).filter((a) => a.kind === 'plan');
  assert.equal(planA.completed_at, null);
});

test('editing a plan recomputes completion for existing assignees', () => {
  const { db, plan, items, u } = fixture();
  const user = u('ae1@example.com');
  lms.assign(db, { planId: plan.id, userIds: [user.id] });
  lms.setProgress(db, user.id, items.a.id, 'completed');
  lms.updatePlan(db, plan.id, { items: [{ item_id: items.a.id }, { item_id: items.c.id, required: false }] });
  assert.ok(lms.getUserLearning(db, user.id)[0].completed_at);
});

test('overdue and reports', () => {
  const { db, plan, u } = fixture();
  lms.assign(db, { planId: plan.id, userIds: [u('ae1@example.com').id], dueAt: lms.addDays(lms.today(), -1) });
  lms.assign(db, { planId: plan.id, userIds: [u('emea@example.com').id] });
  const r = lms.overviewReport(db);
  assert.equal(r.totals.assignments, 2);
  assert.equal(r.totals.overdue, 1);
  assert.equal(r.overdue[0].user_email, 'ae1@example.com');

  // A manager only sees their reporting tree.
  const scoped = lms.overviewReport(db, lms.visibleUserIds(db, u('boss@example.com')));
  assert.equal(scoped.totals.assignments, 1);
  const pr = lms.planReport(db, plan.id, lms.visibleUserIds(db, u('mid@example.com')));
  assert.deepEqual(pr.learners.map((l) => l.email), ['ae1@example.com']);
});

test('visibleUserIds walks the whole reporting tree', () => {
  const { db, u, admin } = fixture();
  const ids = lms.visibleUserIds(db, u('boss@example.com'));
  const emails = ids.map((id) => lms.getUser(db, id).email).sort();
  assert.deepEqual(emails, ['ae1@example.com', 'ae2@example.com', 'boss@example.com', 'mid@example.com']);
  assert.equal(lms.visibleUserIds(db, admin), null);
  assert.deepEqual(lms.visibleUserIds(db, u('ae1@example.com')), [u('ae1@example.com').id]);
});

test('a user cannot be their own manager', () => {
  const { db, u } = fixture();
  assert.throws(() => lms.updateUser(db, u('ae1@example.com').id, { manager_email: 'ae1@example.com' }), /own manager/);
});
