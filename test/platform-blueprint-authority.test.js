// AIDA PLATFORM P3 — versioning, approval and activation.
//
// The four rules under test are the ones a business will eventually depend on
// without knowing they exist:
//
//   drafts are mutable          editing is safe
//   approved is immutable       the words a person agreed to cannot drift
//   stale writes are refused    two editors do not silently overwrite
//   activation is separate      approving copy ≠ putting it live
//
// Time is injected so the tests are deterministic; nothing here reaches a
// database, and the in-memory store is the same one the CLI uses.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createBlueprintAuthority,
  createInMemoryBlueprintStore,
  AUTHORITY_CODES,
  IMMUTABLE_STATUSES,
} = require("../src/platform/blueprint-authority");

const { locksmithA, locksmithB, plumberC } = require("../src/platform/fixtures/clients");

/** A clock that only moves when a test says so. */
function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

function harness() {
  const now = fixedClock();
  const store = createInMemoryBlueprintStore();
  return { now, store, authority: createBlueprintAuthority({ store, now }) };
}

/** draft -> validated -> approved -> active, the ordinary path. */
async function activate(authority, clientId, blueprint, approver = "Peter Dang") {
  const draft = await authority.createDraft({ clientId, blueprint, createdBy: approver });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const v = draft.version.metadata.configVersion;
  const validated = await authority.validateDraft(clientId, v);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors || validated));
  const approved = await authority.approveDraft({ clientId, configVersion: v, approvedBy: approver });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const active = await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: approver });
  assert.equal(active.ok, true, JSON.stringify(active));
  return active.version;
}

describe("blueprint authority — construction", () => {
  it("refuses to exist without a store", () => {
    assert.throws(() => createBlueprintAuthority({ now: () => new Date() }), /store/);
  });

  it("refuses to exist without an injected clock", () => {
    assert.throws(() => createBlueprintAuthority({ store: createInMemoryBlueprintStore() }), /now/);
  });
});

describe("blueprint authority — drafts are mutable", () => {
  it("creates a draft, and it is a draft rather than anything live", async () => {
    const { authority } = harness();
    const result = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    assert.equal(result.ok, true);
    assert.equal(result.version.metadata.status, "draft");
    assert.equal(result.version.metadata.configVersion, 1);
    assert.equal(result.version.metadata.approvedAt, null);
    assert.equal(result.version.metadata.activatedAt, null);
  });

  it("numbers versions upward, per client, without gaps", async () => {
    const { authority } = harness();
    for (const expected of [1, 2, 3]) {
      const r = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
      assert.equal(r.version.metadata.configVersion, expected);
    }
    const other = await authority.createDraft({ clientId: "riverside_plumbing", blueprint: plumberC(), createdBy: "Peter Dang" });
    assert.equal(other.version.metadata.configVersion, 1, "version numbers are per client, not global");
  });

  it("lets a draft be edited", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const updated = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: draft.version.metadata.configVersion,
      mutate: (bp) => { bp.hours.weekly.saturday = { closed: true }; },
      updatedBy: "Peter Dang",
    });
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.version.hours.weekly.saturday, { closed: true });
    assert.equal(updated.version.metadata.status, "draft");
  });

  it("returns a NOT_FOUND rather than throwing for a version that does not exist", async () => {
    const { authority } = harness();
    const got = await authority.getDraft("northside_locks", 99);
    assert.equal(got.ok, false);
    assert.equal(got.code, AUTHORITY_CODES.NOT_FOUND);
  });
});

describe("blueprint authority — validation is a transition, not a report", () => {
  it("moves a valid draft to validated", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const result = await authority.validateDraft("northside_locks", draft.version.metadata.configVersion);
    assert.equal(result.ok, true);
    assert.equal(result.version.metadata.status, "validated");
    assert.ok(result.version.metadata.validatedAt);
  });

  it("refuses to validate a broken draft, and says exactly what is broken", async () => {
    const { authority } = harness();
    const broken = locksmithA();
    broken.services = [];
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: broken, createdBy: "Peter Dang" });
    const result = await authority.validateDraft("northside_locks", draft.version.metadata.configVersion);
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.INVALID);
    assert.ok(result.errors.some((e) => e.path === "services"));
  });
});

