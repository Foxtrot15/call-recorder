#!/usr/bin/env node
// AIDA — Retell web-call sandbox runner (M7B).
//
//   node scripts/retell-web-sandbox.js                      assess only, free
//   node scripts/retell-web-sandbox.js --execute            creates resources
//   node scripts/retell-web-sandbox.js --execute --keep-resources
//   node scripts/retell-web-sandbox.js --cleanup-manifest <path>
//
// DEFAULT BEHAVIOUR SPENDS NOTHING AND CONTACTS NOTHING. Without --execute this
// prints the gate assessment and the plan, then exits.
//
// ─── WHY THIS IS NOT THE PHONE-CALL PATH ────────────────────────────
// RETELL_LIVE_CALLS_ENABLED governs telephone calls; it needs an outbound
// number and can ring a real handset. A web call needs none of that. Routing a
// browser microphone test through the telephone gate would mean enabling real
// dialling to test a browser, so this has its own gate and REFUSES to run while
// the telephone gate is on.
//
// Never prints the API key. Never prints or persists a web-call access token.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { evaluateSandboxGate, evaluateKeepResources } = require("../src/config/retell-sandbox");
const { getRetellConfig } = require("../src/config/retell");
const sandbox = require("../src/services/retell-web-sandbox");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const WANT_EXECUTE = has("--execute");
const WANT_KEEP = has("--keep-resources");
const CLEANUP_MANIFEST = valueOf("--cleanup-manifest");

const line = (c = "─") => console.log(c.repeat(74));
const heading = (t) => { console.log(); line(); console.log(`  ${t}`); line(); };

// Production refuses before anything else is even considered.
if ((process.env.NODE_ENV || "development") === "production") {
  console.error("Refusing to run the Retell sandbox in production.");
  process.exit(1);
}

