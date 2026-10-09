'use strict';

const { transaction } = require('./db');
const { parseCsvObjects } = require('./csv');

const ROLES = ['admin', 'manager', 'learner'];
const CONTENT_TYPES = ['course', 'video', 'document', 'quiz', 'live_session', 'link'];
const PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'];
const USER_FIELDS = ['email', 'name', 'title', 'role', 'team', 'region', 'segment', 'slack_user_id', 'active'];

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.status = 404; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- users

function getUser(db, id) {
  return db.prepare(`
    SELECT u.*, m.name AS manager_name, m.email AS manager_email
    FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.id = ?`).get(id);
}
function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
function getUserBySlackId(db, slackUserId) {
  return db.prepare('SELECT * FROM users WHERE slack_user_id = ?').get(slackUserId);
}

function listUsers(db, filter = {}) {
  const where = [];
  const params = {};
  if (filter.q) { where.push('(u.name LIKE $q OR u.email LIKE $q)'); params.q = `%${filter.q}%`; }
  for (const k of ['role', 'team', 'region', 'segment']) {
    if (filter[k]) { where.push(`u.${k} = $${k}`); params[k] = filter[k]; }
  }
  if (filter.managerId) { where.push('u.manager_id = $managerId'); params.managerId = filter.managerId; }
  if (filter.active !== undefined) { where.push('u.active = $active'); params.active = filter.active ? 1 : 0; }
  const sql = `
    SELECT u.*, m.name AS manager_name, m.email AS manager_email
    FROM users u LEFT JOIN users m ON m.id = u.manager_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY u.name COLLATE NOCASE`;
  return db.prepare(sql).all(params);
}

function normalizeUserInput(input, { partial = false } = {}) {
  const out = {};
  for (const k of USER_FIELDS) {
    if (input[k] === undefined) continue;
    const v = typeof input[k] === 'string' ? input[k].trim() : input[k];
    out[k] = v === '' ? null : v;
  }
  if (!partial || 'email' in out) {
    if (!out.email || !EMAIL_RE.test(out.email)) throw new ValidationError(`Invalid email: ${input.email ?? ''}`);
    out.email = out.email.toLowerCase();
  }
  if (!partial || 'name' in out) {
    if (!out.name) throw new ValidationError('Name is required');
  }
  if (out.role != null) {
    out.role = String(out.role).toLowerCase();
    if (!ROLES.includes(out.role)) throw new ValidationError(`Invalid role: ${out.role}`);
  } else if ('role' in out) {
    delete out.role;
  }
  if ('active' in out) out.active = out.active === false || out.active === 0 || /^(false|0|no|inactive)$/i.test(String(out.active)) ? 0 : 1;
  return out;
}

