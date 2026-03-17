/**
 * Core scan processing pipeline.
 * Shared by the background poller (index.js) and the retry endpoint (drafts.js).
 */
const db = require('../db');
const { downloadPdf } = require('./drive');
const { processOcr, extractRecipient } = require('./ocr');
const { findBestMatch } = require('./contacts');
const { createDraft, deleteDraft } = require('./gmail');

/**
 * (Re-)process a single scan record.
 * If the scan already has a draft, deletes it first.
 */
async function processScan(scanId) {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
  if (!scan) throw new Error('Scan not found');

  // Mark as processing
  db.prepare(`UPDATE scans SET status = 'processing', error_message = NULL, updated_at = unixepoch() WHERE id = ?`).run(scanId);

  try {
    // Clean up any existing draft
    if (scan.gmail_draft_id) {
      await deleteDraft(scan.gmail_draft_id).catch(() => {});
      db.prepare(`UPDATE scans SET gmail_draft_id = NULL WHERE id = ?`).run(scanId);
    }

    // 1. Download PDF from Drive
    const pdfBuffer = await downloadPdf(scan.drive_file_id);

    // 2. OCR
    const { ocrText, recipient } = await processOcr(pdfBuffer);
    console.log(`[pipeline] Recipient extracted: "${recipient}"`);

    // 3. Match contact — pass full OCR text so scorer can find extra clues
    const contact = await findBestMatch(recipient, ocrText);
    console.log(`[pipeline] Matched contact: ${contact ? `${contact.name} <${contact.email}>` : 'none'}`);

    if (!contact) {
      db.prepare(`
        UPDATE scans SET
          ocr_text = ?, recipient_raw = ?, status = 'no_match', updated_at = unixepoch()
        WHERE id = ?
      `).run(ocrText, recipient, scanId);
      return { status: 'no_match', recipient };
    }

    // 4. Create Gmail draft
    const draftId = await createDraft({
      contactName: contact.name,
      contactEmail: contact.email,
      fileName: scan.file_name,
      pdfBuffer,
    });

    // 5. Save result
    db.prepare(`
      UPDATE scans SET
        ocr_text       = ?,
        recipient_raw  = ?,
        contact_id     = ?,
        contact_name   = ?,
        contact_email  = ?,
        gmail_draft_id = ?,
        status         = 'pending',
        updated_at     = unixepoch()
      WHERE id = ?
    `).run(ocrText, recipient, contact.resourceName, contact.name, contact.email, draftId, scanId);

    return { status: 'pending', contact, draftId };
  } catch (err) {
    db.prepare(`
      UPDATE scans SET status = 'error', error_message = ?, updated_at = unixepoch() WHERE id = ?
    `).run(err.message, scanId);
    throw err;
  }
}

module.exports = { processScan };
