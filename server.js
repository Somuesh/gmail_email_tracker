'use strict';
/**
 * Mail Tracker backend: pixel + link redirects + JSON API for the Gmail add-on.
 * Storage: Firestore (collections: emails, links, events).
 *
 * Env:
 *   PUBLIC_BASE_URL  e.g. https://tracker-xxxxx.a.run.app (no trailing slash)
 *   ADDON_AUDIENCE   OAuth client ID of the add-on's Google Cloud project
 *                    (audience of ScriptApp.getIdentityToken())
 */
const crypto = require('crypto');
const express = require('express');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

const db = new Firestore();
const app = express();
const oauth = new OAuth2Client();
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const AUDIENCE = process.env.ADDON_AUDIENCE;

app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');

const newId = (n = 12) => crypto.randomBytes(n).toString('base64url');

// 1x1 transparent GIF
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ---------- auth for add-on API ----------
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'missing token' });
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: AUDIENCE });
    const p = ticket.getPayload();
    if (!p.email || !p.email_verified) return res.status(401).json({ error: 'unverified' });
    req.user = { email: p.email.toLowerCase(), sub: p.sub };
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

// ---------- API ----------
// Register an email to track; returns pixel URL.
app.post('/api/emails', auth, async (req, res) => {
  const id = newId();
  const { subject = '', recipients = [] } = req.body || {};
  await db.collection('emails').doc(id).set({
    owner: req.user.email,
    subject: String(subject).slice(0, 200),
    recipients: (Array.isArray(recipients) ? recipients : []).slice(0, 50).map(String),
    createdAt: FieldValue.serverTimestamp(),
    opens: 0,
    clicks: 0,
    lastOpenAt: null,
  });
  res.json({ id, pixelUrl: `${BASE}/p/${id}.gif` });
});

// Create a tracked link for an existing email id.
app.post('/api/links', auth, async (req, res) => {
  const { emailId, url } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'bad url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'http(s) only' });
  const email = await db.collection('emails').doc(String(emailId)).get();
  if (!email.exists || email.data().owner !== req.user.email) return res.status(404).json({ error: 'not found' });
  const id = newId(8);
  await db.collection('links').doc(id).set({ emailId, url: parsed.toString(), owner: req.user.email });
  res.json({ id, trackedUrl: `${BASE}/l/${id}` });
});

// Recent tracked emails for the dashboard.
app.get('/api/emails', auth, async (req, res) => {
  const snap = await db.collection('emails')
    .where('owner', '==', req.user.email)
    .orderBy('createdAt', 'desc').limit(25).get();
  res.json(snap.docs.map(d => {
    const x = d.data();
    return {
      id: d.id,
      subject: x.subject,
      recipients: x.recipients,
      opens: x.opens,
      clicks: x.clicks,
      createdAt: x.createdAt ? x.createdAt.toMillis() : null,
      lastOpenAt: x.lastOpenAt ? x.lastOpenAt.toMillis() : null,
    };
  }));
});

// Delete all of a user's data (privacy / uninstall).
app.delete('/api/me', auth, async (req, res) => {
  for (const col of ['emails', 'links', 'events']) {
    const snap = await db.collection(col).where('owner', '==', req.user.email).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  res.json({ ok: true });
});

// ---------- public tracking endpoints ----------
function classify(ua = '') {
  if (/GoogleImageProxy/i.test(ua)) return 'google-proxy';
  if (/YahooMailProxy|Apple.*Mail|Mozilla\/5\.0 \(Macintosh.*AppleWebKit.*\) *$/i.test(ua)) return 'apple-or-proxy';
  return 'direct';
}

app.get('/p/:file', async (req, res) => {
  const id = req.params.file.replace(/\.gif$/, '');
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
  });
  res.end(GIF);
  try {
    const ref = db.collection('emails').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return;
    // Skip the sender previewing their own mail shortly after creation (<20s).
    const created = doc.data().createdAt && doc.data().createdAt.toMillis();
    if (created && Date.now() - created < 20000) return;
    const ua = req.get('user-agent') || '';
    await Promise.all([
      ref.update({ opens: FieldValue.increment(1), lastOpenAt: FieldValue.serverTimestamp() }),
      db.collection('events').add({
        type: 'open', emailId: id, owner: doc.data().owner,
        at: FieldValue.serverTimestamp(), client: classify(ua),
      }),
    ]);
  } catch (e) { console.error('open log failed', e.message); }
});

app.get('/l/:id', async (req, res) => {
  const link = await db.collection('links').doc(req.params.id).get();
  if (!link.exists) return res.status(404).send('Link not found');
  const { url, emailId, owner } = link.data();
  res.redirect(302, url);
  try {
    await Promise.all([
      db.collection('emails').doc(emailId).update({ clicks: FieldValue.increment(1) }),
      db.collection('events').add({
        type: 'click', emailId, owner, url, at: FieldValue.serverTimestamp(),
      }),
    ]);
  } catch (e) { console.error('click log failed', e.message); }
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(process.env.PORT || 8080, () => console.log('tracker up'));
