import { useState, useEffect, useCallback, useRef } from 'react';
import ScanCard from '../components/ScanCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

const TABS = [
  { key: 'pending', label: 'Pending', statusFilter: ['pending', 'no_match', 'processing', 'error'] },
  { key: 'sent',    label: 'Sent',    statusFilter: ['sent'] },
  { key: 'skipped', label: 'Skipped', statusFilter: ['skipped'] },
];

const TIME_PILLS = [
  { key: 'all',   label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year',  label: 'This Year' },
];

function getTimeBounds(period, specificDate) {
  const now = new Date();
  if (period === 'date' && specificDate) {
    const d = new Date(specificDate + 'T00:00:00');
    return { start: d.getTime() / 1000, end: d.getTime() / 1000 + 86399 };
  }
  if (period === 'today') {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    return { start: s.getTime() / 1000, end: e.getTime() / 1000 };
  }
  if (period === 'week') {
    const day = now.getDay();
    const mon = new Date(now);
    mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    return { start: mon.getTime() / 1000, end: sun.getTime() / 1000 };
  }
  if (period === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start: s.getTime() / 1000, end: e.getTime() / 1000 };
  }
  if (period === 'year') {
    const s = new Date(now.getFullYear(), 0, 1);
    const e = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { start: s.getTime() / 1000, end: e.getTime() / 1000 };
  }
  return { start: null, end: null };
}

function groupScans(scans, period) {
  if (period === 'today' || period === 'date') return null;
  const map = new Map();
  scans.forEach(scan => {
    const d = new Date(scan.created_at * 1000);
    let key, label;
    if (period === 'week' || period === 'month' || period === 'all') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    }
    if (!map.has(key)) map.set(key, { key, label, scans: [] });
    map.get(key).scans.push(scan);
  });
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, v]) => v);
}

