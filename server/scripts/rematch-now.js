#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const db = require('../db');
const { extractRecipient } = require('../services/ocr');
const { findBestMatch } = require('../services/contacts');
const { createDraft, deleteDraft } = require('../services/gmail');
const { downloadPdf } = require('../services/drive');

const scans = db.prepare("SELECT * FROM scans WHERE ocr_text IS NOT NULL AND status != 'sent'").all();
console.log('Rematching', scans.length, 'scans...');

(async () => {
  for (const scan of scans) {
    try {
      const recipient = extractRecipient(scan.ocr_text);
      const contact = await findBestMatch(recipient, scan.ocr_text);
      const contactStr = contact ? `${contact.name} <${contact.email}>` : 'no_match';
      console.log(`Scan ${scan.id}: "${recipient}" -> ${contactStr}`);

      if (scan.gmail_draft_id) {
        await deleteDraft(scan.gmail_draft_id).catch(() => {});
      }

      if (!contact) {
        db.prepare("UPDATE scans SET recipient_raw=?, status='no_match', gmail_draft_id=NULL, contact_id=NULL, contact_name=NULL, contact_email=NULL, updated_at=unixepoch() WHERE id=?")
          .run(recipient, scan.id);
        continue;
      }

      const pdfBuffer = await downloadPdf(scan.drive_file_id);
      const draftId = await createDraft({
        contactName: contact.name,
        contactEmail: contact.email,
        fileName: scan.file_name,
        pdfBuffer,
      });

      db.prepare("UPDATE scans SET recipient_raw=?, contact_id=?, contact_name=?, contact_email=?, gmail_draft_id=?, status='pending', updated_at=unixepoch() WHERE id=?")
        .run(recipient, contact.resourceName, contact.name, contact.email, draftId, scan.id);

    } catch (err) {
      console.error(`Scan ${scan.id} error:`, err.message);
      db.prepare("UPDATE scans SET status='error', error_message=?, updated_at=unixepoch() WHERE id=?")
        .run(err.message, scan.id);
    }
  }
  console.log('Done.');
  process.exit(0);
})();
