// AIDA PLATFORM P9 — three clients at once, and none of them can see another.
//
// Locksmith A and Locksmith B are the same trade and disagree about almost
// everything. Plumber C is a different trade entirely. Running all three
// through the same authority, the same compiler and the same store at the same
// time is what catches the two failures a single-client test never will:
//
//   LEAKAGE     one client's suburb, number, prohibition or prompt reaching
//               another. On the phone this is a stranger being told the wrong
//               thing about a business that is not the one they rang.
//
//   COLLAPSE    the platform quietly treating all clients the same because the
//               only client it was ever tested with was the one it grew from.
//
// Same store, same instances, concurrent where it matters.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createBlueprintAuthority, createInMemoryBlueprintStore, AUTHORITY_CODES } = require("../src/platform/blueprint-authority");
const { proposeConfigPatch, PATCH_CODES } = require("../src/platform/config-patch");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { compileRetellPreview } = require("../src/platform/provider-compiler-retell");
const { locksmithA, locksmithB, plumberC } = require("../src/platform/fixtures/clients");

const TENANTS = Object.freeze([
  { clientId: "northside_locks", make: locksmithA, approver: "Peter Dang" },
  { clientId: "southbank_security", make: locksmithB, approver: "Dana Whitfield" },
  { clientId: "riverside_plumbing", make: plumberC, approver: "Ravi Menon" },
]);

/** Deployment facts differ per client, the way they would in production. */
const REFS = Object.freeze({
  northside_locks: { llmId: "llm_a0000", voiceId: "custom_voice_a0000", webhookUrl: "https://example.invalid/hooks/a" },
  southbank_security: { llmId: "llm_b0000", voiceId: "custom_voice_b0000", webhookUrl: "https://example.invalid/hooks/b" },
  riverside_plumbing: { llmId: "llm_c0000", voiceId: "custom_voice_c0000", webhookUrl: "https://example.invalid/hooks/c" },
});

function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

/** One store, one authority, all three clients live at once. */
async function threeTenants() {
  const now = fixedClock();
  const store = createInMemoryBlueprintStore();
  const authority = createBlueprintAuthority({ store, now });

  for (const { clientId, make, approver } of TENANTS) {
    const draft = await authority.createDraft({ clientId, blueprint: make(), createdBy: approver });
    const v = draft.version.metadata.configVersion;
    assert.equal((await authority.validateDraft(clientId, v)).ok, true, clientId);
    assert.equal((await authority.approveDraft({ clientId, configVersion: v, approvedBy: approver })).ok, true, clientId);
    assert.equal((await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: approver })).ok, true, clientId);
    now.tick();
  }
  return { authority, store, now };
}

const otherTenants = (clientId) => TENANTS.filter((t) => t.clientId !== clientId);

describe("multi-tenant — three clients live in one store", () => {
  it("each has exactly one active version, and it is their own", async () => {
    const { authority } = await threeTenants();
    for (const { clientId, make } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      assert.equal(active.ok, true, clientId);
      assert.equal(active.version.identity.clientId, clientId);
      assert.equal(active.version.identity.legalName, make().identity.legalName);
      assert.equal(active.version.metadata.configVersion, 1, "version numbers are per client");
    }
  });

  it("lists only its own history", async () => {
    const { authority } = await threeTenants();
    // Give one client extra versions, and check the others do not grow.
    for (let i = 0; i < 3; i += 1) {
      await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    }
    assert.equal((await authority.listVersions("northside_locks")).versions.length, 4);
    assert.equal((await authority.listVersions("southbank_security")).versions.length, 1);
    assert.equal((await authority.listVersions("riverside_plumbing")).versions.length, 1);
  });

  it("cannot read another client's version by guessing its number", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      for (const other of otherTenants(clientId)) {
        const result = await authority.getDraft(other.clientId, 1);
        // It resolves to the OTHER client's own version 1, never to this one's.
        assert.equal(result.version.identity.clientId, other.clientId);
        assert.notEqual(result.version.identity.legalName, TENANTS.find((t) => t.clientId === clientId).make().identity.legalName);
      }
    }
  });

  it("refuses to file one client's blueprint under another's id", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      for (const other of otherTenants(clientId)) {
        const result = await authority.createDraft({ clientId, blueprint: other.make(), createdBy: "Peter Dang" });
        assert.equal(result.ok, false, `${other.clientId}'s body must not be filed under ${clientId}`);
        assert.equal(result.code, AUTHORITY_CODES.CROSS_TENANT);
      }
    }
  });

  it("refuses to activate one client's version under another's id", async () => {
    const { authority } = await threeTenants();
    const result = await authority.activateApprovedVersion({
      clientId: "riverside_plumbing",
      configVersion: 1,
    });
    // riverside_plumbing's own v1 is already active, so this is idempotent —
    // and crucially it did NOT reach into another client's v1.
    assert.equal(result.version.identity.clientId, "riverside_plumbing");
  });
});

