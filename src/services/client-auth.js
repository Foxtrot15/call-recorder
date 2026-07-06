const { createClient } = require("@supabase/supabase-js");
const supabase = require("./supabase"); // admin client — DB + stateless auth.admin calls only

// Fresh, throwaway client for password verification. A new instance per call
// means any session state signInWithPassword sets is discarded with it and can
// never leak into the shared admin client's DB queries (which previously made
// the whole server run as the last logged-in user).
function createAuthClient() {
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
    user: data.user, // saves the middleware a second getUser round-trip
  };
}

module.exports = { signupClient, loginClient, refreshClientSession };
