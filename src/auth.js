const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const TOKEN_PATH = path.join(__dirname, '..', '.tokens.json');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function loadTokens() {
  // Try file-based tokens first
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    }
  } catch {}

  // Fall back to env vars
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    return {
      access_token: process.env.GOOGLE_ACCESS_TOKEN || '',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      expiry_date: 0,
    };
  }

  return null;
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  } catch {
    // On Railway / read-only filesystem, file writes fail — tokens persist via env vars
    console.log('[auth] Could not write tokens file (read-only FS) — using env vars instead');
  }
}

function getAuthUrl() {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  client.setCredentials(tokens);

  // Log refresh token so it can be saved as env var for persistence
  if (tokens.refresh_token) {
    console.log(`[auth] REFRESH_TOKEN obtained — save as GOOGLE_REFRESH_TOKEN env var for persistence`);
    console.log(`[auth] GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  }

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return data.email;
}

async function getAuthClient() {
  const tokens = loadTokens();
  if (!tokens) return null;

  const client = createOAuth2Client();
  client.setCredentials(tokens);

  // Auto-save refreshed tokens
  client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens(merged);
  });

  return client;
}

async function isConnected() {
  const tokens = loadTokens();
  return !!(tokens && (tokens.refresh_token || tokens.access_token));
}

module.exports = { getAuthUrl, exchangeCode, getAuthClient, isConnected };
