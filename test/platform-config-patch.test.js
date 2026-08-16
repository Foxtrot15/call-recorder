// AIDA PLATFORM P4 — the contract a voice configuration agent will use.
//
// Eventually a business owner telephones AIDA and says "we don't do Saturday
// mornings any more". These tests describe what must happen to that sentence,
// and — more importantly — what must NOT.
//
// The failure being designed against is specific. A speech-to-intent pipeline
// mishears things. "Don't service Brunswick" and "don't service Brunswick East"
// differ by one word and by a suburb's worth of revenue, and the person who
// finds out is a customer being told no. So every path here ends at a DRAFT.
//
// There is no speech recognition in these tests and none in the module. This is
// the domain contract, built first so the eventual voice work has something
// safe to aim at.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  proposeConfigPatch,
  applyPatchToBlueprint,
  pathAllowed,
  PATCH_CODES,
  PATCH_SOURCES,
  PATCH_OPERATIONS,
  FORBIDDEN_PATHS,
} = require("../src/platform/config-patch");

const { createBlueprintAuthority, createInMemoryBlueprintStore } = require("../src/platform/blueprint-authority");
const { locksmithA, plumberC } = require("../src/platform/fixtures/clients");

function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

/** A client with one active version, ready to be asked to change. */
async function liveClient(clientId = "northside_locks", make = locksmithA) {
  const now = fixedClock();
  const store = createInMemoryBlueprintStore();
  const authority = createBlueprintAuthority({ store, now });
  const draft = await authority.createDraft({ clientId, blueprint: make(), createdBy: "Peter Dang" });
  const v = draft.version.metadata.configVersion;
  await authority.validateDraft(clientId, v);
  await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Peter Dang" });
  await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: "Peter Dang" });
  return { authority, store, now, clientId, activeVersion: v };
}

const patch = (operations, extra = {}) => ({ operations, ...extra });