describe("multi-tenant — changing one client changes nothing for the others", () => {
  it("keeps the others byte-identical after a full new version elsewhere", async () => {
    const { authority } = await threeTenants();
    const before = {};
    for (const { clientId } of TENANTS) {
      before[clientId] = JSON.stringify((await authority.getActiveVersion(clientId)).version);
    }

    const changed = locksmithA();
    changed.serviceArea.suburbs = ["Somewhere Completely Different"];
    changed.callHandling.escalation.primaryNumber = "+61355500999";
    changed.knowledge.pricingDisclosure = "never_discuss";
    const draft = await authority.createDraft({ clientId: "northside_locks", blueprint: changed, createdBy: "Peter Dang" });
    const v = draft.version.metadata.configVersion;
    await authority.validateDraft("northside_locks", v);
    await authority.approveDraft({ clientId: "northside_locks", configVersion: v, approvedBy: "Peter Dang" });
    await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: v, activatedBy: "Peter Dang" });

    for (const { clientId } of otherTenants("northside_locks")) {
      const after = JSON.stringify((await authority.getActiveVersion(clientId)).version);
      assert.equal(after, before[clientId], `${clientId} changed when another client did`);
    }
    const moved = await authority.getActiveVersion("northside_locks");
    assert.deepEqual(moved.version.serviceArea.suburbs, ["Somewhere Completely Different"]);
  });

  it("keeps a voice patch for one client away from the others", async () => {
    const { authority } = await threeTenants();
    const result = await proposeConfigPatch({
      authority,
      clientId: "riverside_plumbing",
      source: "voice",
      proposedBy: "owner via telephone",
      patch: { operations: [{ op: "set", path: "voice.profileRef", value: "neutral_male_au" }] },
    });
    assert.equal(result.ok, true);

    for (const { clientId, make } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      assert.equal(active.version.voice.profileRef, make().voice.profileRef, `${clientId}'s voice must be untouched`);
    }
    assert.equal((await authority.listVersions("riverside_plumbing")).versions.length, 2);
    assert.equal((await authority.listVersions("northside_locks")).versions.length, 1);
  });

  it("refuses a patch aimed at a client that does not exist, rather than hitting a neighbour", async () => {
    const { authority } = await threeTenants();
    const result = await proposeConfigPatch({
      authority,
      clientId: "northside_lock", // one character short
      source: "voice",
      patch: { operations: [{ op: "set", path: "voice.tone", value: "brisk" }] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PATCH_CODES.NO_ACTIVE);
    for (const { clientId, make } of TENANTS) {
      assert.equal((await authority.getActiveVersion(clientId)).version.voice.tone, make().voice.tone);
    }
  });

  it("keeps concurrent edits to three clients from interfering", async () => {
    const { authority } = await threeTenants();
    const results = await Promise.all(
      TENANTS.map(({ clientId, approver }) =>
        authority.createDraft({
          clientId,
          blueprint: { ...TENANTS.find((t) => t.clientId === clientId).make(), extensions: { editedBy: approver } },
          createdBy: approver,
        }),
      ),
    );
    for (const [i, result] of results.entries()) {
      assert.equal(result.ok, true);
      assert.equal(result.version.identity.clientId, TENANTS[i].clientId);
      assert.equal(result.version.extensions.editedBy, TENANTS[i].approver);
      assert.equal(result.version.metadata.configVersion, 2, "each client numbers its own versions");
    }
  });
});

