#!/usr/bin/env node
// AIDA — Retell call diagnostics, READ ONLY (M7E).
//
//   node scripts/retell-call-diagnostics.js
//       Assessment only. Contacts nothing, creates nothing, spends nothing.
//       Prints the gates a live read would need and exits.
//
//   node scripts/retell-call-diagnostics.js --fetch-call "<call-id>"
//       Reads ONE call back through GET /v2/get-call/{call_id}.
//
//   node scripts/retell-call-diagnostics.js --fetch-call "<id>" --await-analysis
//       Bounded poll until post-call analysis appears, or a stated timeout.
//
//   node scripts/retell-call-diagnostics.js --fetch-call "<id>" --include-content
//       Also prints transcript TEXT. Requires the environment variable too.
//
// ─── WHAT THIS CANNOT DO ────────────────────────────────────────────
// There is no code path here that creates, updates or deletes anything, places
// a call, binds a number, or lists calls. The only provider method reachable is
// the adapter's retrieveCallForDiagnostics, behind canReadDiagnostics. The
// absence of a mutation path is structural, not a flag.
//
// ─── WHAT IT NEVER PRINTS ───────────────────────────────────────────
// The API key, the Authorization header, any access token, any recording URL,
// or a full phone number. Transcript content is withheld unless BOTH the
// environment variable and the command-line flag are given, and is never
// written to the manifest even then.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Load .env from the repository root, the same way scripts/retell-web-sandbox.js
// does — a standalone script is not necessarily run from the root, and a silent
// "no .env found" looks exactly like "nothing is configured".
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { evaluateDiagnosticsGate, evaluateContentDisclosure } = require("../src/config/retell-diagnostics");
const { getRetellConfig } = require("../src/config/retell");
const diagnostics = require("../src/services/retell-call-diagnostics");
const analysisModule = require("../src/services/retell-call-analysis");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const FETCH_CALL = valueOf("--fetch-call");
const WANT_ANALYSIS = has("--await-analysis");
const WANT_CONTENT = has("--include-content");
const WRITE_REPORT = has("--write-report");

const line = (c = "─") => console.log(c.repeat(74));
const heading = (t) => { console.log(); line(); console.log(`  ${t}`); line(); };

// Production refuses before anything else is considered.
if ((process.env.NODE_ENV || "development") === "production") {
  console.error("Refusing to run Retell diagnostics in production.");
  process.exit(1);
}

