#!/usr/bin/env node
// ============================================================================
// E-10D(i) — CREATE THE ACQUISITION RESPONSE ENGINE. ONCE. NOTHING ELSE.
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-provision-response-engine.js --preview
//
//   ... --create-one-response-engine     performs the ONE authorised write
//
// ── WHAT THIS CAN AND CANNOT DO ─────────────────────────────────────
// It creates a Retell LLM (a "response engine"). That object holds a prompt and
// an opening message. It has NO voice, NO agent, NO telephone number and NO
// webhook, so it cannot ring anybody, cannot be rung, and cannot make
// acquisition calling live. It is the id the future agent will point at.
//
// It calls exactly ONE endpoint: createResponseEngine. There is no code path
// here to createAgent, createPhoneCall, bindPhoneNumber, or anything else, and
// a ratchet in test/acquisition-agent-resources.test.js asserts that by reading
// this file.
//
// ── WHY THIS IS A SCRIPT AND NOT WIRED INTO THE APP ─────────────────
// Nothing in this branch injects a `fetchImpl` into the Retell adapter — the
// adapter refuses every request without one, which is what has kept the whole
// repository structurally incapable of a live write. This script supplies one,
// for one command, run by hand. Wiring a transport into the running service
// would hand that capability to everything permanently, and no milestone has
// asked for that.
//
// ── NO RETRY. THIS IS THE IMPORTANT PART. ───────────────────────────
// A timeout or a lost response does NOT mean nothing was created. Retell may
// have built the engine and lost the answer on the way back. Calling create
// again would be how one authorised write becomes two response engines.
//
// So on ANY ambiguous failure this stops and says so, and the next step is to
// LOOK in the Retell dashboard before anybody sends anything else.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { describeAcquisitionRetellResources, SPEC_VERSION } = require(path.join(ROOT, "src/services/acquisition-agent-spec"));

const PREVIEW_ONLY = !process.argv.includes("--create-one-response-engine");

const line = (c = "-") => console.log(c.repeat(74));
const head = (t) => { console.log(""); line("="); console.log(t); line("="); };