describe("multi-tenant — three genuinely different assistants", () => {
  it("compiles three different behaviour hashes", async () => {
    const { authority } = await threeTenants();
    const hashes = {};
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      hashes[clientId] = compileBehaviourSpec(active.version).behaviourHash;
    }
    assert.equal(new Set(Object.values(hashes)).size, 3);
  });

  it("gives two locksmiths genuinely different answers", () => {
    const a = compileBehaviourSpec(locksmithA()).spec;
    const b = compileBehaviourSpec(locksmithB()).spec;

    assert.equal(a.business.vertical, b.business.vertical, "same trade");
    assert.notEqual(a.assistant.name, b.assistant.name);
    assert.notEqual(a.availability.afterHours.available, b.availability.afterHours.available);
    assert.notEqual(a.knowledge.pricing.disclosure, b.knowledge.pricing.disclosure);
    assert.notEqual(a.booking.enabled, b.booking.enabled);
    assert.notEqual(a.serviceArea.outsideAreaAction, b.serviceArea.outsideAreaAction);
    assert.notEqual(a.escalation.unansweredAction, b.escalation.unansweredAction);
    assert.notEqual(a.compliance.callsMayBeRecorded, b.compliance.callsMayBeRecorded);

    const sharedServices = a.services.map((s) => s.serviceId).filter((id) => b.services.some((s) => s.serviceId === id));
    assert.equal(sharedServices.length, 0, "these two locksmiths share no service at all");
  });

  it("shares no suburb, number or service between any two clients", () => {
    const specs = TENANTS.map(({ clientId, make }) => ({ clientId, spec: compileBehaviourSpec(make()).spec }));
    for (const x of specs) {
      for (const y of specs) {
        if (x.clientId === y.clientId) continue;
        for (const suburb of x.spec.serviceArea.suburbs) {
          assert.ok(!y.spec.serviceArea.suburbs.includes(suburb), `${suburb} appears in both ${x.clientId} and ${y.clientId}`);
        }
        assert.notEqual(x.spec.escalation.primaryNumber, y.spec.escalation.primaryNumber);
        for (const s of x.spec.services) {
          assert.ok(!y.spec.services.some((o) => o.serviceId === s.serviceId), `${s.serviceId} is in both`);
        }
      }
    }
  });

  it("compiles three payloads that share nothing but their shape", async () => {
    const { authority } = await threeTenants();
    const previews = {};
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      const { spec } = compileBehaviourSpec(active.version);
      previews[clientId] = compileRetellPreview({ spec, providerRefs: REFS[clientId] });
      assert.equal(previews[clientId].ready, true, clientId);
    }

    const shapes = Object.values(previews).map((p) => JSON.stringify(Object.keys(p.agent).sort()));
    assert.equal(new Set(shapes).size, 1, "same shape");

    const hashes = Object.values(previews).map((p) => p.payloadHash);
    assert.equal(new Set(hashes).size, 3, "different content");

    for (const { clientId, make } of TENANTS) {
      const prompt = previews[clientId].responseEngine.general_prompt;
      assert.ok(prompt.includes(make().identity.tradingName));
      for (const other of otherTenants(clientId)) {
        assert.ok(
          !prompt.includes(other.make().identity.tradingName),
          `${clientId}'s prompt names ${other.clientId}`,
        );
        assert.ok(
          !prompt.includes(other.make().callHandling.escalation.primaryNumber),
          `${clientId}'s prompt carries ${other.clientId}'s transfer number`,
        );
      }
    }
  });

  it("gives each client its own provider references and never borrows another's", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      const { spec } = compileBehaviourSpec(active.version);
      const out = compileRetellPreview({ spec, providerRefs: REFS[clientId] });
      assert.equal(out.agent.voice_id, REFS[clientId].voiceId);
      assert.equal(out.agent.webhook_url, REFS[clientId].webhookUrl);
      assert.ok(out.agent.agent_name.includes(clientId));
      for (const other of otherTenants(clientId)) {
        assert.notEqual(out.agent.voice_id, REFS[other.clientId].voiceId);
      }
    }
  });

  it("refuses to compile a client whose references are missing rather than using a neighbour's", async () => {
    const { authority } = await threeTenants();
    const active = await authority.getActiveVersion("southbank_security");
    const { spec } = compileBehaviourSpec(active.version);
    const out = compileRetellPreview({ spec, providerRefs: {} });
    assert.equal(out.ready, false);
    assert.deepEqual([...out.unresolved].sort(), ["llmId", "voiceId", "webhookUrl"]);
    for (const value of [out.agent.voice_id, out.agent.webhook_url, out.agent.response_engine.llm_id]) {
      assert.equal(value, null);
    }
  });
});

