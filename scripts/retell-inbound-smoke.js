#!/usr/bin/env node
// AIDA — inbound webhook smoke test (M7F-B1).
//
//   node scripts/retell-inbound-smoke.js
//       Assessment only. Contacts nothing. Prints the checks it WOULD run.
//
//   node scripts/retell-inbound-smoke.js --target https://<sandbox>.up.railway.app
//       Runs the checks against a DEPLOYED sandbox endpoint.
//
//   node scripts/retell-inbound-smoke.js --target <url> --known-agent agent_xyz
//       Additionally checks that a known sandbox agent resolves.
//
// ─── WHAT THIS IS FOR ───────────────────────────────────────────────
// Proving a deployed inbound webhook is safe BEFORE any phone number exists.
// Every check is an HTTP request to OUR OWN endpoint. Retell is never
// contacted, no provider resource is created or changed, no call is made and no
// number is required.
//
// ─── THE KEY ────────────────────────────────────────────────────────
// Signing needs the same secret the server verifies with. It is read from
// RETELL_API_KEY in the operator's own environment, used in memory, and NEVER
// printed, written or sent anywhere except as the HMAC key. There is no flag to
// pass it on the command line, because a command line ends up in shell history.
//
// ─── FICTIONAL DATA ONLY ────────────────────────────────────────────
// Numbers come from the ACMA fictitious range 0491 570 006–156, which is
// reserved and cannot reach a real person.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { INBOUND_WEBHOOK_PATH } = require("../src/config/retell");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const TARGET = valueOf("--target");
const KNOWN_AGENT = valueOf("--known-agent");
const WRONG_ENV_AGENT = valueOf("--wrong-env-agent");
const BUDGET_MS = Number(valueOf("--budget-ms")) || 2000;

const line = (c = "─") => console.log(c.repeat(74));
const heading = (t) => { console.log(); line(); console.log(`  ${t}`); line(); };

if ((process.env.NODE_ENV || "development") === "production") {
  console.error("Refusing to run the inbound smoke test in production.");
  process.exitCode = 1;
  return;
}

// ── Fictional payloads ──────────────────────────────────────────────

const FICTIONAL_CALLER = "+61491570110";
const UNKNOWN_AGENT = "agent_smoke_unknown_0000000000";

function inboundBody(agentId) {
  return JSON.stringify({
    event: "call_inbound",
    event_timestamp: 1785600000000,
    call_inbound: {
      agent_id: agentId,
      agent_version: 0,
      from_number: FICTIONAL_CALLER,
      to_number: "+61491570156",
    },
  });
}

/**
 * Sign with the OFFICIAL SDK. If it is absent we refuse rather than improvise —
 * the same rule the server-side verifier follows, for the same reason.
 */
async function sign(body, key) {
  let sdk;
  try {
    // eslint-disable-next-line global-require
    sdk = require("retell-sdk");
  } catch {
    throw new Error("retell-sdk is not installed; this harness will not hand-roll a signature");
  }
  if (typeof sdk.sign !== "function") throw new Error("retell-sdk exposes no sign()");
  return sdk.sign(body, key);
}

