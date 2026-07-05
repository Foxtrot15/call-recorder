const { createClient } = require("@supabase/supabase-js");

// Service-role ADMIN client — shared by the whole server for DB/storage access.
//
// persistSession/autoRefreshToken are disabled so this client can never hold a
// user session: with defaults, calling auth.signUp()/signInWithPassword() on it
// would make every subsequent query run with that user's JWT instead of the
// service key (and hit RLS). Never call user sign-in/sign-up methods on this
// client — user auth lives in services/client-auth.js on its own client.
// Stateless calls (auth.getUser(token), auth.admin.*) are fine.
const supabase = createClient(
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

module.exports = supabase;
