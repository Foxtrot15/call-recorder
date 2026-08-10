// LOCKSMITH ACQUISITION A2 — founder batch review and approval.
//
// The milestone succeeds when the system can produce a reviewable, auditable,
// explicitly approved batch while remaining incapable of placing a call. These
// tests assert both halves: that approval is real, bound and revocable — and
// that nothing here can dial.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const batchSvc = require("../src/services/acquisition-batch");
const { assembleBatch, recordFounderAction, submitForApproval, approveBatch, checkApprovalFreshness, revokeApproval } = batchSvc;
const { createAuditLog } = require("../src/services/acquisition-audit");
const { createEligibilityEngine } = require("../src/services/acquisition-eligibility");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect } = require("../src/services/acquisition-prospect");
const { FOUNDER_CALLING_POLICY, createCallingPolicyApproval } = require("../src/services/acquisition-calling-approval");

const MELBOURNE = "Australia/Melbourne";
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

function approvedProspect({ name, phone, suburb, clock }) {
  let p = createProspect({
    businessName: name,
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    region: "Melbourne",
    timezone: MELBOURNE,
    phones: [{ raw: phone }],
    sourceRefs: [{ url: `https://${suburb.toLowerCase()}.example.com.au/contact` }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: "Peter", reason: "reviewed", now: clock }).prospect;
  }
  return p;
}

/** A world with three good prospects and everything wired up. */
function world({ iso = WEDNESDAY_2PM } = {}) {
  const clock = now(iso);
  const specs = [
    { name: "Northside Lock & Key", phone: "(03) 5550 1042", suburb: "Brunswick" },
    { name: "CBD Lockworks", phone: "1300 975 707", suburb: "Melbourne" },
    { name: "Coburg Key Co", phone: "0491 570 018", suburb: "Coburg" },
  ];
  const prospects = specs.map((s) => approvedProspect({ ...s, clock }));

  const ledger = createEvidenceLedger({ now: clock });
  for (const p of prospects) {
    const source = { url: `https://${p.suburb.toLowerCase()}.example.com.au/contact` };
    for (const [kind, value] of [["business_name", p.businessName], ["trade_category", "Locksmith"], ["phone", p.phones[0].raw]]) {
      ledger.record({ prospectId: p.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source });
    }
  }

  const suppression = createSuppressionList({ now: clock });
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  const numbers = ["+61355501042", "+611300975707", "+61491570018"];
  numbers.forEach((n) => washStore.wash(n));

  const records = prospects.map((p, i) => ({ ...p, numbers: [{ e164: numbers[i] }], evidenceCount: 3, hasOfficialSource: true }));
  const duplicateResolution = resolveDuplicates(records);

  const engine = createEligibilityEngine({
    now: clock,
    washStore,
    suppression,
    holidays: createFixtureHolidayProvider(),
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
    callingPolicyApproval: FOUNDER_CALLING_POLICY,
  });

  const evaluate = (p, ctx) => engine.evaluate(p, { ...ctx, batch: { approved: true, batchHash: "assembly", approvedBy: "Peter" } });

  const build = (dispositions = {}) =>
    assembleBatch({
      prospects,
      evaluate,
      evidenceFor: (id) => ledger.currentForProspect(id),
      duplicateResolution,
      now: clock,
      batchId: "batch_1",
      dispositions,
    });

  return { clock, prospects, ledger, suppression, washStore, duplicateResolution, engine, build, numbers };
}

