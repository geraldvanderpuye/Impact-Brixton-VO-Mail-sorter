const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendDraft, deleteDraft, createDraft } = require('../services/gmail');
const { downloadPdf } = require('../services/drive');
const { processScan } = require('../services/pipeline');
const { extractRecipient } = require('../services/ocr');
const { findBestMatch } = require('../services/contacts');

// POST /api/drafts/:id/send — send the Gmail draft
// Accepts optional { subject, body } to rebuild the draft with edited content before sending.
router.post('/:id/send', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (!scan.gmail_draft_id) return res.status(400).json({ error: 'No draft to send' });
  if (scan.status === 'sent') return res.status(400).json({ error: 'Already sent' });

  const { subject, body } = req.body || {};

  try {
    if (subject || body) {
      // User edited the email — delete old draft, rebuild with custom content, then send
      await deleteDraft(scan.gmail_draft_id);
      const pdfBuffer = await downloadPdf(scan.drive_file_id);
      const newDraftId = await createDraft({
        contactName:  scan.contact_name,
        contactEmail: scan.contact_email,
        fileName:     scan.file_name,
        pdfBuffer,
        subject,
        body,
      });
      await sendDraft(newDraftId);
    } else {
      await sendDraft(scan.gmail_draft_id);
    }

    db.prepare(`
      UPDATE scans SET status = 'sent', updated_at = unixepoch() WHERE id = ?
    `).run(scan.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Send draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/skip — mark as skipped, delete the draft
router.post('/:id/skip', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });

  try {
    if (scan.gmail_draft_id) {
      await deleteDraft(scan.gmail_draft_id);
    }
    db.prepare(`
      UPDATE scans SET status = 'skipped', gmail_draft_id = NULL, updated_at = unixepoch() WHERE id = ?
    `).run(scan.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Skip error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/reassign — change the contact and recreate the draft
router.post('/:id/reassign', async (req, res) => {
  const { contactId, contactName, contactEmail } = req.body;
  if (!contactEmail) return res.status(400).json({ error: 'contactEmail required' });

  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });

  try {
    // Delete old draft if exists
    if (scan.gmail_draft_id) {
      await deleteDraft(scan.gmail_draft_id);
    }

    // Download the PDF from Drive
    const pdfBuffer = await downloadPdf(scan.drive_file_id);

    // Create new draft for the correct contact
    const draftId = await createDraft({
      contactName,
      contactEmail,
      fileName: scan.file_name,
      pdfBuffer,
    });

    db.prepare(`
      UPDATE scans SET
        contact_id     = ?,
        contact_name   = ?,
        contact_email  = ?,
        gmail_draft_id = ?,
        status         = 'pending',
        updated_at     = unixepoch()
      WHERE id = ?
    `).run(contactId || null, contactName || null, contactEmail, draftId, scan.id);

    res.json({ success: true, draftId });
  } catch (err) {
    console.error('Reassign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/recover — recover a skipped scan back to pending
router.post('/:id/recover', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (scan.status !== 'skipped') return res.status(400).json({ error: 'Only skipped scans can be recovered' });
  if (!scan.contact_email) return res.status(400).json({ error: 'No contact assigned — reassign first' });

  try {
    const pdfBuffer = await downloadPdf(scan.drive_file_id);
    const draftId = await createDraft({
      contactName:  scan.contact_name,
      contactEmail: scan.contact_email,
      fileName:     scan.file_name,
      pdfBuffer,
      mailCategory: scan.mail_category,
    });
    db.prepare(`UPDATE scans SET status = 'pending', gmail_draft_id = ?, updated_at = unixepoch() WHERE id = ?`).run(draftId, scan.id);
    res.json({ success: true, draftId });
  } catch (err) {
    console.error('Recover error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/trash — move to recoverable trash
router.post('/:id/trash', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (scan.status === 'sent') return res.status(400).json({ error: 'Cannot trash a sent item' });

  try {
    if (scan.gmail_draft_id) await deleteDraft(scan.gmail_draft_id).catch(() => {});
    db.prepare(`
      UPDATE scans SET status = 'deleted', gmail_draft_id = NULL, deleted_at = unixepoch(), updated_at = unixepoch() WHERE id = ?
    `).run(scan.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Trash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/restore — restore from trash to skipped
router.post('/:id/restore', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (scan.status !== 'deleted') return res.status(400).json({ error: 'Only deleted scans can be restored' });

  try {
    db.prepare(`
      UPDATE scans SET status = 'skipped', deleted_at = NULL, updated_at = unixepoch() WHERE id = ?
    `).run(scan.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/save-override — remember the confirmed contact for this recipient
router.post('/:id/save-override', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (!scan.recipient_raw || !scan.contact_email) return res.status(400).json({ error: 'Missing recipient or contact' });

  const key = scan.recipient_raw.trim().toLowerCase();
  db.prepare(`
    INSERT INTO contact_overrides (recipient_key, contact_id, contact_name, contact_email, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(recipient_key) DO UPDATE SET
      contact_id = excluded.contact_id, contact_name = excluded.contact_name,
      contact_email = excluded.contact_email, updated_at = unixepoch()
  `).run(key, scan.contact_id || null, scan.contact_name, scan.contact_email);

  res.json({ success: true });
});

// POST /api/drafts/:id/retry — reprocess a scan (OCR + match + draft) from scratch
router.post('/:id/retry', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (scan.status === 'sent') return res.status(400).json({ error: 'Already sent' });

  try {
    const result = await processScan(scan.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Retry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/:id/rematch
// Re-extract recipient from stored OCR text + re-run contact matching + recreate draft.
// Faster than /retry because it skips re-downloading the PDF and re-running OCR.
router.post('/:id/rematch', async (req, res) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  if (scan.status === 'sent') return res.status(400).json({ error: 'Already sent' });
  if (!scan.ocr_text) return res.status(400).json({ error: 'No OCR text stored — use retry instead' });

  try {
    // Re-extract recipient from stored OCR text using improved logic
    const recipient = extractRecipient(scan.ocr_text);
    console.log(`[rematch] scan ${scan.id} re-extracted: "${recipient}"`);

    // Re-run contact matching with full OCR text as extra clues
    const contact = await findBestMatch(recipient, scan.ocr_text);
    console.log(`[rematch] scan ${scan.id} contact: ${contact ? `${contact.name} <${contact.email}>` : 'none'}`);

    // Delete old draft if any
    if (scan.gmail_draft_id) {
      await deleteDraft(scan.gmail_draft_id).catch(() => {});
    }

    if (!contact) {
      db.prepare(`
        UPDATE scans SET recipient_raw = ?, status = 'no_match',
          gmail_draft_id = NULL, contact_id = NULL, contact_name = NULL,
          contact_email = NULL, updated_at = unixepoch()
        WHERE id = ?
      `).run(recipient, scan.id);
      return res.json({ success: true, status: 'no_match', recipient });
    }

    // Download PDF and create new draft
    const pdfBuffer = await downloadPdf(scan.drive_file_id);
    const draftId   = await createDraft({
      contactName:  contact.name,
      contactEmail: contact.email,
      fileName:     scan.file_name,
      pdfBuffer,
    });

    db.prepare(`
      UPDATE scans SET
        recipient_raw  = ?, contact_id = ?, contact_name = ?,
        contact_email  = ?, gmail_draft_id = ?, status = 'pending',
        updated_at     = unixepoch()
      WHERE id = ?
    `).run(recipient, contact.resourceName, contact.name, contact.email, draftId, scan.id);

    res.json({ success: true, status: 'pending', contact, draftId });
  } catch (err) {
    console.error('Rematch error:', err.message);
    db.prepare(`UPDATE scans SET status = 'error', error_message = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(err.message, scan.id);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drafts/rematch-all
// Re-run rematch on all scans that have stored OCR text (skips sent scans).
router.post('/rematch-all', async (req, res) => {
  const scans = db.prepare(`
    SELECT id FROM scans WHERE ocr_text IS NOT NULL AND status != 'sent'
  `).all();

  res.json({ started: true, count: scans.length });

  // Run in background
  (async () => {
    for (const { id } of scans) {
      try {
        const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
        const recipient = extractRecipient(scan.ocr_text);
        const contact   = await findBestMatch(recipient, scan.ocr_text);

        if (scan.gmail_draft_id) {
          await deleteDraft(scan.gmail_draft_id).catch(() => {});
        }

        if (!contact) {
          db.prepare(`
            UPDATE scans SET recipient_raw = ?, status = 'no_match',
              gmail_draft_id = NULL, contact_id = NULL, contact_name = NULL,
              contact_email = NULL, updated_at = unixepoch()
            WHERE id = ?
          `).run(recipient, id);
          console.log(`[rematch-all] scan ${id}: no_match (recipient: "${recipient}")`);
          continue;
        }

        const pdfBuffer = await downloadPdf(scan.drive_file_id);
        const draftId   = await createDraft({
          contactName:  contact.name,
          contactEmail: contact.email,
          fileName:     scan.file_name,
          pdfBuffer,
        });

        db.prepare(`
          UPDATE scans SET
            recipient_raw = ?, contact_id = ?, contact_name = ?,
            contact_email = ?, gmail_draft_id = ?, status = 'pending',
            updated_at = unixepoch()
          WHERE id = ?
        `).run(recipient, contact.resourceName, contact.name, contact.email, draftId, id);

        console.log(`[rematch-all] scan ${id}: matched "${contact.name}"`);
      } catch (err) {
        console.error(`[rematch-all] scan ${id} error:`, err.message);
        db.prepare(`UPDATE scans SET status = 'error', error_message = ?, updated_at = unixepoch() WHERE id = ?`)
          .run(err.message, id);
      }
    }
    console.log('[rematch-all] done');
  })();
});

module.exports = router;
