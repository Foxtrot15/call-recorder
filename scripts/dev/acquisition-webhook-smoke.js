#!/usr/bin/env node
// ============================================================================
// E-12J — NEGATIVE PROBES AGAINST THE PUBLIC ACQUISITION WEBHOOK
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-webhook-smoke.js --url https://<staging-host>
//
//   ... --run                 actually send the probes (default: describe only)
//   ... --include-oversize    add the large-body probe
//
// ── WHAT THIS PROVES, AND WHAT IT CANNOT ────────────────────────────
// It proves REJECTION: that an unsigned, malformed, mis-typed or oversized
// request does not get processed. Every probe expects a 4xx.
//
// It cannot prove ACCEPTANCE. A valid Retell signature is an HMAC over the
// exact body using the API key, and this harness is never given the key. That
// is deliberate: forging a signature would mean writing a second copy of the
// thing the verifier exists to check, and a green test against our own forgery
// would prove only that we forge consistently. The authenticated-event proof
// stays reserved for a real Retell delivery after the agent exists.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// Sends nothing but the probes defined in acquisition-webhook-smoke.js. No
// Retell API key, no Supabase key, no cookies, no auth header of any kind. It
// refuses http, localhost, private ranges, URLs carrying credentials, and any
// host matching a configured production base URL.
//
// No probe body carries `aida_purpose` or a dispatch id — nothing here could be
// mistaken for genuine acquisition traffic even if it somehow got past the
// signature check.
// ============================================================================

const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..", "..");
const {
  validateSmokeTarget,
  judgeProbeResult,
  describeRouteState,
  oversizeProbe,
  NEGATIVE_PROBES,
} = require(path.join(ROOT, "src/services/acquisition-webhook-smoke"));

const RUN = process.argv.includes("--run");
const INCLUDE_OVERSIZE = process.argv.includes("--include-oversize");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};

const line = (c = "-") => console.log(c.repeat(78));
const head = (t) => { console.log(""); line("="); console.log(`  ${t}`); line("="); };

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(ROOT, "..", "call-recorder", ".env");
  const out = { ...process.env };
  if (fs.existsSync(envPath)) {
    for (const l of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return out;
}

/** Read-only DEV census, through the existing helper. Never writes. */
async function census() {
  const { makeClient } = require(path.join(ROOT, "scripts/dev/acquisition-dispatch-proof/common"));
  const db = makeClient();
  const tables = [
    "acquisition_prospects", "acquisition_prospect_phones", "acquisition_evidence",
    "acquisition_decisions", "acquisition_suppressions", "acquisition_qualifications",
    "acquisition_call_queue", "acquisition_contact_outcomes", "acquisition_dncr_washes",
    "acquisition_calling_state", "acquisition_dial_executions",
  ];
  let total = 0;
  for (const t of tables) {
    const { data, error } = await db.from(t).select("*");
    if (!error) total += data.length;
  }
  const { data: events } = await db.from("provider_webhook_events").select("*");
  return { total, webhookEvents: events ? events.length : null };
}

async function main() {
  const env = loadEnv();
  const target = validateSmokeTarget(arg("url"), { env });

  console.log("");
  line("=");
  console.log("  E-12J — ACQUISITION WEBHOOK NEGATIVE PROBES");
  console.log(`  mode: ${RUN ? "RUN — probes will be sent" : "DESCRIBE ONLY — nothing will be sent"}`);
  line("=");

  if (!target.ok) {
    head("REFUSED");
    console.log(`  ${target.code}`);
    console.log(`  ${target.message}`);
    console.log("");
    console.log("  Supply a public https staging URL:  --url https://<host>");
    line("=");
    process.exit(1);
  }

  const probes = [...NEGATIVE_PROBES, ...(INCLUDE_OVERSIZE ? [oversizeProbe()] : [])];

  head("TARGET");
  console.log(`  webhook : ${target.webhookUrl}`);
  console.log(`  probes  : ${probes.length}`);
  console.log("");
  console.log("  Nothing sent here carries a Retell key, a Supabase key, a cookie or an");
  console.log("  auth header. No probe body could be read as acquisition traffic.");

  head("PROBES");
  for (const p of probes) {
    console.log(`  ${p.method.padEnd(5)} ${p.name}`);
    console.log(`        expect ${p.expect.join(" or ")} — ${p.proves}`);
  }

  if (!RUN) {
    head("DESCRIBE COMPLETE");
    console.log("  NOTHING WAS SENT. Re-run with --run to send these probes.");
    console.log("  A valid signature is never fabricated: the positive case is proven only");
    console.log("  by a real Retell delivery, after the agent exists.");
    line("=");
    return;
  }

  const before = await census().catch(() => null);
  if (before) console.log(`\n  DEV census before: ${before.total} acquisition rows, ${before.webhookEvents} webhook events`);

  head("RESULTS");
  const statuses = [];
  let failures = 0;
  for (const p of probes) {
    const headers = { ...(p.headers || {}) };
    if (p.contentType) headers["content-type"] = p.contentType;
    let status;
    try {
      const res = await fetch(target.webhookUrl, { method: p.method, headers, body: p.body === null ? undefined : p.body });
      status = res.status;
    } catch (err) {
      console.log(`  [ ERR  ] ${p.name} — ${err.message}`);
      failures += 1;
      continue;
    }
    statuses.push(status);
    const verdict = judgeProbeResult(p, status);
    if (!verdict.pass) failures += 1;
    console.log(`  [${verdict.pass ? "  OK  " : verdict.severity === "critical" ? " !!!! " : " WARN "}] ${p.name.padEnd(38)} ${verdict.detail}`);
  }

  const state = describeRouteState(statuses);
  head(state.dormant ? "ROUTE DORMANT" : failures ? "ATTENTION" : "ALL PROBES REJECTED AS EXPECTED");
  console.log(`  ${state.detail}`);

  const after = await census().catch(() => null);
  if (before && after) {
    console.log("");
    console.log(`  DEV census after : ${after.total} acquisition rows, ${after.webhookEvents} webhook events`);
    const unchanged = after.total === before.total && after.webhookEvents === before.webhookEvents;
    console.log(`  census unchanged : ${unchanged ? "YES" : "NO — INVESTIGATE"}`);
    if (!unchanged) failures += 1;
  }
  line("=");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
