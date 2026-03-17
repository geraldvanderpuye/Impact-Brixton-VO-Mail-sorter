/**
 * Core scan processing pipeline.
 * Shared by the background poller (index.js) and the retry endpoint (drafts.js).
 */
const db = require('../db');
const { downloadPdf } = require('./drive');
const { processOcr, extractRecipient } = require('./ocr');
const { findBestMatch } = require('./contacts');
const { createDraft, deleteDraft } = require('./gmail');

const SENSITIVE_KEYWORDS = [
  'hmrc','inland revenue','court','tribunal','solicitor','legal notice',
  'barclays','lloyds','natwest','hsbc','santander','halifax','monzo',
  'starling','revolut','nationwide','virgin money','bank statement',
  'statement of account','dvla','passport','companies house','vat',
  'national insurance','pension','enforcement','bailiff','ccj','debt collector',
  'tax','government','council tax','universal credit',
];

function classifyMail(ocrText) {
  const text = (ocrText || '').toLowerCase();
  if (SENSITIVE_KEYWORDS.some(kw => text.includes(kw))) return 'sensitive';
  return 'standard';
}

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

    const mailCategory = classifyMail(ocrText);

    // 3. Match contact — check override first, then fall back to findBestMatch
    const overrideKey = (recipient || '').trim().toLowerCase();
    const override = overrideKey ? db.prepare('SELECT * FROM contact_overrides WHERE recipient_key = ?').get(overrideKey) : null;
    let contact;
    if (override) {
      contact = { resourceName: override.contact_id, name: override.contact_name, email: override.contact_email };
      console.log(`[pipeline] Using contact override for "${recipient}": ${contact.name}`);
    } else {
      contact = await findBestMatch(recipient, ocrText);
    }
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
      mailCategory,
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
        mail_category  = ?,
        status         = 'pending',
        updated_at     = unixepoch()
      WHERE id = ?
    `).run(ocrText, recipient, contact.resourceName, contact.name, contact.email, draftId, mailCategory, scanId);

    return { status: 'pending', contact, draftId };
  } catch (err) {
    db.prepare(`
      UPDATE scans SET status = 'error', error_message = ?, updated_at = unixepoch() WHERE id = ?
    `).run(err.message, scanId);
    throw err;
  }
}

module.exports = { processScan };
