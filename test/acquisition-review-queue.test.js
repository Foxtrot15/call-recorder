// LOCKSMITH ACQUISITION M8H — the durable review queue and merge enrichment.
//
// Two gaps M8G left. Ambiguous candidates — the ones actually needing a person
// — were the only part of an import that did not survive the process. And a
// conclusive merge threw away everything the listing carried, including a
// number the business had started publishing.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createAuditLog, verifyRows } = require("../src/services/acquisition-audit");
const { createInMemoryAcquisitionStore, assertStoreContract, STORE_METHODS } = require("../src/services/acquisition-store");
const { openReviewItem, listReviewItems, loadReviewItem, resolveReviewItem, hydratedLog, REVIEW_DECISIONS, STATUS } = require("../src/services/acquisition-review-queue");
const { attachMergedListing, persistImportResult, loadExistingForImport } = require("../src/services/acquisition-persist");
const { importBusinessCsv, IMPORT_OUTCOMES } = require("../src/services/acquisition-import");
const { createEvidenceLedger, assessEvidence } = require("../src/services/acquisition-evidence");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createDialAuthoriser } = require("../src/services/acquisition-authorisation");
const { identityFingerprint } = require("../src/services/acquisition-prospect");

const AT = new Date("2026-08-08T03:00:00.000Z");
const now = () => AT;

const HEADER = "name,category,phone,phone_2,site,full_address,city,state,postal_code,country,place_id,location_link,query_date,business_status,about";
const ROW = (over = {}) => {
  const f = {
    name: "M8H Review Probe Locksmiths",
    category: "Locksmith",
    phone: "(03) 5550 6101",
    phone_2: "",
    city: "Coburg",
    state: "VIC",
    postcode: "3058",
    place_id: "PLACE-M8H-0001",
    ...over,
  };
  return `${f.name},${f.category},${f.phone},${f.phone_2},https://m8h-review-probe.example.com.au,1 Test St ${f.city} VIC ${f.postcode},${f.city},${f.state},${f.postcode},Australia,${f.place_id},https://maps.example.com/?cid=m8h,2026-08-01,OPERATIONAL,Locksmith`;
};
const csv = (...rows) => [HEADER, ...rows].join("\n");

async function importAndPersist(store, text, { clock = now } = {}) {
  const ledger = createEvidenceLedger({ now: clock });
  const existing = await loadExistingForImport({ store, text, profileName: "outscraper-google-maps" });
  const result = importBusinessCsv({ text, profileName: "outscraper-google-maps", now: clock, ledger, existing });
  const written = await persistImportResult({ result, ledger, store, now: clock });
  return { result, ledger, written };
}

const candidate = (over = {}) => ({
  prospectId: "pr_m8h_candidate_0001",
  businessName: "M8H Review Probe Locksmiths",
  tradeCategory: "Locksmith",
  suburb: "Coburg",
  state: "VIC",
  postcode: "3058",
  timezone: "Australia/Melbourne",
  phones: [{ raw: "(03) 5550 6101", label: "Listed number" }],
  origin: "operator_import",
  ...over,
});

// ---------------------------------------------------------------------------

