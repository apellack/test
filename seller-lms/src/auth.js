'use strict';

const crypto = require('node:crypto');
const lms = require('./lms');

const COOKIE = 'lms_session';
const MAX_AGE_S = 60 * 60 * 12;

/**
 * Two auth modes:
 *  - "header" (production): run behind an SSO proxy such as oauth2-proxy in front of Okta,
 *    which sets a trusted email header (TRUSTED_EMAIL_HEADER, default x-forwarded-email).
 *  - "dev": a login form that accepts any active user's email. Never expose this publicly.
 */
function createAuth({
  mode = process.env.AUTH_MODE || 'dev',
  secret = process.env.SESSION_SECRET,
  emailHeader = (process.env.TRUSTED_EMAIL_HEADER || 'x-forwarded-email').toLowerCase(),
} = {}) {
  if (!['dev', 'header'].includes(mode)) throw new Error(`Unknown AUTH_MODE: ${mode}`);
  if (!secret) {
    if (mode !== 'dev') throw new Error('SESSION_SECRET is required');
    secret = crypto.randomBytes(32).toString('hex');
  }

  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

  function issue(res, userId) {
    const value = `${userId}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
    res.cookie(COOKIE, `${value}.${sign(value)}`, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: MAX_AGE_S * 1000,
    });
  }

  function readCookie(req) {
    const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const [id, exp, mac] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
    if (!id || !exp || !mac) return null;
    const expected = sign(`${id}.${exp}`);
    if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    if (Number(exp) < Date.now() / 1000) return null;
    return Number(id);
  }

  // Populates req.user (or leaves it undefined).
  function middleware(db) {
    return (req, _res, next) => {
      let user;
      if (mode === 'header') {
        const email = req.headers[emailHeader];
        if (email) user = lms.getUserByEmail(db, String(email).trim());
      } else {
        const id = readCookie(req);
        if (id) user = lms.getUser(db, id);
      }
      if (user && user.active) req.user = user;
      next();
    };
  }

  return { mode, issue, middleware, clear: (res) => res.clearCookie(COOKIE) };
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// Make sure bootstrap admins (ADMIN_EMAILS, comma separated) exist and are admins.
function ensureAdmins(db, emails = process.env.ADMIN_EMAILS) {
  for (const email of (emails || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const existing = lms.getUserByEmail(db, email);
    if (existing) {
      if (existing.role !== 'admin') lms.updateUser(db, existing.id, { role: 'admin' });
    } else {
      lms.createUser(db, { email, name: email.split('@')[0], role: 'admin' });
    }
  }
}

module.exports = { createAuth, requireUser, requireRole, ensureAdmins };
