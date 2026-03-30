const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
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
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
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
