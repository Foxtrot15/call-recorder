// AIDA PLATFORM — the DEV-only Supabase handle, and the guard in front of it (P36).
//
//   devSupabase({ readOnly })   -> { db, projectRef, url }
//   assertDevProject(url)
//   DEV_PROJECT_REF
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// P36 binds the configuration subsystem to a real database for the first time.
// Every founder-operated persistence test from here on needs credentials, and
// the failure mode that matters is not "the test failed" — it is "the test
// passed, against production".
//
// So there is exactly one place that builds a client, and it refuses to build
// one for any project except DEV. Not a warning, not an environment convention:
// a thrown error, before the handle exists.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────
//   * It will not connect to any project ref but wvwemitmmsdytyutaqbm.
//   * It will not print, log or return a key. The key goes into the client and
//     nowhere else; `url` and `projectRef` are the only identifying values it
//     hands back, and neither is a secret.
//   * It will not write an env file, and it will not modify the one it reads.
//   * It is not imported by anything under src/. Nothing the application loads
//     can reach it, and a ratchet asserts that — src/platform takes its `db` by
//     injection and imports no database client at all.
//
// ── WHERE THE CREDENTIALS COME FROM ─────────────────────────────────
// process.env first. Failing that, a .env file named by PLATFORM_DEV_ENV_FILE,
// read and parsed in-process and never written back. There is no default path
// into a sibling worktree: pointing at one is a deliberate act typed by a
// person who knows which project it names.

const fs = require("node:fs");
const path = require("node:path");

/** The ONE project this file will talk to. */
const DEV_PROJECT_REF = "wvwemitmmsdytyutaqbm";
const DEV_URL = `https://${DEV_PROJECT_REF}.supabase.co`;

/** Parse a .env without a dependency, and without touching the file. */
function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip an inline comment only when the value is not quoted — a key never
    // contains " #", and a comment must never end up inside one.
    if (!/^["']/.test(value)) value = value.split(/\s+#/)[0].trim();
    out[m[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The guard. Refuses anything that is not the DEV project, including a URL
 * that merely contains the ref, so a production host with a lookalike path
 * cannot pass.
 */
function assertDevProject(url) {
  if (typeof url !== "string" || !url) {
    throw new Error("platform-dev-supabase: SUPABASE_URL is not set. Refusing to guess.");
  }
  const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) || [])[1];
  if (!ref) {
    throw new Error(`platform-dev-supabase: SUPABASE_URL is not a Supabase project URL. Refusing to connect.`);
  }
  if (ref !== DEV_PROJECT_REF) {
    throw new Error(
      `platform-dev-supabase: REFUSED. This tool talks to DEV (${DEV_PROJECT_REF}) only, and the ` +
      `configured project is "${ref}". If that is production, nothing about this run was safe — stop.`,
    );
  }
  return ref;
}

/**
 * A DEV client, or an explanation.
 *
 * @param {string} [envFile]  a .env to read if process.env lacks the values.
 *                            Defaults to PLATFORM_DEV_ENV_FILE. No fallback path.
 */
function devSupabase({ envFile = process.env.PLATFORM_DEV_ENV_FILE, requireKey = true } = {}) {
  const fromFile = readEnvFile(envFile ? path.resolve(envFile) : null);
  const url = process.env.SUPABASE_URL || fromFile.SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_KEY || fromFile.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY || fromFile.SUPABASE_SERVICE_ROLE_KEY || "";

  const projectRef = assertDevProject(url);

  if (!key) {
    if (!requireKey) return { db: null, projectRef, url, hasKey: false };
    throw new Error(
      "platform-dev-supabase: no service key. Set SUPABASE_SERVICE_KEY, or point " +
      "PLATFORM_DEV_ENV_FILE at a .env that has one. The key is never printed.",
    );
  }

  // Required lazily so this module can be loaded — and its guard tested —
  // in a checkout with no node_modules, which is the house convention.
  const { createClient } = require("@supabase/supabase-js");
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { db, projectRef, url, hasKey: true };
}

/** For a banner. Contains no secret, by construction. */
const describeTarget = ({ projectRef, url }) =>
  `DEV Supabase — project ${projectRef} (${url}). Service key present but never printed.`;

module.exports = { devSupabase, assertDevProject, readEnvFile, describeTarget, DEV_PROJECT_REF, DEV_URL };