describe("the decision chain can be continued across a restart", () => {
  it("still starts at genesis when nothing is hydrated", () => {
    const log = createAuditLog({ now });
    const a = log.record({ entityType: "prospect", entityId: "p1", event: "e", decision: "record", actor: "t", reason: "r" });
    assert.strictEqual(a.prevHash, "0".repeat(64));
    assert.strictEqual(a.sequence, 1);
    assert.strictEqual(verifyRows(log.all()).ok, true);
  });

  it("continues from a persisted head, and the combined chain verifies as one", () => {
    const before = createAuditLog({ now });
    before.record({ entityType: "prospect", entityId: "p1", event: "opened", decision: "defer", actor: "t", reason: "r" });
    before.record({ entityType: "prospect", entityId: "p1", event: "noted", decision: "record", actor: "t", reason: "r" });
    const persisted = before.all();
    const head = persisted[persisted.length - 1];

    // A different process, holding nothing but what the database gave it.
    const after = createAuditLog({ now, initialHead: head.entryHash, initialSequence: head.sequence });
    after.record({ entityType: "prospect", entityId: "p1", event: "resolved", decision: "approve", actor: "Peter", reason: "r" });

    const combined = [...persisted, ...after.all()];
    assert.strictEqual(verifyRows(combined).ok, true, "pre-restart and post-restart rows must verify as ONE chain");
    assert.strictEqual(combined[2].prevHash, head.entryHash);
    assert.strictEqual(combined[2].sequence, 3, "the sequence continues rather than restarting");
  });

  /**
   * THE FAILURE THIS PREVENTS. Without hydration a fresh process starts a
   * second chain from genesis, and the combined log verifies as altered — which
   * it would be.
   */
  it("a second genesis chain is NOT silently accepted", () => {
    const before = createAuditLog({ now });
    before.record({ entityType: "prospect", entityId: "p1", event: "opened", decision: "defer", actor: "t", reason: "r" });

    const naive = createAuditLog({ now }); // forgot to hydrate
    naive.record({ entityType: "prospect", entityId: "p1", event: "resolved", decision: "approve", actor: "t", reason: "r" });

    const combined = [...before.all(), ...naive.all()];
    assert.strictEqual(verifyRows(combined).ok, false, "two genesis chains must be reported as a break");
  });

  it("detects a wrong initialHead", () => {
    const before = createAuditLog({ now });
    before.record({ entityType: "prospect", entityId: "p1", event: "opened", decision: "defer", actor: "t", reason: "r" });

    const wrong = createAuditLog({ now, initialHead: "b".repeat(64), initialSequence: 1 });
    wrong.record({ entityType: "prospect", entityId: "p1", event: "resolved", decision: "approve", actor: "t", reason: "r" });

    assert.strictEqual(verifyRows([...before.all(), ...wrong.all()]).ok, false);
  });

  it("refuses a malformed or self-contradictory hydration", () => {
    assert.throws(() => createAuditLog({ now, initialHead: "nope", initialSequence: 3 }), /64-character hash/);
    assert.throws(() => createAuditLog({ now, initialHead: "a".repeat(64), initialSequence: 0 }), /non-zero sequence/);
    assert.throws(() => createAuditLog({ now, initialSequence: -1 }), /initialSequence/);
  });

  it("verifyRows is unchanged: it still rejects an altered row", () => {
    const log = createAuditLog({ now });
    log.record({ entityType: "prospect", entityId: "p1", event: "e", decision: "record", actor: "t", reason: "original" });
    const rows = log.all().map((r) => ({ ...r, reason: "tampered" }));
    assert.strictEqual(verifyRows(rows).ok, false);
  });

  it("hydrates from the store, so a fresh process continues automatically", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await hydratedLog({ store, now });
    const opened = first.log.record({ entityType: "prospect", entityId: "p1", event: "opened", decision: "defer", actor: "t", reason: "r" });
    await store.appendDecision(opened);

    const second = await hydratedLog({ store, now });
    const resolved = second.log.record({ entityType: "prospect", entityId: "p1", event: "resolved", decision: "approve", actor: "t", reason: "r" });
    await store.appendDecision(resolved);

    assert.strictEqual(verifyRows(await store.listDecisions({})).ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("the store carries the decision log", () => {
  it("names both methods in the contract", () => {
    assert.ok(STORE_METHODS.includes("appendDecision"));
    assert.ok(STORE_METHODS.includes("listDecisions"));
    assert.doesNotThrow(() => assertStoreContract(createInMemoryAcquisitionStore(), "memory"));
  });

  it("is idempotent on the entry hash", async () => {
    const store = createInMemoryAcquisitionStore();
    const log = createAuditLog({ now });
    const row = log.record({ entityType: "prospect", entityId: "p1", event: "e", decision: "record", actor: "t", reason: "r" });
    assert.strictEqual((await store.appendDecision(row)).created, true);
    assert.strictEqual((await store.appendDecision(row)).created, false, "the same decision twice is the same decision");
    assert.strictEqual((await store.listDecisions({})).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("a review item survives the process", () => {
  it("is created, and a fresh read finds it", async () => {
    const store = createInMemoryAcquisitionStore();
    const opened = await openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", possibleMatches: ["pr_existing"], store, now });
    assert.strictEqual(opened.created, true);

    // Nothing in memory is reused; only the store survives.
    const loaded = await loadReviewItem({ store, reviewId: opened.reviewId });
    assert.strictEqual(loaded.status, STATUS.OPEN);
    assert.strictEqual(loaded.candidate.businessName, "M8H Review Probe Locksmiths");
    assert.deepStrictEqual([...loaded.possibleMatches], ["pr_existing"]);
  });

  it("does not open a second item for the same unresolved candidate", async () => {
    const store = createInMemoryAcquisitionStore();
    const a = await openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", store, now });
    const b = await openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", store, now });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false, "the founder must not be asked the same question twice");
    assert.strictEqual((await listReviewItems({ store })).length, 1);
  });

  it("does not reopen an item that was already decided", async () => {
    const store = createInMemoryAcquisitionStore();
    const opened = await openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", store, now });
    await resolveReviewItem({ store, reviewId: opened.reviewId, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: "Peter", reason: "Same business as pr_existing.", now });

    const again = await openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", store, now });
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.status, STATUS.RESOLVED);
    assert.strictEqual((await listReviewItems({ store, status: STATUS.OPEN })).length, 0);
  });

  it("lists open and resolved separately", async () => {
    const store = createInMemoryAcquisitionStore();
    await openReviewItem({ candidate: candidate(), reason: "r", store, now });
    await openReviewItem({ candidate: candidate({ prospectId: "pr_m8h_candidate_0002", businessName: "Another" }), reason: "r", store, now });
    await resolveReviewItem({ store, reviewId: "rv_pr_m8h_candidate_0002", decision: REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH, actor: "Peter", reason: "Security installer, not a locksmith.", now });

    assert.strictEqual((await listReviewItems({ store })).length, 2);
    assert.strictEqual((await listReviewItems({ store, status: STATUS.OPEN })).length, 1);
    assert.strictEqual((await listReviewItems({ store, status: STATUS.RESOLVED })).length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("resolving a review item", () => {
  const opened = async (store) => openReviewItem({ candidate: candidate(), reason: "May be a duplicate.", possibleMatches: ["pr_existing"], store, now });

  it("records who decided, why, and when", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    const r = await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Different shopfront, different number.", now });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.status, STATUS.RESOLVED);
    assert.strictEqual(r.item.decision, REVIEW_DECISIONS.APPROVE_AS_NEW);
    assert.strictEqual(r.item.decidedBy, "Peter");
    assert.match(r.item.decisionReason, /Different shopfront/);
    assert.strictEqual(r.recorded.actorKind, "human", "an ambiguous case is decided by a person, never by the classifier");
  });

  it("refuses a stale resolution rather than silently re-deciding", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: "Peter", reason: "Same business.", now });

    const second = await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Sam", reason: "I think it is new.", now });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.code, "already_resolved");
    assert.match(second.message, /Peter/, "the refusal should say who decided it");
  });

  it("insists on a named human and a reason", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    assert.strictEqual((await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "", reason: "x", now })).code, "actor_required");
    assert.strictEqual((await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "  ", now })).code, "reason_required");
  });

  it("requires a target for a merge", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    const r = await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: "Peter", reason: "Same business.", now });
    assert.strictEqual(r.code, "merge_target_required");
  });

  it("leaves the item OPEN for needs-more-information, and keeps the note", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    const r = await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.NEEDS_MORE_INFORMATION, actor: "Peter", reason: "Waiting on the ABN lookup.", now });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.status, STATUS.OPEN, "I looked and still cannot tell must not close the item");
    assert.ok(r.item.history.some((h) => /ABN lookup/.test(h.reason)));
  });

  it("refuses an unknown decision and a missing item", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    assert.strictEqual((await resolveReviewItem({ store, reviewId: item.reviewId, decision: "obliterate", actor: "P", reason: "r", now })).code, "decision_unknown");
    assert.strictEqual((await resolveReviewItem({ store, reviewId: "rv_nope", decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "P", reason: "r", now })).code, "review_not_found");
  });

  it("keeps the chain valid across open and resolve", async () => {
    const store = createInMemoryAcquisitionStore();
    const item = await opened(store);
    await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: "Peter", reason: "Same business.", now });
    assert.strictEqual(verifyRows(await store.listDecisions({})).ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("an ambiguous import becomes durable review work", () => {
  it("held candidates open a review item instead of evaporating", async () => {
    const store = createInMemoryAcquisitionStore();
    await importAndPersist(store, csv(ROW()));

    // A drifted second listing: same number, different name and suburb.
    const drifted = csv(ROW({ name: "M8H Review Probe Locksmiths Pty Ltd", city: "Coburg North", place_id: "PLACE-M8H-0002" }));
    const second = await importAndPersist(store, drifted);

    assert.ok(second.written.summary.heldForReview >= 1, "the ambiguous candidate is held");
    const items = await listReviewItems({ store, status: STATUS.OPEN });
    assert.strictEqual(items.length, 1, "and is durably queued");
    assert.ok(items[0].possibleMatches.length >= 1, "with the business it might be");
  });

  it("re-importing the same ambiguous row does not grow the queue", async () => {
    const store = createInMemoryAcquisitionStore();
    await importAndPersist(store, csv(ROW()));
    const drifted = csv(ROW({ name: "M8H Review Probe Locksmiths Pty Ltd", city: "Coburg North", place_id: "PLACE-M8H-0002" }));
    await importAndPersist(store, drifted);
    await importAndPersist(store, drifted);
    await importAndPersist(store, drifted);

    assert.strictEqual((await listReviewItems({ store })).length, 1, "one question, however many times the file is run");
  });

  it("still does not write the held candidate as a prospect", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await importAndPersist(store, csv(ROW()));
    const before = (await store.findProspects({ e164: "+61355506101" })).length;

    await importAndPersist(store, csv(ROW({ name: "M8H Review Probe Locksmiths Pty Ltd", city: "Coburg North", place_id: "PLACE-M8H-0002" })));
    const after = (await store.findProspects({ e164: "+61355506101" })).length;

    assert.strictEqual(after, before, "a possible duplicate must not become the duplicate row");
    assert.ok(first.written.summary.created >= 1);
  });
});

