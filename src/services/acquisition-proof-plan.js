// AIDA Locksmith Acquisition — the first controlled proof, as a plan (E-12K).
//
//   PROOF_PHASES                       the operator sequence, as data
//   assessQueueDrainRisk()             can enabling calling drain the queue?
//   assessProviderActivation()         what would it take to make one call?
//   POST_PROOF_CHECKS                  what must be true afterwards
//
// ── WHAT THIS IS ────────────────────────────────────────────────────
// The runbook for one real acquisition call, expressed as checkable data
// rather than prose somebody follows from memory. It places no call, and there
// is no execution path in this module or the command that prints it.
//
// ── THE QUESTION E-12K WAS BUILT TO ANSWER ──────────────────────────
// If the global calling state is enabled for one controlled proof, can anything
// automatically drain `acquisition_call_queue` or create a second dial?
//
// The answer is no, and the reason is stronger than a gate: **the dial executor
// is not reachable from the running server at all.** A transitive walk of
// requires from `server.js` reaches 105 modules, and
// `acquisition-dial-execution.js` is not one of them. `executeAuthorisedDial`
// is called only by two hand-run proof scripts.
//
// `selectNext` IS reachable, and that is fine: it reserves a prospect against a
// named worker. A reservation is not a call, and nothing turns one into a call
// because the thing that would is unreachable.
//
// So "global enabled + queue 0 + one founder proof" is sufficient today — not
// because we expect nothing to be enqueued, but because there is no consumer.
// `assessQueueDrainRisk` recomputes that at runtime rather than trusting this
// paragraph, and a ratchet fails the build if an executor ever becomes
// reachable from a route.

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..");

