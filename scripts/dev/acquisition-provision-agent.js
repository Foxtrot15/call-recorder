#!/usr/bin/env node
// ============================================================================
// E-12E — CREATE THE ACQUISITION AGENT. ONCE. NOTHING ELSE.
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-provision-agent.js
//
//   ... --create-one-agent      performs the ONE authorised write
//
// ── WHAT THIS CAN AND CANNOT DO ─────────────────────────────────────
// It creates ONE Retell agent, pointing at the response engine that already
// exists. An agent has a voice and a webhook, so unlike the engine it CAN be
// spoken through — but it still has no telephone number, no live provider and
// no unpaused calling state, so creating it cannot place a call. Those are
// three separate authorities and this script touches none of them.
//
// It calls exactly ONE endpoint: createAgent. There is no code path here to
// createResponseEngine, updateResponseEngine, createPhoneCall, createWebCall,
// bindPhoneNumber or updateAgent, and a ratchet asserts that by reading this
// file.
//
// ── NO RETRY. THIS IS THE IMPORTANT PART. ───────────────────────────
// A timeout or a lost response does NOT mean nothing was created. Retell may
// have built the agent and lost the answer on the way back. Calling create
// again would be how one authorised write becomes two acquisition agents —
// and unlike a duplicate response engine, a duplicate AGENT is a thing that
// can telephone people.
//
// So on ANY ambiguous failure this stops and says so, and the next step is to
// LOOK in the Retell dashboard before anybody sends anything else.
//
// If the write SUCCEEDS and recording the id afterwards fails, the id is
// printed loudly and repeatedly. An unrecorded agent that exists is far more
// dangerous than a recorded one that does not.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { SPEC_VERSION } = require(path.join(ROOT, "src/services/acquisition-agent-spec"));
const {
  assessAcquisitionAgentProvisioning,
  classifyCreateAgentFailure,
  REFUSALS,
} = require(path.join(ROOT, "src/services/acquisition-agent-provisioning"));

const PREVIEW_ONLY = !process.argv.includes("--create-one-agent");

const line = (c = "-") => console.log(c.repeat(74));
const head = (t) => { console.log(""); line("="); console.log(t); line("="); };

/** Load the env file the dev proofs already use. Values are never printed. */
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

const EXPLAIN = {
  [REFUSALS.PROD_TAG]: "RETELL_ALLOWED_TAG is 'prod'. The pilot agent belongs on the dev account.",
  [REFUSALS.ENGINE_DRIFT]: "The local response-engine payload no longer matches the provisioned engine. The agent would point at a prompt nobody reviewed.",
  [REFUSALS.ENGINE_ID_MISSING]: "RETELL_ACQUISITION_LLM_ID is not set. An agent with no engine has no brain.",
  [REFUSALS.VOICE_MISSING]: "RETELL_ACQUISITION_VOICE_ID is not set. Acquisition never borrows the receptionist's voice.",
  [REFUSALS.VOICE_MISMATCH]: "The payload's voice is not the configured acquisition voice.",
  [REFUSALS.VOICEMAIL_NOT_HANGUP]: "The answering-machine action is not 'hangup'. Founder policy is to leave no message.",
  [REFUSALS.VOICEMAIL_MESSAGE]: "The voicemail option carries text. Founder policy is to leave no message.",
  [REFUSALS.LANGUAGE]: "The agent language is not en-AU.",
  [REFUSALS.WEBHOOK_MISSING]: "RETELL_ACQUISITION_WEBHOOK_URL is not set. Outcomes would be delivered nowhere.",
  [REFUSALS.WEBHOOK_INSECURE]: "The acquisition webhook URL is not a valid https URL.",
  [REFUSALS.WEBHOOK_LOCAL]: "The acquisition webhook URL points at a local/private host Retell cannot reach.",
  [REFUSALS.ALREADY_PROVISIONED]: "An acquisition agent is already recorded. A second one must never be created.",
  [REFUSALS.NOT_READY]: "The agent spec reports it is not create-ready.",
};

