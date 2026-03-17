import { useState, useEffect, useRef } from 'react';

function getInitials(name) {
  return (name || '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

export default function ContactPicker({ onSelect, onClose, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (initialQuery) search(initialQuery);
  }, []);

  function search(q) {
    clearTimeout(debounceRef.current);
    if (!q.trim() || q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`, {
          credentials: 'include',
        });
        const data = await res.json();
        setResults(Array.isArray(data) ? data : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }

  function handleQueryChange(e) {
    setQuery(e.target.value);
    setSelected(null);
    search(e.target.value);
  }

  function handleConfirm() {
    if (selected) onSelect(selected);
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Change Contact</div>

        <div className="search-input-wrap">
          <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search contacts by name..."
            value={query}
            onChange={handleQueryChange}
          />
        </div>

        <div className="contact-list">
          {loading && (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
              <span className="spinner" />
            </div>
          )}

          {!loading && results.length === 0 && query.length >= 2 && (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: 13 }}>
              No contacts found for "{query}"
            </div>
          )}

          {!loading && results.length === 0 && query.length < 2 && (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: 13 }}>
              Type at least 2 characters to search
            </div>
          )}

          {results.map((c) => (
            <button
              key={c.resourceName}
              className={`contact-option ${selected?.resourceName === c.resourceName ? 'selected' : ''}`}
              onClick={() => setSelected(c)}
            >
              <div className="contact-avatar">{getInitials(c.name)}</div>
              <div className="contact-info">
                <div className="contact-name">{c.name || '(no name)'}</div>
                <div className="contact-email">{c.email}</div>
                {c.org && <div className="contact-email" style={{ fontSize: 11 }}>{c.org}</div>}
              </div>
            </button>
          ))}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!selected}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
