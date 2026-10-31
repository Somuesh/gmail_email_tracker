'use strict';
/**
 * Mail Tracker backend: pixel + link redirects + JSON API + CSV export.
 * Storage: PostgreSQL (Render). Tables are created/migrated automatically on boot.
 *
 * Env:
 *   DATABASE_URL     Postgres connection string (Render: use the Internal URL)
 *   PUBLIC_BASE_URL  e.g. https://mail-tracker.onrender.com (no trailing slash)
 *   ADDON_AUDIENCE   OAuth client ID of the add-on's Google Cloud project
 *   EXPORT_SECRET    (optional) any long random string; signs 5-minute export links
 */
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const dbUrl = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: dbUrl,
  ssl: /\.render\.com/.test(dbUrl) ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

const app = express();
const oauth = new OAuth2Client();
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const AUDIENCE = process.env.ADDON_AUDIENCE;
const EXPORT_SECRET = process.env.EXPORT_SECRET || crypto.randomBytes(32).toString('hex');

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
      url TEXT NOT NULL,
      clicks INT NOT NULL DEFAULT 0
    );
    ALTER TABLE links ADD COLUMN IF NOT EXISTS clicks INT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      client TEXT,
      url TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_email_idx ON events (email_id, at DESC);
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
// Register (idempotent) an email to track. The add-on supplies the id so the pixel
// and tracked links added to the same draft always share one record.
app.post('/api/emails', auth, wrap(async (req, res) => {
  const { id: given, subject = '', recipients = [] } = req.body || {};
  const id = /^[A-Za-z0-9_-]{8,40}$/.test(given || '') ? given : newId();
  const rec = (Array.isArray(recipients) ? recipients : []).slice(0, 50).map(String);
  const r = await q(
    `INSERT INTO emails (id, owner, subject, recipients) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, recipients = EXCLUDED.recipients
     WHERE emails.owner = EXCLUDED.owner
     RETURNING id`,
    [id, req.user.email, String(subject).slice(0, 200), JSON.stringify(rec)]);
  if (!r.rowCount) return res.status(409).json({ error: 'id in use' });
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

// Dashboard: totals + the 25 most recent emails.
app.get('/api/emails', auth, wrap(async (req, res) => {
  const s = await q(
    `SELECT count(*) AS emails, COALESCE(sum(opens),0) AS opens, COALESCE(sum(clicks),0) AS clicks
     FROM emails WHERE owner=$1`, [req.user.email]);
  const r = await q(
    `SELECT id, subject, recipients, opens, clicks,
            (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS created_at,
            (EXTRACT(EPOCH FROM last_open_at)*1000)::bigint AS last_open_at
     FROM emails WHERE owner=$1 ORDER BY created_at DESC LIMIT 25`, [req.user.email]);
  res.json({
    summary: {
      emails: Number(s.rows[0].emails),
      opens: Number(s.rows[0].opens),
      clicks: Number(s.rows[0].clicks),
    },
    emails: r.rows.map(x => ({
      id: x.id, subject: x.subject, recipients: x.recipients, opens: x.opens, clicks: x.clicks,
      createdAt: x.created_at ? Number(x.created_at) : null,
      lastOpenAt: x.last_open_at ? Number(x.last_open_at) : null,
    })),
  });
}));

// Detail for one email: recent activity and per-link clicks.
app.get('/api/emails/:id', auth, wrap(async (req, res) => {
  const e = await q(
    `SELECT id, subject, recipients, opens, clicks,
            (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS created_at,
            (EXTRACT(EPOCH FROM last_open_at)*1000)::bigint AS last_open_at
     FROM emails WHERE id=$1 AND owner=$2`, [req.params.id, req.user.email]);
  if (!e.rowCount) return res.status(404).json({ error: 'not found' });
  const ev = await q(
    `SELECT type, client, url, (EXTRACT(EPOCH FROM at)*1000)::bigint AS at
     FROM events WHERE email_id=$1 ORDER BY at DESC LIMIT 15`, [req.params.id]);
  const lk = await q('SELECT url, clicks FROM links WHERE email_id=$1 ORDER BY clicks DESC', [req.params.id]);
  const x = e.rows[0];
  res.json({
    id: x.id, subject: x.subject, recipients: x.recipients, opens: x.opens, clicks: x.clicks,
    createdAt: x.created_at ? Number(x.created_at) : null,
    lastOpenAt: x.last_open_at ? Number(x.last_open_at) : null,
    events: ev.rows.map(v => ({ type: v.type, client: v.client, url: v.url, at: Number(v.at) })),
    links: lk.rows,
  });
}));

app.delete('/api/emails/:id', auth, wrap(async (req, res) => {
  const r = await q('DELETE FROM emails WHERE id=$1 AND owner=$2', [req.params.id, req.user.email]);
  res.json({ ok: true, deleted: r.rowCount });
}));

app.delete('/api/me', auth, wrap(async (req, res) => {
  const r = await q('DELETE FROM emails WHERE owner=$1', [req.user.email]); // cascades
  res.json({ ok: true, deleted: r.rowCount });
}));

// ---------- CSV export (short-lived signed link, opened in the browser) ----------
function signExport(owner) {
  const body = Buffer.from(JSON.stringify({ o: owner, e: Date.now() + 5 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', EXPORT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyExport(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', EXPORT_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.e > Date.now() ? p.o : null;
  } catch (e) { return null; }
}
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return '"' + s.replace(/"/g, '""') + '"';
};
const csvRow = arr => arr.map(csvCell).join(',');

function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
}

app.post('/api/export-link', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'opens' ? 'opens' : 'emails';
  const tz = encodeURIComponent(validTz(b.tz || 'UTC'));
  res.json({ url: `${BASE}/export/${kind}.csv?t=${signExport(req.user.email)}&tz=${tz}` });
}));

// Local-time pieces for analysis: "2026-10-31 18:24:05", date, hour (0-23), weekday.
function localParts(d, tz) {
  if (!d) return { dt: '', date: '', hour: '', weekday: '' };
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'long',
  });
  const p = {};
  f.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const date = `${p.year}-${p.month}-${p.day}`;
  return { dt: `${date} ${p.hour}:${p.minute}:${p.second}`, date, hour: Number(p.hour), weekday: p.weekday };
}
const sourceName = c => (c === 'google-proxy' ? 'Gmail image proxy' : c === 'apple-or-proxy' ? 'Mail proxy' : 'Direct');
const minutesBetween = (a, b) => (a && b ? Math.round(((b - a) / 60000) * 10) / 10 : '');

