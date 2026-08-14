#!/usr/bin/env node
// ============================================================================
// E-12K — THE FIRST CONTROLLED ACQUISITION CALL, AS A RUNBOOK
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-proof-runbook.js
//
// READ-ONLY, AND THERE IS NO EXECUTION FLAG.
//
// ── WHY NO --execute FLAG EXISTS YET ────────────────────────────────
// Because there is nothing to execute with: no acquisition agent, no outbound
// number, no founder authorisation, and every provider is live:false. A script
// carrying a live-call path for resources that do not exist is a live-call path
// sitting in the repository waiting for those resources to appear.
//
// When the execution wrapper is written it must delegate to the EXISTING
// executor — `executeAuthorisedDial`, which runs the M8E pre-dial gate and
// claims the durable dispatch. It must not call the Retell adapter, must not
// take a list, and must not retry. That contract is asserted by tests in
// test/acquisition-proof-runbook.test.js so the wrapper cannot be written any
// other way without failing the build.
// ============================================================================

const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { PROOF_PHASES, assessQueueDrainRisk, assessProviderActivation } = require(path.join(ROOT, "src/services/acquisition-proof-plan"));

const line = (c = "-") => console.log(c.repeat(78));
const head = (t) => { console.log(""); line("="); console.log(`  ${t}`); line("="); };

function main() {
  console.log("");
  line("=");
  console.log("  E-12K — CONTROLLED FIRST-PROOF RUNBOOK (read-only, no execution path)");
  line("=");

  head("STRUCTURAL SAFETY — CHECKED NOW, NOT ASSERTED");

  const q = assessQueueDrainRisk();
  console.log("  QUEUE DRAIN RISK");
  line("-");
  console.log(`  modules reachable from server.js : ${q.modulesReachable}`);
  console.log(`  dial executor reachable          : ${q.executorReachableFromServer}`);
  console.log(`  executor callers in that graph   : ${q.executorCallersInServerGraph.length || "none"}`);
  console.log(`  schedulers in that graph         : ${q.schedulersInServerGraph.length || "none"}`);
  console.log(`  verdict                          : ${q.safe ? "SAFE" : "*** UNSAFE ***"}`);
  console.log("");
  console.log(`  ${q.reason}`);

  const a = assessProviderActivation();
  console.log("");
  console.log("  PROVIDER ACTIVATION");
  line("-");
  console.log(`  activatable by configuration     : ${a.activatableByConfiguration}`);
  console.log(`  live is a literal false          : ${a.liveIsLiteralFalse}`);
  console.log(`  requires an injected transport   : ${a.requiresInjectedTransport}`);
  console.log(`  constructed anywhere in src/     : ${a.constructedAnywhereInSrc.length || "nowhere"}`);
  console.log("");
  console.log(`  ${a.reason}`);

  head("THE SEQUENCE");
  for (const p of PROOF_PHASES) {
    console.log("");
    console.log(`  PHASE ${p.phase} — ${p.title}`);
    line("-");
    for (const c of p.checks) console.log(`    [ ] ${c}`);
  }

  head("CURRENT STATE");
  console.log("  Run these for the live picture:");
  console.log("");
  console.log("    node scripts/dev/acquisition-preview-proof.js        readiness + blockers");
  console.log("    node scripts/dev/acquisition-provision-agent.js      agent payload preview");
  console.log("    node scripts/dev/acquisition-webhook-smoke.js --url  webhook negative probes");
  console.log("");
  console.log("  No call can be placed from this repository today, and this command has no");
  console.log("  path that could place one.");
  line("=");
  console.log("");
}

main();