function createUser(db, input) {
  const u = normalizeUserInput(input);
  if (getUserByEmail(db, u.email)) throw new ValidationError(`User ${u.email} already exists`);
  const cols = Object.keys(u);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map((c) => `$${c}`).join(',')})`)
    .run(u);
  if (input.manager_email !== undefined || input.manager_id !== undefined) {
    setManager(db, Number(lastInsertRowid), input);
  }
  return getUser(db, Number(lastInsertRowid));
}

function updateUser(db, id, input) {
  if (!getUser(db, id)) throw new NotFoundError('User not found');
  const u = normalizeUserInput(input, { partial: true });
  const cols = Object.keys(u);
  if (cols.length) {
    db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = $${c}`).join(', ')} WHERE id = $id`).run({ ...u, id });
  }
  if (input.manager_email !== undefined || input.manager_id !== undefined) setManager(db, id, input);
  return getUser(db, id);
}

function setManager(db, userId, { manager_id, manager_email }) {
  let managerId = null;
  if (manager_id) managerId = Number(manager_id);
  else if (manager_email) {
    const m = getUserByEmail(db, manager_email.trim());
    if (!m) throw new ValidationError(`Manager ${manager_email} not found`);
    managerId = m.id;
  }
  if (managerId === userId) throw new ValidationError('A user cannot be their own manager');
  db.prepare('UPDATE users SET manager_id = ? WHERE id = ?').run(managerId, userId);
}

/**
 * Import users from CSV. Upserts by email. Recognized columns:
 * email, name, title, role, team, region, segment, manager_email, slack_user_id, active
 * Managers are resolved in a second pass so a manager can appear anywhere in the file.
 */
function importUsers(db, csvText) {
  const rows = parseCsvObjects(csvText);
  const report = { created: 0, updated: 0, errors: [] };
  if (!rows.length) {
    report.errors.push({ row: 0, error: 'CSV is empty or has no data rows' });
    return report;
  }
  if (!('email' in rows[0])) {
    report.errors.push({ row: 1, error: 'CSV must have an "email" column' });
    return report;
  }

  transaction(db, () => {
    const managerLinks = [];
    rows.forEach((row, i) => {
      const rowNum = i + 2; // 1-based, plus header
      try {
        const existing = row.email && getUserByEmail(db, row.email.trim());
        const input = Object.fromEntries(USER_FIELDS.filter((k) => k in row).map((k) => [k, row[k]]));
        if (existing) {
          // Blank cells on update mean "leave as is", not "clear".
          for (const k of Object.keys(input)) if (input[k] === '') delete input[k];
          updateUser(db, existing.id, input);
          report.updated++;
        } else {
          createUser(db, input);
          report.created++;
        }
        if (row.manager_email) managerLinks.push({ rowNum, email: row.email.trim(), manager_email: row.manager_email });
      } catch (err) {
        report.errors.push({ row: rowNum, email: row.email, error: err.message });
      }
    });
    for (const link of managerLinks) {
      try {
        setManager(db, getUserByEmail(db, link.email).id, { manager_email: link.manager_email });
      } catch (err) {
        report.errors.push({ row: link.rowNum, email: link.email, error: err.message });
      }
    }
  });
  return report;
}

// ---------------------------------------------------------------- content

function listContent(db) {
  return db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM plan_items pi WHERE pi.item_id = c.id) AS plan_count
    FROM content_items c ORDER BY c.title COLLATE NOCASE`).all();
}
function getContent(db, id) {
  return db.prepare('SELECT * FROM content_items WHERE id = ?').get(id);
}
function normalizeContent(input, { partial = false } = {}) {
  const out = {};
  for (const k of ['title', 'description', 'type', 'url', 'duration_minutes']) {
    if (input[k] === undefined) continue;
    out[k] = input[k] === '' ? null : input[k];
  }
  if ((!partial || 'title' in out) && !out.title) throw new ValidationError('Title is required');
  if (out.type != null && !CONTENT_TYPES.includes(out.type)) throw new ValidationError(`Invalid type: ${out.type}`);
  if (out.duration_minutes != null) {
    out.duration_minutes = Number(out.duration_minutes);
    if (!Number.isInteger(out.duration_minutes) || out.duration_minutes < 0) throw new ValidationError('Duration must be a whole number of minutes');
  }
  if (out.url != null && !/^https?:\/\//i.test(out.url)) throw new ValidationError('URL must start with http:// or https://');
  return out;
}
function createContent(db, input) {
  const c = normalizeContent(input);
  const cols = Object.keys(c);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO content_items (${cols.join(',')}) VALUES (${cols.map((k) => `$${k}`).join(',')})`)
    .run(c);
  return getContent(db, Number(lastInsertRowid));
}
function updateContent(db, id, input) {
  if (!getContent(db, id)) throw new NotFoundError('Content not found');
  const c = normalizeContent(input, { partial: true });
  const cols = Object.keys(c);
  if (cols.length) db.prepare(`UPDATE content_items SET ${cols.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({ ...c, id });
  return getContent(db, id);
}
function deleteContent(db, id) {
  const { changes } = db.prepare('DELETE FROM content_items WHERE id = ?').run(id);
  if (!changes) throw new NotFoundError('Content not found');
  // Removing an item can complete plans for people who had done everything else.
  refreshAllPlanCompletions(db);
}

// ---------------------------------------------------------------- learning plans

function listPlans(db, { includeArchived = false } = {}) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM plan_items pi WHERE pi.plan_id = p.id) AS item_count,
      (SELECT COALESCE(SUM(c.duration_minutes), 0) FROM plan_items pi JOIN content_items c ON c.id = pi.item_id WHERE pi.plan_id = p.id) AS total_minutes,
      (SELECT COUNT(*) FROM assignments a WHERE a.plan_id = p.id) AS assigned_count,
      (SELECT COUNT(*) FROM assignments a WHERE a.plan_id = p.id AND a.completed_at IS NOT NULL) AS completed_count
    FROM learning_plans p
    ${includeArchived ? '' : 'WHERE p.archived = 0'}
    ORDER BY p.title COLLATE NOCASE`).all();
}

function getPlan(db, id) {
  const plan = db.prepare('SELECT * FROM learning_plans WHERE id = ?').get(id);
  if (!plan) return null;
  plan.items = db.prepare(`
    SELECT c.*, pi.position, pi.required FROM plan_items pi
    JOIN content_items c ON c.id = pi.item_id
    WHERE pi.plan_id = ? ORDER BY pi.position`).all(id);
  return plan;
}

function normalizePlan(input, { partial = false } = {}) {
  const out = {};
  for (const k of ['title', 'description', 'due_days', 'archived']) {
    if (input[k] === undefined) continue;
    out[k] = input[k] === '' ? null : input[k];
  }
  if ((!partial || 'title' in out) && !out.title) throw new ValidationError('Title is required');
  if (out.due_days != null) {
    out.due_days = Number(out.due_days);
    if (!Number.isInteger(out.due_days) || out.due_days < 0) throw new ValidationError('Due days must be a whole number');
  }
  if ('archived' in out) out.archived = out.archived ? 1 : 0;
  return out;
}

function createPlan(db, input, createdBy) {
  return transaction(db, () => {
    const p = normalizePlan(input);
    p.created_by = createdBy ?? null;
    const cols = Object.keys(p);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO learning_plans (${cols.join(',')}) VALUES (${cols.map((k) => `$${k}`).join(',')})`)
      .run(p);
    const id = Number(lastInsertRowid);
    if (Array.isArray(input.items)) writePlanItems(db, id, input.items);
    return getPlan(db, id);
  });
}

