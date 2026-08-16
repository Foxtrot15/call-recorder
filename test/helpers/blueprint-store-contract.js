// THE STORE CONTRACT — one suite, run against every implementation.
//
// The in-memory store is the executable specification for the durable one. If
// they can diverge, the durable store will diverge in production and the tests
// will not notice, so neither gets its own private test file for anything that
// is genuinely a contract.
//
// Usage:
//
//   runStoreContract({ describe, it, assert, name, makeStore });
//
// `makeStore` returns a FRESH store plus the authority built over it, because
// the contract is about what the authority observes — a store is only ever
// used through one.

function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

/**
 * @param {object} o
 * @param {Function} o.makeStore  () => { store, now } — fresh, empty, isolated
 */
function runStoreContract({ describe, it, assert, name, makeStore, createBlueprintAuthority, fixtures }) {
  const { locksmithA, locksmithB, plumberC } = fixtures;

  /** A fresh authority over a fresh store of this implementation. */
  function harness() {
    const { store, now = fixedClock() } = makeStore();
    return { store, now, authority: createBlueprintAuthority({ store, now }) };
  }

  async function activate(authority, clientId, blueprint, who = "Peter Dang") {
    const draft = await authority.createDraft({ clientId, blueprint, createdBy: who });
    assert.equal(draft.ok, true, `createDraft: ${JSON.stringify(draft)}`);
    const v = draft.version.metadata.configVersion;
    assert.equal((await authority.validateDraft(clientId, v)).ok, true);
    assert.equal((await authority.approveDraft({ clientId, configVersion: v, approvedBy: who })).ok, true);
    const active = await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: who });
    assert.equal(active.ok, true, `activate: ${JSON.stringify(active)}`);
    return active.version;
  }

  describe(`store contract [${name}] — create and read`, () => {
    it("stores a draft and reads it back with its body intact", async () => {
      const { authority } = harness();
      const created = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
      assert.equal(created.ok, true, JSON.stringify(created));

      const read = await authority.getDraft("northside_locks", created.version.metadata.configVersion);
      assert.equal(read.ok, true);
      assert.equal(read.version.identity.legalName, locksmithA().identity.legalName);
      assert.equal(read.version.services.length, locksmithA().services.length);
      assert.deepEqual(read.version.hours.weekly, locksmithA().hours.weekly);
      assert.equal(read.version.metadata.status, "draft");
      assert.equal(read.version.metadata.createdBy, "Peter Dang");
    });

    it("round-trips every section without losing or inventing a field", async () => {
      const { authority } = harness();
      const original = plumberC();
      const created = await authority.createDraft({ clientId: "riverside_plumbing", blueprint: original, createdBy: "Ravi Menon" });
      const read = await authority.getDraft("riverside_plumbing", created.version.metadata.configVersion);

      for (const section of ["identity", "serviceArea", "hours", "callHandling", "knowledge", "booking", "voice", "compliance", "outbound"]) {
        assert.deepEqual(read.version[section], original[section], `${section} did not survive the round trip`);
      }
      assert.deepEqual(read.version.services, original.services);
      assert.deepEqual(read.version.integrations, original.integrations);
      assert.equal(read.version.schemaVersion, original.schemaVersion);
    });

    it("numbers versions per client, not globally", async () => {
      const { authority } = harness();
      for (const expected of [1, 2, 3]) {
        const r = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
        assert.equal(r.version.metadata.configVersion, expected);
      }
      const other = await authority.createDraft({ clientId: "riverside_plumbing", blueprint: plumberC(), createdBy: "x" });
      assert.equal(other.version.metadata.configVersion, 1);
    });

    it("returns NOT_FOUND for a version that does not exist", async () => {
      const { authority } = harness();
      const got = await authority.getDraft("northside_locks", 99);
      assert.equal(got.ok, false);
      assert.equal(got.code, "blueprint_not_found");
    });

    it("lists a client's whole history in version order", async () => {
      const { authority } = harness();
      await activate(authority, "northside_locks", locksmithA());
      await activate(authority, "northside_locks", locksmithA());
      await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const listed = await authority.listVersions("northside_locks");
      assert.deepEqual(listed.versions.map((v) => v.configVersion), [1, 2, 3]);
      assert.deepEqual(listed.versions.map((v) => v.status), ["superseded", "active", "draft"]);
    });
  });

  describe(`store contract [${name}] — drafts are mutable`, () => {
    it("accepts an edit and keeps it", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      const updated = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v,
        mutate: (bp) => { bp.hours.weekly.saturday = { closed: true }; }, updatedBy: "Editor",
      });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      const read = await authority.getDraft("northside_locks", v);
      assert.deepEqual(read.version.hours.weekly.saturday, { closed: true });
      assert.equal(read.version.metadata.updatedBy, "Editor");
    });

    it("a fresh draft reports updatedAt as null, not absent", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const read = await authority.getDraft("northside_locks", draft.version.metadata.configVersion);
      assert.equal(read.version.metadata.updatedAt, null);
    });
  });

  describe(`store contract [${name}] — stale writes are refused, not merged`, () => {
    it("refuses a second save from an editor working off an older read", async () => {
      const { authority, now } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      const stale = (await authority.getDraft("northside_locks", v)).version.metadata.updatedAt;

      const first = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v, expectedUpdatedAt: stale,
        mutate: (bp) => { bp.serviceArea.suburbs = ["One"]; }, updatedBy: "Editor One",
      });
      assert.equal(first.ok, true);
      now.tick();

      const second = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v, expectedUpdatedAt: stale,
        mutate: (bp) => { bp.serviceArea.suburbs = ["Two"]; }, updatedBy: "Editor Two",
      });
      assert.equal(second.ok, false);
      assert.equal(second.code, "stale_version_conflict");

      const after = await authority.getDraft("northside_locks", v);
      assert.deepEqual(after.version.serviceArea.suburbs, ["One"], "the refused change must not be merged");
    });

    it("distinguishes an omitted expectation from an expectation of null", async () => {
      const { authority, now } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;

      const omitted = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v,
        mutate: (bp) => { bp.identity.description = "one"; }, updatedBy: "Editor One",
      });
      assert.equal(omitted.ok, true);
      now.tick();

      const stated = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v, expectedUpdatedAt: null,
        mutate: (bp) => { bp.identity.description = "two"; }, updatedBy: "Editor Two",
      });
      assert.equal(stated.ok, false);
      assert.equal(stated.code, "stale_version_conflict");
    });

    it("accepts a save carrying the current stamp", async () => {
      const { authority, now } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      const first = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v,
        mutate: (bp) => { bp.identity.description = "one"; }, updatedBy: "E",
      });
      now.tick();
      const second = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v,
        expectedUpdatedAt: first.version.metadata.updatedAt,
        mutate: (bp) => { bp.identity.description = "two"; }, updatedBy: "E",
      });
      assert.equal(second.ok, true, JSON.stringify(second));
    });
  });

  describe(`store contract [${name}] — approval`, () => {
    it("refuses approval of an unvalidated draft", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const result = await authority.approveDraft({
        clientId: "northside_locks", configVersion: draft.version.metadata.configVersion, approvedBy: "Peter Dang",
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "not_a_draft");
    });

    it("refuses approval by anything that is not a person", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      await authority.validateDraft("northside_locks", v);
      for (const machine of ["system", "aida", "bot", "cron", "", "  "]) {
        const r = await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: machine });
        assert.equal(r.ok, false, `"${machine}" must not approve`);
        assert.equal(r.code, "approver_is_not_a_person");
      }
    });

    it("records who approved, when, and why", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      await authority.validateDraft("northside_locks", v);
      const approved = await authority.approveDraft({
        clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang", reason: "Read it with the owner.",
      });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const read = await authority.getDraft("northside_locks", v);
      assert.equal(read.version.metadata.approvedBy, "Peter Dang");
      assert.equal(read.version.metadata.approvalReason, "Read it with the owner.");
      assert.ok(read.version.metadata.approvedAt);
    });
  });

  describe(`store contract [${name}] — approved and active content is immutable`, () => {
    it("refuses to edit an approved version", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      await authority.validateDraft("northside_locks", v);
      await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });

      const result = await authority.updateDraft({
        clientId: "northside_locks", configVersion: v,
        mutate: (bp) => { bp.identity.legalName = "Rewritten Pty Ltd"; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "version_is_immutable");

      const read = await authority.getDraft("northside_locks", v);
      assert.notEqual(read.version.identity.legalName, "Rewritten Pty Ltd");
    });

    it("refuses to edit an active version", async () => {
      const { authority } = harness();
      const active = await activate(authority, "northside_locks", locksmithA());
      const result = await authority.updateDraft({
        clientId: "northside_locks", configVersion: active.metadata.configVersion,
        mutate: (bp) => { bp.knowledge.pricingDisclosure = "never_discuss"; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "version_is_immutable");
    });

    it("refuses to edit a superseded version", async () => {
      const { authority } = harness();
      const first = await activate(authority, "northside_locks", locksmithA());
      await activate(authority, "northside_locks", locksmithA());
      const result = await authority.updateDraft({
        clientId: "northside_locks", configVersion: first.metadata.configVersion,
        mutate: (bp) => { bp.identity.legalName = "History Rewritten Pty Ltd"; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "version_is_immutable");
    });
  });

  describe(`store contract [${name}] — activation`, () => {
    it("refuses to activate anything not approved", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      assert.equal((await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v })).code, "version_not_approved");
      await authority.validateDraft("northside_locks", v);
      assert.equal((await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v })).code, "version_not_approved");
    });

    it("approving does not activate", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      await authority.validateDraft("northside_locks", v);
      await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });
      const active = await authority.getActiveVersion("northside_locks");
      assert.equal(active.ok, false);
      assert.equal(active.code, "no_active_version");
    });

    it("supersedes the incumbent so there is never a moment with two", async () => {
      const { authority } = harness();
      const first = await activate(authority, "northside_locks", locksmithA());
      const second = await activate(authority, "northside_locks", locksmithA());
      const listed = await authority.listVersions("northside_locks");
      const actives = listed.versions.filter((v) => v.status === "active");
      assert.equal(actives.length, 1);
      assert.equal(actives[0].configVersion, second.metadata.configVersion);
      assert.equal(listed.versions.find((v) => v.configVersion === first.metadata.configVersion).status, "superseded");
    });

    it("is idempotent — activating the already-active version changes nothing", async () => {
      const { authority } = harness();
      const active = await activate(authority, "northside_locks", locksmithA());
      const again = await authority.activateApprovedVersion({
        clientId: "northside_locks", configVersion: active.metadata.configVersion,
      });
      assert.equal(again.ok, true);
      assert.equal(again.alreadyActive, true);
      const listed = await authority.listVersions("northside_locks");
      assert.equal(listed.versions.filter((v) => v.status === "active").length, 1);
    });

    it("reports no active version for a client that has never had one", async () => {
      const { authority } = harness();
      const result = await authority.getActiveVersion("nobody_at_all");
      assert.equal(result.ok, false);
      assert.equal(result.code, "no_active_version");
    });

    it("hands back a frozen active version", async () => {
      const { authority } = harness();
      await activate(authority, "northside_locks", locksmithA());
      const active = await authority.getActiveVersion("northside_locks");
      assert.ok(Object.isFrozen(active.version));
      assert.ok(Object.isFrozen(active.version.identity));
    });
  });

  describe(`store contract [${name}] — supersede and restore`, () => {
    it("marks a version superseded with a reason", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const result = await authority.supersedeVersion({
        clientId: "northside_locks", configVersion: draft.version.metadata.configVersion, reason: "Abandoned.",
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const read = await authority.getDraft("northside_locks", draft.version.metadata.configVersion);
      assert.equal(read.version.metadata.status, "superseded");
      assert.equal(read.version.metadata.supersedeReason, "Abandoned.");
    });

    it("restore copies an old body into a NEW draft rather than reviving it", async () => {
      const { authority } = harness();
      const original = locksmithA();
      original.identity.description = "The original description.";
      const first = await activate(authority, "northside_locks", original);

      const changed = locksmithA();
      changed.identity.description = "A description somebody regrets.";
      await activate(authority, "northside_locks", changed);

      const restored = await authority.restoreFromVersion({
        clientId: "northside_locks", configVersion: first.metadata.configVersion, createdBy: "Peter Dang",
      });
      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(restored.version.metadata.status, "draft");
      assert.equal(restored.version.identity.description, "The original description.");
      assert.ok(restored.version.metadata.configVersion > first.metadata.configVersion);
      assert.equal(restored.version.metadata.approvedAt, null);
      assert.equal(restored.version.metadata.activatedAt, null);

      const source = await authority.getDraft("northside_locks", first.metadata.configVersion);
      assert.equal(source.version.metadata.status, "superseded", "the restored-from version stays as it was");
    });

    it("a restored draft still has to be validated and approved", async () => {
      const { authority } = harness();
      const first = await activate(authority, "northside_locks", locksmithA());
      await activate(authority, "northside_locks", locksmithA());
      const restored = await authority.restoreFromVersion({
        clientId: "northside_locks", configVersion: first.metadata.configVersion, createdBy: "Peter Dang",
      });
      const early = await authority.activateApprovedVersion({
        clientId: "northside_locks", configVersion: restored.version.metadata.configVersion,
      });
      assert.equal(early.ok, false);
      assert.equal(early.code, "version_not_approved");
    });
  });

  describe(`store contract [${name}] — tenant isolation`, () => {
    it("refuses to file one client's blueprint under another's id", async () => {
      const { authority } = harness();
      const result = await authority.createDraft({
        clientId: "southbank_security", blueprint: locksmithA(), createdBy: "x",
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "cross_tenant_reference_refused");
    });

    it("does not return one client's version to another", async () => {
      const { authority } = harness();
      await activate(authority, "northside_locks", locksmithA());
      const result = await authority.getDraft("southbank_security", 1);
      assert.equal(result.ok, false);
      assert.equal(result.code, "blueprint_not_found");
    });

    it("refuses a draft edit that moves itself to another tenant", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const result = await authority.updateDraft({
        clientId: "northside_locks", configVersion: draft.version.metadata.configVersion,
        mutate: (bp) => { bp.identity.clientId = "southbank_security"; },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "cross_tenant_reference_refused");
    });

    it("keeps three clients' active versions entirely separate", async () => {
      const { authority } = harness();
      await activate(authority, "northside_locks", locksmithA());
      await activate(authority, "southbank_security", locksmithB(), "Dana Whitfield");
      await activate(authority, "riverside_plumbing", plumberC(), "Ravi Menon");

      assert.equal((await authority.getActiveVersion("northside_locks")).version.identity.tradingName, "Northside Lock & Key");
      assert.equal((await authority.getActiveVersion("southbank_security")).version.identity.tradingName, "Southbank Security");
      assert.equal((await authority.getActiveVersion("riverside_plumbing")).version.identity.tradingName, "Riverside Plumbing");

      assert.equal((await authority.listVersions("northside_locks")).versions.length, 1);
    });

    it("does not let one client's growth change another's version numbering", async () => {
      const { authority } = harness();
      for (let i = 0; i < 5; i += 1) {
        await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      }
      const other = await authority.createDraft({ clientId: "riverside_plumbing", blueprint: plumberC(), createdBy: "x" });
      assert.equal(other.version.metadata.configVersion, 1);
    });
  });

  describe(`store contract [${name}] — validation is a transition`, () => {
    it("moves a valid draft to validated", async () => {
      const { authority } = harness();
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
      const v = draft.version.metadata.configVersion;
      const result = await authority.validateDraft("northside_locks", v);
      assert.equal(result.ok, true, JSON.stringify(result.errors || result));
      const read = await authority.getDraft("northside_locks", v);
      assert.equal(read.version.metadata.status, "validated");
      assert.ok(read.version.metadata.validatedAt);
    });

    it("refuses to validate a broken draft and names what is broken", async () => {
      const { authority } = harness();
      const broken = locksmithA();
      broken.services = [];
      const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: broken, createdBy: "x" });
      const result = await authority.validateDraft("northside_locks", draft.version.metadata.configVersion);
      assert.equal(result.ok, false);
      assert.equal(result.code, "blueprint_invalid");
      assert.ok(result.errors.some((e) => e.path === "services"));
    });
  });
}

module.exports = { runStoreContract, fixedClock };