describe("assembling a batch", () => {
  it("produces a row per prospect with everything a founder needs", () => {
    const { build } = world();
    const batch = build();
    assert.strictEqual(batch.rows.length, 3);
    for (const row of batch.rows) {
      for (const key of ["businessName", "canonicalNumber", "provenance", "sourceRefs", "eligible", "decisiveReason", "nextEligibleAt", "category", "disposition"]) {
        assert.ok(key in row, `row missing ${key}`);
      }
      assert.ok(row.canonicalNumber.startsWith("+61"));
      assert.ok(row.provenance.sourceRefs.length > 0);
    }
  });

  it("gives accurate category totals", () => {
    const { build } = world();
    const s = build().summary;
    assert.strictEqual(s.totalDiscovered, 3);
    assert.strictEqual(s.eligibleNow, 3);
    assert.strictEqual(s.pending, 3);
    assert.strictEqual(s.included, 0);
  });

  it("categorises a blocked prospect by its decisive reason", () => {
    const { build } = world({ iso: "2026-08-09T02:00:00Z" }); // Sunday
    const s = build().summary;
    assert.strictEqual(s.eligibleNow, 0);
    assert.strictEqual(s.outsideWindow, 3);
    assert.strictEqual(s.eligibleLater, 3, "a Sunday lifts, so these are eligible later");
  });

  it("categorises a suppressed prospect as never-contact", () => {
    const { build, suppression, prospects } = world();
    const { identityFingerprint } = require("../src/services/acquisition-prospect");
    suppression.suppress({
      reason: "opt_out",
      fingerprint: identityFingerprint({ businessName: prospects[0].businessName, suburb: prospects[0].suburb, state: prospects[0].state }),
      actor: "Peter",
      note: "Opted out.",
    });
    const s = build().summary;
    assert.strictEqual(s.permanentlySuppressed, 1);
    assert.strictEqual(s.eligibleNow, 2);
  });

  it("does not compute eligibility itself — it must be handed an evaluator", () => {
    assert.throws(() => assembleBatch({ prospects: [], now: now() }), /requires an evaluate\(\) function/);
  });

  it("orders rows deterministically so the hash cannot depend on input order", () => {
    const { build, prospects, ledger, duplicateResolution, engine, clock } = world();
    const forward = build();
    const reversed = assembleBatch({
      prospects: [...prospects].reverse(),
      evaluate: (p, ctx) => engine.evaluate(p, { ...ctx, batch: { approved: true, batchHash: "assembly", approvedBy: "Peter" } }),
      evidenceFor: (id) => ledger.currentForProspect(id),
      duplicateResolution,
      now: clock,
      batchId: "batch_1",
    });
    assert.strictEqual(reversed.batchHash, forward.batchHash);
    assert.deepStrictEqual(reversed.rows.map((r) => r.prospectId), forward.rows.map((r) => r.prospectId));
  });
});

describe("founder actions", () => {
  const base = { actor: "Peter", now: now() };

  it("includes an eligible record", () => {
    const { build } = world();
    const batch = build();
    const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "approve_record" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.batch.rows[0].disposition, "included");
    assert.strictEqual(batch.rows[0].disposition, "pending", "the original batch is not mutated");
  });

  it("REFUSES to include a record the engine says cannot be called", () => {
    const { build } = world({ iso: "2026-08-09T02:00:00Z" }); // Sunday — nothing eligible
    const batch = build();
    const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "approve_record" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "row_not_eligible");
  });

  it("requires a reason to reject or suppress", () => {
    const { build } = world();
    const batch = build();
    for (const action of ["reject_record", "suppress_record"]) {
      const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action });
      assert.strictEqual(r.code, "reason_required", action);
    }
    const ok = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "reject_record", reason: "Not a locksmith." });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.batch.rows[0].disposition, "rejected");
  });

  it("requires a named actor", () => {
    const { build } = world();
    const batch = build();
    assert.strictEqual(recordFounderAction(batch, { prospectId: batch.rows[0].prospectId, action: "defer_record", now: now() }).code, "actor_missing");
  });

  it("excludes rejected, suppressed and deferred rows from the counts", () => {
    const { build } = world();
    let batch = build();
    batch = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "reject_record", reason: "Not a locksmith." }).batch;
    batch = recordFounderAction(batch, { ...base, prospectId: batch.rows[1].prospectId, action: "defer_record" }).batch;
    assert.strictEqual(batch.summary.rejected, 1);
    assert.strictEqual(batch.summary.deferred, 1);
    assert.strictEqual(batch.summary.eligibleNow, 1, "only the untouched row remains countable");
  });

  it("records every action in the audit log as a human decision", () => {
    const { build } = world();
    const audit = createAuditLog({ now: now() });
    const batch = build();
    recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "approve_record", audit });
    const row = audit.all()[0];
    assert.strictEqual(row.event, "founder_approve_record");
    assert.strictEqual(row.actorKind, "human");
    assert.strictEqual(row.actor, "Peter");
    assert.strictEqual(audit.verifyChain().ok, true);
  });

  it("resolving a duplicate clears the block without changing disposition", () => {
    const { build } = world();
    const batch = build();
    const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "resolve_duplicate", duplicateDecision: "distinct", reason: "Different businesses." });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.batch.rows[0].duplicate, null);
    assert.strictEqual(r.batch.rows[0].duplicateResolvedAs, "distinct");
  });

  it("refuses an unknown action", () => {
    const { build } = world();
    assert.strictEqual(recordFounderAction(build(), { ...base, prospectId: build().rows[0].prospectId, action: "call_them" }).code, "action_unknown");
  });

  // REGRESSION. A1 derives prospectId from the identity fingerprint, so two
  // records for the same business in the same suburb share one. Keying founder
  // actions by prospectId meant rejecting one row silently rejected the other —
  // a founder disposing of a record they never looked at.
  describe("rows that share a prospectId", () => {
    function collidingBatch() {
      const clock = now();
      const a = approvedProspect({ name: "Northside Lock & Key", phone: "(03) 5550 1042", suburb: "Brunswick", clock });
      const b = approvedProspect({ name: "Northside Lock and Key Pty Ltd", phone: "(03) 5550 1042", suburb: "Brunswick", clock });
      assert.strictEqual(a.prospectId, b.prospectId, "the fixture must actually collide");

      return assembleBatch({
        prospects: [a, b],
        evaluate: () => ({
          eligible: true, code: "eligible", message: "ok", temporary: false, decisiveCheck: null,
          failedChecks: [], passedChecks: [], nextEligibleAt: null, requiredFounderAction: null,
          canonicalNumber: "+61355501042", provenance: null, localTime: null,
        }),
        now: clock,
        batchId: "collide",
      });
    }

    it("gives every row a unique rowId", () => {
      const batch = collidingBatch();
      assert.strictEqual(batch.rows.length, 2);
      assert.notStrictEqual(batch.rows[0].rowId, batch.rows[1].rowId);
      assert.strictEqual(batch.rows[0].prospectId, batch.rows[1].prospectId);
    });

    it("acts on exactly one row when targeted by rowId", () => {
      const batch = collidingBatch();
      const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[1].rowId, action: "reject_record", reason: "Duplicate listing." });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.batch.rows[0].disposition, "pending", "the other row must be untouched");
      assert.strictEqual(r.batch.rows[1].disposition, "rejected");
    });

    it("REFUSES an ambiguous prospectId rather than guessing", () => {
      const batch = collidingBatch();
      const r = recordFounderAction(batch, { ...base, prospectId: batch.rows[0].prospectId, action: "reject_record", reason: "x" });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, "ambiguous_row");
      assert.strictEqual(r.rowIds.length, 2);
      assert.match(r.message, /Use the rowId/);
    });
  });
});

