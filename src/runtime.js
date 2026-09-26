const REQUEST_TIMEOUT_MS = 30_000;

function fetchWithDeadline(url, options = {}) {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return fetch(url, { ...options, signal });
}

// A timed-out Promise must not keep running while another poll starts: it could
// upload or ingest late. Exit the container instead; Railway restarts it and the
// receiver's processed IDs are reloaded before any further intake.
function createStageGuard({ timeoutMs = 120_000, now = Date.now, exit = process.exit } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid stage timeout');
  let active = null;
  return {
    snapshot() {
      return active ? { ...active, elapsedMs: now() - active.startedAt } : null;
    },
    async run(stage, operation) {
      if (active) throw new Error('Overlapping scanner stages');
      active = { stage, startedAt: now(), timeoutMs };
      const timer = setTimeout(() => {
        console.error(`[watchdog] ${stage} exceeded ${timeoutMs}ms; exiting for a clean restart`);
        exit(1);
      }, timeoutMs);
      try {
        return await operation();
      } finally {
        clearTimeout(timer);
        active = null;
      }
    },
  };
}

module.exports = { REQUEST_TIMEOUT_MS, fetchWithDeadline, createStageGuard };
