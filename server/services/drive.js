const { google } = require('googleapis');
const { getAuthClient } = require('../auth');
const db = require('../db');

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

async function listNewPdfs() {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const drive = google.drive({ version: 'v3', auth });
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  // Only process files created on or after the poll_since cutoff
  const sinceSetting = db.prepare("SELECT value FROM settings WHERE key = 'poll_since'").get();
  const since = sinceSetting?.value || null;

  // Check PDFs directly in the root folder
  const rootPdfs = await listPdfsInFolder(drive, rootFolderId, since);

  // Check PDFs inside daily subfolders created on or after the cutoff
  const subfolders = await listSubfolders(drive, rootFolderId, since);
  const subPdfs = (
    await Promise.all(subfolders.map((f) => listPdfsInFolder(drive, f.id, since)))
  ).flat();

  const allFiles = [...rootPdfs, ...subPdfs];

  // Also filter to files not yet in the database
  const newFiles = allFiles.filter((f) => {
    const existing = db.prepare('SELECT id FROM scans WHERE drive_file_id = ?').get(f.id);
    return !existing;
  });

  return newFiles;
}

async function downloadPdf(fileId) {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );

  return Buffer.from(res.data);
}

module.exports = { listNewPdfs, downloadPdf };
