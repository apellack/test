'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createSlack } = require('./slack');
const { ensureAdmins } = require('./auth');

const db = openDb();
ensureAdmins(db);
const slack = createSlack();
const app = createApp({ db, slack });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Seller LMS listening on http://localhost:${port} (auth: ${process.env.AUTH_MODE || 'dev'}, slack: ${slack.enabled ? 'on' : 'off'})`);
});

// Optional in-process reminder loop. In production prefer a scheduled `npm run reminders`.
const hours = Number(process.env.REMINDER_INTERVAL_HOURS || 0);
if (hours > 0 && slack.enabled) {
  setInterval(() => {
    slack.sendReminders(db).then((r) => console.log('[reminders]', r), (e) => console.error('[reminders]', e));
  }, hours * 3600 * 1000).unref();
}
