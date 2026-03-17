const { google } = require('googleapis');
const db = require('./db');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(loginHint) {
  const client = createOAuth2Client();
  const opts = {
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  };
  if (loginHint) opts.login_hint = loginHint;
  return client.generateAuthUrl(opts);
}

async function exchangeCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Get user email
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  // Store tokens (single business account — row id=1)
  db.prepare(`
    INSERT INTO tokens (id, access_token, refresh_token, expiry_date, email, updated_at)
    VALUES (1, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      expiry_date  = excluded.expiry_date,
      email        = excluded.email,
      updated_at   = excluded.updated_at
  `).run(
    tokens.access_token,
    tokens.refresh_token || null,
    tokens.expiry_date || null,
    data.email
  );

  return data.email;
}

function getAuthClient() {
  const row = db.prepare('SELECT * FROM tokens WHERE id = 1').get();
  if (!row) return null;

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date,
  });

  // Persist refreshed tokens automatically
  client.on('tokens', (tokens) => {
    db.prepare(`
      UPDATE tokens SET
        access_token = ?,
        expiry_date  = ?,
        updated_at   = unixepoch()
      WHERE id = 1
    `).run(tokens.access_token, tokens.expiry_date || null);
  });

  return client;
}

function isConnected() {
  const row = db.prepare('SELECT id FROM tokens WHERE id = 1').get();
  return !!row;
}

// Middleware: require active session
function requireSession(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/auth/google');
}

module.exports = { getAuthUrl, exchangeCode, getAuthClient, isConnected, requireSession };