describe("blueprint authority — approval requires a person", () => {
  it("refuses approval of a draft that has not been validated", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const result = await authority.approveDraft({
      clientId: "northside_locks",
      configVersion: draft.version.metadata.configVersion,
      approvedBy: "Peter Dang",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.NOT_A_DRAFT);
  });

  it("refuses approval by anything that is not a person", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);
    for (const machine of ["system", "AIDA", "aida", "bot", "automation", "claude", "agent", "cron", "  ", ""]) {
      const result = await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: machine });
      assert.equal(result.ok, false, `"${machine}" should not be able to approve`);
      assert.equal(result.code, AUTHORITY_CODES.NOT_A_PERSON);
    }
  });

  it("records who approved and why", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);
    const approved = await authority.approveDraft({
      clientId: "northside_locks",
      configVersion: v,
      approvedBy: "Peter Dang",
      reason: "Read the diff aloud with the owner.",
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.version.metadata.approvedBy, "Peter Dang");
    assert.equal(approved.version.metadata.approvalReason, "Read the diff aloud with the owner.");
    assert.ok(approved.version.metadata.approvedAt);
  });

  it("re-validates at the moment of approval, so a stale verdict cannot be cashed in", async () => {
    const { store, now } = harness();
    const authority = createBlueprintAuthority({ store, now });
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);

    // Somebody edits the body directly in the store, keeping the validated
    // status. This is the shape of the bug the recheck exists to catch.
    const stored = await store.getVersion("northside_locks", v);
    stored.services = [];
    await store.replaceVersion(stored);

    const approved = await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });
    assert.equal(approved.ok, false);
    assert.equal(approved.code, AUTHORITY_CODES.INVALID);
  });
});

describe("blueprint authority — approved versions are immutable", () => {
  it("refuses to edit an approved version", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);
    await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });

    const result = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: v,
      mutate: (bp) => { bp.identity.legalName = "Something Else Pty Ltd"; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.IMMUTABLE);
  });

  it("refuses to edit an active version", async () => {
    const { authority } = harness();
    const active = await activate(authority, "northside_locks", locksmithA());
    const result = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: active.metadata.configVersion,
      mutate: (bp) => { bp.knowledge.pricingDisclosure = "never_discuss"; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.IMMUTABLE);
  });

  it("refuses to edit a superseded version", async () => {
    const { authority } = harness();
    const first = await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "northside_locks", locksmithA());
    const result = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: first.metadata.configVersion,
      mutate: (bp) => { bp.identity.legalName = "Rewriting History Pty Ltd"; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.IMMUTABLE);
  });

  it("covers all three immutable statuses", () => {
    assert.deepEqual([...IMMUTABLE_STATUSES].sort(), ["active", "approved", "superseded"]);
  });

  it("hands back an approved version that cannot be mutated through the reference", async () => {
    const { authority } = harness();
    const active = await activate(authority, "northside_locks", locksmithA());

    // These modules are sloppy-mode CommonJS, so a write to a frozen property
    // fails SILENTLY rather than throwing. The property that matters is that
    // the value does not change — assert that, not the mechanism.
    assert.ok(Object.isFrozen(active));
    assert.ok(Object.isFrozen(active.identity));
    assert.ok(Object.isFrozen(active.callHandling.escalation));
    assert.ok(Object.isFrozen(active.services));

    const name = active.identity.legalName;
    const number = active.callHandling.escalation.primaryNumber;
    const serviceCount = active.services.length;

    try { active.identity.legalName = "Mutated Pty Ltd"; } catch { /* strict-mode hosts throw */ }
    try { active.callHandling.escalation.primaryNumber = "+61399999999"; } catch { /* as above */ }
    try { active.services.push({ serviceId: "smuggled_in" }); } catch { /* push throws either way */ }

    assert.equal(active.identity.legalName, name);
    assert.equal(active.callHandling.escalation.primaryNumber, number);
    assert.equal(active.services.length, serviceCount);
  });

  it("does not let a held active reference drift after a later activation", async () => {
    const { authority } = harness();
    const held = await activate(authority, "northside_locks", locksmithA());
    const heldName = held.identity.legalName;
    const changed = locksmithA();
    changed.identity.legalName = "Northside Lock & Key (Vic) Pty Ltd";
    await activate(authority, "northside_locks", changed);
    assert.equal(held.identity.legalName, heldName);
  });
});

