// Client session policy: cookie rules, refresh decision logic (B1), and the
// dual-mode (cookie vs Bearer) transport policy for the mobile app.
//
// Pure module (no deps) so the policy is unit-testable and lives in ONE
// place: names, flags, lifetimes, transport resolution, and the middleware's
// refresh decision. The Supabase calls live in services/client-auth.js; the
// wiring in middleware/auth.js and routes/client-auth.js.
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

// ── Dual-mode transport (mobile Bearer vs browser cookies) ──────────────────
//
// The mobile app has no cookie jar worth trusting; it holds tokens in
// Keychain/Keystore and sends `Authorization: Bearer <access_token>`. The
// browser keeps its httpOnly cookies. ONE rule decides which transport a
// request is using, and the two never mix on a single request:
//
//   Any Authorization header present  → bearer mode. The header is the whole
//                                       claim; cookies on the same request
//                                       are IGNORED. A malformed header or
//                                       wrong scheme yields a null token and
//                                       therefore a 401 — it must NOT fall
//                                       back to cookie auth, or an attacker-
//                                       controlled junk header could silently
//                                       downgrade the auth path.
//   No Authorization header           → cookie mode, exactly as before.
//
// Bearer mode never refreshes transparently (the server can't rotate tokens
// the app holds in its keystore via a response header the app isn't parsing);
// the app calls POST /client-auth/refresh explicitly on a 401.

// Parse an Authorization header. Returns the token, or null when the header
// is absent, uses a different scheme, or is malformed. Scheme match is
// case-insensitive per RFC 7235; the token itself must be a single
// non-empty run of non-whitespace.
function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  const m = authorizationHeader.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

// Resolve which transport a request is using and the credentials it carries.
// Returns { mode: "bearer"|"cookie", accessToken, refreshToken } — refresh
// tokens travel only in cookies (browser) or explicit request bodies (app),
// never in the Authorization header, so bearer mode always has refreshToken
// null here.
function resolveClientCredentials({ authorizationHeader, cookies } = {}) {
  if (authorizationHeader != null && authorizationHeader !== "") {
    return {
      mode: "bearer",
      accessToken: extractBearerToken(authorizationHeader),
      refreshToken: null,
    };
  }
  return {
    mode: "cookie",
    accessToken: (cookies && cookies[ACCESS_COOKIE]) || null,
    refreshToken: (cookies && cookies[REFRESH_COOKIE]) || null,
  };
}

// Did a login request ask for tokens in the JSON body instead of cookies?
// Explicit opt-in only — absent/unknown values keep the cookie behaviour, so
// every existing browser client is untouched.
function wantsTokenResponse(body) {
  return Boolean(body) && body.mode === "tokens";
}

// The JSON body shape shared by token-mode login and token-mode refresh —
// ONE shape, so the app parses one thing. snake_case matches the refresh
// endpoint's pre-existing field names (access_token/refresh_token).
function sessionTokenBody(session) {
  return {
    success: true,
    email: session.email,
    token_type: "Bearer",
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn ?? null,   // seconds until access expiry
    expires_at: session.expiresAt ?? null,   // unix seconds, absolute
  };
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
  extractBearerToken,
  resolveClientCredentials,
  wantsTokenResponse,
  sessionTokenBody,
};
