'use strict';

const { openDb } = require('../src/db');
const lms = require('../src/lms');

const CSV = `email,name,role,team,region,segment,manager_email
boss@example.com,Big Boss,manager,Enterprise West,AMER,Enterprise,
mid@example.com,Mid Manager,manager,Enterprise West,AMER,Enterprise,boss@example.com
ae1@example.com,Ae One,learner,Enterprise West,AMER,Enterprise,mid@example.com
ae2@example.com,Ae Two,learner,Commercial East,AMER,Commercial,boss@example.com
emea@example.com,Emea Seller,learner,DACH,EMEA,Enterprise,
`;

function fixture() {
  const db = openDb(':memory:');
  const admin = lms.createUser(db, { email: 'admin@example.com', name: 'Admin', role: 'admin' });
  lms.importUsers(db, CSV);
  const u = (email) => lms.getUserByEmail(db, email);
  const a = lms.createContent(db, { title: 'Intro', type: 'video', duration_minutes: 10 });
  const b = lms.createContent(db, { title: 'Deep dive', type: 'course', duration_minutes: 60 });
  const c = lms.createContent(db, { title: 'Bonus', type: 'document' });
  const plan = lms.createPlan(db, {
    title: 'Onboarding', due_days: 30,
    items: [{ item_id: a.id }, { item_id: b.id }, { item_id: c.id, required: false }],
  }, admin.id);
  return { db, admin, u, items: { a, b, c }, plan };
}

module.exports = { fixture, CSV };
