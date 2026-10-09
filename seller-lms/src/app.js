'use strict';

const path = require('node:path');
const express = require('express');
const lms = require('./lms');
const { createAuth } = require('./auth');
const { createSlack } = require('./slack');
const { apiRouter } = require('./routes/api');
const { slackRouter } = require('./routes/slack');

function createApp({ db, auth = createAuth(), slack = createSlack(), logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Slack needs the raw body for signature checks, so mount it before the JSON parser.
  app.use('/slack', slackRouter({ db, slack, logger }));

  app.use(express.json({ limit: '5mb' }));
  app.use(auth.middleware(db));

  app.get('/auth/config', (_req, res) => res.json({ mode: auth.mode }));
  if (auth.mode === 'dev') {
    app.post('/auth/login', (req, res) => {
      const user = req.body?.email && lms.getUserByEmail(db, String(req.body.email).trim());
      if (!user || !user.active) return res.status(401).json({ error: 'No active user with that email' });
      auth.issue(res, user.id);
      res.json({ user });
    });
    app.post('/auth/logout', (_req, res) => { auth.clear(res); res.status(204).end(); });
  }

  app.use('/api', apiRouter({ db, slack }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createApp };