describe("config patch — a voice change becomes a draft, never an activation", () => {
  it("turns a heard request into a new DRAFT version", async () => {
    const { authority, clientId, activeVersion } = await liveClient();
    const result = await proposeConfigPatch({
      authority,
      clientId,
      source: "voice",
      proposedBy: "owner via telephone",
      patch: patch([{ op: "set", path: "hours.weekly.saturday", value: { closed: true } }], {
        explanation: "We don't do Saturday mornings any more.",
        transcriptRef: "call_abc123",
      }),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "draft");
    assert.equal(result.requiresHumanApproval, true);
    assert.ok(result.version.metadata.configVersion > activeVersion);
    assert.equal(result.version.metadata.approvedAt, null);
    assert.equal(result.version.metadata.activatedAt, null);
  });

  it("leaves the active version completely untouched", async () => {
    const { authority, clientId } = await liveClient();
    const before = await authority.getActiveVersion(clientId);
    const beforeSaturday = JSON.stringify(before.version.hours.weekly.saturday);

    await proposeConfigPatch({
      authority, clientId, source: "voice", proposedBy: "owner via telephone",
      patch: patch([{ op: "set", path: "hours.weekly.saturday", value: { closed: true } }]),
    });

    const after = await authority.getActiveVersion(clientId);
    assert.equal(after.version.metadata.configVersion, before.version.metadata.configVersion);
    assert.equal(JSON.stringify(after.version.hours.weekly.saturday), beforeSaturday);
  });

  it("returns a diff a business owner could be read aloud", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice", proposedBy: "owner via telephone",
      patch: patch([{ op: "remove_from_list", path: "serviceArea.suburbs", value: "Brunswick" }]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.diff.hasChanges, true);
    const summaries = result.diff.changes.map((c) => c.summary).join(" | ");
    assert.match(summaries, /Brunswick/);
    assert.match(summaries, /removed/);
  });

  it("retains where the proposal came from and what was said", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice", proposedBy: "owner via telephone",
      patch: patch([{ op: "set", path: "knowledge.pricingDisclosure", value: "never_discuss" }], {
        explanation: "Stop mentioning prices unless they ask.",
        transcriptRef: "call_def456",
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.provenance.source, "voice");
    assert.equal(result.provenance.proposedBy, "owner via telephone");
    assert.equal(result.provenance.explanation, "Stop mentioning prices unless they ask.");
    assert.equal(result.provenance.transcriptRef, "call_def456");
    assert.equal(result.provenance.basedOnVersion, 1);
    assert.equal(result.version.metadata.source, "voice");
    assert.equal(result.version.metadata.supersedes, 1);
  });

  it("records the source without ever using it to grant trust", async () => {
    // Every source lands in the same place: a draft awaiting a person.
    const { authority, clientId } = await liveClient();
    for (const source of PATCH_SOURCES) {
      const result = await proposeConfigPatch({
        authority, clientId, source, proposedBy: `${source} caller`,
        patch: patch([{ op: "set", path: "identity.description", value: `changed via ${source}` }]),
      });
      assert.equal(result.ok, true, `${source}: ${JSON.stringify(result)}`);
      assert.equal(result.status, "draft", `${source} must not shortcut to anything live`);
      assert.equal(result.requiresHumanApproval, true);
    }
  });

  it("rejects a source nobody defined", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "carrier_pigeon",
      patch: patch([{ op: "set", path: "identity.description", value: "x" }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.BAD_SOURCE);
  });

  it("refuses to patch a client with no active configuration", async () => {
    const now = fixedClock();
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    const result = await proposeConfigPatch({
      authority, clientId: "nobody_at_all",
      patch: patch([{ op: "set", path: "identity.description", value: "x" }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.NO_ACTIVE);
  });
});

describe("config patch — there is no path to direct activation", () => {
  it("returns nothing that is approved or active", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "hours.weekly.sunday", value: { open: "10:00", close: "14:00" } }]),
    });
    assert.equal(result.ok, true);
    assert.notEqual(result.status, "approved");
    assert.notEqual(result.status, "active");
    assert.notEqual(result.status, "validated");
  });

  it("cannot set status through the patch itself", async () => {
    const { authority, clientId } = await liveClient();
    for (const path of ["metadata.status", "metadata.approvedBy", "metadata.approvedAt", "metadata.activatedAt", "metadata"]) {
      const result = await proposeConfigPatch({
        authority, clientId, source: "voice",
        patch: patch([{ op: "set", path, value: "active" }]),
      });
      assert.equal(result.ok, false, `"${path}" must not be patchable`);
      assert.equal(result.code, PATCH_CODES.BAD_PATH);
    }
  });

  it("cannot move a client to another tenant or another trade", async () => {
    const { authority, clientId } = await liveClient();
    for (const [path, value] of [["identity.clientId", "southbank_security"], ["identity.vertical", "plumbing"]]) {
      const result = await proposeConfigPatch({
        authority, clientId, source: "voice",
        patch: patch([{ op: "set", path, value }]),
      });
      assert.equal(result.ok, false, `"${path}" must not be patchable`);
      assert.equal(result.code, PATCH_CODES.BAD_PATH);
    }
  });

  it("cannot rewrite the schema version out from under validation", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "schemaVersion", value: "anything-at-all" }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.BAD_PATH);
  });

  it("keeps every forbidden path unreachable by prefix as well as exactly", () => {
    for (const forbidden of FORBIDDEN_PATHS) {
      assert.equal(pathAllowed(forbidden), false, `"${forbidden}" must be refused`);
      assert.equal(pathAllowed(`${forbidden}.something`), false, `"${forbidden}.something" must be refused`);
    }
  });

  it("allows only paths on the allowlist", () => {
    for (const allowed of [
      "hours.weekly.saturday",
      "services",
      "serviceArea.suburbs",
      "callHandling.urgencyRules",
      "knowledge.pricingWording",
      "voice.tone",
      "identity.tradingName",
      "integrations",
      "extensions.anything",
    ]) {
      assert.equal(pathAllowed(allowed), true, `"${allowed}" should be patchable`);
    }
    for (const denied of ["", "   ", null, undefined, 42, "somethingElse", "identity", "identity.clientId"]) {
      assert.equal(pathAllowed(denied), false, `${JSON.stringify(denied)} should not be patchable`);
    }
  });
});