async function main() {
  const gate = evaluateDiagnosticsGate(process.env, { callId: FETCH_CALL });
  const content = evaluateContentDisclosure(process.env, { commandLineFlag: WANT_CONTENT });
  const c = gate.config;

  heading("AIDA — Retell call diagnostics (read only)");
  console.log(`  mode          : ${FETCH_CALL ? "LIVE READ of one call" : "assessment only (no request will be made)"}`);
  console.log(`  node env      : ${c.nodeEnv}`);
  console.log(`  allowed tag   : ${c.allowedTag}`);
  console.log(`  api key       : ${c.hasApiKey ? "present (never printed)" : "NOT SET"}`);
  console.log(`  transcript    : ${content.include ? "CONTENT WILL BE SHOWN" : "withheld"} (${content.reason})`);
  console.log(`  target call   : ${gate.callId || "none given"}`);

  heading("Gate assessment");
  if (gate.allowed) {
    console.log("  ✓ every diagnostics gate is satisfied");
  } else {
    console.log(`  ✗ ${gate.blockers.length} blocker(s):`);
    for (const b of gate.blockers) console.log(`      - ${b}`);
  }
  // The adapter enforces its own capability independently. Showing both means a
  // disagreement between them is visible rather than mysterious.
  console.log();
  console.log(`  adapter capability canReadDiagnostics: ${gate.capability.allowed ? "allowed" : "refused"}`);
  for (const r of gate.capability.reasons) console.log(`      - ${r}`);

  console.log();
  console.log("  Not required by a read:");
  for (const n of gate.notRequired) console.log(`      · ${n}`);

  heading("What a live read would do");
  console.log("  1. GET /v2/get-call/{call_id}      one call, by id");
  console.log("  2. sanitise the response           no transcript, no recording URL, no token");
  console.log("  3. summarise turn structure        who spoke, when, how long — never what");
  console.log("  4. summarise latency               against AIDA heuristics, not provider SLAs");
  console.log("  5. classify the disconnect         only from what Retell itself reported");
  console.log("  6. build an evidence report        which states what is NOT known");
  if (WANT_ANALYSIS) {
    console.log(`  7. poll for post-call analysis     every ${c.analysisPollMs}ms, giving up after ${c.analysisMaxWaitMs}ms`);
  }
  console.log();
  console.log("  Nothing is created, updated, deleted or dialled. No call is placed.");

  if (!FETCH_CALL) {
    heading("No action taken");
    console.log("  This was an assessment. No provider request was made and nothing was charged.");
    console.log();
    console.log("  To read one call once the gates above pass:");
    console.log("    node scripts/retell-call-diagnostics.js --fetch-call \"<call-id>\"");
    console.log();
    return 0;
  }

  if (!gate.allowed) {
    heading("Refusing to read");
    console.log("  The gates above are not satisfied. Nothing was contacted.");
    return 2;
  }

  heading("Reading one call from Retell");
  const adapter = buildLiveAdapter();

  const first = await readCall(adapter, gate.callId);
  if (!first.ok) {
    console.log(`  ✗ the read failed: ${first.errorCode}${first.status ? ` (HTTP ${first.status})` : ""}`);
    if (first.message) console.log(`    ${first.message}`);
    console.log("    Nothing was created or changed.");
    return 3;
  }

  let body = first.body;
  let analysisOutcome = null;

  if (WANT_ANALYSIS) {
    heading("Waiting for post-call analysis");
    console.log(`  Bounded: every ${c.analysisPollMs}ms, giving up after ${c.analysisMaxWaitMs}ms. This never polls indefinitely.`);
    analysisOutcome = await analysisModule.pollForAnalysis({
      readCall: () => readCall(adapter, gate.callId),
      intervalMs: c.analysisPollMs,
      maxWaitMs: c.analysisMaxWaitMs,
      onAttempt: ({ attempt, readiness }) => console.log(`  attempt ${attempt}: ${readiness.state}${readiness.reason ? ` — ${readiness.reason}` : ""}`),
    });
    if (analysisOutcome.body) body = analysisOutcome.body;
    console.log(`  → ${analysisOutcome.outcome} after ${analysisOutcome.attempts} attempt(s)`);
  }

  const summary = diagnostics.summariseCall(body, { includeContent: content.include });

  // Belt and braces before anything is printed or written.
  const leaks = diagnostics.findSensitiveLeaks(summary);
  if (leaks.length) {
    console.error("  ✗ REFUSING TO PRINT: the summary contained values it must not carry:");
    for (const leak of leaks) console.error(`      ${leak.path} (${leak.kind})`);
    return 4;
  }

  printSummary(summary);

  const report = diagnostics.buildDropoutEvidenceReport(summary);
  printEvidenceReport(report);

  if (body.call_analysis) {
    printAnalysis(body.call_analysis, content.include);
  }

  if (content.include) {
    heading("⚠  TRANSCRIPT CONTENT");
    console.log("  This is a real conversation. Do not persist, paste or forward it.");
    console.log("  It is NOT written to the report file.");
    console.log();
    console.log(summary.content && summary.content.transcript ? indent(summary.content.transcript) : "  (no transcript was returned)");
  }

  if (WRITE_REPORT) writeReport(summary, report);

  heading("Done");
  console.log("  Read only. Nothing was created, updated, deleted or dialled.");
  return 0;
}

