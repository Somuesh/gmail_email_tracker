'use strict';
/**
 * Mail Tracker backend: pixel + link redirects + JSON API for the Gmail add-on.
 * Storage: PostgreSQL (Render). Tables are created automatically on boot.
 *
 * Env:
 *   DATABASE_URL     Postgres connection string (Render: use the Internal URL)
 *   PUBLIC_BASE_URL  e.g. https://mail-tracker.onrender.com (no trailing slash)
 *   ADDON_AUDIENCE   OAuth client ID of the add-on's Google Cloud project
 */
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const dbUrl = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: dbUrl,
  // External Render URLs need SSL; internal ones don't.
  ssl: /\.render\.com/.test(dbUrl) ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

const app = express();
const oauth = new OAuth2Client();
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const AUDIENCE = process.env.ADDON_AUDIENCE;

app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');

const newId = (n = 12) => crypto.randomBytes(n).toString('base64url');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      recipients JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      opens INT NOT NULL DEFAULT 0,
      clicks INT NOT NULL DEFAULT 0,
      last_open_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS emails_owner_idx ON emails (owner, created_at DESC);
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      client TEXT,
      url TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_email_idx ON events (email_id);
  `);
}

// ---------- auth for add-on API ----------
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'missing token' });
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: AUDIENCE });
    const p = ticket.getPayload();
    if (!p.email || !p.email_verified) return res.status(401).json({ error: 'unverified' });
    req.user = { email: p.email.toLowerCase() };
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: 'server error' });
});

// ---------- API ----------
app.post('/api/emails', auth, wrap(async (req, res) => {
  const id = newId();
  const { subject = '', recipients = [] } = req.body || {};
  const rec = (Array.isArray(recipients) ? recipients : []).slice(0, 50).map(String);
  await q('INSERT INTO emails (id, owner, subject, recipients) VALUES ($1,$2,$3,$4)',
    [id, req.user.email, String(subject).slice(0, 200), JSON.stringify(rec)]);
  res.json({ id, pixelUrl: `${BASE}/p/${id}.gif` });
}));

app.post('/api/links', auth, wrap(async (req, res) => {
  const { emailId, url } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'bad url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'http(s) only' });
  const own = await q('SELECT 1 FROM emails WHERE id=$1 AND owner=$2', [String(emailId), req.user.email]);
  if (!own.rowCount) return res.status(404).json({ error: 'not found' });
  const id = newId(8);
  await q('INSERT INTO links (id, email_id, owner, url) VALUES ($1,$2,$3,$4)',
    [id, emailId, req.user.email, parsed.toString()]);
  res.json({ id, trackedUrl: `${BASE}/l/${id}` });
}));

app.get('/api/emails', auth, wrap(async (req, res) => {
  const r = await q(
    `SELECT id, subject, recipients, opens, clicks,
            (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS created_at,
            (EXTRACT(EPOCH FROM last_open_at)*1000)::bigint AS last_open_at
     FROM emails WHERE owner=$1 ORDER BY created_at DESC LIMIT 25`, [req.user.email]);
  res.json(r.rows.map(x => ({
    id: x.id, subject: x.subject, recipients: x.recipients, opens: x.opens, clicks: x.clicks,
    createdAt: x.created_at ? Number(x.created_at) : null,
    lastOpenAt: x.last_open_at ? Number(x.last_open_at) : null,
  })));
}));

app.delete('/api/me', auth, wrap(async (req, res) => {
  await q('DELETE FROM emails WHERE owner=$1', [req.user.email]); // cascades to links/events
  res.json({ ok: true });
}));

// ---------- public tracking endpoints ----------
function classify(ua = '') {
  if (/GoogleImageProxy/i.test(ua)) return 'google-proxy';
  if (/YahooMailProxy/i.test(ua)) return 'apple-or-proxy';
  return 'direct';
}

app.get('/p/:file', (req, res) => {
  const id = req.params.file.replace(/\.gif$/, '');
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
  });
  res.end(GIF);
  (async () => {
    // Ignore the sender's own preview in the first 20 seconds.
    const r = await q(
      `UPDATE emails SET opens = opens + 1, last_open_at = now()
       WHERE id=$1 AND created_at < now() - interval '20 seconds'
       RETURNING owner`, [id]);
    if (r.rowCount) {
      await q('INSERT INTO events (type, email_id, owner, client) VALUES ($1,$2,$3,$4)',
        ['open', id, r.rows[0].owner, classify(req.get('user-agent') || '')]);
    }
  })().catch(e => console.error('open log failed', e.message));
});

app.get('/l/:id', wrap(async (req, res) => {
  const r = await q('SELECT url, email_id, owner FROM links WHERE id=$1', [req.params.id]);
  if (!r.rowCount) return res.status(404).send('Link not found');
  const { url, email_id, owner } = r.rows[0];
  res.redirect(302, url);
  Promise.all([
    q('UPDATE emails SET clicks = clicks + 1 WHERE id=$1', [email_id]),
    q('INSERT INTO events (type, email_id, owner, url) VALUES ($1,$2,$3,$4)', ['click', email_id, owner, url]),
  ]).catch(e => console.error('click log failed', e.message));
}));

app.get('/healthz', (_req, res) => res.send('ok'));

initDb()
  .then(() => app.listen(process.env.PORT || 8080, () => console.log('tracker up')))
  .catch(e => { console.error('DB init failed', e.message); process.exit(1); });