describe("config patch — a mishearing is a conflict, not an overwrite", () => {
  it("refuses when the world moved between hearing and applying", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{
        op: "set",
        path: "knowledge.pricingDisclosure",
        value: "never_discuss",
        expectedCurrent: "indicative_ranges", // the locksmith is callout_fee_only
      }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.CONFLICT);
    assert.equal(result.expected, "indicative_ranges");
    assert.equal(result.actual, "callout_fee_only");
  });

  it("proceeds when the stated expectation matches", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{
        op: "set",
        path: "knowledge.pricingDisclosure",
        value: "never_discuss",
        expectedCurrent: "callout_fee_only",
      }]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.version.knowledge.pricingDisclosure, "never_discuss");
  });

  it("treats an expectation of a deep value structurally, not by reference", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{
        op: "set",
        path: "hours.weekly.saturday",
        value: { closed: true },
        expectedCurrent: { open: "09:00", close: "13:00" },
      }]),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("refuses a patch that would change nothing, rather than creating a pointless version", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "knowledge.pricingDisclosure", value: "callout_fee_only" }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.NOT_APPLIED);
  });
});

describe("config patch — a rejected invalid patch", () => {
  it("still produces a draft when the result is invalid, but says so loudly", async () => {
    // A mishearing that produces an INVALID blueprint should be visible as a
    // failed validation on a draft — not silently discarded, and certainly not
    // applied. The person reviewing needs to see what was heard.
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "services", value: [] }]),
    });
    assert.equal(result.ok, true, "the proposal is recorded");
    assert.equal(result.status, "draft");
    assert.equal(result.validation.ok, false, "and it is plainly marked invalid");
    assert.ok(result.validation.errors.some((e) => e.path === "services"));
  });

  it("cannot be approved while it is invalid", async () => {
    const { authority, clientId } = await liveClient();
    const proposal = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "services", value: [] }]),
    });
    const v = proposal.version.metadata.configVersion;
    const validated = await authority.validateDraft(clientId, v);
    assert.equal(validated.ok, false);
    const approved = await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Peter Dang" });
    assert.equal(approved.ok, false);
  });

  it("rejects an operation nobody defined", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "delete_everything", path: "services" }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.BAD_OPERATION);
    assert.ok(!PATCH_OPERATIONS.includes("delete_everything"));
  });

  it("rejects a patch with no operations at all", async () => {
    const { authority, clientId } = await liveClient();
    for (const empty of [patch([]), {}, { operations: "everything" }, null]) {
      const result = await proposeConfigPatch({ authority, clientId, source: "voice", patch: empty });
      assert.equal(result.ok, false);
      assert.equal(result.code, PATCH_CODES.NO_OPERATIONS);
    }
  });

  it("rejects a list operation aimed at something that is not a list", async () => {
    const { authority, clientId } = await liveClient();
    for (const op of ["add_to_list", "remove_from_list"]) {
      const result = await proposeConfigPatch({
        authority, clientId, source: "voice",
        patch: patch([{ op, path: "knowledge.pricingWording", value: "x" }]),
      });
      assert.equal(result.ok, false, `${op} on a string should fail`);
      assert.equal(result.code, PATCH_CODES.BAD_PATH);
    }
  });

  it("applies nothing at all when one operation in a batch is refused", async () => {
    const { authority, clientId } = await liveClient();
    const before = await authority.getActiveVersion(clientId);
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([
        { op: "set", path: "identity.tradingName", value: "A Perfectly Fine Change" },
        { op: "set", path: "metadata.status", value: "active" },
      ]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.BAD_PATH);
    const versions = await authority.listVersions(clientId);
    assert.equal(versions.versions.length, 1, "a refused batch must not leave a half-applied draft behind");
    const after = await authority.getActiveVersion(clientId);
    assert.equal(after.version.identity.tradingName, before.version.identity.tradingName);
  });
});