/** The single provider call this script can make. */
async function readCall(adapter, callId) {
  const result = await adapter.retrieveCallForDiagnostics({ callId });
  if (!result.ok) {
    // The port nests failures under `error` — reading result.code directly gives
    // undefined, which is exactly the shape mistake M7D found four times over.
    const err = result.error || {};
    return { ok: false, errorCode: err.code || "unknown_error", status: err.status || null, message: err.message || null, body: null };
  }
  // One-shot: the body is taken exactly once and cannot be read again, so it
  // cannot be serialised into a log line or a manifest by a later caller.
  const body = typeof result.takeCallBody === "function" ? result.takeCallBody() : null;
  return { ok: true, errorCode: null, status: null, body };
}

function printSummary(s) {
  heading("Observed facts");
  console.log(`  call id             : ${s.callId}`);
  console.log(`  call type           : ${s.callType || `UNRECOGNISED (${s.rawCallStatus || "absent"})`}${s.direction ? ` / ${s.direction}` : ""}`);
  console.log(`  agent               : ${s.agentId} (version ${s.agentVersion === null ? "?" : s.agentVersion})`);
  console.log(`  status              : ${s.callStatus || `UNRECOGNISED: ${s.rawCallStatus}`}`);
  console.log(`  connected           : ${s.connected === null ? "unknown" : s.connected ? "yes" : "no"} — ${s.connectionBasis}`);
  console.log(`  started / ended     : ${s.startTimestamp || "?"} / ${s.endTimestamp || "?"}`);
  console.log(`  duration            : ${s.durationMs === null ? "not reported" : `${s.durationMs}ms`}${s.derivedDurationMs !== null ? ` (timestamps say ${s.derivedDurationMs}ms)` : ""}`);
  console.log(`  disconnect reason   : ${s.disconnectionReason || (s.rawDisconnectionReason ? `UNDOCUMENTED: ${s.rawDisconnectionReason}` : "not reported")}`);
  console.log(`  category            : ${s.category}  [${s.categoryEvidence}]`);
  console.log(`  numbers             : from ${s.numbers.from || "n/a"}  to ${s.numbers.to || "n/a"}  (masked)`);
  console.log(`  analysis            : ${s.analysis.state}`);

  heading("Turn structure (no content)");
  if (!s.timeline.present) {
    console.log("  No transcript_object was returned.");
  } else {
    console.log(`  ${s.timeline.turnCount} turn(s): ${s.timeline.agentTurns} agent, ${s.timeline.userTurns} caller, ${s.timeline.toolCallCount} tool call(s)`);
    console.log(`  last completed turn : ${s.timeline.lastCompletedSpeaker || "none ended in terminal punctuation"}`);
    console.log(`  final turn          : ${s.timeline.finalTurnRole || "?"}${s.timeline.finalTurnAppearsIncomplete === true ? "  ⚠ APPEARS INCOMPLETE (heuristic)" : ""}`);
    console.log(`  last word at        : ${s.timeline.finalEventAtSeconds === null ? "?" : `${s.timeline.finalEventAtSeconds}s`}`);
    console.log();
    for (const t of s.timeline.turns) {
      console.log(`    #${String(t.index).padStart(2)} ${String(t.role).padEnd(20)} ${fmtSeconds(t.startSeconds)}→${fmtSeconds(t.endSeconds)}  ${String(t.characterCount).padStart(4)} chars  ${t.endsWithTerminalPunctuation === false ? "(no terminal punctuation)" : ""}`);
    }
  }

  heading("Latency");
  if (!s.latency.present) {
    console.log("  No latency object was returned. Slow generation can be neither shown nor ruled out.");
  } else {
    for (const name of s.latency.componentsPresent) {
      const m = s.latency.components[name];
      console.log(`  ${name.padEnd(26)} p50 ${fmtMs(m.p50)}  p95 ${fmtMs(m.p95)}  max ${fmtMs(m.max)}  n=${m.num === undefined ? "?" : m.num}`);
    }
    if (s.latency.missing.length) console.log(`  absent: ${s.latency.missing.join(", ")}`);
    console.log();
    if (!s.latencyBreaches.length) {
      console.log("  No AIDA diagnostic heuristic was exceeded.");
    } else {
      for (const b of s.latencyBreaches) {
        console.log(`  ⚠ ${b.component} ${b.metric} = ${b.observedMs}ms > ${b.thresholdMs}ms  [${b.thresholdSource} — NOT a provider guarantee]`);
      }
    }
  }

  if (s.missing.length) {
    console.log();
    console.log(`  Absent from the response: ${s.missing.join(", ")}`);
  }
  if (s.unknownFields.length) {
    console.log(`  Fields this build does not model (names only): ${s.unknownFields.join(", ")}`);
  }
}