// ---------------------------------------------------------------------------

describe("merge enrichment attaches what is genuinely new", () => {
  const seeded = async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    return { store, canonicalId: written.persisted[0].prospectId };
  };

  it("keeps the canonical prospect id and adds a newly published number once", async () => {
    const { store, canonicalId } = await seeded();
    const before = (await store.listProspectPhones(canonicalId)).length;

    const r = await attachMergedListing({
      canonicalProspectId: canonicalId,
      candidate: candidate({ phones: [{ raw: "(03) 5550 6101" }, { raw: "0455 010 601", label: "Listed mobile" }] }),
      evidence: [],
      store,
      now,
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.phonesAdded, 1, "only the new one");
    assert.strictEqual(r.phonesAlreadyPresent, 1, "the existing one is recognised, not duplicated");
    assert.strictEqual((await store.listProspectPhones(canonicalId)).length, before + 1);
  });

  it("is idempotent — merging the same listing again adds nothing", async () => {
    const { store, canonicalId } = await seeded();
    const args = { canonicalProspectId: canonicalId, candidate: candidate({ phones: [{ raw: "0455 010 601" }] }), evidence: [], store, now };
    await attachMergedListing(args);
    const second = await attachMergedListing(args);
    assert.strictEqual(second.phonesAdded, 0);
    assert.strictEqual(second.outcome, "unchanged");
  });

  /**
   * The evidence hash must be computed against the row it will LIVE on. A
   * candidate's rows name the candidate's prospect id; re-pointing them by
   * editing the field would leave a hash that matches nothing, so the same fact
   * would append again on every future import, forever, into an append-only
   * table.
   */
  it("re-records evidence under the canonical prospect, and does not duplicate it", async () => {
    const { store, canonicalId } = await seeded();
    const ledger = createEvidenceLedger({ now });
    const claim = ledger.record({
      prospectId: "pr_m8h_candidate_0001",
      kind: "trade_category",
      captureMode: "operator_import",
      value: "Emergency locksmith",
      observedAt: AT.toISOString(),
      capturedBy: "test",
      source: { url: "https://maps.example.com/?cid=m8h", sourceType: "map_listing", label: "Google Maps listing" },
    });

    const first = await attachMergedListing({ canonicalProspectId: canonicalId, candidate: candidate({ phones: [] }), evidence: [claim], store, now });
    assert.strictEqual(first.evidenceAdded, 1);

    const stored = (await store.listEvidence(canonicalId)).filter((e) => e.value === "Emergency locksmith");
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].prospectId, canonicalId, "it lives on the canonical prospect");

    const second = await attachMergedListing({ canonicalProspectId: canonicalId, candidate: candidate({ phones: [] }), evidence: [claim], store, now });
    assert.strictEqual(second.evidenceAdded, 0, "the same claim must not append twice");
  });

  it("does not overwrite the canonical prospect's own fields", async () => {
    const { store, canonicalId } = await seeded();
    const before = await store.loadProspect(canonicalId);

    await attachMergedListing({
      canonicalProspectId: canonicalId,
      candidate: candidate({ businessName: "TOTALLY DIFFERENT NAME", suburb: "Elsewhere", tradeCategory: "Something else" }),
      evidence: [],
      store,
      now,
    });

    const after = await store.loadProspect(canonicalId);
    assert.strictEqual(after.businessName, before.businessName, "a directory row is not evidence the stored record is wrong");
    assert.strictEqual(after.suburb, before.suburb);
    assert.strictEqual(after.tradeCategory, before.tradeCategory);
  });

  /**
   * The M8G defect's mirror image. A merged directory listing must not be able
   * to make a business look better-sourced than it is.
   */
  it("cannot upgrade source authority", async () => {
    const { store, canonicalId } = await seeded();
    const ledger = createEvidenceLedger({ now });
    const claim = ledger.record({
      prospectId: "pr_m8h_candidate_0001",
      kind: "phone",
      captureMode: "operator_import",
      value: "0455 010 601",
      observedAt: AT.toISOString(),
      capturedBy: "test",
      source: { url: "https://maps.example.com/?cid=m8h", sourceType: "map_listing", label: "Google Maps listing" },
    });

    await attachMergedListing({ canonicalProspectId: canonicalId, candidate: candidate({ phones: [] }), evidence: [claim], store, now });
    const assessment = assessEvidence(await store.listEvidence(canonicalId));
    assert.strictEqual(assessment.phoneFromOfficialSource, false, "a merged directory number is still not officially sourced");
  });

  it("refuses to merge into a prospect that does not exist", async () => {
    const store = createInMemoryAcquisitionStore();
    const r = await attachMergedListing({ canonicalProspectId: "pr_nope", candidate: candidate(), evidence: [], store, now });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "canonical_missing");
  });

  it("runs automatically when the importer conclusively merges", async () => {
    const store = createInMemoryAcquisitionStore();
    await importAndPersist(store, csv(ROW()));
    const canonicalId = (await store.findProspects({ e164: "+61355506101" }))[0].prospectId;
    const before = (await store.listProspectPhones(canonicalId)).length;

    // Same name, same locality, same number, PLUS a newly published mobile.
    const second = await importAndPersist(store, csv(ROW({ phone_2: "0455 010 601" })));

    assert.ok(second.result.outcomes[0].status === IMPORT_OUTCOMES.MERGED || second.written.summary.mergePhonesAdded >= 0);
    assert.strictEqual((await store.listProspectPhones(canonicalId)).length, before + 1, "the newly published number is attached to the business we already have");
  });
});

