require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { getAuthUrl, exchangeCode, isConnected } = require('./auth');
const { listNewPdfs, downloadPdf } = require('./drive');
const { processOcr } = require('./ocr');
const { uploadPdf } = require('./storage');
const { fetchWithDeadline, createStageGuard } = require('./runtime');
const { version } = require('../package.json');

const PORT = process.env.PORT || 3001;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const stageGuard = createStageGuard({ timeoutMs: Number(process.env.STAGE_TIMEOUT_MS || 120_000) });
const intervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
  throw new Error('POLL_INTERVAL_SECONDS must be at least 10');
}

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
let processedIdsLoaded = false;
let lastPollStartedAt = null;
let lastPollCompletedAt = null;
let lastSuccessfulPollAt = null;
let lastError = null;

// Fetch already-processed file IDs from CompanyBoard so we don't reprocess after redeploy
async function loadProcessedIds() {
  if (!INGEST_URL || !INGEST_SECRET) throw new Error('Ingest configuration missing');
  const baseUrl = INGEST_URL.replace(/\/ingest$/, '/processed-ids');
  const res = await fetchWithDeadline(baseUrl, {
    headers: { 'x-api-key': INGEST_SECRET },
  });
  if (res.ok) {
    const { ids } = await res.json();
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
      throw new Error('Invalid processed-ID response');
    }
    ids.forEach(id => processedFiles.add(id));
    processedIdsLoaded = true;
    console.log(`[init] Loaded ${ids.length} previously processed file IDs from CompanyBoard`);
  } else {
    throw new Error(`Failed to load processed IDs: ${res.status}`);
  }
}

// Post scan results to CompanyBoard.
// PDF is uploaded directly to Supabase Storage (bypasses Vercel's 4.5MB limit).
// Only metadata is sent to the ingest API.
async function postToIngest({ fileName, recipientName, category, ocrText, driveFileId, pdfBuffer }) {
  if (!INGEST_URL) {
    throw new Error('INGEST_URL not configured');
  }

  // Upload PDF directly to Supabase Storage (no size limit issues)
  let storagePath = null;
  if (pdfBuffer) {
    storagePath = await stageGuard.run('storage-upload', () => uploadPdf(pdfBuffer, fileName));
    if (!storagePath) {
      throw new Error('Failed to upload PDF to Supabase Storage');
    }
  }

  // Send only metadata to CompanyBoard ingest API (tiny JSON payload)
  return stageGuard.run('receiver-ingest', async () => {
    const res = await fetchWithDeadline(INGEST_URL, {
      method: 'POST',
      headers: {
        'x-api-key': INGEST_SECRET || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName,
        recipientName: recipientName || null,
        category: category || 'standard',
        ocrText: ocrText || null,
        driveFileId: driveFileId || null,
        storagePath, // pre-uploaded path in Supabase
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ingest failed (${res.status}): ${text}`);
    }

    const result = await res.json();
    if (result?.success !== true || typeof result.mailId !== 'string' || !result.mailId) {
      throw new Error('Receiver did not confirm ingestion');
    }
    return result;
  });
}

async function processSingleFile(file) {
  console.log(`[scan] Processing: ${file.name} (${file.id})`);

  let pdfBuffer = null;
  let ocrText = null;
  let recipient = null;
  let category = 'standard';

  try {
    // Download PDF from Drive (must succeed — no PDF = nothing to ingest)
    pdfBuffer = await stageGuard.run('drive-download', () => downloadPdf(file.id));
  } catch (err) {
    console.error(`[scan] Failed to download ${file.name}:`, err.message);
    return null; // Can't proceed without the file
  }

  // OCR — best effort. If it fails, we still ingest the PDF.
  try {
    const ocrResult = await stageGuard.run('ocr', () => processOcr(pdfBuffer));
    ocrText = ocrResult.ocrText;
    recipient = ocrResult.recipient;
    category = classifyMail(ocrText);
    console.log(`[scan] OCR complete | Category: ${category}`);
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
  if (isProcessing) {
    console.log('[poll] Previous run still in progress, skipping');
    return;
  }

  isProcessing = true;
  lastPollStartedAt = Date.now();
  try {
    if (!(await isConnected())) throw new Error('Google account is not connected');
    if (!processedIdsLoaded) {
      await stageGuard.run('load-processed-ids', loadProcessedIds);
    }
    console.log('[poll] Checking Drive...');
    const newFiles = await stageGuard.run('drive-list', () => listNewPdfs(processedFiles));
    if (newFiles.length === 0) {
      console.log('[poll] No new files');
    }
    let failedFiles = 0;
    if (newFiles.length) console.log(`[poll] Found ${newFiles.length} new file(s)`);
    for (const file of newFiles) {
      if (!(await processSingleFile(file))) failedFiles++;
    }
    if (failedFiles) throw new Error(`${failedFiles} file(s) failed; retrying on the next poll`);
    lastSuccessfulPollAt = Date.now();
    lastError = null;
    console.log('[poll] Completed successfully');
  } catch (err) {
    lastError = 'poll_failed';
    console.error('[poll] Drive poll error:', err.message);
  } finally {
    lastPollCompletedAt = Date.now();
    isProcessing = false;
  }
}

async function healthSnapshot() {
  const connected = await isConnected();
  const activeStage = stageGuard.snapshot();
  const stalled = activeStage && activeStage.elapsedMs >= activeStage.timeoutMs;
  const stale = !isProcessing && (!lastSuccessfulPollAt ||
    Date.now() - lastSuccessfulPollAt > Math.max(intervalSeconds * 3_000, 300_000));
  const healthy = connected && processedIdsLoaded && !lastError && !stalled && !stale;
  return {
    status: healthy ? 'ok' : stalled ? 'stalled' : !connected ? 'disconnected' : 'degraded',
    version, connected, processed: processedFiles.size, processing: isProcessing,
    activeStage, lastPollStartedAt, lastPollCompletedAt, lastSuccessfulPollAt, lastError,
  };
}

// Minimal HTTP server for health check + auth flow
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    const health = await healthSnapshot();
    res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
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
if (require.main === module) server.listen(PORT, () => {
  console.log(`\nIB Mail Scanner running on http://localhost:${PORT}`);

  // Schedule polling
  if (intervalSeconds >= 10) {
    const cronExpr = intervalSeconds < 60
      ? `*/${intervalSeconds} * * * * *`
      : `*/${Math.floor(intervalSeconds / 60)} * * * *`;

    cron.schedule(cronExpr, () => {
      pollDrive().catch(console.error);
    });
    console.log(`Polling every ${intervalSeconds}s`);
  }

  // pollDrive loads IDs before discovery, and retries safely if initialization fails.
  setTimeout(() => pollDrive().catch(console.error), 2000);
});

module.exports = { pollDrive, healthSnapshot };
