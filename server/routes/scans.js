const express = require('express');
const router = express.Router();
const db = require('../db');
const { downloadPdf } = require('../services/drive');

// GET /api/scans — list all scans, newest first
router.get('/', (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM scans';
  const params = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT 200';

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// GET /api/scans/stats/summary — count by status
// Must be registered before /:id so Express doesn't treat "stats" as an id
router.get('/stats/summary', (req, res) => {
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM scans GROUP BY status`).all();
  const stats = { pending: 0, sent: 0, skipped: 0, no_match: 0, processing: 0, deleted: 0, error: 0 };
  rows.forEach(r => { stats[r.status] = r.count; });

  // Today / yesterday counts (by updated_at)
  const now = new Date();
  const todayStart  = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd    = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const ystStart    = new Date(todayStart); ystStart.setDate(ystStart.getDate() - 1);
  const ystEnd      = new Date(todayEnd);   ystEnd.setDate(ystEnd.getDate() - 1);

  function periodStats(start, end) {
    const r = db.prepare(`SELECT status, COUNT(*) as count FROM scans WHERE updated_at >= ? AND updated_at <= ? GROUP BY status`)
      .all(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
    const s = { sent: 0, skipped: 0, no_match: 0, deleted: 0 };
    r.forEach(x => { if (s[x.status] !== undefined) s[x.status] = x.count; });
    return s;
  }

  stats.today     = periodStats(todayStart, todayEnd);
  stats.yesterday = periodStats(ystStart, ystEnd);

  res.json(stats);
});

// GET /api/scans/:id/thumbnail — return JPEG of first PDF page (for preview)
router.get('/:id/thumbnail', async (req, res) => {
  const row = db.prepare('SELECT drive_file_id FROM scans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { fromBuffer } = require('pdf2pic');
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');

  try {
    const pdfBuffer = await downloadPdf(row.drive_file_id);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
    try {
      const convert = fromBuffer(pdfBuffer, {
        density: 96, format: 'jpeg', width: 794, height: 1123,
        saveFilename: 'thumb', savePath: tmpDir,
      });
      await convert(1, { responseType: 'image' });
      // pdf2pic saves as thumb.1.jpeg or thumb.1.jpg depending on version
      const candidates = ['thumb.1.jpeg', 'thumb.1.jpg'];
      const found = candidates.map(f => path.join(tmpDir, f)).find(f => fs.existsSync(f));
      if (!found) throw new Error('Thumbnail file not found after conversion');
      const buffer = fs.readFileSync(found);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Thumbnail error:', err.message);
    res.status(500).json({ error: 'Failed to generate thumbnail' });
  }
});

// GET /api/scans/:id — single scan
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// GET /api/scans/:id/pdf — proxy the PDF from Google Drive
router.get('/:id/pdf', async (req, res) => {
  const row = db.prepare('SELECT drive_file_id, file_name FROM scans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  try {
    const buffer = await downloadPdf(row.drive_file_id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch PDF from Drive' });
  }
});

module.exports = router;
