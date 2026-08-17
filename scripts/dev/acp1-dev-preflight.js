#!/usr/bin/env node
// AIDA PLATFORM — ACP1 DEV preflight, remote half (P36).
//
//   PLATFORM_DEV_ENV_FILE=../call-recorder/.env node scripts/dev/acp1-dev-preflight.js
//
// ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────
// supabase/sql/verification/19_acp1_preflight_readonly.sql is the preflight. It
// queries pg_tables, pg_class and pg_proc, which PostgREST does not expose, so
// the full file can only be run in the SQL editor by a person.
//
// This runs the half that IS reachable over PostgREST — do the ACP1 tables
// already exist, does public.clients look as expected, are ACP2/ACP3 still
// absent — so the founder walks into the SQL editor already knowing the answer
// to the questions that decide whether to proceed.
//
// It prints, for every check, WHICH questions it could not answer remotely.
// A preflight that quietly reports on a subset is worse than one that refuses.
//
// ── SAFETY ──────────────────────────────────────────────────────────
//   * Reads only. Every call is .select() with a limit. No insert, update,
//     delete, upsert or rpc appears in this file.
//   * DEV only — the project-ref guard throws before a client exists.
//   * Prints no key.

const { devSupabase, describeTarget, DEV_PROJECT_REF } = require("./platform-dev-supabase");

const ACP1_TABLES = ["platform_config_versions", "platform_config_events"];
const ACP2_TABLES = ["platform_provisioning_plans"];
const ACP3_TABLES = ["platform_provisioning_executions", "platform_action_executions"];

/** PostgREST's answer for "no such table", across versions. */
const MISSING = (error) =>
  Boolean(error) && (
    error.code === "PGRST205" || error.code === "42P01" ||
    /could not find the table|does not exist|schema cache/i.test(error.message || "")
  );

/**
 * Does this table exist?
 *
 * ── WHY THIS ASKS FOR A ROW ─────────────────────────────────────────
 * The first version used .select("*", { head: true, count: "exact" }), which is
 * the efficient way to ask "how many rows". Against a table that does NOT
 * exist, PostgREST answers 404 with an EMPTY BODY, and supabase-js parses its
 * error out of the body — so `error` came back null and the probe reported
 * ABSENT tables as PRESENT.
 *
 * That is not a subtle failure. It reported five ACP tables as applied to DEV
 * when none of them existed, and it did it with enough confidence to survive a
 * column-by-column "shape matches" check that was broken the same way.
 *
 * So existence is now established by asking for a row. A missing table answers
 * PGRST205; a present-but-empty one answers with zero rows and no error. A
 * probe verified against a table name nobody has ever created is the only kind
 * worth trusting.
 */
async function tableState(db, table) {
  const { data, error } = await db.from(table).select("*").limit(1);
  if (MISSING(error)) return { table, exists: false, rows: null };
  if (error) return { table, exists: null, rows: null, error: error.message };
  // A second call may count rows now that the table is known to exist.
  const counted = await db.from(table).select("*", { count: "exact", head: true });
  return { table, exists: true, rows: counted.error ? null : (counted.count ?? (data || []).length) };
}

(async () => {
  let target;
  try {
    target = devSupabase();
  } catch (error) {
    console.error(`\nREFUSED: ${error.message}\n`);
    process.exit(2);
  }
  const { db } = target;

  console.log("");
  console.log("ACP1 DEV PREFLIGHT — remote half, read-only");
  console.log(describeTarget(target));
  console.log("");

  let stop = false;
  const line = (verdict, text) => console.log(`  ${verdict.padEnd(6)} ${text}`);

  // ── 1. Do the ACP1 tables already exist? ──
  console.log("1. ACP1 tables — expect ABSENT on a first apply");
  for (const t of ACP1_TABLES) {
    const s = await tableState(db, t);
    if (s.exists === false) line("OK", `${t} — absent`);
    else if (s.exists === true) { stop = true; line("STOP", `${t} — ALREADY EXISTS with ${s.rows} row(s). Do not re-apply blind.`); }
    else { stop = true; line("STOP", `${t} — could not determine: ${s.error}`); }
  }

  // ── 2. public.clients, the tenant key source ──
  console.log("\n2. public.clients — the slug ACP1 stores in client_id");
  const clients = await db.from("clients").select("slug").order("slug").limit(50);
  if (MISSING(clients.error)) { stop = true; line("STOP", "public.clients is missing — ACP1 stores clients.slug and this DEV project does not look right"); }
  else if (clients.error) { stop = true; line("STOP", `could not read public.clients: ${clients.error.message}`); }
  else {
    line("OK", `public.clients readable — ${clients.data.length} slug(s)`);
    for (const c of clients.data) console.log(`         · ${c.slug}`);
    const collision = clients.data.some((c) => /^aida[-_]platform[-_]dev/i.test(c.slug));
    line(collision ? "NOTE" : "OK", collision
      ? "a slug already matches the intended P36 fixture namespace — pick another"
      : "the intended P36 fixture namespace is free");
  }

  // ── 3. ACP2 / ACP3 must remain absent ──
  console.log("\n3. ACP2 / ACP3 — must remain UNAPPLIED, this milestone is ACP1 only");
  for (const t of [...ACP2_TABLES, ...ACP3_TABLES]) {
    const s = await tableState(db, t);
    if (s.exists === false) line("OK", `${t} — absent, as expected`);
    else if (s.exists === true) { stop = true; line("STOP", `${t} EXISTS — ACP2/ACP3 were applied. That is outside this milestone.`); }
    else line("NOTE", `${t} — indeterminate: ${s.error}`);
  }

  // ── 4. What this cannot answer from here ──
  console.log("\n4. NOT ANSWERABLE OVER PostgREST — run 19_acp1_preflight_readonly.sql in the SQL editor");
  console.log("         · index / relation name collisions (pg_class): pcv_one_active_per_client and the six others");
  console.log("         · trigger-function name collisions (pg_proc): pcv_guard_frozen_rows, pcv_refuse_delete, pce_append_only");
  console.log("         · gen_random_uuid() availability (pg_proc)");
  console.log("       These are catalogue queries. PostgREST exposes no catalogue, and this tool does not pretend otherwise.");

  console.log("");
  console.log(stop
    ? "VERDICT: STOP. At least one check did not pass — do not apply ACP1."
    : "VERDICT: the remote half is GREEN. Run the SQL preflight for the catalogue checks before applying.");
  console.log("");
  process.exit(stop ? 1 : 0);
})().catch((error) => {
  console.error(`\nFAILED: ${error.message}\n`);
  process.exit(3);
});

void DEV_PROJECT_REF;