describe("blueprint authority — stale writes are refused, not merged", () => {
  it("refuses a second save from an editor working off an older read", async () => {
    const { authority, now } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;

    // Editor One saves.
    const first = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: v,
      mutate: (bp) => { bp.serviceArea.suburbs.push("Reservoir"); },
      updatedBy: "Editor One",
    });
    assert.equal(first.ok, true);
    // What Editor Two read: a draft that had never been edited. That is a real
    // expectation, and null is how it is stated.
    const staleStamp = draft.version.metadata.updatedAt;
    assert.equal(staleStamp, null, "a fresh draft states its unedited-ness rather than omitting it");

    now.tick();
    // Editor Two saves against what they read BEFORE Editor One's save.
    const second = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: v,
      expectedUpdatedAt: staleStamp,
      mutate: (bp) => { bp.serviceArea.suburbs.push("Bundoora"); },
      updatedBy: "Editor Two",
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, AUTHORITY_CODES.STALE);
    assert.equal(second.actualUpdatedAt, first.version.metadata.updatedAt);
  });

  it("does NOT merge the refused change — Editor One's work survives intact", async () => {
    const { authority, now } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: v,
      mutate: (bp) => { bp.serviceArea.suburbs = ["Brunswick"]; },
      updatedBy: "Editor One",
    });
    now.tick();
    const refused = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: v,
      expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
      mutate: (bp) => { bp.serviceArea.suburbs = ["Somewhere Else Entirely"]; },
      updatedBy: "Editor Two",
    });
    assert.equal(refused.ok, false);
    const after = await authority.getDraft("northside_locks", v);
    assert.deepEqual(after.version.serviceArea.suburbs, ["Brunswick"], "the refused change must not be merged in");
  });

  it("distinguishes an omitted expectation from an expectation of null", async () => {
    // The bug this covers: a fresh draft has updatedAt === null, so treating
    // null as "no expectation" made every editor of a never-edited draft
    // unable to detect a conflict at all.
    const { authority, now } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;

    // Omitted: no check, the write lands.
    const omitted = await authority.updateDraft({
      clientId: "northside_locks", configVersion: v,
      mutate: (bp) => { bp.identity.description = "edited by one"; }, updatedBy: "Editor One",
    });
    assert.equal(omitted.ok, true);

    now.tick();
    // Explicit null: "it had never been edited when I read it" — it has now.
    const stated = await authority.updateDraft({
      clientId: "northside_locks", configVersion: v,
      expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "edited by two"; }, updatedBy: "Editor Two",
    });
    assert.equal(stated.ok, false);
    assert.equal(stated.code, AUTHORITY_CODES.STALE);

    const after = await authority.getDraft("northside_locks", v);
    assert.equal(after.version.identity.description, "edited by one");
  });

  it("accepts an expectation of null against a genuinely unedited draft", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const result = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: draft.version.metadata.configVersion,
      expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "the first edit"; },
      updatedBy: "Editor One",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("accepts a save that carries the current stamp", async () => {
    const { authority, now } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    const first = await authority.updateDraft({
      clientId: "northside_locks", configVersion: v,
      mutate: (bp) => { bp.identity.description = "one"; }, updatedBy: "Editor One",
    });
    now.tick();
    const second = await authority.updateDraft({
      clientId: "northside_locks", configVersion: v,
      expectedUpdatedAt: first.version.metadata.updatedAt,
      mutate: (bp) => { bp.identity.description = "two"; }, updatedBy: "Editor One",
    });
    assert.equal(second.ok, true);
    assert.equal(second.version.identity.description, "two");
  });
});

