'use strict';

// Send Slack reminders for overdue / due-soon learning. Run daily from cron or a scheduler.
const { openDb } = require('../src/db');
const { createSlack } = require('../src/slack');

(async () => {
  const slack = createSlack();
  if (!slack.enabled) {
    console.error('SLACK_BOT_TOKEN is not set; nothing to do.');
    process.exit(1);
  }
  const result = await slack.sendReminders(openDb());
  console.log(JSON.stringify(result));
})();