app.get('/export/:kind.csv', wrap(async (req, res) => {
  const owner = verifyExport(req.query.t);
  if (!owner) return res.status(401).send('Link expired. Request a new export from the add-on.');
  const stamp = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="mail-tracker-${req.params.kind}-${stamp}.csv"`,
    'Cache-Control': 'no-store',
  });
  const tz = validTz(req.query.tz || 'UTC');

  // One row per OPEN: ready for pivot tables (by hour, weekday, recipient, source ...).
  if (req.params.kind === 'opens') {
    const r = await q(
      `SELECT e.id, e.subject, e.recipients, e.created_at, ev.at, ev.client,
              row_number() OVER (PARTITION BY e.id ORDER BY ev.at) AS n
       FROM events ev JOIN emails e ON e.id = ev.email_id
       WHERE ev.owner=$1 AND ev.type='open'
       ORDER BY ev.at DESC`, [owner]);
    const lines = [csvRow([
      'Email ID', 'Label', 'Recipients', 'Recipient count', 'Sent at', 'Open #', 'Is first open',
      'Opened at', 'Open date', 'Open hour (0-23)', 'Open weekday', 'Minutes since sent',
      'Source', 'Possibly automated (proxy)'])];
    r.rows.forEach(x => {
      const sent = localParts(x.created_at, tz), opened = localParts(x.at, tz);
      const rec = x.recipients || [];
      lines.push(csvRow([
        x.id, x.subject, rec.join('; '), rec.length, sent.dt, Number(x.n), Number(x.n) === 1 ? 'Yes' : 'No',
        opened.dt, opened.date, opened.hour, opened.weekday, minutesBetween(x.created_at, x.at),
        sourceName(x.client), x.client === 'direct' ? 'No' : 'Yes']));
    });
    return res.send('\ufeff' + lines.join('\r\n'));
  }

  // One row per EMAIL: summary with time-to-first-open.
  const r = await q(
    `SELECT e.id, e.subject, e.recipients, e.created_at, e.opens,
            min(ev.at) AS first_open, max(ev.at) AS last_open,
            count(*) FILTER (WHERE ev.client = 'direct') AS direct_opens,
            count(*) FILTER (WHERE ev.client <> 'direct') AS proxy_opens
     FROM emails e LEFT JOIN events ev ON ev.email_id = e.id AND ev.type = 'open'
     WHERE e.owner=$1 GROUP BY e.id ORDER BY e.created_at DESC`, [owner]);
  const lines = [csvRow([
    'Email ID', 'Label', 'Recipients', 'Recipient count', 'Sent at', 'Sent date', 'Sent hour (0-23)',
    'Sent weekday', 'Opened?', 'Total opens', 'Direct opens', 'Proxy opens', 'First opened at',
    'Last opened at', 'Minutes to first open'])];
  r.rows.forEach(x => {
    const sent = localParts(x.created_at, tz);
    const rec = x.recipients || [];
    lines.push(csvRow([
      x.id, x.subject, rec.join('; '), rec.length, sent.dt, sent.date, sent.hour, sent.weekday,
      x.opens > 0 ? 'Yes' : 'No', x.opens, Number(x.direct_opens), Number(x.proxy_opens),
      localParts(x.first_open, tz).dt, localParts(x.last_open, tz).dt,
      minutesBetween(x.created_at, x.first_open)]));
  });
  res.send('\ufeff' + lines.join('\r\n'));
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
    // Ignore the sender's own preview (first 20s) and duplicate fetches within 2s.
    const r = await q(
      `UPDATE emails SET opens = opens + 1, last_open_at = now()
       WHERE id=$1
         AND created_at < now() - interval '20 seconds'
         AND (last_open_at IS NULL OR last_open_at < now() - interval '2 seconds')
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
    q('UPDATE links SET clicks = clicks + 1 WHERE id=$1', [req.params.id]),
    q('INSERT INTO events (type, email_id, owner, url) VALUES ($1,$2,$3,$4)', ['click', email_id, owner, url]),
  ]).catch(e => console.error('click log failed', e.message));
}));

app.get('/healthz', (_req, res) => res.send('ok'));

initDb()
  .then(() => app.listen(process.env.PORT || 8080, () => console.log('tracker up')))
  .catch(e => { console.error('DB init failed', e.message); process.exit(1); });