function printEvidenceReport(r) {
  heading("Evidence report");
  for (const f of r.findings) {
    const tag = f.evidence === "provider_classified" ? "PROVIDER" : f.evidence === "observed" ? "OBSERVED" : "UNPROVEN";
    console.log(`  [${tag.padEnd(8)}] ${f.statement}`);
  }
  console.log();
  if (r.unknowns.length) {
    console.log("  NOT ESTABLISHED:");
    for (const u of r.unknowns) console.log(`      · ${u}`);
    console.log();
  }
  console.log(`  cause assigned : ${r.cause || "none"}  [${r.causeEvidence}]`);
  console.log(`  conclusion     : ${r.conclusion}`);
}

function printAnalysis(rawAnalysis, includeContent) {
  heading("Post-call analysis");
  const validated = analysisModule.validateCallAnalysis(rawAnalysis, { includeContent });
  if (!validated.ok) {
    console.log("  ✗ the analysis did not validate:");
    for (const e of validated.errors) console.log(`      - ${e.field}: ${e.message}`);
  }
  const a = validated.analysis;
  if (a) {
    console.log(`  summary          : ${a.callSummaryPresent ? `present (${a.callSummaryLength} chars)` : "absent"}`);
    if (includeContent && a.callSummary) console.log(`      "${a.callSummary}"`);
    console.log(`  user sentiment   : ${a.userSentiment || "not reported"}`);
    console.log(`  call successful  : ${a.callSuccessful === null ? "not reported" : a.callSuccessful}`);
    console.log(`  in voicemail     : ${a.inVoicemail === null ? "not reported" : a.inVoicemail}`);
    for (const [name, value] of Object.entries(a.custom || {})) {
      console.log(`  custom.${name.padEnd(20)} ${describeCustom(value)}`);
    }
  }
  for (const w of validated.warnings) console.log(`  · ${w.message}`);
  console.log();
  console.log("  Provider analysis is UNTRUSTED. Nothing here can change a profile,");
  console.log("  approve a change, alter routing or pricing, or trigger billing.");
}

function describeCustom(value) {
  if (!value) return "empty";
  if (value.type === "string") return `text, ${value.length} chars (content withheld)`;
  return `${value.type} = ${value.value}`;
}

function fmtMs(v) {
  return v === undefined || v === null ? "  ?  " : `${String(Math.round(v)).padStart(5)}ms`;
}

function fmtSeconds(v) {
  return v === null || v === undefined ? "  ?  " : `${v.toFixed(2)}s`;
}

function indent(text) {
  return String(text).split("\n").map((l) => `    ${l}`).join("\n");
}

/**
 * Write the sanitised summary and evidence report to a temp file.
 *
 * The `content` channel is stripped first, so transcript text cannot reach the
 * file even when --include-content printed it to the terminal.
 */
function writeReport(summary, report) {
  const { content, ...safe } = summary;
  const dir = path.join(os.tmpdir(), "aida-retell-diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostics-${summary.callId || "unknown"}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary: safe, report }, null, 2), "utf8");
  heading("Report");
  console.log(`  ${file}`);
  console.log("  Contains the sanitised summary only — no transcript, no recording URL, no token.");
}

function buildLiveAdapter() {
  const { createRetellAdapter } = require("../src/services/retell-adapter");
  if (typeof globalThis.fetch !== "function") {
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
    console.error("Diagnostics failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
