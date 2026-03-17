const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT,
    refresh_token TEXT,
    expiry_date  INTEGER,
    email        TEXT,
    updated_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    drive_file_id   TEXT UNIQUE NOT NULL,
    file_name       TEXT,
    ocr_text        TEXT,
    recipient_raw   TEXT,
    contact_id      TEXT,
    contact_name    TEXT,
    contact_email   TEXT,
    gmail_draft_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
  CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at DESC);
`);

// Idempotent column additions
[
  'ALTER TABLE scans ADD COLUMN mail_category TEXT',
  'ALTER TABLE scans ADD COLUMN deleted_at INTEGER',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

db.exec(`
  CREATE TABLE IF NOT EXISTS contact_overrides (
    recipient_key  TEXT PRIMARY KEY,
    contact_id     TEXT,
    contact_name   TEXT NOT NULL,
    contact_email  TEXT NOT NULL,
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

module.exports = db;