// ── Checks ──────────────────────────────────────────────────────────

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${detail || ""}`);
  return ok;
}

async function post(url, body, headers = {}) {
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed, elapsedMs: Date.now() - started };
}

/** Nothing sensitive may appear in a response body. */
function findLeaks(payload) {
  const json = JSON.stringify(payload || {});
  const leaks = [];
  if (/\+\d{8,15}/.test(json)) leaks.push("a number in international form");
  if (process.env.RETELL_API_KEY && json.includes(process.env.RETELL_API_KEY)) leaks.push("the API key");
  if (/https?:\/\//.test(json)) leaks.push("a URL");
  if (/[A-Za-z0-9_\-.]{60,}/.test(json)) leaks.push("a token-like string");
  return leaks;
}

async function main() {
  const key = process.env.RETELL_API_KEY || null;
  const url = TARGET ? `${TARGET.replace(/\/+$/, "")}${INBOUND_WEBHOOK_PATH}` : null;

  heading("AIDA — inbound webhook smoke test");
  console.log(`  mode          : ${TARGET ? "LIVE against a deployed sandbox" : "assessment only (nothing will be contacted)"}`);
  console.log(`  target        : ${url || "none given"}`);
  console.log(`  signing key   : ${key ? "present (never printed)" : "NOT SET — signed checks will be skipped"}`);
  console.log(`  known agent   : ${KNOWN_AGENT || "none given (resolution check skipped)"}`);
  console.log(`  budget        : ${BUDGET_MS}ms per request`);

  heading("Checks");
  console.log("   1. unsigned request                  → expect 401");
  console.log("   2. bad signature                     → expect 401");
  console.log("   3. signed, unknown agent             → expect 200 + empty call_inbound");
  console.log("   4. signed, known sandbox agent       → expect 200 + fictional variables");
  console.log("   5. signed, wrong-environment agent   → expect 200 + empty call_inbound");
  console.log("   6. no secret or raw E.164 in any response body");
  console.log("   7. every response inside the budget");
  console.log();
  console.log("  Retell is never contacted. No resource is created or changed.");
  console.log("  No call is placed. No phone number is required.");

  if (!TARGET) {
    heading("No action taken");
    console.log("  This was an assessment. No request was made.");
    console.log();
    console.log("  Once a sandbox is deployed:");
    console.log("    node scripts/retell-inbound-smoke.js --target https://<service>.up.railway.app");
    console.log();
    return 0;
  }

  if (!/^https:\/\//i.test(TARGET)) {
    heading("Refusing to run");
    console.log("  --target must be an https URL. A signature sent over http is a signature disclosed.");
    return 2;
  }

  heading("Running");

  // 1. Unsigned.
  const unsigned = await post(url, inboundBody(UNKNOWN_AGENT));
  record("unsigned request rejected", unsigned.status === 401, `got ${unsigned.status}`);

  // 2. Bad signature.
  const bad = await post(url, inboundBody(UNKNOWN_AGENT), { "x-retell-signature": `v=${Date.now()},d=${"a".repeat(64)}` });
  record("bad signature rejected", bad.status === 401, `got ${bad.status}`);

  if (!key) {
    heading("Signed checks skipped");
    console.log("  RETELL_API_KEY is not set in this environment, so no signed request could be built.");
    return summarise();
  }

  // 3. Signed, unknown agent.
  const unknownBody = inboundBody(UNKNOWN_AGENT);
  const unknown = await post(url, unknownBody, { "x-retell-signature": await sign(unknownBody, key) });
  const unknownEmpty = unknown.status === 200 && JSON.stringify(unknown.body) === JSON.stringify({ call_inbound: {} });
  record("unknown agent → 200 empty call_inbound", unknownEmpty, `got ${unknown.status} ${JSON.stringify(unknown.body)}`);

  // 4. Signed, known agent.
  let known = null;
  if (KNOWN_AGENT) {
    const body = inboundBody(KNOWN_AGENT);
    known = await post(url, body, { "x-retell-signature": await sign(body, key) });
    const vars = known.body && known.body.call_inbound && known.body.call_inbound.dynamic_variables;
    record("known agent → 200 with variables", known.status === 200 && Boolean(vars), `got ${known.status}, ${vars ? Object.keys(vars).length : 0} variable(s)`);
    if (vars) {
      const spokenOnly = Object.entries(vars).every(([k, v]) => !k.endsWith("_spoken") || !/\+\d{6,15}/.test(String(v)));
      record("no spoken variable carries E.164", spokenOnly);
      record("caller number sent spoken-only", vars.caller_number === undefined && vars.caller_number_e164 === undefined);
    }
  } else {
    console.log("  · known-agent check skipped (pass --known-agent)");
  }

  // 5. Wrong environment.
  if (WRONG_ENV_AGENT) {
    const body = inboundBody(WRONG_ENV_AGENT);
    const wrong = await post(url, body, { "x-retell-signature": await sign(body, key) });
    const safe = wrong.status === 200 && JSON.stringify(wrong.body) === JSON.stringify({ call_inbound: {} });
    record("wrong-environment agent → empty", safe, `got ${wrong.status}`);
  } else {
    console.log("  · wrong-environment check skipped (pass --wrong-env-agent)");
  }

  // 6. Leakage, across every response seen.
  const allLeaks = [unsigned, bad, unknown, known].filter(Boolean).flatMap((r) => findLeaks(r.body));
  record("no secret or raw number in any response", allLeaks.length === 0, allLeaks.join("; "));

  // 7. Budget. A DEPLOYED measurement, unlike the local one in the test suite.
  const slowest = Math.max(...[unsigned, bad, unknown, known].filter(Boolean).map((r) => r.elapsedMs));
  record(`every response within ${BUDGET_MS}ms`, slowest <= BUDGET_MS, `slowest ${slowest}ms`);
  console.log();
  console.log(`  Retell allows 10s before it retries and then falls back. Slowest here: ${slowest}ms.`);

  return summarise();
}

function summarise() {
  const failed = results.filter((r) => !r.ok);
  heading(failed.length ? "FAILED" : "All checks passed");
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail || ""}`);
  console.log();
  console.log("  No Retell resource was created or changed. No call was placed.");
  console.log("  No phone number was used.");
  return failed.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    console.error();
    console.error("Smoke test failed:", err.message);
    process.exitCode = 1;
  });
