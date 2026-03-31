const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

async function listPdfsInFolder(drive, folderId, since) {
  const sinceFilter = since ? ` and createdTime > '${since}'` : '';
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false${sinceFilter}`,
    fields: 'files(id, name, createdTime, size)',
    orderBy: 'createdTime desc',
    pageSize: 100,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return res.data.files || [];
}

async function listSubfolders(drive, folderId, since) {
  const sinceFilter = since ? ` and createdTime > '${since}'` : '';
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false${sinceFilter}`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 30,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return res.data.files || [];
}

// Look back window — how far back to check for files on each poll
// Default 7 days to catch anything missed. Deduplication via processedIds
// prevents reprocessing, so a wide window is safe.
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '7', 10);

async function listNewPdfs(processedIds) {
  const auth = await getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const drive = google.drive({ version: 'v3', auth });
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  // Always look back N days — processedIds handles dedup
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Check PDFs in root folder + subfolders
  const rootPdfs = await listPdfsInFolder(drive, rootFolderId, since);
  const subfolders = await listSubfolders(drive, rootFolderId, null); // subfolders may be older
  const subPdfs = (
    await Promise.all(subfolders.map((f) => listPdfsInFolder(drive, f.id, since)))
  ).flat();

  const allFiles = [...rootPdfs, ...subPdfs];
  console.log(`[drive] lookback=${LOOKBACK_DAYS}d | folder=${rootFolderId} | root=${rootPdfs.length} PDFs | subs=${subfolders.length} folders, ${subPdfs.length} PDFs`);

  // Filter out already-processed files
  const filtered = allFiles.filter(f => !processedIds.has(f.id));
  console.log(`[drive] ${allFiles.length} total, ${filtered.length} new`);
  return filtered;
}

async function downloadPdf(fileId) {
  const auth = await getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(res.data);
}

module.exports = { listNewPdfs, downloadPdf };
