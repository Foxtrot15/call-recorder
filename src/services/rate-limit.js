// Minimal in-memory fixed-window rate limiter (decision D11 — ships with the
// first real VoIP endpoints). Pure factory, injectable clock, no deps.
//
// Deliberately in-memory: Aida runs as a single Railway instance, and these
// limits guard cheap token-mint/registration abuse, not distributed DDoS.
// If the deployment ever scales horizontally, replace with a shared store —
// the call sites only know check(key) → allowed.

function createRateLimiter({ limit, windowMs, now = Date.now }) {
  if (!Number.isFinite(limit) || limit < 1) throw new Error("rate limiter needs limit >= 1");
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("rate limiter needs windowMs >= 1");

  const windows = new Map(); // key -> { start, count }

  function check(key) {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      windows.set(key, { start: t, count: 1 });
      return { allowed: true, remaining: limit - 1 };
    }
    if (w.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: w.start + windowMs - t };
    }
    w.count += 1;
    return { allowed: true, remaining: limit - w.count };
  }

  // Opportunistic cleanup so long-lived processes don't accumulate dead keys.
  function prune() {
    const t = now();
    for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
  }

  return { check, prune, _size: () => windows.size };
}

module.exports = { createRateLimiter };