async function main() {
  console.log("");
  line("=");
  console.log("  E-12E — ACQUISITION AGENT");
  console.log(`  mode: ${PREVIEW_ONLY ? "PREVIEW ONLY — nothing will be sent" : "CREATE — ONE write will be attempted"}`);
  line("=");

  const env = loadEnv();
  const { getRetellConfig, canWriteLive } = require(path.join(ROOT, "src/config/retell"));
  const config = getRetellConfig(env);

  // ── Has one already been recorded? ───────────────────────────────
  // The durable "one agent, ever" authority is E-12F. Until it is wired, this
  // script cannot know whether an agent already exists, and creating one
  // blindly is exactly the mistake that authority exists to prevent — so
  // create mode is refused below. Preview works fully.
  let existingResource = null;
  let authorityReadable = false;
  try {
    // eslint-disable-next-line global-require
    const authority = require(path.join(ROOT, "src/services/acquisition-resource-authority"));
    existingResource = await authority.readAcquisitionAgentResource({ env });
    authorityReadable = true;
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") {
      console.log(`\n  ! could not read the provisioning authority: ${err.message}`);
    }
  }

  const verdict = assessAcquisitionAgentProvisioning({ env, config, existingResource });

  head("1. The exact payload");
  if (verdict.payload) {
    console.log(JSON.stringify({ ...verdict.payload, post_call_analysis_data: `<${verdict.payload.post_call_analysis_data.length} fields>` }, null, 2));
  } else {
    const a = verdict.resources.agent;
    console.log(JSON.stringify({ ...a, post_call_analysis_data: `<${a.post_call_analysis_data.length} fields>` }, null, 2));
    console.log("\n  (shown for review — this payload is NOT create-ready, see section 3)");
  }

  head("2. What this payload is NOT");
  const forbidden = ["general_prompt", "begin_message", "general_tools", "default_dynamic_variables", "from_number", "to_number", "phone_number"];
  const present = forbidden.filter((k) => k in verdict.resources.agent);
  console.log(`  engine-only / calling fields present: ${present.length ? `**${present.join(", ")}**` : "NONE"}`);
  if (present.length) throw new Error("The agent payload carries response-engine or calling fields. Refusing.");

  head("3. Preflight");
  const c = verdict.checks;
  const gate = canWriteLive(env);
  console.log(`  retell tag           : ${c.allowedTag || "(unset — defaults to dev)"}`);
  console.log(`  NODE_ENV             : ${c.nodeEnv || "(unset)"}   (does not affect which account is written to)`);
  console.log(`  engine hash expected : ${c.engineHashExpected}`);
  console.log(`  engine hash actual   : ${c.engineHashActual}`);
  console.log(`  engine drifted       : ${c.engineDrifted}`);
  console.log(`  llm_id present       : ${c.llmIdPresent}`);
  console.log(`  acquisition voice    : ${c.voiceSelected || "(unset)"}`);
  console.log(`  voice on payload     : ${c.voiceOnPayload || "(null)"}`);
  console.log(`  voicemail action     : ${c.voicemailAction || "(none)"}`);
  console.log(`  language             : ${c.language}`);
  console.log(`  webhook url          : ${c.webhookUrl || "(unset)"}`);
  console.log(`  agent already exists : ${c.alreadyProvisioned}${authorityReadable ? "" : "  (AUTHORITY UNREADABLE)"}`);
  console.log(`  createAgentReady     : ${c.createAgentReady}`);
  console.log(`  canWriteLive         : ${gate.allowed}${gate.allowed ? "" : ` — ${gate.reasons.join("; ")}`}`);

  if (verdict.refusals.length) {
    head("REFUSED — NOT CREATE-READY");
    for (const r of verdict.refusals) console.log(`  • ${r}\n      ${EXPLAIN[r] || ""}`);
    console.log("");
    console.log("  Nothing was sent. This is the truthful state, not a script failure.");
    line("=");
    if (!PREVIEW_ONLY) process.exit(1);
    return;
  }

  if (PREVIEW_ONLY) {
    head("PREVIEW COMPLETE");
    console.log("  NOTHING WAS SENT. No acquisition agent exists as a result of this run.");
    console.log("  Re-run with --create-one-agent to perform the single authorised write.");
    line("=");
    return;
  }

  if (!gate.allowed) throw new Error(`Refusing to attempt a write: ${gate.reasons.join("; ")}`);

  // ── The one-agent guard must exist before one agent may be created ──
  // Without a durable record of whether an acquisition agent already exists,
  // a second run of this script would create a second agent — and an agent is
  // a thing that can be spoken through. Refusing here is the whole reason the
  // authority is a prerequisite rather than a nicety.
  if (!authorityReadable) {
    head("REFUSED — THE ONE-AGENT GUARD IS NOT AVAILABLE");
    console.log("  The durable provisioning authority could not be read, so this script");
    console.log("  cannot know whether an acquisition agent already exists.");
    console.log("  Refusing to create one blindly. Preview mode is unaffected.");
    line("=");
    process.exit(1);
  }

  // ── THE ONE WRITE ────────────────────────────────────────────────
  head("4. Sending ONE createAgent request");
  console.log("  If this times out or the answer is lost, DO NOT RUN THIS AGAIN.");
  console.log("  Check the Retell dashboard first — the agent may exist.");
  console.log("");

  const { createRetellAdapter } = require(path.join(ROOT, "src/services/retell-adapter"));
  const adapter = createRetellAdapter({ config, env, fetchImpl: (...a) => globalThis.fetch(...a) });

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await adapter.createAgent({
      payload: verdict.payload,
      idempotencyKey: `acq-agent-${SPEC_VERSION}`,
    });
  } catch (err) {
    head("AMBIGUOUS FAILURE — STOP");
    console.error(`  ${err.message}`);
    console.error("");
    console.error("  Whether Retell created the AGENT is UNKNOWN. Do not run this again.");
    console.error("  An agent can be spoken through. Look in the dashboard before anything else.");
    process.exit(2);
  }

  head("5. Result");
  if (!result.ok) {
    const e = result.error || {};
    const verdictOnFailure = classifyCreateAgentFailure(e.code);
    console.log(`  REFUSED  code=${e.code} status=${e.status || "-"} req=${result.providerRequestId || "-"}`);
    console.log(`  ${e.message || ""}`);
    console.log("");
    if (verdictOnFailure.status === "unknown") {
      console.log("  ** AMBIGUOUS ** — the agent MAY have been created. Do not retry.");
      console.log("  Check the Retell dashboard before any further request.");
      process.exit(2);
    }
    console.log("  Definitive refusal: nothing was created. Safe to correct and run again.");
    process.exit(1);
  }

  const id = result.resource && result.resource.id;
  console.log(`  CREATED`);
  console.log(`  agent_id          : ${id || "(none returned — see below)"}`);
  console.log(`  resource version  : ${result.resource ? result.resource.version : null}`);
  console.log(`  provider request  : ${result.providerRequestId || "-"}`);
  console.log(`  latency           : ${result.latencyMs}ms`);
  console.log(`  spec version      : ${SPEC_VERSION}`);
  console.log(`  requested at      : ${startedAt}`);

  if (!id) {
    head("NO ID RETURNED — TREAT AS AMBIGUOUS");
    console.log("  Retell reported success without an id. The agent may exist and be");
    console.log("  unreferenceable. Check the dashboard. DO NOT run this again.");
    process.exit(2);
  }

  // ── Record it durably. Failure here is LOUD, never a second create. ──
  head("6. Recording the agent in the provisioning authority");
  try {
    // eslint-disable-next-line global-require
    const { recordAcquisitionAgentResource } = require(path.join(ROOT, "src/services/acquisition-resource-authority"));
    await recordAcquisitionAgentResource({
      env,
      providerResourceId: id,
      providerVersion: result.resource ? result.resource.version : null,
      payload: verdict.payload,
      providerTag: config.allowedTag,
    });
    console.log("  recorded.");
  } catch (err) {
    head("!!! AGENT CREATED BUT NOT RECORDED — RECONCILIATION REQUIRED !!!");
    console.error(`  persistence failed: ${err.message}`);
    console.error("");
    console.error(`      THE AGENT EXISTS.  agent_id = ${id}`);
    console.error(`      THE AGENT EXISTS.  agent_id = ${id}`);
    console.error(`      THE AGENT EXISTS.  agent_id = ${id}`);
    console.error("");
    console.error("  DO NOT run this script again — it would create a SECOND agent.");
    console.error("  Record the id above by hand, then reconcile the provisioning table.");
    process.exit(3);
  }

  head("7. What to set, BY HAND, NOT BY THIS SCRIPT");
  console.log("  Set this in the deployment environment, NOT in git:");
  console.log("");
  console.log(`    RETELL_ACQUISITION_AGENT_ID=${id}`);
  console.log("");
  console.log("  NOTHING ELSE CHANGED. There is no acquisition phone number, the");
  console.log("  provider is still live:false and calling is still paused, so this");
  console.log("  agent cannot telephone anybody.");
  line("=");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