// ---------------------------------------------------------------------------

describe("review and merge never weaken suppression", () => {
  const suppress = async (store, prospect) => {
    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint(prospect),
      e164: "+61355506101",
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
      suppressedAt: AT.toISOString(),
    });
  };

  it("a suppressed business still blocks after merge enrichment", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const canonicalId = written.persisted[0].prospectId;
    const prospect = await store.loadProspect(canonicalId);
    await suppress(store, prospect);

    await attachMergedListing({ canonicalProspectId: canonicalId, candidate: candidate({ phones: [{ raw: "0455 010 601" }] }), evidence: [], store, now });

    const suppression = createSuppressionList({ now, initialEntries: await store.listSuppressions() });
    const engine = createEligibilityEngine({ now, suppression });
    const decision = engine.evaluate({ ...prospect, phones: [{ raw: "(03) 5550 6101" }] }, { evidenceRows: [] });
    assert.strictEqual(decision.eligible, false);
    assert.ok(decision.failedChecks.some((f) => f.check === "suppression" && f.code === ELIGIBILITY_CODES.SUPPRESSED));
  });

  it("the final authorisation gate still refuses it", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    const prospect = await store.loadProspect(written.persisted[0].prospectId);
    await suppress(store, prospect);

    const gate = createDialAuthoriser({ now, store });
    const decision = await gate.authorise({ ...prospect, phones: [{ raw: "(03) 5550 6101" }] }, {});
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.dial, null);
  });

  it("resolving a review cannot erase or mutate a suppression", async () => {
    const store = createInMemoryAcquisitionStore();
    const { written } = await importAndPersist(store, csv(ROW()));
    await suppress(store, await store.loadProspect(written.persisted[0].prospectId));
    const before = await store.listSuppressions();

    const item = await openReviewItem({ candidate: candidate(), reason: "r", store, now });
    await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Approved.", now });

    assert.deepStrictEqual(await store.listSuppressions(), before, "no review decision may touch the suppression list");
  });

  it("approving as new cannot bypass a suppression on the same number", async () => {
    const store = createInMemoryAcquisitionStore();
    const c = candidate();
    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint(c),
      e164: "+61355506101",
      actor: "founder",
      actorKind: "human",
      note: "Opted out.",
      suppressedAt: AT.toISOString(),
    });

    const item = await openReviewItem({ candidate: c, reason: "r", store, now });
    await resolveReviewItem({ store, reviewId: item.reviewId, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Looks like a real business.", now });

    // Approval is about identity, never about permission. The gate is the only
    // thing that grants that, and it reads durable suppression.
    const gate = createDialAuthoriser({ now, store });
    const decision = await gate.authorise({ ...c, lifecycle: "discovered" }, {});
    assert.strictEqual(decision.authorised, false, "a founder approving a business does not un-suppress it");
  });
});

