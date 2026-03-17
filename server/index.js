require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const { getAuthUrl, exchangeCode, isConnected, requireSession } = require('./auth');
const db = require('./db');
const { listNewPdfs, downloadPdf } = require('./services/drive');
const { processScan } = require('./services/pipeline');

const scansRouter = require('./routes/scans');
const draftsRouter = require('./routes/drafts');
const contactsRouter = require('./routes/contacts');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: IS_DEV ? 'http://localhost:5173' : false, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: !IS_DEV, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  // Pass stored email as login_hint so Google pre-selects the right account
  const stored = db.prepare("SELECT email FROM tokens WHERE id = 1").get();
  res.redirect(getAuthUrl(stored?.email));
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Google auth error: ${error}`);

  try {
    const email = await exchangeCode(code);
    req.session.authenticated = true;
    req.session.email = email;
    res.redirect(IS_DEV ? 'http://localhost:5173/' : '/');
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    connected: isConnected(),
    email: req.session?.email || null,
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/scans', requireSession, scansRouter);
app.use('/api/drafts', requireSession, draftsRouter);
app.use('/api/contacts', requireSession, contactsRouter);

// ─── Serve React client (production) ─────────────────────────────────────────
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
if (!IS_DEV) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', requireSession, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ─── Background Poll Pipeline ─────────────────────────────────────────────────
let isProcessing = false;

/**
 * Extract a date from a scanner filename.
 * Primary: YYYY-MM-DD anywhere in name (e.g. "scan_virtual_123 2025-08-22T14-21-32UTC.pdf")
 * Fallbacks: YYYY_MM_DD, YYYYMMDD (year >= 2000), DD-MM-YYYY.
 * Returns a Unix timestamp (seconds) or null.
 */
function extractDateFromFilename(name) {
  const s = name.replace(/\.pdf$/i, '');

  // YYYY-MM-DD (ISO, e.g. 2025-08-22T...)
  let m = s.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
    if (!isNaN(d)) return Math.floor(d.getTime() / 1000);
  }

  // YYYY_MM_DD
  m = s.match(/(20\d{2})_(\d{2})_(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
    if (!isNaN(d)) return Math.floor(d.getTime() / 1000);
  }

  // YYYYMMDD (8 consecutive digits, year >= 2000)
  m = s.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
    if (!isNaN(d)) return Math.floor(d.getTime() / 1000);
  }

  // DD-MM-YYYY or DD_MM_YYYY
  m = s.match(/(\d{2})[-_](\d{2})[-_](20\d{2})/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
    if (!isNaN(d)) return Math.floor(d.getTime() / 1000);
  }

  return null;
}

async function processSingleFile(file) {
  console.log(`[poll] Processing: ${file.name} (${file.id})`);

  // Prefer date from filename; fall back to Drive's createdTime
  const fileCreatedAt =
    extractDateFromFilename(file.name) ||
    (file.createdTime ? Math.floor(new Date(file.createdTime).getTime() / 1000) : Math.floor(Date.now() / 1000));

  console.log(`[poll] Scan date resolved to: ${new Date(fileCreatedAt * 1000).toISOString().slice(0, 10)}`);

  db.prepare(`
    INSERT OR IGNORE INTO scans (drive_file_id, file_name, status, created_at, updated_at)
    VALUES (?, ?, 'processing', ?, unixepoch())
  `).run(file.id, file.name, fileCreatedAt);

  const scanId = db.prepare('SELECT id FROM scans WHERE drive_file_id = ?').get(file.id)?.id;
  if (!scanId) return;

  try {
    await processScan(scanId);
  } catch (err) {
    console.error(`[poll] Error processing ${file.name}:`, err.message);
  }
}

async function pollDrive() {
  if (!isConnected()) return;
  if (isProcessing) {
    console.log('[poll] Previous run still in progress, skipping');
    return;
  }

  isProcessing = true;
  try {
    // Retry any scans that previously errored
    const errorScans = db.prepare(`SELECT id, file_name FROM scans WHERE status = 'error'`).all();
    if (errorScans.length > 0) {
      console.log(`[poll] Retrying ${errorScans.length} previously-failed scan(s)`);
      for (const scan of errorScans) {
        console.log(`[poll] Retrying: ${scan.file_name}`);
        await processScan(scan.id).catch((err) =>
          console.error(`[poll] Retry failed for scan ${scan.id}:`, err.message)
        );
      }
    }

    // Pick up new files from Drive
    const newFiles = await listNewPdfs();
    if (newFiles.length === 0 && errorScans.length === 0) {
      console.log('[poll] No new files found');
      return;
    }
    if (newFiles.length > 0) {
      console.log(`[poll] Found ${newFiles.length} new file(s)`);
      for (const file of newFiles) {
        await processSingleFile(file);
      }
    }
  } catch (err) {
    console.error('[poll] Drive poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

// Endpoint to trigger manual poll
app.post('/api/poll', requireSession, async (req, res) => {
  console.log('[poll] Manual poll triggered');
  pollDrive().catch(console.error);
  res.json({ message: 'Poll started' });
});

// Schedule automatic polling
const intervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);
const cronExpression = `*/${intervalSeconds} * * * * *`;
if (intervalSeconds >= 30) {
  cron.schedule(cronExpression, () => {
    console.log('[poll] Scheduled poll running...');
    pollDrive().catch(console.error);
  });
  console.log(`[poll] Scheduler started — checking Drive every ${intervalSeconds}s`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Virtual Office Mail server running on http://localhost:${PORT}`);

  // Set poll_since cutoff on first run so historical files are ignored
  const existingSince = db.prepare("SELECT value FROM settings WHERE key = 'poll_since'").get();
  if (!existingSince) {
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('poll_since', ?)").run(now);
    console.log(`📅 Poll cutoff initialised to ${now} — only scans arriving from now will be processed`);
  } else {
    console.log(`📅 Poll cutoff: ${existingSince.value}`);
  }

  if (!isConnected()) {
    console.log(`⚠️  Not yet authenticated — visit http://localhost:${PORT}/auth/google`);
  } else {
    console.log(`🔗 Google account connected`);
    // Run initial poll on startup
    setTimeout(() => pollDrive().catch(console.error), 2000);
  }
});
