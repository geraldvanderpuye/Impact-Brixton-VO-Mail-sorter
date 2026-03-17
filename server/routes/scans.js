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
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM scans GROUP BY status
  `).all();

  const stats = { pending: 0, sent: 0, skipped: 0, no_match: 0, processing: 0 };
  rows.forEach((r) => { stats[r.status] = r.count; });
  res.json(stats);
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