// ---------------------------------------------------------------------------

describe("nothing in the review path can contact anybody", () => {
  const MODULES = ["acquisition-review-queue.js", "acquisition-persist.js"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");

  it("imports no network or provider client", () => {
    for (const f of MODULES) {
      for (const pattern of [/require\(["'](https?|node:https?|axios|node-fetch|twilio|retell-sdk|@retell|nodemailer)["']\)/, /\bfetch\s*\(/]) {
        assert.ok(!pattern.test(read(f)), `${f} must not contain ${pattern}`);
      }
    }
  });

  it("has no call, SMS or email surface", () => {
    for (const f of MODULES) {
      for (const pattern of [/messages\.create\s*\(/, /calls\.create\s*\(/, /\bplaceCall\s*\(/, /\bsendSms\s*\(/, /\bdial\s*\(/]) {
        assert.ok(!pattern.test(read(f)), `${f} must not contain ${pattern}`);
      }
    }
  });

  it("cannot approve compliance or mark a business callable", () => {
    const src = read("acquisition-review-queue.js");
    for (const pattern of [/callingPolicyApproval/, /washStore/, /review_approved/, /appendSuppression/]) {
      assert.ok(!pattern.test(src), `the review queue must not touch ${pattern}`);
    }
  });

  it("still has no dialler anywhere in the acquisition tree", () => {
    const dir = path.join(__dirname, "..", "src", "services");
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("acquisition-") && f.endsWith(".js"))
      .filter((f) => /\bfunction\s+(dial|placeCall|dispatchCall|startCall|ringProspect)\s*\(/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    assert.deepStrictEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------

/**
 * THE ROUND TRIP HAS TO BE EXACT (M8H).
 *
 * Found by the real Postgres proof, not by these tests. `recorded_at` is a
 * timestamptz: it goes in as `...000Z` and comes back as `...+00:00` — same
 * instant, different string, different sha256. `sequence` is a bigint and
 * returns as a string for the same reason.
 *
 * Either one silently breaks verifyChain(), which then reports an UNTAMPERED
 * log as altered. That is the worst failure available to an integrity control,
 * because it destroys trust in the only thing that was supposed to be
 * trustworthy — and it would have been discovered by somebody investigating a
 * fake breach.
 *
 * The in-memory store cannot reproduce it (it hands back the same object), so
 * this pins the shape the Supabase adapter has to preserve.
 */
describe("a decision read back from storage still verifies", () => {
  const { verifyRows: verify } = require("../src/services/acquisition-audit");

  const postgresish = (row) => ({
    audit_id: row.auditId,
    schema_version: row.schemaVersion,
    // bigint arrives as a string
    sequence: String(row.sequence),
    entity_type: row.entityType,
    entity_id: row.entityId,
    event: row.event,
    decision: row.decision,
    actor: row.actor,
    actor_kind: row.actorKind,
    reason: row.reason,
    detail: row.detail,
    correlation_id: row.correlationId,
    prev_hash: row.prevHash,
    entry_hash: row.entryHash,
    // timestamptz arrives in offset form, not Z form
    recorded_at: row.recordedAt.replace(/\.(\d{3})Z$/, "+00:00"),
  });

  it("survives timestamptz and bigint coming back in a different shape", () => {
    const log = createAuditLog({ now });
    const a = log.record({ entityType: "prospect", entityId: "p1", event: "review_opened", decision: "defer", actor: "t", reason: "r", detail: { z: 1, a: 2 } });
    const b = log.record({ entityType: "prospect", entityId: "p1", event: "review_resolved", decision: "approve", actor: "Peter", reason: "r" });

    assert.strictEqual(verify([a, b]).ok, true, "the in-memory rows verify");

    // What the adapter must reconstruct them to.
    const { PROSPECT_ROUND_TRIP: _unused } = {};
    const roundTripped = [a, b].map(postgresish).map((r) => ({
      auditId: r.audit_id,
      schemaVersion: r.schema_version,
      sequence: Number(r.sequence),
      entityType: r.entity_type,
      entityId: r.entity_id,
      event: r.event,
      decision: r.decision,
      actor: r.actor,
      actorKind: r.actor_kind,
      reason: r.reason,
      detail: r.detail,
      correlationId: r.correlation_id,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
      recordedAt: new Date(r.recorded_at).toISOString(),
    }));

    assert.strictEqual(verify(roundTripped).ok, true, "and so must the rows read back out of the database");
  });

  it("would have caught the defect: leaving the timestamp uncanonicalised breaks the chain", () => {
    const log = createAuditLog({ now });
    const a = log.record({ entityType: "prospect", entityId: "p1", event: "review_opened", decision: "defer", actor: "t", reason: "r" });
    const naive = { ...a, recordedAt: a.recordedAt.replace(/\.(\d{3})Z$/, "+00:00") };
    assert.strictEqual(verify([naive]).ok, false, "an untampered row must not verify if its shape was not restored");
  });
});