function updatePlan(db, id, input) {
  return transaction(db, () => {
    if (!getPlan(db, id)) throw new NotFoundError('Plan not found');
    const p = normalizePlan(input, { partial: true });
    const cols = Object.keys(p);
    if (cols.length) db.prepare(`UPDATE learning_plans SET ${cols.map((k) => `${k} = $${k}`).join(', ')} WHERE id = $id`).run({ ...p, id });
    if (Array.isArray(input.items)) {
      writePlanItems(db, id, input.items);
      refreshPlanCompletions(db, id);
    }
    return getPlan(db, id);
  });
}

// items: [{ item_id, required }] in display order
function writePlanItems(db, planId, items) {
  const seen = new Set();
  db.prepare('DELETE FROM plan_items WHERE plan_id = ?').run(planId);
  const insert = db.prepare('INSERT INTO plan_items (plan_id, item_id, position, required) VALUES (?, ?, ?, ?)');
  items.forEach((it, i) => {
    const itemId = Number(it.item_id ?? it.id);
    if (seen.has(itemId)) throw new ValidationError('A content item can only appear once per plan');
    if (!getContent(db, itemId)) throw new ValidationError(`Content item ${itemId} not found`);
    seen.add(itemId);
    insert.run(planId, itemId, i, it.required === false || it.required === 0 ? 0 : 1);
  });
}

// ---------------------------------------------------------------- assignments

function resolveTargets(db, { userIds, filter }) {
  const ids = new Set((userIds || []).map(Number));
  if (filter && Object.values(filter).some(Boolean)) {
    for (const u of listUsers(db, { ...filter, active: true })) ids.add(u.id);
  }
  return [...ids];
}