describe("blueprint authority — activation is a separate decision", () => {
  it("refuses to activate anything that has not been approved", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;

    let result = await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.NOT_APPROVED);

    await authority.validateDraft("northside_locks", v);
    result = await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v });
    assert.equal(result.ok, false, "validated is still not approved");
    assert.equal(result.code, AUTHORITY_CODES.NOT_APPROVED);
  });

  it("approving does NOT activate — nothing is live until somebody says so", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);
    await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });

    const active = await authority.getActiveVersion("northside_locks");
    assert.equal(active.ok, false);
    assert.equal(active.code, AUTHORITY_CODES.NO_ACTIVE);
  });

  it("supersedes the incumbent so there is never a moment with two active versions", async () => {
    const { authority } = harness();
    const first = await activate(authority, "northside_locks", locksmithA());
    const second = await activate(authority, "northside_locks", locksmithA());

    const listed = await authority.listVersions("northside_locks");
    const actives = listed.versions.filter((v) => v.status === "active");
    assert.equal(actives.length, 1);
    assert.equal(actives[0].configVersion, second.metadata.configVersion);

    const superseded = listed.versions.find((v) => v.configVersion === first.metadata.configVersion);
    assert.equal(superseded.status, "superseded");
  });

  it("is idempotent — activating the already-active version changes nothing", async () => {
    const { authority } = harness();
    const active = await activate(authority, "northside_locks", locksmithA());
    const again = await authority.activateApprovedVersion({
      clientId: "northside_locks",
      configVersion: active.metadata.configVersion,
    });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyActive, true);
    const listed = await authority.listVersions("northside_locks");
    assert.equal(listed.versions.filter((v) => v.status === "active").length, 1);
  });

  it("reports no active version for a client that has never activated one", async () => {
    const { authority } = harness();
    const result = await authority.getActiveVersion("nobody_at_all");
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.NO_ACTIVE);
  });

  it("refuses to choose if the store somehow holds two active versions", async () => {
    const { authority, store } = harness();
    const first = await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "northside_locks", locksmithA());
    // Corrupt the store the way a bad migration or a partial write would.
    const resurrect = await store.getVersion("northside_locks", first.metadata.configVersion);
    resurrect.metadata.status = "active";
    await store.replaceVersion(resurrect);

    const result = await authority.getActiveVersion("northside_locks");
    assert.equal(result.ok, false, "two active versions must be refused, not silently resolved");
    assert.equal(result.code, AUTHORITY_CODES.NO_ACTIVE);
  });
});

describe("blueprint authority — restore creates a new version", () => {
  it("copies an old body into a NEW draft rather than resurrecting it", async () => {
    const { authority } = harness();
    const original = locksmithA();
    original.identity.description = "The original description.";
    const first = await activate(authority, "northside_locks", original);

    const changed = locksmithA();
    changed.identity.description = "A description somebody regrets.";
    await activate(authority, "northside_locks", changed);

    const restored = await authority.restoreFromVersion({
      clientId: "northside_locks",
      configVersion: first.metadata.configVersion,
      createdBy: "Peter Dang",
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.version.metadata.status, "draft", "a restore is a proposal, not a fact");
    assert.equal(restored.version.identity.description, "The original description.");
    assert.equal(restored.version.metadata.supersedes, first.metadata.configVersion);
    assert.ok(restored.version.metadata.configVersion > first.metadata.configVersion);
    assert.equal(restored.version.metadata.approvedAt, null);
    assert.equal(restored.version.metadata.approvedBy, null);
    assert.equal(restored.version.metadata.activatedAt, null);
  });

  it("leaves the restored-from version exactly as it was", async () => {
    const { authority } = harness();
    const first = await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "northside_locks", locksmithA());
    await authority.restoreFromVersion({ clientId: "northside_locks", configVersion: first.metadata.configVersion, createdBy: "Peter Dang" });
    const reread = await authority.getDraft("northside_locks", first.metadata.configVersion);
    assert.equal(reread.version.metadata.status, "superseded");
  });

  it("makes a restored draft go through validation and approval like anything else", async () => {
    const { authority } = harness();
    const first = await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "northside_locks", locksmithA());
    const restored = await authority.restoreFromVersion({ clientId: "northside_locks", configVersion: first.metadata.configVersion, createdBy: "Peter Dang" });
    const v = restored.version.metadata.configVersion;

    const early = await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v });
    assert.equal(early.ok, false);
    assert.equal(early.code, AUTHORITY_CODES.NOT_APPROVED);
  });
});

