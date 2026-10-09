'use strict';

const express = require('express');

// Inbound Slack endpoints: slash command (/learn) and interactive buttons.
// Point both the slash command and Interactivity request URLs at these paths.
function slackRouter({ db, slack, logger = console }) {
  const r = express.Router();
  r.use(express.text({ type: 'application/x-www-form-urlencoded', limit: '1mb' }));
  r.use((req, res, next) => {
    if (!slack.verifySignature(req.body || '', req.headers)) return res.status(401).send('Invalid signature');
    req.form = Object.fromEntries(new URLSearchParams(req.body));
    next();
  });

  r.post('/commands', (req, res) => res.json(slack.handleCommand(db, req.form)));

  r.post('/interactions', async (req, res) => {
    // Ack immediately; Slack requires a response within 3 seconds.
    res.status(200).end();
    try {
      await slack.handleInteraction(db, JSON.parse(req.form.payload || '{}'));
    } catch (err) {
      logger.error(`[slack] interaction failed: ${err.message}`);
    }
  });

  return r;
}

module.exports = { slackRouter };
