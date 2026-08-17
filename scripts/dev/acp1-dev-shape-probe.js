#!/usr/bin/env node
// AIDA PLATFORM — what is ACTUALLY on DEV (P36 finding).
//
//   PLATFORM_DEV_ENV_FILE=../call-recorder/.env node scripts/dev/acp1-dev-shape-probe.js
//
// The preflight found the ACP1/ACP2/ACP3 tables already present on DEV, which
// every migration header denies. This establishes WHAT is there before anybody
// decides what to do about it.
//
// Column presence is answerable over PostgREST: selecting a column that does
// not exist returns 42703. CHECK constraint CONTENTS are not — they live in
// pg_constraint, which PostgREST does not expose — so this reports which
// questions remain for the SQL editor rather than guessing.
//
// READ ONLY. Every call is .select() with a limit. There is no
// insert, update, delete, upsert or rpc in this file, and no probe that writes
// a row to see whether a constraint bites.

const { devSupabase, describeTarget } = require("./platform-dev-supabase");

const EXPECTED = {
  platform_config_versions: [
    "id", "client_id", "config_version", "schema_version", "status",
    "blueprint", "content_hash", "behaviour_hash",
    "created_at", "created_by", "source",
    "supersedes", "restored_from",
    "updated_at", "updated_by", "validated_at",
    "approved_at", "approved_by", "approved_hash", "approval_reason",
    "activated_at", "activated_by",
    "superseded_at", "superseded_by", "supersede_reason",
  ],
  platform_config_events: [
    "id", "client_id", "config_version", "event_type",
    "actor", "actor_role", "source", "occurred_at", "metadata",
  ],
};

const OTHER_TABLES = [
  "platform_provisioning_plans",
  "platform_provisioning_executions",
  "platform_action_executions",
];

const UNKNOWN_COLUMN = (e) => Boolean(e) && (e.code === "42703" || /column .* does not exist/i.test(e.message || ""));
const MISSING_TABLE = (e) => Boolean(e) && (e.code === "PGRST205" || e.code === "42P01" || /could not find the table/i.test(e.message || ""));

/**
 * Does this column exist?
 *
 * Same trap as tableState: the first version returned `true` for any error that
 * was not 42703 — including PGRST205 for a table that does not exist. So a
 * missing table reported every one of its columns as present, and printed
 * "shape matches the committed migration" about nothing at all.
 *
 * Callers must establish the TABLE exists first; this now distinguishes the
 * three real answers rather than collapsing two of them into "yes".
 */
async function columnExists(db, table, column) {
  const { error } = await db.from(table).select(column).limit(1);
  if (UNKNOWN_COLUMN(error)) return false;
  if (MISSING_TABLE(error)) return null;
  if (error) return null;
  return true;
}

(async () => {
  const target = devSupabase();
  const { db } = target;

  console.log("");
  console.log("DEV SCHEMA PROBE — read-only");
  console.log(describeTarget(target));
  console.log("");

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const { error } = await db.from(table).select("*").limit(1);
    const { count } = await db.from(table).select("*", { head: true, count: "exact" });
    if (MISSING_TABLE(error)) { console.log(`${table}: ABSENT\n`); continue; }
    if (error) { console.log(`${table}: indeterminate — ${error.message}\n`); continue; }

    console.log(`${table}: EXISTS, ${count ?? 0} row(s)`);
    const missing = [];
    const extra = [];
    for (const c of columns) {
      const present = await columnExists(db, table, c);
      if (present === false) missing.push(c);
      if (present === null) extra.push(`${c}?`);
    }
    console.log(`  expected columns present : ${columns.length - missing.length}/${columns.length}`);
    if (missing.length) console.log(`  MISSING                  : ${missing.join(", ")}`);
    if (extra.length) console.log(`  indeterminate            : ${extra.join(", ")}`);
    if (!missing.length) console.log("  → shape matches the committed migration");
    console.log("");
  }

  console.log("ACP2 / ACP3 tables:");
  for (const t of OTHER_TABLES) {
    const { error } = await db.from(t).select("*").limit(1);
    const { count } = await db.from(t).select("*", { head: true, count: "exact" });
    if (MISSING_TABLE(error)) console.log(`  ${t}: ABSENT`);
    else if (error) console.log(`  ${t}: indeterminate — ${error.message}`);
    else console.log(`  ${t}: EXISTS, ${count ?? 0} row(s)`);
  }

  console.log("");
  console.log("NOT ANSWERABLE OVER PostgREST — these decide whether DEV is CURRENT or STALE:");
  console.log("  · the event_type CHECK list      (13 = pre-P24, 29 = current)");
  console.log("  · the actor_role CHECK list      (7 = pre-P36, 8 = current)");
  console.log("  · which constraints, indexes, triggers and functions exist");
  console.log("  · whether RLS is on and how many policies exist");
  console.log("Run supabase/sql/verification/20_acp1_verify_readonly.sql in the SQL editor.");
  console.log("");
})().catch((error) => {
  console.error(`\nFAILED: ${error.message}\n`);
  process.exit(3);
});
