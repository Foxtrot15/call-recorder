#!/usr/bin/env node
// AIDA — Retell web-call sandbox runner (M7B).
//
//   node scripts/retell-web-sandbox.js                      assess only, free
//   node scripts/retell-web-sandbox.js --execute            resources + ONE web call
//   node scripts/retell-web-sandbox.js --execute --no-call   resources ONLY, no call
//   node scripts/retell-web-sandbox.js --execute --keep-resources
//   node scripts/retell-web-sandbox.js --execute --browser   Proof C harness
//   node scripts/retell-web-sandbox.js --cleanup-manifest <path>
//
// --no-call provisions the knowledge base, response engine and agent, verifies
// them, and stops. No web call, no browser harness, no call resource of any
// kind. It exists so an agent can be created for the Retell dashboard — to bind
// a number to later — without spending a call to do it. It is mutually
// exclusive with --browser, whose entire purpose is to create one.
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

// Load .env, the same way src/server.js does.
//
// Without this the script read process.env only, so every variable placed in
// .env was invisible: a fully-configured sandbox still reported all nine gates
// missing, looking exactly like nothing had been set. The alternative was
// exporting the API key in a shell, which puts it in shell history.
//
// The path is pinned to the repository root rather than left to the working
// directory. The server is always started from the root; a standalone script is
// not, and a silent "no .env found" is the confusing failure this fixes.
//
// dotenv does NOT overwrite variables already present in process.env, so an
// exported shell value still wins over .env. That is the default and is the
// precedence we want — no override flag is passed, deliberately.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { evaluateSandboxGate, evaluateKeepResources, evaluateRunMode } = require("../src/config/retell-sandbox");
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
const WANT_BROWSER = has("--browser");
const WANT_NO_CALL = has("--no-call");
const CLEANUP_MANIFEST = valueOf("--cleanup-manifest");
const SDK_SPECIFIER = valueOf("--sdk");

// Which mode the flags select, decided by a PURE function so the combinations
// are testable without spawning this script. Contradictions fail closed.
const RUN_MODE = evaluateRunMode({ execute: WANT_EXECUTE, browser: WANT_BROWSER, noCall: WANT_NO_CALL });

const line = (c = "─") => console.log(c.repeat(74));
const heading = (t) => { console.log(); line(); console.log(`  ${t}`); line(); };

// Production refuses before anything else is even considered.
if ((process.env.NODE_ENV || "development") === "production") {
  console.error("Refusing to run the Retell sandbox in production.");
  process.exit(1);
}

// Contradictory flags refuse before any gate is even read, so an incoherent
// command can never reach a provider request.
if (!RUN_MODE.ok) {
  console.error("Refusing to run — contradictory flags:");
  for (const e of RUN_MODE.errors) console.error(`  • ${e}`);
  process.exit(1);
}