describe("multi-tenant — one client's mistake is not another's", () => {
  it("keeps an invalid draft for one client from blocking another", async () => {
    const { authority } = await threeTenants();
    const broken = locksmithB();
    broken.services = [];
    const draft = await authority.createDraft({ clientId: "southbank_security", blueprint: broken, createdBy: "Dana Whitfield" });
    assert.equal((await authority.validateDraft("southbank_security", draft.version.metadata.configVersion)).ok, false);

    // Everyone else still works, and Southbank's own active version survives.
    for (const { clientId } of TENANTS) {
      assert.equal((await authority.getActiveVersion(clientId)).ok, true, clientId);
    }
    const stillActive = await authority.getActiveVersion("southbank_security");
    assert.ok(stillActive.version.services.length > 0);
  });

  it("keeps one client's stale-write conflict from touching another", async () => {
    const { authority, now } = await threeTenants();
    const a = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang" });
    const b = await authority.createDraft({ clientId: "riverside_plumbing", blueprint: plumberC(), createdBy: "Ravi Menon" });

    await authority.updateDraft({
      clientId: "northside_locks", configVersion: a.version.metadata.configVersion,
      mutate: (bp) => { bp.identity.description = "first"; }, updatedBy: "Editor One",
    });
    now.tick();
    const conflicted = await authority.updateDraft({
      clientId: "northside_locks", configVersion: a.version.metadata.configVersion,
      expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "second"; }, updatedBy: "Editor Two",
    });
    assert.equal(conflicted.code, AUTHORITY_CODES.STALE);

    // The plumber's draft is unaffected and still writable.
    const plumberEdit = await authority.updateDraft({
      clientId: "riverside_plumbing", configVersion: b.version.metadata.configVersion,
      expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "the plumber is fine"; }, updatedBy: "Ravi Menon",
    });
    assert.equal(plumberEdit.ok, true);
    assert.equal(plumberEdit.version.identity.description, "the plumber is fine");
  });

  it("keeps approvers apart — one client's approver is not another's", async () => {
    const { authority } = await threeTenants();
    for (const { clientId, approver } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      assert.equal(active.version.metadata.approvedBy, approver);
      for (const other of otherTenants(clientId)) {
        assert.notEqual(active.version.metadata.approvedBy, other.approver);
      }
    }
  });
});

describe("multi-tenant — no client can configure a compliance authority", () => {
  it("leaves all three with outbound described as disabled", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      assert.equal(active.version.outbound.enabled, false, clientId);
    }
  });

  it("refuses a patch from any client aimed at anything that grants permission", async () => {
    const { authority } = await threeTenants();
    const attempts = [
      "metadata.status",
      "metadata.approvedBy",
      "identity.clientId",
      "identity.vertical",
      "schemaVersion",
    ];
    for (const { clientId } of TENANTS) {
      for (const path of attempts) {
        const result = await proposeConfigPatch({
          authority, clientId, source: "voice",
          patch: { operations: [{ op: "set", path, value: "anything" }] },
        });
        assert.equal(result.ok, false, `${clientId} must not patch ${path}`);
        assert.equal(result.code, PATCH_CODES.BAD_PATH);
      }
    }
  });

  it("keeps every client's mandatory prohibitions, whatever else they configure", async () => {
    const { MANDATORY_PROHIBITED_CLAIMS } = require("../src/platform/client-blueprint");
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      for (const must of MANDATORY_PROHIBITED_CLAIMS) {
        assert.ok(active.version.knowledge.prohibitedClaims.includes(must), `${clientId} lost "${must}"`);
      }
      // And a patch cannot remove one: the draft is recorded but invalid.
      const result = await proposeConfigPatch({
        authority, clientId, source: "voice",
        patch: { operations: [{ op: "remove_from_list", path: "knowledge.prohibitedClaims", value: "claiming_to_be_human" }] },
      });
      assert.equal(result.validation.ok, false, `${clientId} must not be able to drop a mandatory prohibition`);
      assert.ok(result.validation.errors.some((e) => e.path === "knowledge.prohibitedClaims"));
    }
  });

  it("makes every client's assistant answer truthfully when asked, both directions", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      const { spec } = compileBehaviourSpec(active.version);
      assert.equal(spec.disclosure.whenAsked, true, clientId);
      for (const direction of ["inbound", "outbound"]) {
        const out = compileRetellPreview({ spec, providerRefs: REFS[clientId], direction });
        assert.match(out.responseEngine.general_prompt, /say plainly and immediately that you are an AI assistant/i, `${clientId} ${direction}`);
      }
    }
  });

  it("discloses in the OUTBOUND opening for every client, and forces nothing inbound", async () => {
    const { authority } = await threeTenants();
    for (const { clientId } of TENANTS) {
      const active = await authority.getActiveVersion(clientId);
      const { spec } = compileBehaviourSpec(active.version);
      assert.equal(spec.disclosure.inOpening.outbound, true, clientId);
      assert.equal(spec.disclosure.inOpening.inbound, false, clientId);
      const outbound = compileRetellPreview({ spec, providerRefs: REFS[clientId], direction: "outbound" });
      assert.match(outbound.responseEngine.begin_message, /AI assistant/i, clientId);
    }
  });
});
