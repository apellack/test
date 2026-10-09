'use strict';

const express = require('express');
const lms = require('../lms');
const { toCsv } = require('../csv');
const { requireUser, requireRole } = require('../auth');

function apiRouter({ db, slack }) {
  const r = express.Router();
  r.use(requireUser);

  const id = (req, key = 'id') => Number(req.params[key]);
  const adminOnly = requireRole('admin');
  const staff = requireRole('admin', 'manager');

  // Can the current user see/act on this user's learning?
  function canSee(req, userId) {
    const scope = lms.visibleUserIds(db, req.user);
    return scope === null || scope.includes(userId);
  }
  function assertCanSee(req, userId) {
    if (!canSee(req, userId)) throw Object.assign(new Error('Forbidden'), { status: 403 });
  }

  // ------------------------------------------------------------ me

  r.get('/me', (req, res) => res.json({ user: req.user, slack: slack.status() }));
  r.get('/me/learning', (req, res) => res.json(lms.getUserLearning(db, req.user.id)));

  r.post('/progress', async (req, res) => {
    const { itemId, status } = req.body;
    const userId = req.body.userId ? Number(req.body.userId) : req.user.id;
    // Admins can record progress for others (e.g. live session attendance).
    if (userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const completed = lms.setProgress(db, userId, Number(itemId), status);
    await slack.announceCompletions(db, lms.getUser(db, userId), completed);
    res.json({ completedAssignments: completed });
  });

  // ------------------------------------------------------------ users

  r.get('/users', staff, (req, res) => {
    const { q, role, team, region, segment } = req.query;
    const active = req.query.active === undefined ? undefined : req.query.active === 'true';
    const scope = lms.visibleUserIds(db, req.user);
    let users = lms.listUsers(db, { q, role, team, region, segment, active });
    if (scope) users = users.filter((u) => scope.includes(u.id));
    res.json(users);
  });

  // Distinct values for filter dropdowns.
  r.get('/users/facets', staff, (_req, res) => {
    const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} AS v FROM users WHERE ${col} IS NOT NULL AND active = 1 ORDER BY 1`).all().map((x) => x.v);
    res.json({ team: distinct('team'), region: distinct('region'), segment: distinct('segment'), role: lms.ROLES });
  });

  r.post('/users', adminOnly, (req, res) => res.status(201).json(lms.createUser(db, req.body)));
  r.patch('/users/:id', adminOnly, (req, res) => res.json(lms.updateUser(db, id(req), req.body)));

  r.post('/users/import', adminOnly, express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!csv) return res.status(400).json({ error: 'Send CSV as text/csv or JSON { csv }' });
    res.json(lms.importUsers(db, csv));
  });

  r.get('/users/:id/learning', (req, res) => {
    assertCanSee(req, id(req));
    if (!lms.getUser(db, id(req))) return res.status(404).json({ error: 'User not found' });
    res.json({ user: lms.getUser(db, id(req)), assignments: lms.getUserLearning(db, id(req)) });
  });

  // ------------------------------------------------------------ content

  r.get('/content', (_req, res) => res.json(lms.listContent(db)));
  r.post('/content', adminOnly, (req, res) => res.status(201).json(lms.createContent(db, req.body)));
  r.patch('/content/:id', adminOnly, (req, res) => res.json(lms.updateContent(db, id(req), req.body)));
  r.delete('/content/:id', adminOnly, (req, res) => { lms.deleteContent(db, id(req)); res.status(204).end(); });

  // ------------------------------------------------------------ learning plans

  r.get('/plans', (req, res) => res.json(lms.listPlans(db, { includeArchived: req.query.archived === 'true' })));
  r.get('/plans/:id', (req, res) => {
    const plan = lms.getPlan(db, id(req));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  });
  r.post('/plans', adminOnly, (req, res) => res.status(201).json(lms.createPlan(db, req.body, req.user.id)));
  r.patch('/plans/:id', adminOnly, (req, res) => res.json(lms.updatePlan(db, id(req), req.body)));

  // ------------------------------------------------------------ assignments

  /**
   * Body: { planId | itemId, userIds?: number[], filter?: { team, region, segment, role }, allUsers?: boolean,
   *         dueAt?: 'YYYY-MM-DD', notify?: boolean }
   * Managers can only assign within their reporting tree.
   */
  r.post('/assignments', staff, async (req, res) => {
    const { planId, itemId, userIds = [], filter, allUsers, dueAt, notify = true } = req.body;
    const scope = lms.visibleUserIds(db, req.user);
    let targets = [...new Set(userIds.map(Number))];
    const hasFilter = filter && ['team', 'region', 'segment', 'role'].some((k) => filter[k]);
    if (hasFilter || allUsers) {
      const { team, region, segment, role } = hasFilter ? filter : {};
      const matched = lms.listUsers(db, { team, region, segment, role, active: true }).map((u) => u.id);
      targets = [...new Set([...targets, ...matched.filter((uid) => !scope || scope.includes(uid))])];
    }
    if (scope && targets.some((uid) => !scope.includes(uid))) return res.status(403).json({ error: 'You can only assign to people on your team' });

    const result = lms.assign(db, {
      planId: planId ? Number(planId) : undefined,
      itemId: itemId ? Number(itemId) : undefined,
      userIds: targets,
      dueAt: dueAt || undefined,
      assignedBy: req.user.id,
    });
    const slackResult = notify ? await slack.notifyAssigned(db, result) : null;
    res.status(201).json({
      created: result.created.length,
      skipped: result.skipped,
      assignments: result.created.map((c) => c.assignment),
      slack: slackResult,
    });
  });

  r.patch('/assignments/:id', staff, (req, res) => {
    const a = lms.getAssignment(db, id(req));
    if (!a) return res.status(404).json({ error: 'Assignment not found' });
    assertCanSee(req, a.user_id);
    res.json(lms.updateAssignmentDue(db, a.id, req.body.dueAt));
  });

  r.delete('/assignments/:id', staff, (req, res) => {
    const a = lms.getAssignment(db, id(req));
    if (!a) return res.status(404).json({ error: 'Assignment not found' });
    assertCanSee(req, a.user_id);
    lms.deleteAssignment(db, a.id);
    res.status(204).end();
  });

  // ------------------------------------------------------------ reports

  r.get('/reports/overview', staff, (req, res) => res.json(lms.overviewReport(db, lms.visibleUserIds(db, req.user))));

  r.get('/reports/plans/:id', staff, (req, res) => {
    const report = lms.planReport(db, id(req), lms.visibleUserIds(db, req.user));
    if (req.query.format !== 'csv') return res.json(report);
    const rows = report.learners.map((l) => ({
      name: l.name, email: l.email, team: l.team, region: l.region, segment: l.segment,
      assigned_at: l.assigned_at, due_at: l.due_at, completed_at: l.completed_at,
      overdue: l.overdue ? 'yes' : 'no', percent_complete: l.progress.percent,
      ...Object.fromEntries(report.plan.items.map((it) => [it.title, l.items[it.id]])),
    }));
    res.type('text/csv').attachment(`plan-${report.plan.id}-progress.csv`).send(toCsv(rows));
  });

  // ------------------------------------------------------------ slack admin

  r.get('/slack/status', adminOnly, (_req, res) => res.json(slack.status()));
  r.post('/slack/reminders', adminOnly, async (req, res) => res.json(await slack.sendReminders(db, req.body || {})));
  r.post('/slack/link-users', adminOnly, async (_req, res) => res.json(await slack.linkUsersByEmail(db)));

  return r;
}

module.exports = { apiRouter };