/**
 * Assign a plan or a single content item to a set of users (explicit ids and/or a filter
 * like { team, region, segment, role, managerId }). Existing assignments are left alone.
 * Returns { created: [{ assignment, user }], skipped: number }.
 */
function assign(db, { planId, itemId, userIds, filter, dueAt, assignedBy }) {
  if (!planId === !itemId) throw new ValidationError('Provide exactly one of planId or itemId');
  if (dueAt && !DATE_RE.test(dueAt)) throw new ValidationError('dueAt must be YYYY-MM-DD');
  const plan = planId ? getPlan(db, planId) : null;
  const item = itemId ? getContent(db, itemId) : null;
  if (planId && !plan) throw new NotFoundError('Plan not found');
  if (itemId && !item) throw new NotFoundError('Content not found');
  if (plan && plan.archived) throw new ValidationError('Cannot assign an archived plan');

  const targets = resolveTargets(db, { userIds, filter });
  if (!targets.length) throw new ValidationError('No users matched');

  const due = dueAt || (plan && plan.due_days != null ? addDays(today(), plan.due_days) : null);
  const insert = db.prepare(`
    INSERT INTO assignments (user_id, plan_id, item_id, assigned_by, due_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`);

  return transaction(db, () => {
    const created = [];
    for (const userId of targets) {
      const user = getUser(db, userId);
      if (!user) throw new ValidationError(`User ${userId} not found`);
      const { changes, lastInsertRowid } = insert.run(userId, planId ?? null, itemId ?? null, assignedBy ?? null, due);
      if (!changes) continue;
      const id = Number(lastInsertRowid);
      refreshAssignmentCompletion(db, id);
      created.push({ assignment: getAssignment(db, id), user });
    }
    return { created, skipped: targets.length - created.length, plan, item };
  });
}

function getAssignment(db, id) {
  return db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
}

function deleteAssignment(db, id) {
  const { changes } = db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  if (!changes) throw new NotFoundError('Assignment not found');
}

function updateAssignmentDue(db, id, dueAt) {
  if (dueAt && !DATE_RE.test(dueAt)) throw new ValidationError('dueAt must be YYYY-MM-DD');
  const { changes } = db.prepare('UPDATE assignments SET due_at = ? WHERE id = ?').run(dueAt || null, id);
  if (!changes) throw new NotFoundError('Assignment not found');
  return getAssignment(db, id);
}

// Item ids that count toward an assignment (required plan items, or the single item).
function requiredItemIds(db, assignment) {
  if (assignment.item_id) return [assignment.item_id];
  const rows = db.prepare('SELECT item_id, required FROM plan_items WHERE plan_id = ?').all(assignment.plan_id);
  const required = rows.filter((r) => r.required);
  return (required.length ? required : rows).map((r) => r.item_id);
}

function assignmentProgress(db, assignment) {
  const ids = requiredItemIds(db, assignment);
  if (!ids.length) return { total: 0, completed: 0, percent: 0 };
  const done = db.prepare(`
    SELECT COUNT(*) AS n FROM progress
    WHERE user_id = ? AND status = 'completed' AND item_id IN (${ids.map(() => '?').join(',')})`)
    .get(assignment.user_id, ...ids).n;
  return { total: ids.length, completed: done, percent: Math.round((done / ids.length) * 100) };
}

// Recompute completed_at. Returns true if the assignment just became complete.
function refreshAssignmentCompletion(db, id) {
  const a = getAssignment(db, id);
  const { total, completed } = assignmentProgress(db, a);
  const isDone = total > 0 && completed === total;
  if (isDone && !a.completed_at) {
    db.prepare("UPDATE assignments SET completed_at = datetime('now') WHERE id = ?").run(id);
    return true;
  }
  if (!isDone && a.completed_at) db.prepare('UPDATE assignments SET completed_at = NULL WHERE id = ?').run(id);
  return false;
}

function refreshPlanCompletions(db, planId) {
  for (const { id } of db.prepare('SELECT id FROM assignments WHERE plan_id = ?').all(planId)) refreshAssignmentCompletion(db, id);
}
function refreshAllPlanCompletions(db) {
  for (const { id } of db.prepare('SELECT id FROM assignments').all()) refreshAssignmentCompletion(db, id);
}