describe("config patch — applyPatchToBlueprint never mutates its input", () => {
  it("leaves the original object alone", () => {
    const original = locksmithA();
    const snapshot = JSON.stringify(original);
    const result = applyPatchToBlueprint(original, patch([
      { op: "set", path: "identity.tradingName", value: "Changed" },
      { op: "add_to_list", path: "serviceArea.suburbs", value: "Reservoir" },
    ]));
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(original), snapshot);
    assert.equal(result.blueprint.identity.tradingName, "Changed");
    assert.ok(result.blueprint.serviceArea.suburbs.includes("Reservoir"));
  });

  it("works on a frozen active version without needing to thaw it", async () => {
    const { authority, clientId } = await liveClient();
    const active = await authority.getActiveVersion(clientId);
    assert.ok(Object.isFrozen(active.version));
    const result = applyPatchToBlueprint(active.version, patch([{ op: "set", path: "voice.tone", value: "brisk" }]));
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.voice.tone, "brisk");
    assert.notEqual(active.version.voice.tone, "brisk");
  });

  it("adds to a list without duplicating what is already there", () => {
    const bp = locksmithA();
    const result = applyPatchToBlueprint(bp, patch([
      { op: "add_to_list", path: "serviceArea.suburbs", value: "Brunswick" },
      { op: "add_to_list", path: "serviceArea.suburbs", value: "Reservoir" },
    ]));
    assert.equal(result.blueprint.serviceArea.suburbs.filter((s) => s === "Brunswick").length, 1);
    assert.equal(result.blueprint.serviceArea.suburbs.filter((s) => s === "Reservoir").length, 1);
  });

  it("removes a whole object from a list by structural match", () => {
    const bp = plumberC();
    const target = bp.services.find((s) => s.serviceId === "leaking_tap");
    const result = applyPatchToBlueprint(bp, patch([{ op: "remove_from_list", path: "services", value: target }]));
    assert.equal(result.ok, true);
    assert.ok(!result.blueprint.services.some((s) => s.serviceId === "leaking_tap"));
    assert.ok(bp.services.some((s) => s.serviceId === "leaking_tap"), "the input keeps its service");
  });

  it("is a no-op when removing something that is not there", () => {
    const bp = locksmithA();
    const before = bp.serviceArea.suburbs.length;
    const result = applyPatchToBlueprint(bp, patch([{ op: "remove_from_list", path: "serviceArea.suburbs", value: "Atlantis" }]));
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.serviceArea.suburbs.length, before);
  });

  it("requires a blueprint", () => {
    assert.equal(applyPatchToBlueprint(null, patch([{ op: "set", path: "voice.tone", value: "x" }])).ok, false);
  });
});

describe("config patch — voice configuration cannot bypass approval", () => {
  it("has no exported function that approves or activates", () => {
    const surface = Object.keys(require("../src/platform/config-patch"));
    for (const name of surface) {
      assert.ok(!/^(approve|activate|publish|golive|deploy)/i.test(name), `config-patch must not export "${name}"`);
    }
  });

  it("still requires the full human path after a voice proposal", async () => {
    const { authority, clientId } = await liveClient();
    const proposal = await proposeConfigPatch({
      authority, clientId, source: "voice", proposedBy: "owner via telephone",
      patch: patch([{ op: "set", path: "hours.weekly.saturday", value: { closed: true } }]),
    });
    const v = proposal.version.metadata.configVersion;

    // Straight to activation: refused.
    const shortcut = await authority.activateApprovedVersion({ clientId, configVersion: v });
    assert.equal(shortcut.ok, false);

    // Approval before validation: refused.
    const early = await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Peter Dang" });
    assert.equal(early.ok, false);

    // Approval by the machine that proposed it: refused.
    await authority.validateDraft(clientId, v);
    const selfApproved = await authority.approveDraft({ clientId, configVersion: v, approvedBy: "aida" });
    assert.equal(selfApproved.ok, false);

    // Only a named person, and only then, gets it live.
    const approved = await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Peter Dang" });
    assert.equal(approved.ok, true);
    const active = await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: "Peter Dang" });
    assert.equal(active.ok, true);
    assert.deepEqual(active.version.hours.weekly.saturday, { closed: true });
  });

  it("still requires approval for a change to the voice itself", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice", proposedBy: "owner via telephone",
      patch: patch([{ op: "set", path: "voice.profileRef", value: "neutral_male_au" }]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "draft");
    assert.equal(result.requiresHumanApproval, true);

    const stillActive = await authority.getActiveVersion(clientId);
    assert.equal(stillActive.version.voice.profileRef, "warm_female_au");
  });

  it("refuses a voice change that names a provider voice id", async () => {
    const { authority, clientId } = await liveClient();
    const result = await proposeConfigPatch({
      authority, clientId, source: "voice",
      patch: patch([{ op: "set", path: "voice.profileRef", value: "custom_voice_018b4225b718ffc38a2e1da4d4" }]),
    });
    // Recorded as a draft so a person can see what was heard, and plainly invalid.
    assert.equal(result.ok, true);
    assert.equal(result.validation.ok, false);
    assert.ok(result.validation.errors.some((e) => e.path === "voice.profileRef"));
  });
});