describe("batch approval", () => {
  const base = { actor: "Peter", now: now() };

  function readyBatch(w = world()) {
    let batch = w.build();
    for (const row of batch.rows) {
      batch = recordFounderAction(batch, { ...base, prospectId: row.prospectId, action: "approve_record" }).batch;
    }
    return submitForApproval(batch, { actor: "Peter", now: now() }).batch;
  }

  it("approves an explicitly reviewed batch, recording actor and timestamp", () => {
    const audit = createAuditLog({ now: now() });
    const r = approveBatch(readyBatch(), { founder: "Peter", now: now(), audit, note: "Reviewed all three." });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.batch.state, "approved");
    assert.strictEqual(r.batch.approval.approvedBy, "Peter");
    assert.strictEqual(r.batch.approval.approvedAt, new Date(WEDNESDAY_2PM).toISOString());
    assert.strictEqual(r.batch.approval.recordCount, 3);
  });

  it("binds the approval to the batch hash", () => {
    const batch = readyBatch();
    const r = approveBatch(batch, { founder: "Peter", now: now() });
    assert.strictEqual(r.batch.approval.batchHash, batch.batchHash);
    assert.ok(r.batch.approval.batchHash.length > 8);
  });

  it("states on the artifact that it authorises no call", () => {
    const r = approveBatch(readyBatch(), { founder: "Peter", now: now() });
    assert.match(r.batch.approval.authorises, /does not place, schedule or trigger any call/);
    assert.strictEqual(r.batch.dispatched, false);
  });

  it("insists the approver is a named person", () => {
    for (const who of ["system", "AIDA", "bot", "automation"]) {
      assert.strictEqual(approveBatch(readyBatch(), { founder: who, now: now() }).code, "approver_not_human", who);
    }
    assert.strictEqual(approveBatch(readyBatch(), { founder: "  ", now: now() }).code, "founder_missing");
  });

  it("refuses an empty batch", () => {
    const w = world();
    const batch = submitForApproval(w.build(), { actor: "Peter", now: now() }).batch;
    assert.strictEqual(approveBatch(batch, { founder: "Peter", now: now() }).code, "batch_empty");
  });

  it("refuses to approve a batch that is not awaiting approval", () => {
    const w = world();
    assert.strictEqual(approveBatch(w.build(), { founder: "Peter", now: now() }).code, "not_awaiting_approval");
  });

  it("refuses when an included record has become ineligible", () => {
    // Build a batch on Wednesday, then re-assemble the same dispositions on a
    // Sunday: the rows are included but no longer callable.
    const wed = world();
    let batch = wed.build();
    const dispositions = {};
    for (const row of batch.rows) dispositions[row.prospectId] = "included";

    const sun = world({ iso: "2026-08-09T02:00:00Z" });
    const staleBatch = submitForApproval(sun.build(dispositions), { actor: "Peter", now: now("2026-08-09T02:00:00Z") }).batch;
    const r = approveBatch(staleBatch, { founder: "Peter", now: now("2026-08-09T02:00:00Z") });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "included_not_eligible");
  });

  it("refuses when an included record has an unresolved duplicate", () => {
    const clock = now();
    const a = approvedProspect({ name: "Alpha Locks", phone: "(03) 5550 7777", suburb: "Brunswick", clock });
    const b = approvedProspect({ name: "Beta Locks", phone: "(03) 5550 7777", suburb: "Richmond", clock });
    const resolution = resolveDuplicates([
      { ...a, numbers: [{ e164: "+61355507777" }], hasOfficialSource: true },
      { ...b, numbers: [{ e164: "+61355507777" }], hasOfficialSource: true },
    ]);
    assert.ok(resolution.pendingReview.length > 0, "the fixture must actually produce a pending duplicate");

    // Force both rows into the batch as included, bypassing the eligibility
    // gate, to prove approveBatch re-checks duplicates independently.
    const rows = [a, b].map((p, i) => Object.freeze({
      prospectId: p.prospectId, businessName: p.businessName, canonicalNumber: "+61355507777",
      eligible: true, code: "eligible", decisiveReason: "ok", temporary: false,
      failedChecks: [], passedChecks: [], nextEligibleAt: null, requiredFounderAction: null,
      provenance: null, sourceRefs: [], evidenceCount: 3, localTime: null, category: "eligibleNow",
      disposition: "included",
      duplicate: { blocked: true, requiresReview: true, code: "duplicate_requires_resolution", message: "may be the same" },
    }));
    const batch = Object.freeze({ batchId: "b", state: "awaiting_approval", rows: Object.freeze(rows), summary: batchSvc.summarise(rows), batchHash: batchSvc.hashBatch(rows), approval: null });

    const r = approveBatch(batch, { founder: "Peter", now: now() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "unresolved_duplicates");
  });

  it("audits the approval as a human decision", () => {
    const audit = createAuditLog({ now: now() });
    approveBatch(readyBatch(), { founder: "Peter", now: now(), audit });
    const row = audit.all().find((r) => r.event === "batch_approved");
    assert.ok(row);
    assert.strictEqual(row.decision, "approve");
    assert.strictEqual(row.actorKind, "human");
    assert.strictEqual(row.detail.recordCount, 3);
    assert.strictEqual(audit.verifyChain().ok, true);
  });

  it("cannot be modified once approved", () => {
    const approved = approveBatch(readyBatch(), { founder: "Peter", now: now() }).batch;
    const r = recordFounderAction(approved, { ...base, prospectId: approved.rows[0].prospectId, action: "defer_record" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "batch_approved");
  });
});

