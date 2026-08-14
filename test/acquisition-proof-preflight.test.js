// LOCKSMITH ACQUISITION E-12H — the founder's readiness view, and the
// one-shot permission slip that would go with it.
//
// ── THE RISK IN BUILDING THIS AT ALL ────────────────────────────────
// A readiness aggregator is one refactor away from becoming a second, weaker
// authorisation path — one that a future caller consults INSTEAD of the M8E
// pre-dial gate because it is convenient and returns a boolean. That would
// quietly move DNCR, suppression, hours and the calling state out of the only
// place that owns them.
//
// So this report's `ready` field is hardcoded false, permanently, and the tests
// below assert that. It reports; it never permits.
//
// ── AND THE PERMISSION SLIP ─────────────────────────────────────────
// ALLOW_TEST_CALL=true would have been the easy shape and is the wrong one: an
// environment variable authorises a STATE, not an act. It cannot say who
// decided, what about, when it expires, or whether it has already been spent —
// and it stays true afterwards. The model here follows the two approval
// patterns the repository already had: a named human approver rejected if the
// name looks automated, and a canonical identity hash over exactly what was
// approved.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { describeProofPreflight } = require("../src/services/acquisition-proof-preflight");
const {
  createProofAuthorisation,
  bindProofAuthorisation,
  isLiveProofAuthorisation,
  proofIdentity,
  PROOF_CODES,
  MAX_WINDOW_MINUTES,
} = require("../src/services/acquisition-proof-authorisation");

const ISO = "2026-08-14T02:00:00.000Z";
const now = (iso = ISO) => () => new Date(iso);

const PROSPECT = "prospect_fixture_1";
const TO = "+61355501234";
const FROM = "+61355509876";
const AGENT = "agent_fixture_1";

const goodAuth = (over = {}) =>
  createProofAuthorisation({
    approvedBy: "Peter Dang", prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM,
    agentId: AGENT, reason: "first controlled proof", now: now(), ...over,
  });

// ---------------------------------------------------------------------------
// 1. THE PERMISSION SLIP
// ---------------------------------------------------------------------------

describe("E-12H: a proof authorisation names one of everything", () => {
  it("1. a well-formed authorisation is issued", () => {
    const a = goodAuth();
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.approvedBy, "Peter Dang");
    assert.strictEqual(a.scope, "one_call");
    assert.strictEqual(a.consumed, false);
    assert.strictEqual(a.prospectId, PROSPECT);
    assert.strictEqual(a.destinationE164, TO);
    assert.strictEqual(a.fromNumber, FROM);
    assert.strictEqual(a.agentId, AGENT);
    assert.strictEqual(a.identity.length, 64);
  });

  it("2. it expires, and the window is bounded", () => {
    const a = goodAuth();
    assert.ok(new Date(a.expiresAt) > new Date(a.issuedAt));
    assert.strictEqual(goodAuth({ windowMinutes: MAX_WINDOW_MINUTES + 1 }).code, PROOF_CODES.BAD_WINDOW);
    assert.strictEqual(goodAuth({ windowMinutes: 0 }).code, PROOF_CODES.BAD_WINDOW);
    assert.strictEqual(goodAuth({ windowMinutes: -5 }).code, PROOF_CODES.BAD_WINDOW);
    assert.strictEqual(goodAuth({ windowMinutes: 2.5 }).code, PROOF_CODES.BAD_WINDOW);
  });

  it("3. it must be authorised by a named PERSON", () => {
    assert.strictEqual(goodAuth({ approvedBy: null }).code, PROOF_CODES.NO_APPROVER);
    assert.strictEqual(goodAuth({ approvedBy: "   " }).code, PROOF_CODES.NO_APPROVER);
    for (const bot of ["system", "AIDA", "automation", "claude", "cron", "worker", "bot", "assistant"]) {
      assert.strictEqual(goodAuth({ approvedBy: bot }).code, PROOF_CODES.NON_HUMAN, bot);
    }
  });

  it("4. it must name one prospect, one destination, one from-number, one agent", () => {
    assert.strictEqual(goodAuth({ prospectId: null }).code, PROOF_CODES.NO_PROSPECT);
    assert.strictEqual(goodAuth({ destinationE164: "0355501234" }).code, PROOF_CODES.BAD_DESTINATION);
    assert.strictEqual(goodAuth({ fromNumber: "not-a-number" }).code, PROOF_CODES.BAD_FROM);
    assert.strictEqual(goodAuth({ agentId: null }).code, PROOF_CODES.NO_AGENT);
  });

  it("5. dialling yourself is refused", () => {
    assert.strictEqual(goodAuth({ destinationE164: FROM }).code, PROOF_CODES.SAME_NUMBER);
  });

  it("6. it is NOT a campaign — nothing about it is plural", () => {
    const a = goodAuth();
    const json = JSON.stringify(a);
    assert.ok(!/prospects|members|batch|queue|campaign/i.test(json), "a proof slip cannot name a set");
    assert.strictEqual(a.scope, "one_call");
  });
});