/**
 * Update a user's status on a content item. Returns the assignments that this change
 * completed, so callers can celebrate (e.g. announce in Slack).
 */
function setProgress(db, userId, itemId, status) {
  if (!PROGRESS_STATUSES.includes(status)) throw new ValidationError(`Invalid status: ${status}`);
  if (!getContent(db, itemId)) throw new NotFoundError('Content not found');
  return transaction(db, () => {
    db.prepare(`
      INSERT INTO progress (user_id, item_id, status, started_at, completed_at, updated_at)
      VALUES ($u, $i, $s,
        CASE WHEN $s = 'not_started' THEN NULL ELSE datetime('now') END,
        CASE WHEN $s = 'completed' THEN datetime('now') END,
        datetime('now'))
      ON CONFLICT (user_id, item_id) DO UPDATE SET
        status = $s,
        started_at = CASE WHEN $s = 'not_started' THEN NULL ELSE COALESCE(started_at, datetime('now')) END,
        completed_at = CASE WHEN $s = 'completed' THEN COALESCE(completed_at, datetime('now')) END,
        updated_at = datetime('now')`).run({ u: userId, i: itemId, s: status });

    const affected = db.prepare(`
      SELECT a.id FROM assignments a
      WHERE a.user_id = $u AND (a.item_id = $i OR a.plan_id IN (SELECT plan_id FROM plan_items WHERE item_id = $i))`)
      .all({ u: userId, i: itemId });
    return affected.filter(({ id }) => refreshAssignmentCompletion(db, id)).map(({ id }) => getAssignment(db, id));
  });
}

function isOverdue(a) {
  return !a.completed_at && a.due_at && a.due_at < today();
}

// A learner's full view: each assignment with its items and their progress.
function getUserLearning(db, userId) {
  const rows = db.prepare(`
    SELECT a.*, p.title AS plan_title, p.description AS plan_description,
           c.title AS item_title
    FROM assignments a
    LEFT JOIN learning_plans p ON p.id = a.plan_id
    LEFT JOIN content_items c ON c.id = a.item_id
    WHERE a.user_id = ?
    ORDER BY a.completed_at IS NOT NULL, a.due_at IS NULL, a.due_at, a.assigned_at`).all(userId);
  const progressStmt = db.prepare('SELECT status, completed_at FROM progress WHERE user_id = ? AND item_id = ?');
  return rows.map((a) => {
    const items = a.plan_id
      ? getPlan(db, a.plan_id).items
      : [{ ...getContent(db, a.item_id), position: 0, required: 1 }];
    return {
      ...a,
      title: a.plan_title || a.item_title,
      kind: a.plan_id ? 'plan' : 'item',
      overdue: isOverdue(a),
      progress: assignmentProgress(db, a),
      items: items.map((it) => ({ ...it, status: progressStmt.get(userId, it.id)?.status || 'not_started' })),
    };
  });
}

// ---------------------------------------------------------------- reporting

