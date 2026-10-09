'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  title          TEXT,
  role           TEXT NOT NULL DEFAULT 'learner' CHECK (role IN ('admin', 'manager', 'learner')),
  team           TEXT,
  region         TEXT,
  segment        TEXT,
  manager_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  slack_user_id  TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_items (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL DEFAULT 'course' CHECK (type IN ('course', 'video', 'document', 'quiz', 'live_session', 'link')),
  url              TEXT,
  duration_minutes INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_plans (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  due_days    INTEGER,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_items (
  plan_id  INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (plan_id, item_id)
);

-- An assignment gives one user either a whole learning plan or a single content item.
CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id      INTEGER REFERENCES learning_plans(id) ON DELETE CASCADE,
  item_id      INTEGER REFERENCES content_items(id) ON DELETE CASCADE,
  assigned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TEXT NOT NULL DEFAULT (datetime('now')),
  due_at       TEXT,
  completed_at TEXT,
  last_reminded_at TEXT,
  CHECK ((plan_id IS NULL) <> (item_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS assignments_user_plan ON assignments(user_id, plan_id) WHERE plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assignments_user_item ON assignments(user_id, item_id) WHERE item_id IS NOT NULL;

-- Progress is per user per content item, so finishing an item counts toward every plan containing it.
CREATE TABLE IF NOT EXISTS progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed')),
  started_at   TEXT,
  completed_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);
`;

function openDb(file = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'lms.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
