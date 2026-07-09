// Requires are lazy (per call) so the pure-testable parts of this module —
// revokeClientSession's decision logic in particular — load in the dep-free
// unit-test environment; same convention as services/devices.js.
// admin() is the shared service-role client — DB + stateless auth.admin only.
const admin = () => require("./supabase");

// Fresh, throwaway client for password verification. A new instance per call
// means any session state signInWithPassword sets is discarded with it and can
// never leak into the shared admin client's DB queries (which previously made
// the whole server run as the last logged-in user).
function createAuthClient() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );
}

// Sign up a new client account. Links the Auth user to a clients row.
async function signupClient(email, password, clientId) {
  const supabase = admin();
  // Check the target clients row before creating the Auth user, so a bad slug
  // doesn't leave an orphaned login behind — and so each failure mode gets a
  // clear error instead of the old silent zero-row update.
  const { data: clientRow, error: lookupError } = await supabase
    .from("clients")
    .select("slug, auth_user_id")
    .eq("slug", clientId)
    .single();

  if (lookupError || !clientRow) {
    throw new Error(`No client found with slug "${clientId}" — create the clients row first`);
  }
  if (clientRow.auth_user_id) {
    throw new Error(`Client "${clientId}" already has a login linked — unlink it before re-registering`);
  }

  // admin.createUser is a stateless admin REST call: unlike auth.signUp it
  // sets no session on this client, and email_confirm skips the confirmation
  // email (no confirmation flow exists in this app, so signUp left users
  // permanently unconfirmed and unable to log in).
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) throw new Error(`Auth signup failed: ${authError.message}`);
  if (!authData.user) throw new Error("No user returned from signup");

  // Link the Auth user to the clients row. The is-null guard means a
  // concurrent signup can't claim the same row twice; select() returns the
  // updated rows so we can verify exactly one was linked.
  const { data: updated, error: updateError } = await supabase
    .from("clients")
    .update({ auth_user_id: authData.user.id })
    .eq("slug", clientId)
    .is("auth_user_id", null)
    .select("slug");

  if (updateError || !updated || updated.length !== 1) {
    // Roll back the just-created Auth user so signup stays retryable —
    // otherwise the email is burned ("already registered") with no linked client.
    try {
      await supabase.auth.admin.deleteUser(authData.user.id);
    } catch (rollbackErr) {
      console.error(`⚠️  Could not roll back Auth user ${authData.user.id}:`, rollbackErr.message);
    }
    const reason = updateError
      ? updateError.message
      : `expected to link 1 clients row for "${clientId}", linked ${updated ? updated.length : 0}`;
    throw new Error(`Failed to link Auth user: ${reason}`);
  }

  return { userId: authData.user.id, email: authData.user.email };
}

// Log in an existing client account
async function loginClient(email, password) {
  // Throwaway client — see createAuthClient() for why this must not run on
  // the shared admin client.
  const authClient = createAuthClient();
  const { data, error } = await authClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw new Error(`Login failed: ${error.message}`);
  if (!data.user) throw new Error("No user returned from login");
  if (!data.session) throw new Error("No session returned from login");

  return {
    userId: data.user.id,
    email: data.user.email,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in ?? null,  // seconds — the app schedules its refresh off this
    expiresAt: data.session.expires_at ?? null,  // unix seconds
  };
}

// Exchange a refresh token for a fresh session (B1). Runs on a throwaway
// client for the same contamination reason as loginClient. Supabase ROTATES
// refresh tokens: the returned pair replaces the old one entirely (the old
// refresh token dies after a short reuse-grace window), so callers must
// persist BOTH returned tokens.
async function refreshClientSession(refreshToken) {
  if (!refreshToken) throw new Error("No refresh token");

  const authClient = createAuthClient();
  const { data, error } = await authClient.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error) throw new Error(`Session refresh failed: ${error.message}`);
  if (!data.session || !data.user) throw new Error("No session returned from refresh");

  return {
    userId: data.user.id,
    email: data.user.email,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in ?? null,
    expiresAt: data.session.expires_at ?? null,
    user: data.user, // saves the middleware a second getUser round-trip
  };
}

// Server-side logout: revoke the Supabase session so the refresh token dies
// NOW instead of living out its 30-day idle window in a stolen cookie jar or
// keystore. Best-effort by design — logout must always succeed locally
// (cookies cleared / keystore wiped) even when Supabase is unreachable, so
// this never throws.
//
// Two paths to a revocation:
//   1. A still-valid access token → admin.signOut(jwt, "local") kills the
//      session it belongs to (only that session — other devices stay logged in).
//   2. Access token dead/absent but a refresh token provided → burn the
//      refresh token by USING it (rotation consumes it), then revoke the
//      fresh session it produced. Net effect: the whole chain is dead.
async function revokeClientSession({ accessToken, refreshToken } = {}, deps = {}) {
  const adminSignOut = deps.adminSignOut
    || ((jwt) => admin().auth.admin.signOut(jwt, "local"));
  const refresh = deps.refreshClientSession || refreshClientSession;

  if (accessToken) {
    try {
      const { error } = (await adminSignOut(accessToken)) || {};
      if (!error) return { revoked: true, via: "access" };
    } catch (err) {
      console.log("Logout: access-token revocation failed:", err.message);
    }
  }

  if (refreshToken) {
    try {
      const session = await refresh(refreshToken);
      const { error } = (await adminSignOut(session.accessToken)) || {};
      if (!error) return { revoked: true, via: "refresh" };
    } catch (err) {
      // A refresh token Supabase already refuses is as good as revoked.
      console.log("Logout: refresh-token revocation failed:", err.message);
      return { revoked: false, reason: err.message };
    }
  }

  return { revoked: false, reason: "no usable credential" };
}

module.exports = { signupClient, loginClient, refreshClientSession, revokeClientSession };