describe("approval staleness", () => {
  const base = { actor: "Peter", now: now() };

  function approvedWorld() {
    const w = world();
    let batch = w.build();
    for (const row of batch.rows) batch = recordFounderAction(batch, { ...base, prospectId: row.prospectId, action: "approve_record" }).batch;
    batch = submitForApproval(batch, { actor: "Peter", now: now() }).batch;
    return { w, approved: approveBatch(batch, { founder: "Peter", now: now() }).batch, dispositions: Object.fromEntries(batch.rows.map((r) => [r.prospectId, "included"])) };
  }

  it("is fresh when nothing has changed", () => {
    const { w, approved, dispositions } = approvedWorld();
    const current = w.build(dispositions);
    const check = checkApprovalFreshness(approved, current);
    assert.strictEqual(check.fresh, true);
    assert.strictEqual(check.stale, false);
  });

  it("goes stale when a record's eligibility changes", () => {
    const { approved, dispositions } = approvedWorld();
    // Same records, evaluated on a Sunday: eligibility flips, so the hash moves.
    const sunday = world({ iso: "2026-08-09T02:00:00Z" });
    const current = sunday.build(dispositions);
    const check = checkApprovalFreshness(approved, current);
    assert.strictEqual(check.stale, true);
    assert.strictEqual(check.code, "batch_changed");
    assert.match(check.message, /no longer describes what would be called/);
  });

  it("goes stale when a record is removed from the batch", () => {
    const { w, approved, dispositions } = approvedWorld();
    const fewer = { ...dispositions };
    fewer[Object.keys(fewer)[0]] = "deferred";
    const check = checkApprovalFreshness(approved, w.build(fewer));
    assert.strictEqual(check.stale, true);
  });

  it("reports an unapproved batch as stale rather than fresh", () => {
    const w = world();
    assert.strictEqual(checkApprovalFreshness(w.build(), w.build()).stale, true);
  });
});