describe("blueprint authority — supersession", () => {
  it("marks a version superseded with a stated reason", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const result = await authority.supersedeVersion({
      clientId: "northside_locks",
      configVersion: draft.version.metadata.configVersion,
      reason: "Abandoned — the owner changed their mind.",
    });
    assert.equal(result.ok, true);
    assert.equal(result.version.metadata.status, "superseded");
    assert.equal(result.version.metadata.supersedeReason, "Abandoned — the owner changed their mind.");
  });

  it("lists a client's whole history in version order", async () => {
    const { authority } = harness();
    await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "northside_locks", locksmithA());
    await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });

    const listed = await authority.listVersions("northside_locks");
    assert.deepEqual(listed.versions.map((v) => v.configVersion), [1, 2, 3]);
    assert.deepEqual(listed.versions.map((v) => v.status), ["superseded", "active", "draft"]);
  });
});

describe("blueprint authority — one client cannot see or touch another", () => {
  it("refuses to create a draft under a clientId the body disagrees with", async () => {
    const { authority } = harness();
    const result = await authority.createDraft({
      clientId: "southbank_security",
      blueprint: locksmithA(), // says northside_locks
      createdBy: "Peter Dang",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.CROSS_TENANT);
  });

  it("does not return one client's version to another", async () => {
    const { authority } = harness();
    const a = await activate(authority, "northside_locks", locksmithA());
    const result = await authority.getDraft("southbank_security", a.metadata.configVersion);
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.NOT_FOUND);
  });

  it("refuses a draft edit that tries to move itself to another tenant", async () => {
    const { authority } = harness();
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const result = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion: draft.version.metadata.configVersion,
      mutate: (bp) => { bp.identity.clientId = "southbank_security"; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AUTHORITY_CODES.CROSS_TENANT);
  });

  it("keeps each client's active version to itself", async () => {
    const { authority } = harness();
    await activate(authority, "northside_locks", locksmithA());
    await activate(authority, "southbank_security", locksmithB());
    await activate(authority, "riverside_plumbing", plumberC());

    const a = await authority.getActiveVersion("northside_locks");
    const b = await authority.getActiveVersion("southbank_security");
    const c = await authority.getActiveVersion("riverside_plumbing");
    assert.equal(a.version.identity.tradingName, "Northside Lock & Key");
    assert.equal(b.version.identity.tradingName, "Southbank Security");
    assert.equal(c.version.identity.tradingName, "Riverside Plumbing");

    const listed = await authority.listVersions("northside_locks");
    assert.equal(listed.versions.length, 1, "listing one client must not include another's versions");
  });
});

describe("blueprint authority — activation grants no permission", () => {
  it("produces an active version that still describes outbound as disabled", async () => {
    const { authority } = harness();
    const active = await activate(authority, "northside_locks", locksmithA());
    assert.equal(active.outbound.enabled, false);
  });

  it("exposes no operation that could enable calling, dial, or provision anything", () => {
    const { authority } = harness();
    const surface = Object.keys(authority);
    const forbidden = /(dial|call|provision|retell|twilio|enable|suppress|dncr|authoris|authoriz)/i;
    for (const op of surface) {
      assert.ok(!forbidden.test(op), `the authority must not expose "${op}"`);
    }
  });
});