async function main() {
  if (CLEANUP_MANIFEST) return cleanupFromManifest(CLEANUP_MANIFEST);

  const gate = evaluateSandboxGate(process.env);

  heading("AIDA — Retell web-call sandbox");
  console.log(`  mode          : ${WANT_EXECUTE ? "EXECUTE" : "assessment only (no request will be made)"}`);
  console.log(`  node env      : ${gate.config.nodeEnv}`);
  console.log(`  allowed tag   : ${gate.config.allowedTag}`);
  console.log(`  voice id      : ${gate.config.voiceId ? "set (from RETELL_DEFAULT_VOICE_ID)" : "NOT SET"}`);
  console.log(`  language      : ${gate.config.language || "NOT SET"}`);
  console.log(`  api key       : ${gate.config.hasApiKey ? "present (never printed)" : "NOT SET"}`);

  heading("Gate assessment");
  if (gate.allowed) {
    console.log("  ✓ every sandbox gate is satisfied");
  } else {
    console.log(`  ✗ ${gate.blockers.length} blocker(s):`);
    for (const b of gate.blockers) console.log(`      - ${b}`);
  }
  console.log();
  console.log("  Not required by this sandbox:");
  for (const n of gate.notRequired) console.log(`      · ${n}`);

  heading("Intended resource plan");
  const names = sandbox.sandboxNames(sandbox.stampFrom(new Date()));
  console.log(`  1. knowledge base   "${names.knowledgeBase}"   (multipart, fictional content)`);
  console.log(`  2. wait for status "complete"                  (max ${gate.config.kbMaxWaitMs}ms, poll ${gate.config.kbPollMs}ms)`);
  console.log(`  3. response engine  "${names.responseEngine}"  (knowledge_base_ids attached)`);
  console.log(`  4. voice agent      "${names.agent}"           (recording off, no webhook, no number)`);
  console.log(`  5. verify agent     response_engine.llm_id, voice_id, language`);
  console.log(`  6. ONE web call     (no phone number, no dialling)`);
  console.log(`  7. verify call      bound to the sandbox agent`);
  console.log();
  console.log("  Nothing existing is updated. No number is bought, imported or bound.");

  if (!WANT_EXECUTE) {
    heading("No action taken");
    console.log("  This was an assessment. No provider request was made and nothing was charged.");
    console.log();
    console.log("  To run for real once the gates above pass:");
    console.log("    node scripts/retell-web-sandbox.js --execute");
    console.log();
    return 0;
  }

  if (!gate.allowed) {
    heading("Refusing to execute");
    console.log("  The gates above are not satisfied. Nothing was contacted.");
    return 2;
  }

  // ── The warning, before the first provider request ────────────────
  heading("⚠  ABOUT TO CONTACT RETELL");
  console.log("  This will create temporary Retell resources.");
  console.log("  This may incur a small Retell charge.");
  console.log("  No phone number will be bought, imported, bound or called.");
  console.log("  Recording is disabled. No webhook is configured.");
  console.log();

  const keep = evaluateKeepResources(process.env, { commandLineFlag: WANT_KEEP });
  console.log(`  cleanup       : ${keep.keep ? "RESOURCES WILL BE KEPT" : "automatic after validation"} (${keep.reason})`);
  console.log();

  const adapter = buildLiveAdapter();
  const runResult = await sandbox.runWebCallSandbox({
    adapter,
    config: gate.config,
    logger: console,
  });

  heading("Result");
  for (const step of runResult.results) {
    console.log(`  ${step.ok ? "✓" : "✗"} ${step.step.padEnd(24)} ${step.detail || ""}`);
  }
  console.log();
  for (const v of runResult.validations) {
    console.log(`  ${v.ok ? "✓" : "✗"} ${v.check.padEnd(32)} ${v.detail || ""}`);
  }

  // ── Manifest ──────────────────────────────────────────────────────
  const manifest = sandbox.buildManifest(runResult, { keptResources: keep.keep });
  const manifestPath = writeManifest(manifest);
  heading("Manifest");
  console.log(`  ${manifestPath}`);
  console.log("  Contains ids and timings only — no API key, no access token, no transcript.");

  // ── What was and was not proven ───────────────────────────────────
  if (runResult.ok && runResult.created.callId) {
    heading("What this run proved");
    const p = runResult.proofs;

    console.log("  ✓ PROOF A — the create-web-call API path");
    for (const c of p.proofA_createWebCallApi.covers) console.log(`      · ${c}`);
    console.log();
    console.log(`  call id     : ${runResult.created.callId}`);
    console.log(`  call status : ${runResult.created.callStatus} (initial)`);
    console.log(`  access token: received, held in memory only — NOT printed, NOT stored.`);
    console.log();
    console.log("  ✗ PROOF B — human audio and agent behaviour: NOT established.");
    console.log(`      ${p.proofB_humanAudio.note}`);
    console.log();
    console.log("  ✗ PROOF C — AIDA's full browser flow: NOT established.");
    console.log(`      ${p.proofC_aidaBrowserFlow.note}`);
    console.log();
    console.log(`  ⚠  ${p.warning}`);
    console.log();
    console.log("  This was an UNATTENDED API test. No browser joined, so no audio");
    console.log("  occurred and nothing was spoken. The call will shortly move to");
    console.log("  \"not_connected\" or \"error\" because the ~30-second token window will");
    console.log("  pass unused. That is EXPECTED here and does not retract Proof A.");
    console.log();
    console.log("  The token is not printed because it could not be pasted into a browser");
    console.log("  in time. A real conversation needs the token minted at the moment the");
    console.log("  browser joins — see docs/RETELL_SANDBOX_VALIDATION_PLAN.md.");
  }

  // ── Cleanup ───────────────────────────────────────────────────────
  let exitCode = runResult.ok ? 0 : 1;

  if (keep.keep) {
    heading("Resources kept");
    console.log("  You asked for the resources to be kept. They cost money while they exist.");
    printResources(runResult.created);
    console.log();
    console.log(`  Clean up later with:`);
    console.log(`    node scripts/retell-web-sandbox.js --cleanup-manifest "${manifestPath}"`);
    return exitCode;
  }

  heading("Cleanup");
  const cleanup = await sandbox.cleanupSandbox({ adapter, resources: runResult.created, logger: console });
  for (const o of cleanup.outcomes) console.log(`  ${o.outcome === "failed" ? "✗" : "·"} ${o.kind.padEnd(18)} ${o.outcome}${o.errorCode ? ` (${o.errorCode})` : ""}`);
  if (cleanup.callNote) console.log(`  · ${cleanup.callNote}`);

  updateManifest(manifestPath, { cleanupState: cleanup.ok ? "cleaned" : "partial_failure", cleanupRemaining: cleanup.remaining });

  if (!cleanup.ok) {
    heading("⚠  CLEANUP INCOMPLETE — MANUAL ACTION REQUIRED");
    console.log("  These provider resources still exist and may still be charged for:");
    for (const r of cleanup.remaining) console.log(`      ${r.kind}: ${r.id}`);
    console.log();
    console.log("  Delete them in the Retell dashboard, or retry:");
    console.log(`    node scripts/retell-web-sandbox.js --cleanup-manifest "${manifestPath}"`);
    exitCode = 3;
  }

  return exitCode;
}