// ---------------------------------------------------------------------------
// 2. SINGLE USE, AND SCOPED
// ---------------------------------------------------------------------------

describe("E-12H: it authorises one call, once", () => {
  it("7. binding consumes it", () => {
    const a = goodAuth();
    const bound = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d1", now: now() });
    assert.strictEqual(bound.consumed, true);
    assert.strictEqual(bound.dispatchId, "d1");
    assert.ok(bound.consumedAt);
  });

  it("8. a consumed authorisation cannot be spent again", () => {
    const a = goodAuth();
    const bound = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d1", now: now() });
    const again = bindProofAuthorisation(bound, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d2", now: now() });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.code, PROOF_CODES.ALREADY_USED);
  });

  it("9. the original is frozen, so it cannot be un-spent by mutation", () => {
    const a = goodAuth();
    assert.ok(Object.isFrozen(a));
    assert.throws(() => { "use strict"; a.consumed = true; });
  });

  it("10. a slip issued for one business cannot be spent on another", () => {
    const a = goodAuth();
    for (const wrong of [
      { prospectId: "someone_else" },
      { destinationE164: "+61355509999" },
      { fromNumber: "+61355500000" },
      { agentId: "another_agent" },
    ]) {
      const r = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: now(), ...wrong });
      assert.strictEqual(r.ok, false, JSON.stringify(wrong));
      assert.strictEqual(r.code, PROOF_CODES.SCOPE_MISMATCH, JSON.stringify(wrong));
    }
  });

  it("11. an expired authorisation is refused", () => {
    const a = goodAuth({ windowMinutes: 30 });
    const later = () => new Date("2026-08-14T03:00:00.000Z");
    assert.strictEqual(isLiveProofAuthorisation(a, later), false);
    const r = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: later });
    assert.strictEqual(r.code, PROOF_CODES.EXPIRED);
  });

  it("12. the identity hash is over exactly the four bound facts", () => {
    const base = proofIdentity({ prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT });
    assert.notStrictEqual(base, proofIdentity({ prospectId: "x", destinationE164: TO, fromNumber: FROM, agentId: AGENT }));
    assert.notStrictEqual(base, proofIdentity({ prospectId: PROSPECT, destinationE164: "+61399999999", fromNumber: FROM, agentId: AGENT }));
    assert.strictEqual(base, goodAuth().identity);
  });

  it("13. a refusal is never mistaken for an authorisation", () => {
    const bad = goodAuth({ approvedBy: "system" });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(isLiveProofAuthorisation(bad, now()), false);
    assert.strictEqual(bindProofAuthorisation(bad, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: now() }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// 3. THE PREFLIGHT REPORTS, IT NEVER PERMITS
// ---------------------------------------------------------------------------

describe("E-12H: the preflight is a view, not a gate", () => {
  it("14. `ready` is false even when every item is green", async () => {
    // The single most important assertion in this file.
    const r = await describeProofPreflight({ env: {}, now: now() });
    assert.strictEqual(r.ready, false);
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-proof-preflight.js"), "utf8");
    assert.match(src, /ready: false, \/\/ ALWAYS false/);
    assert.match(r.note, /view, not a permission/i);
    assert.match(r.note, /pre-dial gate/i);
  });

  it("15. it imports nothing that can dial or provision", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-proof-preflight.js"), "utf8");
    assert.ok(!/retell-adapter|acquisition-dial-execution|createPhoneCall|fetch\(/.test(src));
  });

  it("16. nothing in the dial path consults it — no parallel permission", () => {
    for (const rel of ["src/services/acquisition-dial-execution.js", "src/services/acquisition-authorisation.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.ok(!/proof-preflight|describeProofPreflight/.test(src), `${rel} must not consult the readiness view`);
    }
  });

  it("17. the authoritative pre-dial gate is untouched by this stage", () => {
    const { createDialAuthoriser, AUTHORISATION_CODES } = require("../src/services/acquisition-authorisation");
    assert.strictEqual(typeof createDialAuthoriser, "function");
    assert.ok(Object.keys(AUTHORISATION_CODES).length > 0);
    // Checked as COUPLING, not as a word: the gate's own prose has used
    // "proof run" since M8E to mean a rehearsal, and banning the word would
    // mean editing unrelated documentation to satisfy this test.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
    assert.ok(!/require\([^)]*proof[^)]*\)/i.test(src), "the gate must not import proof tooling");
    assert.ok(!/proofAuthorisation|describeProofPreflight|bindProofAuthorisation/.test(src), "nor reference it");
  });
});

// ---------------------------------------------------------------------------
// 4. THE CURRENT ANSWER IS NOT READY, FOR THE RIGHT REASONS
// ---------------------------------------------------------------------------

describe("E-12H: today's report names the real blockers", () => {
  it("18. with the real (empty) environment it is not ready", async () => {
    const r = await describeProofPreflight({ env: {}, now: now() });
    assert.strictEqual(r.readyForReview, false);
    assert.ok(r.blockers.length >= 6);
  });

  it("19. it names every blocker the founder listed", async () => {
    const r = await describeProofPreflight({ env: {}, now: now() });
    const all = r.blockers.join(" | ");
    assert.match(all, /no acquisition agent has been provisioned/i);
    assert.match(all, /RETELL_ACQUISITION_OUTBOUND_NUMBER is not set/i);
    assert.match(all, /RETELL_ACQUISITION_WEBHOOK_URL is not set/i);
    assert.match(all, /live:false/i);
    assert.match(all, /DNCR/i);
    assert.match(all, /no live, unspent founder proof authorisation/i);
  });

  it("20. a PAUSED calling state is reported as a blocker", async () => {
    const store = { async readCallingState() { return { scope: "global", state: "paused", revision: 1 }; } };
    const r = await describeProofPreflight({ env: {}, store, now: now() });
    assert.ok(r.blockers.some((b) => /calling is PAUSED \(revision 1\)/.test(b)));
  });

  it("21. an UNREADABLE calling state blocks — it never reads as safe or as enabled", async () => {
    const store = { async readCallingState() { throw new Error("connection refused"); } };
    const r = await describeProofPreflight({ env: {}, store, now: now() });
    const item = r.execution.callingState;
    assert.strictEqual(item.ready, "unknown");
    assert.ok(r.blockers.some((b) => /callingState/.test(b)));
  });

  it("22. DNCR: a FIXTURE wash never clears a real number", async () => {
    const washStore = { async listWashes() { return [{ washedAt: ISO }]; } };
    const r = await describeProofPreflight({ env: { ACQUISITION_DNCR_MODE: "fixture" }, washStore, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.dncr.ready, false);
    assert.match(r.compliance.dncr.detail, /fixture wash does not clear a real number/i);
  });

  it("23. DNCR: even in import mode a stale wash does not clear it", async () => {
    const washStore = { async listWashes() { return [{ washedAt: "2026-01-01T00:00:00.000Z" }]; } };
    const r = await describeProofPreflight({ env: { ACQUISITION_DNCR_MODE: "import" }, washStore, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.dncr.ready, false);
    assert.match(r.compliance.dncr.detail, /within 30 days/i);
  });

  it("24. DNCR: a fresh imported wash for that exact number clears", async () => {
    const washStore = { async listWashes() { return [{ washedAt: "2026-08-10T00:00:00.000Z" }]; } };
    const r = await describeProofPreflight({ env: { ACQUISITION_DNCR_MODE: "import" }, washStore, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.dncr.ready, true);
  });

  it("25. suppression blocks, and an unreadable list blocks too", async () => {
    const suppressed = { async lookupSuppression() { return { reason: "opt_out" }; } };
    let r = await describeProofPreflight({ env: {}, store: suppressed, prospectId: PROSPECT, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.suppression.ready, false);

    const broken = { async lookupSuppression() { throw new Error("down"); } };
    r = await describeProofPreflight({ env: {}, store: broken, prospectId: PROSPECT, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.suppression.ready, "unknown");
  });

  it("26. A-L2 is reported OPEN rather than quietly satisfied", async () => {
    const r = await describeProofPreflight({ env: {}, now: now() });
    assert.strictEqual(r.compliance.publicHoliday.ready, "unknown");
    assert.match(r.compliance.publicHoliday.detail, /A-L2 is OPEN/);
    assert.match(r.compliance.publicHoliday.detail, /FIXTURE/);
  });

  it("27. a live founder authorisation turns exactly one item green, and no others", async () => {
    const auth = goodAuth();
    const before = await describeProofPreflight({ env: {}, now: now() });
    const after = await describeProofPreflight({ env: {}, now: now(), proofAuthorisation: auth });
    assert.strictEqual(before.execution.founderAuthorisation.ready, false);
    assert.strictEqual(after.execution.founderAuthorisation.ready, true);
    assert.strictEqual(after.blockers.length, before.blockers.length - 1, "authorising changes one fact and nothing else");
    assert.strictEqual(after.ready, false, "and it is still not permission");
  });

  it("28. a CONSUMED authorisation does not count as live", async () => {
    const bound = bindProofAuthorisation(goodAuth(), { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: now() });
    const r = await describeProofPreflight({ env: {}, now: now(), proofAuthorisation: bound });
    assert.strictEqual(r.execution.founderAuthorisation.ready, false, "one call means one call");
  });
});

// ---------------------------------------------------------------------------
// 5. THE PREVIEW COMMAND
// ---------------------------------------------------------------------------

describe("E-12H: the founder command is read-only", () => {
  const SCRIPT = path.join(__dirname, "..", "scripts", "dev", "acquisition-preview-proof.js");
  const src = () => fs.readFileSync(SCRIPT, "utf8");

  it("29. it has no write path at all", () => {
    const s = src();
    assert.ok(!/adapter\.\w+\(|createPhoneCall|createAgent|writeCallingState|\.insert\(|\.update\(/.test(s));
    assert.ok(!/--create|--execute|--confirm|--yes/.test(s), "no flag can make it act");
  });

  it("30. NOT READY exits 0 — reporting the truth is success", () => {
    const s = src();
    assert.match(s, /process\.exit\(0\)/);
    assert.match(s, /NOT READY is not a script failure/i);
  });

  it("31. it separates resources, compliance and execution safety", () => {
    const s = src();
    assert.match(s, /RESOURCE READINESS/);
    assert.match(s, /COMPLIANCE/);
    assert.match(s, /EXECUTION SAFETY/);
  });

  it("32. it is not wired into the server or any service", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.ok(!/preview-proof/.test(server));
    for (const dir of ["src/services", "src/routes"]) {
      const d = path.join(__dirname, "..", dir);
      for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".js"))) {
        assert.ok(!/acquisition-preview-proof/.test(fs.readFileSync(path.join(d, f), "utf8")), `${dir}/${f}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. CROSS-STAGE SAFETY
// ---------------------------------------------------------------------------

describe("E-12E–H: the cross-stage invariants", () => {
  it("33. no proof tooling can activate the queue or a campaign", () => {
    for (const rel of ["src/services/acquisition-proof-authorisation.js", "src/services/acquisition-proof-preflight.js", "scripts/dev/acquisition-preview-proof.js"]) {
      const s = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.ok(!/selectNext|enqueue|createCallQueue|writeCallingState/.test(s), `${rel} must not touch the queue or calling state`);
    }
  });

  it("34. every new module is importable with no database and no credentials", () => {
    const saved = { ...process.env };
    try {
      for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "RETELL_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) delete process.env[k];
      for (const rel of [
        "../src/services/acquisition-agent-provisioning",
        "../src/services/acquisition-resource-authority",
        "../src/services/acquisition-proof-authorisation",
        "../src/services/acquisition-proof-preflight",
      ]) {
        const abs = require.resolve(rel);
        delete require.cache[abs];
        assert.doesNotThrow(() => require(abs), rel);
      }
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("35. and none of them defaults to doing anything", () => {
    // Both new scripts default to read-only/preview.
    const agentRunner = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", "acquisition-provision-agent.js"), "utf8");
    assert.match(agentRunner, /PREVIEW_ONLY = !process\.argv\.includes/);
    const preview = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", "acquisition-preview-proof.js"), "utf8");
    assert.ok(!/process\.argv\.includes\("--create/.test(preview), "the preview has no create mode to default away from");
  });
});