// scopeUserIds: null for everyone (admins), or the set of users a manager may see.
function scopeClause(scopeUserIds, column = 'a.user_id') {
  if (!scopeUserIds) return { sql: '', params: [] };
  if (!scopeUserIds.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${column} IN (${scopeUserIds.map(() => '?').join(',')})`, params: scopeUserIds };
}

function overviewReport(db, scopeUserIds = null) {
  const s = scopeClause(scopeUserIds);
  const t = today();
  const totals = db.prepare(`
    SELECT COUNT(*) AS assignments,
      SUM(completed_at IS NOT NULL) AS completed,
      SUM(completed_at IS NULL AND due_at IS NOT NULL AND due_at < ?) AS overdue,
      COUNT(DISTINCT user_id) AS learners
    FROM assignments a WHERE 1 ${s.sql}`).get(t, ...s.params);

  const plans = db.prepare(`
    SELECT p.id, p.title, COUNT(a.id) AS assigned,
      SUM(a.completed_at IS NOT NULL) AS completed,
      SUM(a.completed_at IS NULL AND a.due_at IS NOT NULL AND a.due_at < ?) AS overdue
    FROM learning_plans p JOIN assignments a ON a.plan_id = p.id
    WHERE 1 ${s.sql}
    GROUP BY p.id ORDER BY p.title COLLATE NOCASE`).all(t, ...s.params);

  const byTeam = db.prepare(`
    SELECT COALESCE(u.team, '(none)') AS team, COUNT(a.id) AS assigned,
      SUM(a.completed_at IS NOT NULL) AS completed,
      SUM(a.completed_at IS NULL AND a.due_at IS NOT NULL AND a.due_at < ?) AS overdue
    FROM assignments a JOIN users u ON u.id = a.user_id
    WHERE 1 ${s.sql}
    GROUP BY 1 ORDER BY 1`).all(t, ...s.params);

  const overdue = listOverdue(db, scopeUserIds);
  return { totals: { ...totals, completed: totals.completed || 0, overdue: totals.overdue || 0 }, plans, byTeam, overdue };
}

function listOverdue(db, scopeUserIds = null) {
  const s = scopeClause(scopeUserIds);
  return db.prepare(`
    SELECT a.*, u.name AS user_name, u.email AS user_email, u.slack_user_id, u.manager_id,
      COALESCE(p.title, c.title) AS title
    FROM assignments a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN learning_plans p ON p.id = a.plan_id
    LEFT JOIN content_items c ON c.id = a.item_id
    WHERE a.completed_at IS NULL AND a.due_at IS NOT NULL AND a.due_at < ? AND u.active = 1 ${s.sql}
    ORDER BY a.due_at`).all(today(), ...s.params);
}

// Per-learner progress on one plan.
function planReport(db, planId, scopeUserIds = null) {
  const plan = getPlan(db, planId);
  if (!plan) throw new NotFoundError('Plan not found');
  const s = scopeClause(scopeUserIds);
  const assignments = db.prepare(`
    SELECT a.*, u.name AS user_name, u.email AS user_email, u.team, u.region, u.segment
    FROM assignments a JOIN users u ON u.id = a.user_id
    WHERE a.plan_id = ? ${s.sql} ORDER BY u.name COLLATE NOCASE`).all(planId, ...s.params);
  const progressStmt = db.prepare('SELECT status FROM progress WHERE user_id = ? AND item_id = ?');
  const learners = assignments.map((a) => ({
    assignment_id: a.id,
    user_id: a.user_id,
    name: a.user_name,
    email: a.user_email,
    team: a.team,
    region: a.region,
    segment: a.segment,
    assigned_at: a.assigned_at,
    due_at: a.due_at,
    completed_at: a.completed_at,
    overdue: isOverdue(a),
    progress: assignmentProgress(db, a),
    items: Object.fromEntries(plan.items.map((it) => [it.id, progressStmt.get(a.user_id, it.id)?.status || 'not_started'])),
  }));
  return { plan, learners };
}

// Ids a viewer may see in reports: null = everyone; managers see themselves plus their whole reporting tree.
function visibleUserIds(db, viewer) {
  if (viewer.role === 'admin') return null;
  if (viewer.role !== 'manager') return [viewer.id];
  const rows = db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM users WHERE manager_id = ?
      UNION SELECT u.id FROM users u JOIN tree t ON u.manager_id = t.id
    ) SELECT id FROM tree`).all(viewer.id);
  return [viewer.id, ...rows.map((r) => r.id)];
}

module.exports = {
  ROLES, CONTENT_TYPES, PROGRESS_STATUSES, ValidationError, NotFoundError,
  today, addDays,
  getUser, getUserByEmail, getUserBySlackId, listUsers, createUser, updateUser, importUsers,
  listContent, getContent, createContent, updateContent, deleteContent,
  listPlans, getPlan, createPlan, updatePlan,
  assign, getAssignment, deleteAssignment, updateAssignmentDue, assignmentProgress,
  setProgress, getUserLearning, isOverdue,
  overviewReport, listOverdue, planReport, visibleUserIds,
};
