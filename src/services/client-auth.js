const supabase = require("./supabase");

// Sign up a new client account. Links the Auth user to a clients row.
async function signupClient(email, password, clientId) {
  // Create the Auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) throw new Error(`Auth signup failed: ${authError.message}`);
  if (!authData.user) throw new Error("No user returned from signup");

  // Link the Auth user to the clients row
  const { error: updateError } = await supabase
    .from("clients")
    .update({ auth_user_id: authData.user.id })
    .eq("slug", clientId);

  if (updateError) throw new Error(`Failed to link Auth user: ${updateError.message}`);

  return { userId: authData.user.id, email: authData.user.email };
}

// Log in an existing client account
async function loginClient(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
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

module.exports = { signupClient, loginClient };