/** Load the env file the dev proofs already use. Values are never printed. */
function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(ROOT, "..", "call-recorder", ".env");
  if (!fs.existsSync(envPath)) throw new Error(`Cannot find ${envPath}. Set ACQUISITION_ENV_FILE.`);
  const out = { ...process.env };
  for (const l of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

async function main() {
  console.log("");
  line("=");
  console.log("  E-10D(i) — ACQUISITION RESPONSE ENGINE");
  console.log(`  mode: ${PREVIEW_ONLY ? "PREVIEW ONLY — nothing will be sent" : "CREATE — ONE write will be attempted"}`);
  line("=");

  const env = loadEnv();
  const { getRetellConfig, canWriteLive } = require(path.join(ROOT, "src/config/retell"));
  const config = getRetellConfig(env);

  // ── The payload. Response engine ONLY. ───────────────────────────
  const resources = describeAcquisitionRetellResources();
  const payload = resources.responseEngine;

  head("1. The exact payload");
  console.log(JSON.stringify({ ...payload, general_prompt: `<${payload.general_prompt.length} chars — printed below>` }, null, 2));
  console.log("");
  console.log("--- general_prompt ---");
  console.log(payload.general_prompt);

  head("2. What this payload is NOT");
  const forbidden = ["agent_name", "voice_id", "language", "webhook_url", "post_call_analysis_data", "from_number", "to_number", "phone_number"];
  const present = forbidden.filter((k) => k in payload);
  console.log(`  agent-only / calling fields present: ${present.length ? `**${present.join(", ")}**` : "NONE"}`);
  if (present.length) throw new Error("The response-engine payload carries agent or calling fields. Refusing.");

  head("3. Preflight");
  const gate = canWriteLive(env);
  console.log(`  tag              : ${config.allowedTag}`);
  console.log(`  enabled          : ${config.enabled}`);
  console.log(`  live writes      : ${config.liveWritesEnabled}`);
  console.log(`  dry run          : ${config.dryRun}`);
  console.log(`  api key present  : ${config.hasApiKey}`);
  console.log(`  api base valid   : ${config.apiBaseUrlValid}`);
  console.log(`  canWriteLive     : ${gate.allowed}${gate.allowed ? "" : ` — ${gate.reasons.join("; ")}`}`);

  if (config.allowedTag === "prod") {
    throw new Error("REFUSING: RETELL_ALLOWED_TAG is 'prod'. This milestone is authorised for the dev account only.");
  }

  if (PREVIEW_ONLY) {
    head("PREVIEW COMPLETE");
    console.log("  NOTHING WAS SENT. No response engine exists as a result of this run.");
    console.log("  Re-run with --create-one-response-engine to perform the single authorised write.");
    line("=");
    return;
  }

  if (!gate.allowed) {
    throw new Error(`Refusing to attempt a write: ${gate.reasons.join("; ")}`);
  }

  // ── THE ONE WRITE ────────────────────────────────────────────────
  head("4. Sending ONE createResponseEngine request");
  console.log("  If this times out or the answer is lost, DO NOT RUN THIS AGAIN.");
  console.log("  Check the Retell dashboard first — the engine may exist.");
  console.log("");

  const { createRetellAdapter } = require(path.join(ROOT, "src/services/retell-adapter"));
  // The transport, supplied for this command only.
  const adapter = createRetellAdapter({ config, env, fetchImpl: (...a) => globalThis.fetch(...a) });

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await adapter.createResponseEngine({
      payload,
      idempotencyKey: `acq-engine-${SPEC_VERSION}`,
    });
  } catch (err) {
    head("AMBIGUOUS FAILURE — STOP");
    console.error(`  ${err.message}`);
    console.error("");
    console.error("  Whether Retell created the engine is UNKNOWN. Do not run this again.");
    console.error("  Look in the Retell dashboard for a Retell LLM created around now.");
    process.exit(2);
  }

  head("5. Result");
  if (!result.ok) {
    const e = result.error || {};
    console.log(`  REFUSED  code=${e.code} status=${e.status || "-"} req=${result.providerRequestId || "-"}`);
    console.log(`  ${e.message || ""}`);
    console.log("");
    // A definitive refusal (4xx) means nothing was created. An ambiguous one
    // does not, and the two must not be reported the same way.
    const ambiguous = ["provider_timeout", "provider_unreachable", "provider_error"].includes(e.code);
    if (ambiguous) {
      console.log("  ** AMBIGUOUS ** — the engine MAY have been created. Do not retry.");
      console.log("  Check the Retell dashboard before any further request.");
      process.exit(2);
    }
    console.log("  Definitive refusal: nothing was created. Safe to correct and run again.");
    process.exit(1);
  }

  const id = result.resource && result.resource.id;
  console.log(`  CREATED`);
  console.log(`  llm_id            : ${id || "(none returned — see below)"}`);
  console.log(`  resource version  : ${result.resource ? result.resource.version : null}`);
  console.log(`  provider request  : ${result.providerRequestId || "-"}`);
  console.log(`  latency           : ${result.latencyMs}ms`);
  console.log(`  spec version      : ${SPEC_VERSION}`);
  console.log(`  requested at      : ${startedAt}`);

  if (!id) {
    head("NO ID RETURNED — TREAT AS AMBIGUOUS");
    console.log("  Retell reported success without an id. The engine may exist and be");
    console.log("  unreferenceable. Check the dashboard. DO NOT run this again.");
    process.exit(2);
  }

  head("6. Record it — BY HAND, NOT BY THIS SCRIPT");
  console.log("  Set this in the deployment environment, NOT in git:");
  console.log("");
  console.log(`    RETELL_ACQUISITION_LLM_ID=${id}`);
  console.log("");
  console.log("  NOTHING ELSE WAS CREATED. There is no acquisition agent, no phone");
  console.log("  number and no webhook. Acquisition calling remains impossible.");
  line("=");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
