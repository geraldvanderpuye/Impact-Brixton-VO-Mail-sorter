require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { getAuthClient, getAuthUrl, exchangeCode, isConnected } = require('./auth');
const { listNewPdfs, downloadPdf } = require('./drive');
const { processOcr, extractRecipient } = require('./ocr');

const PORT = process.env.PORT || 3001;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

// Sensitive keyword list — classify mail category
const SENSITIVE_KEYWORDS = [
  'hmrc', 'inland revenue', 'court', 'tribunal', 'solicitor', 'legal notice',
  'barclays', 'lloyds', 'natwest', 'hsbc', 'santander', 'halifax', 'monzo',
  'starling', 'revolut', 'nationwide', 'virgin money', 'bank statement',
  'statement of account', 'dvla', 'passport', 'companies house', 'vat',
  'national insurance', 'pension', 'enforcement', 'bailiff', 'ccj', 'debt collector',
  'tax', 'government', 'council tax', 'universal credit',
];

function classifyMail(ocrText) {
  const text = (ocrText || '').toLowerCase();
  return SENSITIVE_KEYWORDS.some(kw => text.includes(kw)) ? 'sensitive' : 'standard';
}

// Track processed Drive file IDs in memory — pre-populated from CompanyBoard on startup
const processedFiles = new Set();
let isProcessing = false;

// Fetch already-processed file IDs from CompanyBoard so we don't reprocess after redeploy
async function loadProcessedIds() {
  if (!INGEST_URL || !INGEST_SECRET) return;
  try {
    const baseUrl = INGEST_URL.replace(/\/ingest$/, '/processed-ids');
    const res = await fetch(baseUrl, {
      headers: { 'x-api-key': INGEST_SECRET },
    });
    if (res.ok) {
      const { ids } = await res.json();
      ids.forEach(id => processedFiles.add(id));
      console.log(`[init] Loaded ${ids.length} previously processed file IDs from CompanyBoard`);
    } else {
      console.warn(`[init] Failed to load processed IDs: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[init] Could not fetch processed IDs:`, err.message);
  }
}

// Post scan results to CompanyBoard using multipart form data
// (avoids Vercel's 4.5MB JSON body limit for large PDFs)
async function postToIngest({ fileName, recipientName, category, ocrText, driveFileId, pdfBuffer }) {
  if (!INGEST_URL) {
    console.error('[ingest] INGEST_URL not configured');
    return null;
  }

  const formData = new FormData();
  formData.append('fileName', fileName);
  if (recipientName) formData.append('recipientName', recipientName);
  formData.append('category', category || 'standard');
  if (ocrText) formData.append('ocrText', ocrText);
  if (driveFileId) formData.append('driveFileId', driveFileId);
  if (pdfBuffer) {
    formData.append('pdf', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  }

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'x-api-key': INGEST_SECRET || '' },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function processSingleFile(file) {
  console.log(`[scan] Processing: ${file.name} (${file.id})`);

  let pdfBuffer = null;
  let ocrText = null;
  let recipient = null;
  let category = 'standard';

  try {
    // Download PDF from Drive (must succeed — no PDF = nothing to ingest)
    pdfBuffer = await downloadPdf(file.id);
  } catch (err) {
    console.error(`[scan] Failed to download ${file.name}:`, err.message);
    return null; // Can't proceed without the file
  }

  // OCR — best effort. If it fails, we still ingest the PDF.
  try {
    const ocrResult = await processOcr(pdfBuffer);
    ocrText = ocrResult.ocrText;
    recipient = ocrResult.recipient;
    category = classifyMail(ocrText);
    console.log(`[scan] Recipient: "${recipient}" | Category: ${category}`);
  } catch (err) {
    console.error(`[scan] OCR failed for ${file.name} — ingesting without OCR:`, err.message);
  }

  // Post to CompanyBoard — the PDF MUST get into the mail sorter
  try {
    const result = await postToIngest({
      fileName: file.name,
      recipientName: recipient,
      category,
      ocrText,
      driveFileId: file.id,
      pdfBuffer,
    });

    processedFiles.add(file.id);
    console.log(`[scan] Posted to CompanyBoard: matched=${result?.matched}, mailId=${result?.mailId}`);
    return result;
  } catch (err) {
    console.error(`[scan] Ingest failed for ${file.name}:`, err.message);
    // Do NOT mark as processed — retry next poll
    return null;
  }
}

async function pollDrive() {
  if (!(await isConnected())) return;
  if (isProcessing) {
    console.log('[poll] Previous run still in progress, skipping');
    return;
  }

  isProcessing = true;
  try {
    console.log('[poll] Checking Drive...');
    const newFiles = await listNewPdfs(processedFiles);
    if (newFiles.length === 0) {
      console.log('[poll] No new files');
      return;
    }

    console.log(`[poll] Found ${newFiles.length} new file(s)`);
    for (const file of newFiles) {
      await processSingleFile(file);
    }
  } catch (err) {
    console.error('[poll] Drive poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

// Minimal HTTP server for health check + auth flow
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected: await isConnected(), processed: processedFiles.size }));
    return;
  }

  if (url.pathname === '/auth/google') {
    res.writeHead(302, { Location: getAuthUrl() });
    res.end();
    return;
  }

  if (url.pathname === '/auth/google/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('Missing code');
      return;
    }
    try {
      const email = await exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>Connected as ${email}</h2><p>Scanner will start polling automatically.</p>`);
      // Start polling after auth
      setTimeout(() => pollDrive().catch(console.error), 2000);
    } catch (err) {
      res.writeHead(500);
      res.end('Auth failed: ' + err.message);
    }
    return;
  }

  if (url.pathname === '/poll' && req.method === 'POST') {
    pollDrive().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Poll started' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  const connected = await isConnected();
  res.end(`
    <h2>IB Mail Scanner</h2>
    <p>Status: ${connected ? 'Connected' : '<a href="/auth/google">Connect Google Account</a>'}</p>
    <p>Processed: ${processedFiles.size} files this session</p>
  `);
});

// Start
server.listen(PORT, () => {
  console.log(`\nIB Mail Scanner running on http://localhost:${PORT}`);

  // Schedule polling
  const intervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);
  if (intervalSeconds >= 10) {
    const cronExpr = intervalSeconds < 60
      ? `*/${intervalSeconds} * * * * *`
      : `*/${Math.floor(intervalSeconds / 60)} * * * *`;

    cron.schedule(cronExpr, () => {
      pollDrive().catch(console.error);
    });
    console.log(`Polling every ${intervalSeconds}s`);
  }

  // Load processed IDs from CompanyBoard, then start polling
  isConnected().then(async (connected) => {
    if (connected) {
      await loadProcessedIds();
      console.log('Google account connected — starting initial poll');
      setTimeout(() => pollDrive().catch(console.error), 2000);
    } else {
      console.log(`Not authenticated — visit http://localhost:${PORT}/auth/google`);
    }
  });
});
