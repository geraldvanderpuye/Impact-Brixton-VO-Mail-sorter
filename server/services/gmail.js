const { google } = require('googleapis');
const { getAuthClient } = require('../auth');

const STANDARD_SUBJECT = 'Your Mail at IB';

const STANDARD_FOOTER = [
  'Regards',
  '- Please note this letter will be destroyed within 30 days',
  'IB Team',
  '- If you need any help with your membership please contact virtual@impactbrixton.com.',
].join('\r\n');

function buildDefaultBody(contactName) {
  const firstName = contactName ? contactName.trim().split(/\s+/)[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [greeting, '', 'You have received mail at your IB virtual office address.', '', STANDARD_FOOTER].join('\r\n');
}

function buildSensitiveBody(contactName) {
  const firstName = contactName ? contactName.trim().split(/\s+/)[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [
    greeting, '',
    'You have received what appears to be sensitive mail (banking, legal or government correspondence) at your IB virtual office address.',
    '',
    'Please let us know when you plan to come and collect it, or we can arrange forwarding for a one-off fee of £2.50.',
    '',
    'Simply reply to this email to arrange forwarding.',
    '',
    STANDARD_FOOTER,
  ].join('\r\n');
}

function buildMimeMessage({ to, toName, subject, body, pdfBuffer, pdfFileName }) {
  const boundary = `----=_Part_${Date.now()}`;

  const header = [
    `MIME-Version: 1.0`,
    `To: ${toName ? `"${toName}" <${to}>` : to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
  ].join('\r\n');

  const textPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
    ``,
  ].join('\r\n');

  const attachmentPart = [
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFileName}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${pdfFileName}"`,
    ``,
    pdfBuffer.toString('base64').match(/.{1,76}/g).join('\r\n'),
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  // RFC 2822 requires a blank line (CRLF) between headers and body
  const raw = header + '\r\n' + textPart + attachmentPart;
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// subject / body are optional overrides; defaults are applied if omitted
async function createDraft({ contactName, contactEmail, fileName, pdfBuffer, subject, body, mailCategory }) {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildMimeMessage({
    to: contactEmail,
    toName: contactName,
    subject: subject || STANDARD_SUBJECT,
    body: body || (mailCategory === 'sensitive' ? buildSensitiveBody(contactName) : buildDefaultBody(contactName)),
    pdfBuffer,
    pdfFileName: fileName,
  });

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  return res.data.id;
}

async function sendDraft(draftId) {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draftId },
  });
}

async function deleteDraft(draftId) {
  const auth = getAuthClient();
  if (!auth) throw new Error('Not authenticated');

  const gmail = google.gmail({ version: 'v1', auth });

  try {
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });
  } catch (err) {
    // Draft may have already been sent/deleted — not fatal
    console.warn(`Could not delete draft ${draftId}:`, err.message);
  }
}

module.exports = { createDraft, sendDraft, deleteDraft, STANDARD_SUBJECT, buildDefaultBody, buildSensitiveBody };
