import { useState, useEffect } from 'react';
import StatusBadge from './StatusBadge.jsx';
import ContactPicker from './ContactPicker.jsx';

// Mirror the server defaults so the preview always matches what will be sent
const STANDARD_SUBJECT = 'Your Mail at IB';
const STANDARD_FOOTER = [
  'Regards',
  '- Please note this letter will be destroyed within 30 days',
  'IB Team',
  '- If you need any help with your membership please contact virtual@impactbrixton.com.',
].join('\n');

function buildDefaultBody(contactName) {
  const firstName = contactName ? contactName.trim().split(/\s+/)[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [greeting, '', 'You have received mail at your IB virtual office address.', '', STANDARD_FOOTER].join('\n');
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
  ].join('\n');
}

function getInitials(name) {
  return (name || '?')
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() || '')
    .join('');
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function EmailModal({ scan, onSend, onClose }) {
  const [subject, setSubject] = useState(STANDARD_SUBJECT);
  const [body, setBody]       = useState(() =>
    scan.mail_category === 'sensitive' ? buildSensitiveBody(scan.contact_name) : buildDefaultBody(scan.contact_name)
  );
  const [busy, setBusy]       = useState(false);

  async function handleSend() {
    setBusy(true);
    try {
      await onSend({ subject, body });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--email" onClick={e => e.stopPropagation()}>
        <div className="modal-title">✉️ Review &amp; Send Email</div>

        <div className="email-field">
          <label className="email-label">To</label>
          <div className="email-value-readonly">
            {scan.contact_name && <span className="email-to-name">{scan.contact_name}</span>}
            <span className="email-to-addr">&lt;{scan.contact_email}&gt;</span>
          </div>
        </div>

        <div className="email-field">
          <label className="email-label" htmlFor="email-subject">Subject</label>
          <input
            id="email-subject"
            className="email-input"
            value={subject}
            onChange={e => setSubject(e.target.value)}
          />
        </div>

        <div className="email-field">
          <label className="email-label" htmlFor="email-body">Body</label>
          <textarea
            id="email-body"
            className="email-textarea"
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={10}
          />
        </div>

        <div className="email-attachment-note">
          📎 <em>{scan.file_name}</em> will be attached automatically
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-success" onClick={handleSend} disabled={busy || !subject.trim()}>
            {busy ? <span className="spinner" /> : '✉️'}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ScanCard({ scan, isSelected, onUpdate, onToast }) {
  const [expanded, setExpanded]             = useState(false);
  const [busy, setBusy]                     = useState(null);
  const [showPicker, setShowPicker]         = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);

  // Auto-expand when selected from the Recent Arrivals tiles
  useEffect(() => {
    if (isSelected) setExpanded(true);
  }, [isSelected]);

  async function api(path, method = 'POST', body) {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function handleSend({ subject, body } = {}) {
    setShowEmailModal(false);
    setBusy('send');
    try {
      await api(`/api/drafts/${scan.id}/send`, 'POST', { subject, body });
      onToast('Email sent successfully', 'success');
      onUpdate(scan.id, { status: 'sent' });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry() {
    setBusy('retry');
    try {
      await api(`/api/drafts/${scan.id}/retry`);
      onToast('Scan reprocessed successfully', 'success');
      onUpdate(scan.id, { status: 'pending', error_message: null });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleSkip() {
    setBusy('skip');
    try {
      await api(`/api/drafts/${scan.id}/skip`);
      onToast('Scan skipped', null);
      onUpdate(scan.id, { status: 'skipped' });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRecover() {
    setBusy('recover');
    try {
      const result = await api(`/api/drafts/${scan.id}/recover`);
      onToast('Scan recovered — ready to send', 'success');
      onUpdate(scan.id, { status: 'pending', gmail_draft_id: result.draftId });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleTrash() {
    setBusy('trash');
    try {
      await api(`/api/drafts/${scan.id}/trash`);
      onToast('Moved to trash', null);
      onUpdate(scan.id, { status: 'deleted' });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore() {
    setBusy('restore');
    try {
      await api(`/api/drafts/${scan.id}/restore`);
      onToast('Restored to skipped', 'success');
      onUpdate(scan.id, { status: 'skipped' });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleReassign(contact) {
    setShowPicker(false);
    setBusy('reassign');
    try {
      const result = await api(`/api/drafts/${scan.id}/reassign`, 'POST', {
        contactId: contact.resourceName,
        contactName: contact.name,
        contactEmail: contact.email,
      });
      onToast(`Draft updated for ${contact.name}`, 'success');
      onUpdate(scan.id, {
        contact_id:     contact.resourceName,
        contact_name:   contact.name,
        contact_email:  contact.email,
        gmail_draft_id: result.draftId,
        status: 'pending',
      });
    } catch (err) {
      onToast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const isReadOnly = scan.status === 'sent';
  const hasContact = !!scan.contact_email;
  const isNoMatch = scan.status === 'no_match';
  const displayName = scan.contact_name
    || (isNoMatch ? 'No match found' : scan.recipient_raw?.split('\n')[0] || '—');
  const detectedMeta = scan.recipient_raw?.split('\n').slice(0, 2).join(' · ') || scan.file_name || '';

  return (
    <>
      <div data-scan-id={scan.id} className={`scan-row ${expanded ? 'scan-row--open' : ''} ${isNoMatch ? 'scan-row--no-match' : ''} ${scan.status === 'error' ? 'scan-row--error' : ''}`}>

        {/* Compact summary row — click to expand */}
        <div className="scan-row-summary" onClick={() => setExpanded(e => !e)}>
          <div className="scan-row-avatar" style={isNoMatch ? { background: 'var(--warning)' } : {}}>
            {getInitials(scan.contact_name || scan.recipient_raw)}
          </div>
          <div className="scan-row-info">
            <div className={`scan-row-name ${isNoMatch ? 'scan-row-name--warn' : ''}`}>{displayName}</div>
            {detectedMeta && (
              <div className="scan-row-meta">{detectedMeta}</div>
            )}
          </div>
          <div className="scan-row-right">
            <StatusBadge status={scan.status} />
            <span className="scan-row-time">{formatTime(scan.created_at)}</span>
            <span className={`scan-row-chevron ${expanded ? 'scan-row-chevron--open' : ''}`}>▶</span>
          </div>
        </div>

        {/* Expanded panel */}
        {expanded && (
          <div className="scan-expand">
            {/* PDF preview */}
            <div className="scan-expand-preview">
              <a href={`/api/scans/${scan.id}/pdf`} target="_blank" rel="noreferrer" title="Click to open full PDF">
                <img
                  src={`/api/scans/${scan.id}/thumbnail`}
                  alt="Mail preview"
                  className="scan-thumbnail"
                  onError={e => { e.target.style.display = 'none'; }}
                />
              </a>
              <div className="scan-expand-filename" title={scan.file_name}>
                📄 {scan.file_name}
              </div>
            </div>

            {/* Details + actions */}
            <div className="scan-expand-body">
              <div className="info-row">
                <div className="info-label">Matched to</div>
                <div className="info-value">
                  {hasContact ? (
                    <div className="contact-display">
                      <div className="contact-avatar">{getInitials(scan.contact_name)}</div>
                      <div className="contact-info">
                        <div className="contact-name">{scan.contact_name}</div>
                        <div className="contact-email">{scan.contact_email}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="alert alert-warning">No contact matched — assign one below</div>
                  )}
                </div>
              </div>

              {scan.mail_category && (
                <div className="info-row">
                  <div className="info-label">Category</div>
                  <div className="info-value">
                    <span className={`category-badge category-badge--${scan.mail_category}`}>
                      {scan.mail_category === 'sensitive' ? '🔒 Sensitive' : '📬 Standard'}
                    </span>
                  </div>
                </div>
              )}

              {scan.recipient_raw && (
                <div className="info-row">
                  <div className="info-label">Detected</div>
                  <div className="info-value" style={{ fontSize: 13, whiteSpace: 'pre-line' }}>
                    {scan.recipient_raw}
                  </div>
                </div>
              )}

              {scan.error_message && (
                <div className="alert alert-error">
                  <div style={{ marginBottom: 8 }}>{scan.error_message}</div>
                  <button className="btn btn-ghost btn-sm" onClick={handleRetry} disabled={!!busy}>
                    {busy === 'retry' ? <span className="spinner" /> : '🔄'}
                    Retry
                  </button>
                </div>
              )}

              {scan.ocr_text && (
                <details style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  <summary style={{ cursor: 'pointer', userSelect: 'none' }}>OCR text</summary>
                  <div className="info-value ocr-text" style={{ marginTop: 6 }}>{scan.ocr_text}</div>
                </details>
              )}

              {scan.status === 'deleted' ? (
                <div className="scan-actions">
                  <button className="btn btn-ghost" onClick={handleRestore} disabled={!!busy}>
                    {busy === 'restore' ? <span className="spinner" /> : '♻️'} Restore
                  </button>
                </div>
              ) : !isReadOnly && (
                <div className="scan-actions">
                  {hasContact && scan.gmail_draft_id && (
                    <button className="btn btn-success" onClick={() => setShowEmailModal(true)} disabled={!!busy}>
                      {busy === 'send' ? <span className="spinner" /> : '✉️'} Send Email
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={() => setShowPicker(true)} disabled={!!busy}>
                    {busy === 'reassign' ? <span className="spinner" /> : '👤'}
                    {hasContact ? 'Change Contact' : 'Assign Contact'}
                  </button>
                  {scan.status === 'skipped' ? (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={handleRecover} disabled={!!busy}>
                        {busy === 'recover' ? <span className="spinner" /> : '↩️'} Recover
                      </button>
                      <button className="btn btn-danger-ghost btn-sm" onClick={handleTrash} disabled={!!busy}>
                        {busy === 'trash' ? <span className="spinner" /> : '🗑️'} Delete
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-danger-ghost btn-sm" onClick={handleSkip} disabled={!!busy}>
                      {busy === 'skip' ? <span className="spinner" /> : null} Skip
                    </button>
                  )}
                </div>
              )}

              {scan.status === 'sent' && (
                <div style={{ color: 'var(--success)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  ✓ Email sent to {scan.contact_email}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showEmailModal && (
        <EmailModal
          scan={scan}
          onSend={handleSend}
          onClose={() => setShowEmailModal(false)}
        />
      )}

      {showPicker && (
        <ContactPicker
          initialQuery={scan.recipient_raw?.split('\n')[0] || ''}
          onSelect={handleReassign}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
