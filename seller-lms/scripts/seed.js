'use strict';

// Load demo data: users from samples/users.csv, a content library, plans, and some assignments/progress.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const lms = require('../src/lms');

const db = openDb();
if (lms.listPlans(db, { includeArchived: true }).length) {
  console.log('Database already has plans; skipping seed. Delete data/lms.db to reseed.');
  process.exit(0);
}

const admin = lms.getUserByEmail(db, 'admin@example.com')
  || lms.createUser(db, { email: 'admin@example.com', name: 'Enablement Admin', role: 'admin', team: 'Sales Enablement' });
console.log('Users import:', lms.importUsers(db, fs.readFileSync(path.join(__dirname, '..', 'samples', 'users.csv'), 'utf8')));

const c = (title, type, duration_minutes, url, description) => lms.createContent(db, { title, type, duration_minutes, url, description });
const items = {
  culture: c('Welcome to HashiCorp Sales', 'video', 20, null, 'Our mission, the field org, and how we win.'),
  portfolio: c('HashiCorp Portfolio Overview', 'course', 45, 'https://www.hashicorp.com/products', 'Terraform, Vault, Consul, Nomad, Packer, Boundary, Waypoint and HCP at a glance.'),
  tfIntro: c('What is Terraform?', 'document', 15, 'https://developer.hashicorp.com/terraform/intro', 'Infrastructure as code fundamentals.'),
  tfPitch: c('Selling HCP Terraform: Discovery to Close', 'course', 60, null, 'Personas, pain points, and the standardization story.'),
  vaultIntro: c('What is Vault?', 'document', 15, 'https://developer.hashicorp.com/vault/docs/what-is-vault', 'Secrets management and identity-based security.'),
  vaultPitch: c('Vault Value Pitch & Objection Handling', 'video', 40, null, 'Positioning Vault against point solutions and cloud-native secrets managers.'),
  vaultQuiz: c('Vault Sales Certification Quiz', 'quiz', 30, null, '20 questions; 80% to pass.'),
  meddpicc: c('MEDDPICC Fundamentals', 'course', 90, null, 'Our qualification methodology.'),
  discovery: c('Running a Great Discovery Call', 'live_session', 60, null, 'Live role-play with enablement.'),
  sfdc: c('Salesforce Hygiene for HashiCorp Sellers', 'document', 20, null, 'Opportunity stages, required fields and forecasting.'),
};

const plan = (title, description, due_days, list) =>
  lms.createPlan(db, { title, description, due_days, items: list.map(([item, required = true]) => ({ item_id: item.id, required })) }, admin.id);

const onboarding = plan('New Seller Onboarding', 'Everything a new seller needs in their first 30 days.', 30,
  [[items.culture], [items.portfolio], [items.tfIntro], [items.vaultIntro], [items.meddpicc], [items.sfdc], [items.discovery, false]]);
const vault = plan('Vault Sales Certification', 'Get certified to lead Vault opportunities.', 21,
  [[items.vaultIntro], [items.vaultPitch], [items.vaultQuiz]]);
plan('HCP Terraform Deep Dive', 'Advanced Terraform positioning for Enterprise sellers.', 45,
  [[items.tfIntro], [items.tfPitch], [items.discovery]]);

const ids = (emails) => emails.map((e) => lms.getUserByEmail(db, e).id);
lms.assign(db, { planId: onboarding.id, filter: { role: 'learner' }, assignedBy: admin.id });
lms.assign(db, { planId: vault.id, userIds: ids(['jordan.lee@example.com', 'alex.kim@example.com', 'morgan.chen@example.com']), dueAt: lms.addDays(lms.today(), -2), assignedBy: admin.id });
lms.assign(db, { itemId: items.meddpicc.id, userIds: ids(['sam.rivera@example.com', 'priya.shah@example.com']), dueAt: lms.addDays(lms.today(), 14), assignedBy: admin.id });

const done = (email, ...list) => list.forEach((it) => lms.setProgress(db, lms.getUserByEmail(db, email).id, it.id, 'completed'));
done('jordan.lee@example.com', items.culture, items.portfolio, items.tfIntro, items.vaultIntro, items.meddpicc, items.sfdc, items.vaultPitch);
done('alex.kim@example.com', items.culture, items.portfolio, items.vaultIntro);
done('morgan.chen@example.com', items.culture);
lms.setProgress(db, lms.getUserByEmail(db, 'taylor.nguyen@example.com').id, items.culture.id, 'in_progress');

console.log('Seeded. Sign in as admin@example.com (admin), sam.rivera@example.com (manager) or jordan.lee@example.com (learner).');