function getPeriodLabel(period, specificDate) {
  const now = new Date();
  if (period === 'all')   return 'All';
  if (period === 'today') return 'Today — ' + now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (period === 'week')  return 'This Week';
  if (period === 'month') return 'This Month — ' + now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  if (period === 'year')  return 'This Year — ' + now.getFullYear();
  if (period === 'date' && specificDate) {
    return new Date(specificDate + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  return '';
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function formatTileTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function SubGroup({ label, scans, selectedScanId, onUpdate, onToast }) {
  const [open, setOpen] = useState(false);

  // Auto-open if the selected scan lives in this group
  useEffect(() => {
    if (selectedScanId && scans.some(s => s.id === selectedScanId)) setOpen(true);
  }, [selectedScanId, scans]);

  return (
    <div className="sub-group">
      <div className="sub-group-header" onClick={() => setOpen(o => !o)}>
        <div className="sub-group-title">
          <span className="period-chevron" style={{ transform: open ? 'rotate(90deg)' : '' }}>▶</span>
          {label}
        </div>
        <span className="period-count">{scans.length} item{scans.length !== 1 ? 's' : ''}</span>
      </div>
      {open && (
        <div className="period-group-body sub-group-body">
          {scans.map(scan => (
            <ScanCard
              key={scan.id}
              scan={scan}
              isSelected={scan.id === selectedScanId}
              onUpdate={onUpdate}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ authStatus }) {
  const [scans, setScans]                   = useState([]);
  const [stats, setStats]                   = useState({});
  const [activeTab, setActiveTab]           = useState('pending');
  const [timePeriod, setTimePeriod]         = useState('all');
  const [specificDate, setSpecificDate]     = useState('');
  const [search, setSearch]                 = useState('');
  const [polling, setPolling]               = useState(false);
  const [rematching, setRematching]         = useState(false);
  const [loading, setLoading]               = useState(true);
  const [toasts, setToasts]                 = useState([]);
  const [selectedScanId, setSelectedScanId] = useState(null);
  const toastId = useRef(0);

  const fetchScans = useCallback(async () => {
    try {
      const [scansRes, statsRes] = await Promise.all([
        fetch('/api/scans', { credentials: 'include' }).then(r => r.json()),
        fetch('/api/scans/stats/summary', { credentials: 'include' }).then(r => r.json()),
      ]);
      if (Array.isArray(scansRes)) setScans(scansRes);
      if (statsRes && typeof statsRes === 'object') setStats(statsRes);
    } catch (err) {
      console.error('Failed to fetch scans:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScans();
    const interval = setInterval(fetchScans, 30000);
    return () => clearInterval(interval);
  }, [fetchScans]);

  function selectScan(scan) {
    setSelectedScanId(scan.id);
    // Navigate to the right tab and clear filters so the scan is visible
    const tab = TABS.find(t => t.statusFilter.includes(scan.status));
    if (tab) setActiveTab(tab.key);
    setTimePeriod('all');
    setSpecificDate('');
    setSearch('');
    // Scroll to the card after React re-renders
    setTimeout(() => {
      const el = document.querySelector(`[data-scan-id="${scan.id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  }

  async function triggerPoll() {
    setPolling(true);
    try {
      await fetch('/api/poll', { method: 'POST', credentials: 'include' });
      setTimeout(() => fetchScans().finally(() => setPolling(false)), 3000);
    } catch {
      setPolling(false);
    }
  }

  async function triggerRematchAll() {
    setRematching(true);
    addToast('Re-matching all scans…');
    try {
      const res = await fetch('/api/drafts/rematch-all', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      addToast(`Re-matching ${data.count} scan(s) in background`);
      let checks = 0;
      const timer = setInterval(() => {
        fetchScans();
        if (++checks >= 6) { clearInterval(timer); setRematching(false); }
      }, 5000);
    } catch {
      addToast('Rematch failed', 'error');
      setRematching(false);
    }
  }

  function addToast(message, type = null) {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }

  function handleUpdate(scanId, patch) {
    setScans(prev => prev.map(s => s.id === scanId ? { ...s, ...patch } : s));
    fetch('/api/scans/stats/summary', { credentials: 'include' })
      .then(r => r.json())
      .then(data => typeof data === 'object' && setStats(data))
      .catch(() => {});
  }

  // 4 most recently received scans (quick-access tiles, always visible regardless of tab/filter)
  const recentScans = [...scans].sort((a, b) => b.created_at - a.created_at).slice(0, 4);

  // Filter: status tab
  const activeTabDef = TABS.find(t => t.key === activeTab);
  let filtered = scans.filter(s => activeTabDef.statusFilter.includes(s.status));

  // Filter: time
  const activePeriod = specificDate ? 'date' : timePeriod;
  const { start, end } = getTimeBounds(activePeriod, specificDate);
  if (start !== null) {
    filtered = filtered.filter(s => s.created_at >= start && s.created_at <= end);
  }

  // Filter: search
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(s =>
      (s.contact_name || '').toLowerCase().includes(q) ||
      (s.recipient_raw || '').toLowerCase().includes(q) ||
      (s.file_name || '').toLowerCase().includes(q)
    );
  }

  const pendingCount = (stats.pending || 0) + (stats.no_match || 0) + (stats.error || 0);
  const groups = groupScans(filtered, activePeriod);
  const periodLabel = getPeriodLabel(activePeriod, specificDate);

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <img src="/logo.png" alt="IB" style={{ width: 28, height: 28, borderRadius: 6 }} />
          IB Virtual Office Mail Sorter
        </div>
        <div className="header-right">
          {authStatus?.email && <span className="header-email">{authStatus.email}</span>}
          <button
            className="btn btn-ghost btn-sm"
            onClick={triggerRematchAll}
            disabled={rematching}
            title="Re-extract recipients and re-match all scans to contacts"
          >
            {rematching ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '🔄'} Rematch All
          </button>
          <button className="btn-icon" onClick={fetchScans} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
              <path d="M8 16H3v5"/>
            </svg>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            fetch('/auth/logout', { method: 'POST', credentials: 'include' }).then(() => window.location.reload());
          }}>
            Sign out
          </button>
        </div>
      </header>

      <main className="main">

        {/* Welcome Banner */}
        <div className="welcome-banner">
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'var(--primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div>
            <div className="welcome-banner-text">Welcome Host</div>
            <div className="welcome-banner-sub">
              {pendingCount > 0
                ? `${pendingCount} item${pendingCount !== 1 ? 's' : ''} waiting for review`
                : 'All caught up — no pending mail'}
            </div>
          </div>
        </div>

        {/* Search + Date */}
        <div className="search-row">
          <div className="search-input-wrap" style={{ flex: 1 }}>
            <span className="search-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
            </span>
            <input
              className="search-input"
              placeholder="Search by customer name, business or file…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <label className={`date-pick-btn ${specificDate ? 'has-date' : ''}`}>
            📅{' '}
            {specificDate
              ? new Date(specificDate + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
              : 'Pick a date'}
            {specificDate && (
              <span
                className="date-clear"
                onClick={e => { e.preventDefault(); e.stopPropagation(); setSpecificDate(''); }}
              >✕</span>
            )}
            <input
              type="date"
              value={specificDate}
              onChange={e => { setSpecificDate(e.target.value); }}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', zIndex: 1 }}
            />
          </label>
        </div>

        {/* Recent Arrivals — 4 latest scans as quick-access tiles */}
        {recentScans.length > 0 && (
          <div className="recent-scans-section">
            <div className="recent-scans-label">Recent Arrivals</div>
            <div className="recent-scans-row">
              {recentScans.map(scan => {
                const name = scan.contact_name || scan.recipient_raw?.split('\n')[0] || '—';
                return (
                  <button
                    key={scan.id}
                    className={`recent-scan-tile ${selectedScanId === scan.id ? 'selected' : ''}`}
                    onClick={() => selectScan(scan)}
                    title={name}
                  >
                    <div className="recent-tile-top">
                      <div
                        className="recent-tile-avatar"
                        style={scan.status === 'no_match' ? { background: 'var(--warning)' } : {}}
                      >
                        {getInitials(name)}
                      </div>
                      <span className="recent-tile-name">{name}</span>
                    </div>
                    {scan.recipient_raw && scan.contact_name && (
                      <div className="recent-tile-meta">{scan.recipient_raw.split('\n')[0]}</div>
                    )}
                    <div className="recent-tile-footer">
                      <StatusBadge status={scan.status} />
                      <span className="recent-tile-time">{formatTileTime(scan.created_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Status Tabs */}
        <div className="tabs">
          {TABS.map(tab => {
            const count =
              tab.key === 'pending' ? pendingCount :
              tab.key === 'sent'    ? (stats.sent || 0) :
              tab.key === 'skipped' ? (stats.skipped || 0) : 0;
            return (
              <button
                key={tab.key}
                className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
                {count > 0 && <span className="badge">{count}</span>}
              </button>
            );
          })}
        </div>

        {/* Time Pills */}
        <div className="time-pills">
          {TIME_PILLS.map(p => (
            <button
              key={p.key}
              className={`time-pill ${timePeriod === p.key && !specificDate ? 'active' : ''}`}
              onClick={() => { setTimePeriod(p.key); setSpecificDate(''); }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="toolbar">
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {filtered.length} item{filtered.length !== 1 ? 's' : ''}
          </span>
          {activeTab === 'pending' && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={triggerPoll}
              disabled={polling}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {polling ? <span className="spinner" /> : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                  <path d="M21 3v5h-5"/>
                </svg>
              )}
              Check Drive Now
            </button>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 64, color: 'var(--text-muted)' }}>
            <span className="spinner" style={{ width: 28, height: 28 }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              {activeTab === 'pending' ? '📭' : activeTab === 'sent' ? '📤' : '🗃️'}
            </div>
            <h3>
              {activeTab === 'pending' ? 'No mail to review' :
               activeTab === 'sent'    ? 'No sent mail yet' : 'No skipped mail'}
            </h3>
            <p>
              {activeTab === 'pending'
                ? 'New scans appear here automatically when PDFs arrive in the Drive folder.'
                : 'Items will appear here after processing.'}
            </p>
          </div>
        ) : groups ? (
          <div className="scan-grid">
            <div className="period-top-label">{periodLabel}</div>
            {groups.map(g => (
              <SubGroup
                key={g.key}
                label={g.label}
                scans={g.scans}
                selectedScanId={selectedScanId}
                onUpdate={handleUpdate}
                onToast={addToast}
              />
            ))}
          </div>
        ) : (
          <div className="scan-grid">
            <div className="period-group">
              <div className="period-group-header period-group-header--static">
                <div className="period-group-title">
                  📅 {periodLabel}
                  <span className="period-count">{filtered.length} item{filtered.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="period-group-body">
                {filtered.map(scan => (
                  <ScanCard
                    key={scan.id}
                    scan={scan}
                    isSelected={scan.id === selectedScanId}
                    onUpdate={handleUpdate}
                    onToast={addToast}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type || ''}`}>
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