async function main() {
  if (CLEANUP_MANIFEST) return cleanupFromManifest(CLEANUP_MANIFEST);

  const gate = evaluateSandboxGate(process.env);

  heading("AIDA — Retell web-call sandbox");
  console.log(`  mode          : ${RUN_MODE.mode}${RUN_MODE.mode === "provision" ? " (resources only — NO call of any kind)" : ""}`);
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
  if (RUN_MODE.createCall) {
    console.log(`  6. ONE web call     (no phone number, no dialling)`);
    console.log(`  7. verify call      bound to the sandbox agent`);
  } else if (RUN_MODE.startBrowser) {
    console.log(`  6. browser harness  the call is minted by YOUR click, not by this script`);
  } else {
    console.log(`  6. STOP             --no-call: no web call, no browser harness, no call resource`);
  }
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
  if (!RUN_MODE.createCall && !RUN_MODE.startBrowser) {
    console.log("  --no-call: NO web call and NO telephone call will be created.");
  }
  console.log();

  const keep = evaluateKeepResources(process.env, { commandLineFlag: WANT_KEEP });
  console.log(`  cleanup       : ${keep.keep ? "RESOURCES WILL BE KEPT" : "automatic after validation"} (${keep.reason})`);
  console.log();

  const adapter = buildLiveAdapter();
  const runResult = await sandbox.runWebCallSandbox({
    adapter,
    config: gate.config,
    logger: console,
    // With --browser the call is NOT created during provisioning. The access
    // token lives about 30 seconds, so it is minted by the browser's own click
    // instead — see the harness section below.
    // Decided by the pure mode resolver, not by re-deriving it here. In
    // `provision` mode this is false and no harness is started either, so the
    // run creates a knowledge base, a response engine and an agent — and no
    // call resource of any kind.
    createCall: RUN_MODE.createCall,
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

  // ── Browser harness (Proof C) ─────────────────────────────────────
  if (RUN_MODE.startBrowser && runResult.ok && runResult.created.agentId) {
    const outcome = await runBrowserHarness({ adapter, runResult });
    heading("Cleanup");
    const cleanup = await sandbox.cleanupSandbox({ adapter, resources: runResult.created, logger: console });
    for (const o of cleanup.outcomes) console.log(`  ${o.outcome === "failed" ? "✗" : "·"} ${o.kind.padEnd(18)} ${o.outcome}`);
    if (cleanup.callNote) console.log(`  · ${cleanup.callNote}`);
    updateManifest(manifestPath, { cleanupState: cleanup.ok ? "cleaned" : "partial_failure", browserProof: outcome });
    if (!cleanup.ok) {
      console.log();
      console.log("  Still present — delete these in the Retell dashboard:");
      for (const r of cleanup.remaining) console.log(`      ${r.kind}: ${r.id}`);
      return 3;
    }
    return outcome.callCreated ? 0 : 4;
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

// ── Proof C: the browser harness ────────────────────────────────────

/**
 * Serve the isolated harness and wait for the operator to run one call.
 *
 * The call is created by the browser's POST — not here — because the access
 * token is invalidated about 30 seconds after creation. Minting it during
 * provisioning and expecting someone to open a browser in time is a race that
 * cannot be won.
 */
async function runBrowserHarness({ adapter, runResult }) {
  const harnessModule = require("../src/services/retell-browser-harness");

  const outcome = { callCreated: false, callId: null, agentId: runResult.created.agentId, error: null };

  const harness = harnessModule.createBrowserHarness({
    agentId: runResult.created.agentId,
    language: getRetellConfig(process.env).defaultLanguage,
    sandboxNames: runResult.names,
    sdkSpecifier: SDK_SPECIFIER || undefined,
    logger: console,
    createCall: async () => {
      const created = await sandbox.createSandboxWebCall({
        adapter,
        agentId: runResult.created.agentId,
        logger: console,
      });
      if (created.ok) {
        outcome.callCreated = true;
        outcome.callId = created.callId;
      } else {
        outcome.error = created.code;
      }
      return created;
    },
  });

  const started = await harnessModule.startBrowserHarness(harness, { logger: console });

  heading("PROOF C — AIDA's own browser web-call");
  console.log("  A local harness is now serving on loopback only. Nothing has been called yet.");
  console.log();
  console.log(`  OPEN THIS IN A BROWSER:`);
  console.log(`    ${started.url}`);
  console.log();
  console.log("  The key is in the URL fragment, which browsers never send to a server.");
  console.log("  Then press \"Start test call\". That click — and only that click — creates");
  console.log(`  the web call and joins it within the provider's ~${harnessModule.TOKEN_WINDOW_SECONDS}-second token window.`);
  console.log();
  console.log("  ⚠  This places a REAL, BILLABLE Retell web call. Keep it short.");
  console.log();
  console.log("  Press Ctrl+C when you have finished to clean up the sandbox resources.");
  console.log();

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    process.once("SIGINT", () => { console.log("\n  Stopping the harness…"); finish(); });
    // Bounded so an unattended run cannot leave a server and paid resources
    // alive indefinitely.
    setTimeout(() => { console.log("\n  Harness time limit reached."); finish(); }, 15 * 60 * 1000).unref();
  });

  await started.close();

  console.log();
  console.log(`  browser call created : ${outcome.callCreated ? `yes (${outcome.callId})` : "no"}`);
  if (outcome.error) console.log(`  last error           : ${outcome.error}`);
  console.log();
  console.log("  NOTE: this script can confirm the backend issued a call to this browser.");
  console.log("  Whether two-way AUDIO actually worked is something only the person at the");
  console.log("  browser can confirm — record that observation yourself.");

  return outcome;
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
