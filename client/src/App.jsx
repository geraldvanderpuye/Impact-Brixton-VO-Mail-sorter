import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard.jsx';

export default function App() {
  const [authStatus, setAuthStatus] = useState(null);

  useEffect(() => {
    fetch('/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then(setAuthStatus)
      .catch(() => setAuthStatus({ authenticated: false, connected: false }));
  }, []);

  if (!authStatus) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: '40px 24px' }}>
          <img src="/logo.png" alt="IB Logo" style={{ width: 96, height: 96, borderRadius: 20, marginBottom: 20 }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>IB Virtual Office Mail Sorter</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: 28, maxWidth: 340, margin: '0 auto 28px' }}>
            Sign in with the business Google account to access the mail dashboard.
          </p>
          <a href="/auth/google" className="btn btn-primary" style={{ textDecoration: 'none', display: 'inline-flex' }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
              <path d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </a>
        </div>
      </div>
    );
  }

  return <Dashboard authStatus={authStatus} />;
}