describe("revoking an approval", () => {
  const base = { actor: "Peter", now: now() };

  function approvedBatch() {
    const w = world();
    let batch = w.build();
    for (const row of batch.rows) batch = recordFounderAction(batch, { ...base, prospectId: row.prospectId, action: "approve_record" }).batch;
    batch = submitForApproval(batch, { actor: "Peter", now: now() }).batch;
    return approveBatch(batch, { founder: "Peter", now: now() }).batch;
  }

  it("is always available, because nothing has dispatched", () => {
    const audit = createAuditLog({ now: now() });
    const r = revokeApproval(approvedBatch(), { actor: "Peter", reason: "Changed my mind.", now: now(), audit });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.batch.state, "cancelled");
    assert.strictEqual(r.batch.approval, null);
  });

  it("keeps the withdrawn approval on the record", () => {
    const r = revokeApproval(approvedBatch(), { actor: "Peter", reason: "Changed my mind.", now: now() });
    assert.ok(r.batch.revokedApproval, "the approval happened and the trail must show it");
    assert.strictEqual(r.batch.revokedApproval.approvedBy, "Peter");
    assert.strictEqual(r.batch.revokedReason, "Changed my mind.");
  });

  it("requires an actor and a reason", () => {
    assert.strictEqual(revokeApproval(approvedBatch(), { reason: "x", now: now() }).code, "actor_missing");
    assert.strictEqual(revokeApproval(approvedBatch(), { actor: "Peter", now: now() }).code, "reason_required");
  });
});

describe("the milestone cannot place a call", () => {
  it("exports nothing that dispatches, dials or schedules", () => {
    for (const name of Object.keys(batchSvc)) {
      assert.ok(!/dispatch|dial|call(?!ing)|start|send|queue|execute|trigger/i.test(name), `"${name}" must not exist in this milestone`);
    }
  });

  it("the source references no provider, transport or dialler", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/services/acquisition-batch.js"), "utf8");
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    for (const dep of requires) assert.ok(dep.startsWith("./") || dep.startsWith("../"), `only local modules, found "${dep}"`);
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bfetch\(|axios|XMLHttpRequest|https?:\/\//.test(code), "no network call");
    for (const forbidden of ["twilio", "retell", "sendgrid", "nodemailer", "supabase"]) {
      assert.ok(!new RegExp(forbidden, "i").test(code), `must not reference ${forbidden}`);
    }
  });

  it("an approved batch is inert — it carries data, not an instruction", () => {
    const w = world();
    let batch = w.build();
    for (const row of batch.rows) batch = recordFounderAction(batch, { actor: "Peter", now: now(), prospectId: row.prospectId, action: "approve_record" }).batch;
    batch = submitForApproval(batch, { actor: "Peter", now: now() }).batch;
    const approved = approveBatch(batch, { founder: "Peter", now: now() }).batch;

    assert.strictEqual(approved.dispatched, false);
    for (const value of Object.values(approved)) {
      assert.notStrictEqual(typeof value, "function", "an approved batch must contain no callable behaviour");
    }
    assert.ok(Object.isFrozen(approved));
  });

  it("the default state of a freshly assembled batch contacts nothing", () => {
    const { build } = world();
    const batch = build();
    assert.strictEqual(batch.state, "draft");
    assert.strictEqual(batch.approval, null);
    assert.strictEqual(batch.summary.included, 0);
  });
});
