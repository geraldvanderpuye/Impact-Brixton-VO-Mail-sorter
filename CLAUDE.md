# IB Virtual Office — Mail Sorting App

## What this app does
Polls a Google Drive folder for scanned mail PDFs → OCR extracts the recipient → searches Google Contacts → creates a Gmail draft with the PDF attached → staff review and send from the web UI.

## Tech Stack
- **Backend**: Node.js + Express (`server/`)
- **Frontend**: React + Vite (`client/`)
- **Database**: SQLite via better-sqlite3 (`data/app.db`)
- **Google APIs**: Drive, Gmail, People (Contacts)
- **AI**: Claude claude-haiku-4-5 (Anthropic) for OCR recipient extraction
- **PDF→Image**: pdf2pic (requires Poppler: `brew install poppler`)

## Key Files
| File | Purpose |
|------|---------|
| `server/index.js` | Express app + cron polling loop |
| `server/db.js` | SQLite schema (scans + tokens tables) |
| `server/auth.js` | Google OAuth2 helpers, token storage |
| `server/services/drive.js` | Drive folder polling + PDF download |
| `server/services/ocr.js` | pdf2pic → Cloud Vision → recipient extraction |
| `server/services/contacts.js` | People API search |
| `server/services/gmail.js` | Draft create/send/delete |
| `server/routes/scans.js` | GET scans, GET scans/:id/pdf proxy |
| `server/routes/drafts.js` | send, skip, reassign actions |
| `client/src/pages/Dashboard.jsx` | Main UI with tabs |
| `client/src/components/ScanCard.jsx` | Per-scan card with actions |
| `client/src/components/ContactPicker.jsx` | Modal contact search |

## Environment Variables
Copy `.env.example` → `.env` and fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google Cloud Console OAuth2 credentials
- `GOOGLE_REDIRECT_URI` — `http://localhost:3000/auth/google/callback`
- `GOOGLE_DRIVE_FOLDER_ID` — ID from the Drive folder URL
- `SESSION_SECRET` — any random string
- `PORT` — default 3000
- `POLL_INTERVAL_SECONDS` — default 60

## Starting the App
```bash
# Backend (port 3000)
node server/index.js

# Frontend (port 5173) — in a separate terminal
cd client && npm run dev
```
Or use the Claude Code launch configurations (Backend + Frontend).

## First-Time Setup
1. `npm install` (project root)
2. `cd client && npm install`
3. Copy `.env.example` → `.env`, fill values
4. Visit `http://localhost:3000/auth/google` to connect the IB Google account
5. Confirm Drive, Gmail, People, Cloud Vision APIs are enabled in Google Cloud

## App Flow
1. Cron polls Drive folder every 60s for new PDFs
2. OCR extracts recipient from first page (UK/US postcode detection)
3. People API searches Google Contacts for best match
4. Gmail draft created with PDF attached
5. Web UI at `http://localhost:5173` shows pending items — staff clicks Send

## Notes
- `data/app.db` is gitignored (live data stays local)
- `.env` is gitignored (secrets stay local)
- Node.js 22 via Homebrew: `/opt/homebrew/opt/node@22/bin/node`