/** Every module reachable by require() from server.js, transitively. */
function reachableFromServer(entry = "server.js") {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let body;
    try {
      body = fs.readFileSync(path.join(SRC, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of body.matchAll(/require\("(\.[^"]+)"\)/g)) {
      let p = path.posix.normalize(path.posix.join(path.posix.dirname(rel.replace(/\\/g, "/")), m[1]));
      if (!p.endsWith(".js")) p += ".js";
      if (fs.existsSync(path.join(SRC, p))) stack.push(p);
    }
  }
  return seen;
}

/**
 * Can the running server place, or cause, an acquisition call?
 *
 * Computed from the module graph rather than asserted, so it stays true only
 * while it IS true. If a future milestone wires an executor into a route, this
 * flips and the accompanying ratchet fails.
 */
function assessQueueDrainRisk() {
  const reachable = reachableFromServer();
  const bodies = new Map();
  for (const rel of reachable) {
    try {
      bodies.set(rel, fs.readFileSync(path.join(SRC, rel), "utf8"));
    } catch { /* ignore */ }
  }
  const findsIn = (needle) => [...bodies.entries()].filter(([, b]) => b.includes(needle)).map(([r]) => r);

  const executorReachable = reachable.has("services/acquisition-dial-execution.js");
  const executorCallers = findsIn("executeAuthorisedDial(");
  // Timers that could run work without a request. The adapter's per-request
  // AbortController timeout is not a scheduler and is excluded by name.
  const schedulers = [...bodies.entries()]
    .filter(([rel, b]) => /setInterval\(|node-cron|\.schedule\(/.test(b) && rel !== "services/retell-adapter.js")
    .map(([r]) => r);

  const canDial = executorReachable || executorCallers.length > 0;

  return Object.freeze({
    safe: !canDial && schedulers.length === 0,
    executorReachableFromServer: executorReachable,
    executorCallersInServerGraph: Object.freeze(executorCallers),
    schedulersInServerGraph: Object.freeze(schedulers),
    modulesReachable: reachable.size,
    reason: canDial
      ? "A dial executor IS reachable from the running server. Enabling calling could now cause a call without a person asking for one."
      : "No dial executor is reachable from the running server, and no scheduler runs work without a request. "
        + "Enabling the global calling state cannot, by itself, cause any call — there is no consumer to drain the queue.",
  });
}

/**
 * What would it actually take to make the acquisition provider capable of one
 * call — and is any of it a flag somebody could flip by accident?
 *
 * The answer today is no. `live: false` is a hardcoded literal, the provider
 * reads no environment variable at all, and submitting requires a `transport`
 * function passed in by a caller. Nothing in src/ constructs the provider.
 *
 * That matters for a specific worry: the Retell API key IS present in staging.
 * It cannot become a call transport by flipping a flag, because no flag is
 * read — a person has to write code that passes a transport in.
 */
function assessProviderActivation() {
  const provider = fs.readFileSync(path.join(SRC, "services", "acquisition-retell-provider.js"), "utf8");
  const readsEnv = /process\.env|\benv\./.test(provider.replace(/^\s*\/\/.*$/gm, ""));
  const liveIsLiteralFalse = /live:\s*false,/.test(provider);
  const requiresInjectedTransport = /transport = null/.test(provider);

  const constructors = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.name.endsWith(".js")) continue;
      if (e.name === "acquisition-retell-provider.js") continue;
      if (/createRetellAcquisitionProvider\s*\(/.test(fs.readFileSync(path.join(SRC, rel), "utf8"))) constructors.push(rel);
    }
  };
  walk("services");
  walk("routes");

  return Object.freeze({
    activatableByConfiguration: readsEnv,
    liveIsLiteralFalse,
    requiresInjectedTransport,
    constructedAnywhereInSrc: Object.freeze(constructors),
    restartRequired: false,
    reason:
      "Activation is a CODE change, not a configuration change. `live` is a literal false, the provider reads no "
      + "environment variable, and submitting requires a transport function passed in by a caller. The Retell API key "
      + "being present in staging therefore cannot become a call transport by flipping a flag.",
  });
}

/** The operator sequence. Data, so the command and the tests read the same thing. */
const PROOF_PHASES = Object.freeze([
  Object.freeze({
    phase: 0,
    title: "READINESS",
    checks: Object.freeze([
      "the exact acquisition agent exists and is recorded in provider_resources",
      "the exact acquisition outbound number is configured (RETELL_ACQUISITION_OUTBOUND_NUMBER)",
      "the acquisition webhook is publicly reachable and returns 4xx to every negative probe",
      "the response-engine drift pin is green",
      "the acquisition voice is the founder's selection",
      "voicemail_option is action hangup, with no message",
      "every provider is still live:false",
      "calling is still paused",
    ]),
  }),
  Object.freeze({
    phase: 1,
    title: "COMPLIANCE — for ONE target",
    checks: Object.freeze([
      "exactly one prospect and one destination are named",
      "an AUTHORITATIVE DNCR wash exists for that number, imported and within 30 days",
      "the business and the number are not suppressed",
      "the moment is inside the permitted calling window",
      "the day is not a public holiday (fixture provider — A-L2 remains OPEN)",
      "attempt count and spacing permit a call (A-L6/A-L7)",
      "the prospect is qualified and duplicate-resolved",
    ]),
  }),
  Object.freeze({
    phase: 2,
    title: "FOUNDER AUTHORISATION",
    checks: Object.freeze([
      "a named human approver — not the system",
      "bound to that exact prospect, destination, from-number and agent",
      "a bounded validity window",
      "single use, identified by hash",
      "no campaign or list scope",
    ]),
  }),
  Object.freeze({
    phase: 3,
    title: "CONTROLLED ENABLE",
    checks: Object.freeze([
      "confirm the queue is empty (0 rows) BEFORE enabling anything",
      "confirm no dial executor is reachable from the running server (assessQueueDrainRisk)",
      "enable the global calling state by explicit revision — compare-and-set on the current revision",
      "record who enabled it and why",
      "NOTE: enabling is reversible and must be reversed in phase 6",
    ]),
  }),
  Object.freeze({
    phase: 4,
    title: "EXECUTION — one command, one destination",
    checks: Object.freeze([
      "a single explicit command, run by a person",
      "it delegates to the existing dial executor and the M8E pre-dial gate — it does NOT call the Retell adapter",
      "no loop, no list, no retry, no second destination",
      "an ambiguous provider answer is raised, never retried",
    ]),
  }),
  Object.freeze({
    phase: 5,
    title: "RETURN PATH",
    checks: Object.freeze([
      "Retell delivers to the acquisition webhook and the signature verifies",
      "the delivery is fingerprinted in provider_webhook_events",
      "provider_ref binds write-once to that dispatch",
      "lifecycle advances to attempted, and to connected only if a person was reached",
      "the durable outcome is recorded",
      "the dispatch is resolved LAST",
    ]),
  }),
  Object.freeze({
    phase: 6,
    title: "POST-PROOF SAFE STATE",
    checks: Object.freeze([
      "exactly one dispatch exists for that authorisation",
      "the queue is still 0",
      "no retry is pending anywhere",
      "calling has been returned to paused, with a new revision",
      "no provider was left live",
      "the one-shot proof authorisation is consumed",
      "the outcome is captured, and suppression or callback state matches it",
    ]),
  }),
]);

/** The post-proof checks, separately, because they are the ones people skip. */
const POST_PROOF_CHECKS = PROOF_PHASES[6].checks;

module.exports = {
  PROOF_PHASES,
  POST_PROOF_CHECKS,
  assessQueueDrainRisk,
  assessProviderActivation,
  reachableFromServer,
};
