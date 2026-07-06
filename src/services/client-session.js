// Client session cookie policy + refresh decision logic (B1).
//
// Pure module (no deps) so the policy is unit-testable and lives in ONE
// place: names, flags, lifetimes, and the middleware's refresh decision.
// The Supabase calls live in services/client-auth.js; the wiring in
// middleware/auth.js and routes/client-auth.js.
//
// Two-cookie strategy:
//   aida_client_session  — Supabase ACCESS token (JWT, ~1h validity).
//                          Verified against Supabase on every request.
//   aida_client_refresh  — Supabase REFRESH token. Used only to mint a new
//                          access token when the JWT has expired; rotates on
//                          every use (Supabase rotation), so each refresh
//                          re-sets BOTH cookies.
// Both are httpOnly + secure + sameSite=lax: no JS can read them, no
// cross-site POST can carry them. The refresh cookie outlives the access
// cookie (30d vs 7d) so a dashboard left idle overnight resumes silently.

const ACCESS_COOKIE = "aida_client_session";   // unchanged name — backward compatible
const REFRESH_COOKIE = "aida_client_refresh";

const ACCESS_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days (as before)
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days idle cap

const BASE_FLAGS = { httpOnly: true, secure: true, sameSite: "lax" };

function accessCookieOptions() {
  return { ...BASE_FLAGS, maxAge: ACCESS_COOKIE_MAX_AGE_MS };
}

function refreshCookieOptions() {
  return { ...BASE_FLAGS, maxAge: REFRESH_COOKIE_MAX_AGE_MS };
}

// Set both session cookies (refresh only when provided — Supabase rotates it
// on every refresh, so callers always pass the NEWEST pair they hold).
function setClientSessionCookies(res, { accessToken, refreshToken }) {
  if (accessToken) res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions());
  if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
}

function clearClientSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(REFRESH_COOKIE);
}

// The middleware's decision, kept pure so the state table is testable:
//   authenticated — access token verified; proceed.
//   refresh       — access token missing/expired BUT a refresh token exists;
//                   attempt a transparent server-side refresh.
//   reject        — nothing usable; 401.
function evaluateClientSession({ hasAccessToken, accessValid, hasRefreshToken }) {
  if (hasAccessToken && accessValid) return "authenticated";
  if (hasRefreshToken) return "refresh";
  return "reject";
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_MAX_AGE_MS,
  accessCookieOptions,
  refreshCookieOptions,
  setClientSessionCookies,
  clearClientSessionCookies,
  evaluateClientSession,
};