// ── Cleanup from a manifest ─────────────────────────────────────────

async function cleanupFromManifest(manifestPath) {
  heading("AIDA — Retell sandbox cleanup");
  console.log(`  manifest: ${manifestPath}`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`  Could not read the manifest: ${err.message}`);
    return 2;
  }

  const gate = evaluateSandboxGate(process.env);
  // Cleanup needs credentials and live writes, but NOT the execute flag —
  // otherwise tidying up after a run would require re-arming the thing that
  // created the resources.
  const needed = gate.blockers.filter((b) => !/SANDBOX_EXECUTE/.test(b));
  if (needed.length) {
    console.error("  Cannot clean up — the provider is not reachable with this configuration:");
    for (const b of needed) console.error(`      - ${b}`);
    return 2;
  }

  const resources = manifest.resources || {};
  printResources(resources);

  const cleanup = await sandbox.cleanupSandbox({ adapter: buildLiveAdapter(), resources, logger: console });
  for (const o of cleanup.outcomes) console.log(`  ${o.outcome === "failed" ? "✗" : "·"} ${o.kind.padEnd(18)} ${o.outcome}`);
  if (cleanup.callNote) console.log(`  · ${cleanup.callNote}`);

  updateManifest(manifestPath, { cleanupState: cleanup.ok ? "cleaned" : "partial_failure", cleanupRemaining: cleanup.remaining });

  if (!cleanup.ok) {
    console.log();
    console.log("  Still present — delete these in the Retell dashboard:");
    for (const r of cleanup.remaining) console.log(`      ${r.kind}: ${r.id}`);
    return 3;
  }
  console.log();
  console.log("  All sandbox resources are gone.");
  return 0;
}

// ── Helpers ─────────────────────────────────────────────────────────

function printResources(r) {
  for (const [k, v] of Object.entries(r || {})) {
    if (v) console.log(`      ${k}: ${v}`);
  }
}

/**
 * The manifest lives in the OS temp directory, deliberately OUTSIDE the
 * repository, so it can never be committed by accident.
 */
function writeManifest(manifest) {
  const dir = path.join(os.tmpdir(), "aida-retell-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sandbox-${manifest.createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
  return file;
}

function updateManifest(file, patch) {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), "utf8");
  } catch {
    // A manifest we cannot update is not a reason to fail a run that otherwise
    // succeeded; the console output above is the authoritative record.
  }
}

/**
 * The real adapter, built only after every gate has passed.
 *
 * ─── TRANSPORT ────────────────────────────────────────────────────
 * No SDK is involved. M3 chose Node's built-in fetch deliberately: the official
 * `retell-sdk` requires Node 20+ while this repo declares `"node": ">=18"`, and
 * raising the floor for every deploy to gain a thin REST wrapper was not worth
 * it. The adapter takes `fetchImpl` as an injected dependency and is INERT
 * without one — which is what keeps it unrunnable during tests.
 *
 * That inertness bit me: the first version of this script built the adapter
 * without a transport, so `--execute` would have failed on its very first
 * request with "no HTTP transport is configured" rather than exercising
 * anything. Injecting it here is the one place a real transport belongs.
 *
 * Required lazily so the assessment path never constructs it.
 */
function buildLiveAdapter() {
  const { createRetellAdapter } = require("../src/services/retell-adapter");

  if (typeof globalThis.fetch !== "function") {
    // Node 18+ has fetch built in. If it is missing the runtime is older than
    // the repo supports, and guessing at a polyfill would be worse than saying so.
    throw new Error(`This Node runtime (${process.version}) has no global fetch. Node 18 or newer is required.`);
  }

  return createRetellAdapter({
    config: getRetellConfig(process.env),
    fetchImpl: (...a) => globalThis.fetch(...a),
  });
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error();
    console.error("Sandbox failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
