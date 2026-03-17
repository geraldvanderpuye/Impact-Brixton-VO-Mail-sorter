const LABELS = {
  pending:    { icon: '●', text: 'Pending Review' },
  sent:       { icon: '✓', text: 'Sent' },
  skipped:    { icon: '—', text: 'Skipped' },
  no_match:   { icon: '?', text: 'No Match Found' },
  processing: { icon: '◌', text: 'Processing' },
  error:      { icon: '!', text: 'Error' },
};

export default function StatusBadge({ status }) {
  const { icon, text } = LABELS[status] || { icon: '·', text: status };
  return (
    <span className={`status-badge ${status}`}>
      <span>{icon}</span>
      {text}
    </span>
  );
}
