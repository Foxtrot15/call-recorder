// AIDA PLATFORM P17/P18 — the configuration service, its HTTP surface, the
// voice path, cross-tenant attacks and one end-to-end client flow.
//
// The invariant that matters most, asserted from several directions:
//
//   ACTIVATION IS NOT DEPLOYMENT.
//
// Making a version active means "this is the configuration AIDA considers
// current for this client". It updates no Retell agent, provisions nothing,
// changes no phone routing and enables no call. Nothing in the subsystem can
// even reach the code that would.
//
// No network anywhere in this file.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createConfigService, SERVICE_CODES } = require("../src/platform/config-service");
const { createPrincipal, voicePrincipal } = require("../src/platform/config-access");
const { createInMemoryConfigAudit, createStoreConfigAudit } = require("../src/platform/config-audit");
const { createInMemoryBlueprintStore } = require("../src/platform/blueprint-authority");
const { createPostgresBlueprintStore } = require("../src/platform/blueprint-store-postgres");
const { createPlatformConfigHandlers } = require("../src/routes/platform-config-handlers");
const { createFakePostgres } = require("./helpers/fake-postgres");
const { plumberC, garageDoorD, locksmithA } = require("../src/platform/fixtures/clients");

const ROOT = path.join(__dirname, "..");
const REFS = Object.freeze({ llmId: "llm_x", voiceId: "custom_voice_x", webhookUrl: "https://example.invalid/h" });

function clock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

/** A service over the durable adapter — the shape production would use. */
function harness({ durable = true } = {}) {
  const now = clock();
  const db = createFakePostgres();
  const store = durable ? createPostgresBlueprintStore({ db, now }) : createInMemoryBlueprintStore();
  const audit = durable ? createStoreConfigAudit({ store }) : createInMemoryConfigAudit({ now });
  const service = createConfigService({ store, now, audit, providerRefs: REFS });
  return { service, store, audit, now, db };
}

const PRINCIPALS = {
  operator: (clientId) => createPrincipal({ role: "operator", actorId: "Peter Dang", clientId, crossTenant: true }),
  owner: (clientId, who = "owner@x.invalid") => createPrincipal({ role: "client_owner", actorId: who, clientId }),
  editor: (clientId, who = "editor@x.invalid") => createPrincipal({ role: "client_editor", actorId: who, clientId }),
  viewer: (clientId) => createPrincipal({ role: "client_viewer", actorId: "viewer@x.invalid", clientId }),
  voice: (clientId) => voicePrincipal({ clientId }),
};

/** Take a client all the way to active through the SERVICE, not the authority. */
async function activateThroughService(service, clientId, blueprint) {
  const editor = PRINCIPALS.editor(clientId);
  const owner = PRINCIPALS.owner(clientId);
  const operator = PRINCIPALS.operator(clientId);

  const draft = await service.createDraft({ principal: editor, clientId, blueprint });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const v = draft.configVersion;
  assert.equal((await service.validate({ principal: editor, clientId, configVersion: v })).ok, true);
  assert.equal((await service.approve({ principal: owner, clientId, configVersion: v })).ok, true);
  const activated = await service.activate({ principal: operator, clientId, configVersion: v });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  return { configVersion: v, activated };
}

// ════════════════════════════════════════════════════════════════════
// P17A — ACTIVATION IS NOT DEPLOYMENT
// ════════════════════════════════════════════════════════════════════

describe("P17A — activation is not deployment", () => {
  it("says so in the response, in words a UI cannot present as a deploy", async () => {
    const { service } = harness();
    const { activated } = await activateThroughService(service, "riverside_plumbing", plumberC());
    assert.equal(activated.providerUpdated, false);
    assert.match(activated.meaning, /configuration AIDA considers current/i);
    assert.match(activated.note, /No provider resource was created or updated/i);
  });

  it("says approval is not live either", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: plumberC() });
    await service.validate({ principal: PRINCIPALS.editor(clientId), clientId, configVersion: draft.configVersion });
    const approved = await service.approve({ principal: PRINCIPALS.owner(clientId), clientId, configVersion: draft.configVersion });
    assert.equal(approved.isLive, false);
    assert.match(approved.note, /NOT the active configuration/i);
  });

  it("the whole subsystem imports no transport, provisioner or calling authority", () => {
    const FILES = [
      "src/platform/config-service.js",
      "src/platform/config-access.js",
      "src/platform/config-audit.js",
      "src/routes/platform-config-handlers.js",
      "src/routes/platform-config.js",
    ];
    const FORBIDDEN = [
      "retell-adapter", "voice-platform-port", "provider-resource-registry",
      "acquisition-dial-execution", "acquisition-dial-provider", "acquisition-calling-state",
      "acquisition-calling-approval", "acquisition-authorisation", "acquisition-dncr",
      "acquisition-suppression", "acquisition-dispatch-store", "acquisition-agent-provisioning",
      "acquisition-resource-authority", "twilio", "@supabase/supabase-js", "node-fetch", "axios",
    ];
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      for (const bad of FORBIDDEN) {
        assert.ok(!imports.some((i) => i.includes(bad)), `${file} imports ${bad}`);
      }
    }
  });

  it("would CATCH a forbidden import if one were added", () => {
    // Non-vacuity: the matcher must bite on a realistic bad fixture.
    const badFixture = `const { executeDial } = require("../services/acquisition-dial-execution");`;
    const imports = [...badFixture.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.ok(imports.some((i) => i.includes("acquisition-dial-execution")), "the ratchet would not catch it");
  });

  it("exposes no operation that could provision, dial or enable anything", () => {
    const { service } = harness();
    const ACTING = /^(provision|deploy|publish|dial|call|enable|disable|send|suppress|wash)([A-Z]|$)/;
    for (const name of Object.keys(service)) {
      assert.ok(!ACTING.test(name), `the service must not expose "${name}"`);
    }
    for (const bad of ["provisionAgent", "enableCalling", "dialProspect", "publish"]) {
      assert.ok(ACTING.test(bad), `the check would not catch "${bad}"`);
    }
  });

  it("leaves the active version readable and unchanged by a preview", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    await activateThroughService(service, clientId, plumberC());
    const before = await service.getActive({ principal: PRINCIPALS.owner(clientId), clientId });
    await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });
    const after = await service.getActive({ principal: PRINCIPALS.owner(clientId), clientId });
    assert.equal(JSON.stringify(after.version), JSON.stringify(before.version));
  });
});

// ════════════════════════════════════════════════════════════════════
// P17B — PROVIDER PREVIEW
// ════════════════════════════════════════════════════════════════════

describe("P17B — provider preview is pure", () => {
  it("returns the version, every hash, and the words", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    const { configVersion } = await activateThroughService(service, clientId, plumberC());
    const preview = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });

    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.configVersion, configVersion);
    assert.equal(preview.status, "active");
    for (const h of ["behaviourHash", "responseEngineHash", "agentHash", "payloadHash"]) {
      assert.match(preview[h], /^[0-9a-f]{64}$/, h);
    }
    assert.match(preview.blueprintHash, /^[0-9a-f]{64}$/, "the durable store reports the content hash");
    assert.ok(preview.openingLine.length > 0);
    assert.ok(preview.prompt.includes("Riverside Plumbing"));
    assert.equal(preview.provisioned, false);
    assert.match(preview.note, /PREVIEW ONLY/);
  });

  it("is deterministic — the same version previews to the same hashes", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    await activateThroughService(service, clientId, plumberC());
    const a = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });
    const b = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });
    assert.equal(a.payloadHash, b.payloadHash);
    assert.equal(a.behaviourHash, b.behaviourHash);
  });

  it("previews both directions, and they differ exactly where the ruling says", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    await activateThroughService(service, clientId, plumberC());
    const inbound = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId, direction: "inbound" });
    const outbound = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId, direction: "outbound" });

    assert.match(outbound.openingLine, /AI assistant/i, "outbound discloses in the opening");
    assert.ok(!/AI assistant/i.test(inbound.openingLine), "inbound does not");
    assert.notEqual(inbound.payloadHash, outbound.payloadHash);
    for (const p of [inbound, outbound]) {
      assert.match(p.prompt, /say plainly and immediately that you are an AI assistant/i);
    }
  });

  it("needs no API key and reaches nothing", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    await activateThroughService(service, clientId, plumberC());
    const preview = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });
    const json = JSON.stringify(preview);
    for (const secret of ["api_key", "apiKey", "Bearer", "authorization"]) {
      assert.ok(!json.toLowerCase().includes(secret.toLowerCase()), `preview leaked ${secret}`);
    }
  });

  it("refuses to preview an invalid configuration rather than showing something misleading", async () => {
    const { service } = harness();
    const clientId = "riverside_plumbing";
    const broken = plumberC();
    broken.callHandling.escalation.primaryNumber = null;
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: broken });
    const preview = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId, configVersion: draft.configVersion });
    assert.equal(preview.ok, false);
    assert.equal(preview.outcome, SERVICE_CODES.INVALID);
    assert.ok(preview.errors.some((e) => e.path === "callHandling.escalation.primaryNumber"));
  });

  it("names unresolved provider references instead of inventing them", async () => {
    const now = clock();
    const store = createPostgresBlueprintStore({ db: createFakePostgres(), now });
    const service = createConfigService({ store, now, providerRefs: {} });
    const clientId = "riverside_plumbing";
    await activateThroughService(service, clientId, plumberC());
    const preview = await service.preview({ principal: PRINCIPALS.owner(clientId), clientId });
    assert.equal(preview.ready, false);
    assert.deepEqual([...preview.unresolved].sort(), ["llmId", "voiceId", "webhookUrl"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// P18 — THE VOICE CONFIGURATION PATH
// ════════════════════════════════════════════════════════════════════

describe("P18 — a voice request can only ever produce a draft", () => {
  async function liveClient(make = plumberC, clientId = "riverside_plumbing") {
    const h = harness();
    await activateThroughService(h.service, clientId, make());
    return { ...h, clientId };
  }

  it('"we now close at 4pm Saturday" becomes a draft, and the active version does not move', async () => {
    const { service, clientId } = await liveClient();
    const before = await service.getActive({ principal: PRINCIPALS.owner(clientId), clientId });

    const proposal = await service.proposePatch({
      principal: PRINCIPALS.voice(clientId),
      clientId,
      patch: {
        explanation: "We now close at 4pm Saturday.",
        transcriptRef: "call_voice_0001",
        operations: [{ op: "set", path: "hours.weekly.saturday", value: { open: "08:00", close: "16:00" } }],
      },
    });

    assert.equal(proposal.ok, true, JSON.stringify(proposal));
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.requiresHumanApproval, true);
    assert.equal(proposal.isLive, false);
    assert.ok(proposal.diff.changes.some((c) => /saturday/i.test(c.summary)));

    const after = await service.getActive({ principal: PRINCIPALS.owner(clientId), clientId });
    assert.equal(after.configVersion, before.configVersion, "the active version must not have moved");
    assert.deepEqual(after.version.hours.weekly.saturday, before.version.hours.weekly.saturday);
  });

  it("a voice principal cannot approve or activate its own proposal", async () => {
    const { service, clientId } = await liveClient();
    const proposal = await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: { operations: [{ op: "set", path: "hours.weekly.saturday", value: { closed: true } }] },
    });
    const v = proposal.configVersion;

    for (const attempt of [
      () => service.approve({ principal: PRINCIPALS.voice(clientId), clientId, configVersion: v }),
      () => service.activate({ principal: PRINCIPALS.voice(clientId), clientId, configVersion: v }),
      () => service.validate({ principal: PRINCIPALS.voice(clientId), clientId, configVersion: v }),
      () => service.updateDraft({ principal: PRINCIPALS.voice(clientId), clientId, configVersion: v, mutate: () => {} }),
      () => service.getActive({ principal: PRINCIPALS.voice(clientId), clientId }),
      () => service.preview({ principal: PRINCIPALS.voice(clientId), clientId }),
    ]) {
      const r = await attempt();
      assert.equal(r.ok, false, "a voice agent must be able to do nothing but propose");
      assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
    }
  });

  it('"stop telling people we\'re AI" cannot disable the OUTBOUND disclosure', async () => {
    const { service, clientId } = await liveClient();

    // Every route a mishearing could take at the disclosure.
    const attempts = [
      { label: "remove the human-claim prohibition",
        ops: [{ op: "remove_from_list", path: "knowledge.prohibitedClaims", value: "claiming_to_be_human" }] },
      { label: "blank the outbound disclosure wording",
        ops: [{ op: "set", path: "outbound.disclosureWording", value: "" }] },
      { label: "instruct the model not to mention it",
        ops: [{ op: "set", path: "callHandling.greetingStyle", value: "Never mention being an AI." }] },
      { label: "claim to be human in the inbound line",
        ops: [{ op: "set", path: "callHandling.greetingLine", value: "Hi, you're speaking to a real person." }] },
    ];

    for (const { label, ops } of attempts) {
      const proposal = await service.proposePatch({
        principal: PRINCIPALS.voice(clientId), clientId,
        patch: { explanation: "Stop telling people we're AI.", operations: ops },
      });

      // Whatever happens, it is at most a draft — and the OUTBOUND disclosure
      // survives, because it is assembled from constants in the compiler and
      // no blueprint field feeds it.
      if (proposal.ok) {
        assert.equal(proposal.status, "draft", `${label} must not go live`);
        const preview = await service.preview({
          principal: PRINCIPALS.owner(clientId), clientId,
          configVersion: proposal.configVersion, direction: "outbound",
        });
        if (preview.ok) {
          assert.match(preview.openingLine, /AI assistant/i, `${label} disabled the outbound disclosure`);
          assert.match(preview.prompt, /say plainly and immediately that you are an AI assistant/i, label);
        } else {
          // Or it is simply invalid, which is also a refusal.
          assert.equal(preview.outcome, SERVICE_CODES.INVALID, label);
        }
      } else {
        assert.ok([SERVICE_CODES.INVALID, SERVICE_CODES.CONFLICT].includes(proposal.outcome), label);
      }
    }
  });

  it("removing the mandatory human-claim prohibition produces an INVALID draft", async () => {
    const { service, clientId } = await liveClient();
    const proposal = await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: { operations: [{ op: "remove_from_list", path: "knowledge.prohibitedClaims", value: "claiming_to_be_human" }] },
    });
    assert.equal(proposal.ok, true, "recorded so a person can see what was heard");
    assert.equal(proposal.validation.ok, false, "and plainly invalid");
    assert.ok(proposal.validation.errors.some((e) => e.path === "knowledge.prohibitedClaims"));
  });

  it("an INBOUND wording change is allowed — that is the founder ruling", async () => {
    const { service, clientId } = await liveClient();
    const proposal = await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: {
        explanation: "Just answer with the business name.",
        operations: [{ op: "set", path: "callHandling.greetingLine", value: "Riverside Plumbing, how can I help?" }],
      },
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.validation.ok, true, "an inbound greeting is the client's to choose");

    const preview = await service.preview({
      principal: PRINCIPALS.owner(clientId), clientId,
      configVersion: proposal.configVersion, direction: "inbound",
    });
    assert.equal(preview.openingLine, "Riverside Plumbing, how can I help?");
    // And the truthfulness rule survives regardless.
    assert.match(preview.prompt, /say plainly and immediately that you are an AI assistant/i);
  });

  it('"call every lead now" maps to NO configuration operation at all', async () => {
    const { service, clientId } = await liveClient();

    // Every path a speech-to-intent layer might plausibly produce for it.
    const attempts = [
      [{ op: "set", path: "outbound.enabled", value: true }],
      [{ op: "set", path: "calling.enabled", value: true }],
      [{ op: "set", path: "callingState", value: "enabled" }],
      [{ op: "set", path: "metadata.status", value: "active" }],
      [{ op: "set", path: "dial.authorised", value: true }],
      [{ op: "set", path: "extensions.callEveryLeadNow", value: true }],
    ];

    for (const operations of attempts) {
      const proposal = await service.proposePatch({
        principal: PRINCIPALS.voice(clientId), clientId,
        patch: { explanation: "Call every lead now.", operations },
      });
      if (proposal.ok) {
        // If it landed at all, it is a DRAFT that enables nothing: outbound is
        // a description, and the service exposes no dial operation.
        assert.equal(proposal.status, "draft");
        const version = proposal.version;
        assert.ok(!("calling" in version), "no calling section can be created");
        assert.ok(!("dial" in version), "no dial section can be created");
        // Even outbound.enabled:true is only a description, and validation
        // demands disclosure and opt-out wording before it is even legal.
        if (version.outbound && version.outbound.enabled === true) {
          assert.equal(proposal.validation.ok, false, "outbound cannot be switched on without disclosure and opt-out wording");
        }
      } else {
        assert.ok([SERVICE_CODES.INVALID, SERVICE_CODES.CONFLICT].includes(proposal.outcome));
      }
    }

    // And nothing anywhere gained the ability to dial.
    assert.ok(!Object.keys(service).some((k) => /dial|call|provision|enable/i.test(k)));
  });

  it("records the proposal, and the refusal, in the audit history", async () => {
    const { service, clientId } = await liveClient();
    await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: { operations: [{ op: "set", path: "voice.tone", value: "brisk" }] },
    });
    await service.proposePatch({
      principal: PRINCIPALS.voice("somebody_else"), clientId,
      patch: { operations: [{ op: "set", path: "voice.tone", value: "brisk" }] },
    });

    const history = await service.history({ principal: PRINCIPALS.owner(clientId), clientId });
    const types = history.events.map((e) => e.eventType);
    assert.ok(types.includes("voice_patch_proposed"), "the accepted proposal is recorded");
    assert.ok(types.includes("voice_patch_refused"), "and so is the cross-tenant refusal");
  });
});

// ════════════════════════════════════════════════════════════════════
// P18B — CROSS-TENANT ATTACKS
// ════════════════════════════════════════════════════════════════════

describe("P18B — every cross-tenant attempt fails closed", () => {
  async function twoLiveClients() {
    const h = harness();
    await activateThroughService(h.service, "riverside_plumbing", plumberC());
    await activateThroughService(h.service, "rolladoor_repairs", garageDoorD());
    return h;
  }

  const A = "riverside_plumbing";
  const B = "rolladoor_repairs";

  it("client A cannot READ client B's active configuration", async () => {
    const { service } = await twoLiveClients();
    const r = await service.getActive({ principal: PRINCIPALS.owner(A), clientId: B });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
  });

  it("client A cannot LIST or read a specific version of client B", async () => {
    const { service } = await twoLiveClients();
    for (const attempt of [
      () => service.listVersions({ principal: PRINCIPALS.owner(A), clientId: B }),
      () => service.getVersion({ principal: PRINCIPALS.owner(A), clientId: B, configVersion: 1 }),
      () => service.diff({ principal: PRINCIPALS.owner(A), clientId: B, toVersion: 1 }),
      () => service.history({ principal: PRINCIPALS.owner(A), clientId: B }),
    ]) {
      const r = await attempt();
      assert.equal(r.ok, false);
      assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
    }
  });

  it("client A cannot APPROVE client B's draft", async () => {
    const { service } = await twoLiveClients();
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(B), clientId: B, blueprint: garageDoorD() });
    await service.validate({ principal: PRINCIPALS.editor(B), clientId: B, configVersion: draft.configVersion });
    const r = await service.approve({ principal: PRINCIPALS.owner(A), clientId: B, configVersion: draft.configVersion });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);

    const still = await service.getVersion({ principal: PRINCIPALS.owner(B), clientId: B, configVersion: draft.configVersion });
    assert.equal(still.version.metadata.status, "validated", "B's draft must be untouched");
  });

  it("client A cannot ACTIVATE client B's version", async () => {
    const { service } = await twoLiveClients();
    const before = await service.getActive({ principal: PRINCIPALS.owner(B), clientId: B });
    const r = await service.activate({ principal: PRINCIPALS.operator(A), clientId: B, configVersion: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
    const after = await service.getActive({ principal: PRINCIPALS.owner(B), clientId: B });
    assert.equal(after.configVersion, before.configVersion);
  });

  it("client A cannot PREVIEW client B's configuration", async () => {
    const { service } = await twoLiveClients();
    const r = await service.preview({ principal: PRINCIPALS.owner(A), clientId: B });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
  });

  it("client A cannot PROPOSE a patch against client B", async () => {
    const { service } = await twoLiveClients();
    const r = await service.proposePatch({
      principal: PRINCIPALS.owner(A), clientId: B,
      patch: { operations: [{ op: "set", path: "voice.tone", value: "hijacked" }] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
    const b = await service.getActive({ principal: PRINCIPALS.owner(B), clientId: B });
    assert.notEqual(b.version.voice.tone, "hijacked");
  });

  it("a wrong version under the CORRECT client is a clean not-found, not a leak", async () => {
    const { service } = await twoLiveClients();
    const r = await service.getVersion({ principal: PRINCIPALS.owner(A), clientId: A, configVersion: 999 });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.NOT_FOUND);
  });

  it("version-id guessing never crosses a tenant", async () => {
    const { service } = await twoLiveClients();
    // B's version 1 exists. A asking for version 1 gets A's own, never B's.
    const mine = await service.getVersion({ principal: PRINCIPALS.owner(A), clientId: A, configVersion: 1 });
    assert.equal(mine.version.identity.clientId, A);
    assert.equal(mine.version.identity.tradingName, "Riverside Plumbing");
  });

  it("a stale draft update is refused without revealing anything about the draft", async () => {
    const { service, now } = await twoLiveClients();
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: plumberC() });
    await service.updateDraft({
      principal: PRINCIPALS.editor(A), clientId: A, configVersion: draft.configVersion,
      mutate: (bp) => { bp.identity.description = "one"; },
    });
    now.tick();
    const stale = await service.updateDraft({
      principal: PRINCIPALS.editor(A), clientId: A, configVersion: draft.configVersion,
      expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "two"; },
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.outcome, SERVICE_CODES.CONFLICT);
  });

  it("a stale approval is refused — the body moved after it was validated", async () => {
    const { service } = await twoLiveClients();
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: plumberC() });
    const v = draft.configVersion;
    await service.validate({ principal: PRINCIPALS.editor(A), clientId: A, configVersion: v });
    // Editing after validation drops it back to draft, so approval must refuse.
    await service.updateDraft({
      principal: PRINCIPALS.editor(A), clientId: A, configVersion: v,
      mutate: (bp) => { bp.identity.description = "changed after validation"; },
    });
    const r = await service.approve({ principal: PRINCIPALS.owner(A), clientId: A, configVersion: v });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.CONFLICT);
  });

  it("a stale activation is refused — the version is not approved", async () => {
    const { service } = await twoLiveClients();
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: plumberC() });
    const r = await service.activate({ principal: PRINCIPALS.operator(A), clientId: A, configVersion: draft.configVersion });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.CONFLICT);
  });

  it("a restored historical version comes back as a DRAFT needing approval", async () => {
    const { service } = await twoLiveClients();
    const first = await service.getActive({ principal: PRINCIPALS.owner(A), clientId: A });
    await activateThroughService(service, A, plumberC());
    const restored = await service.restore({
      principal: PRINCIPALS.operator(A), clientId: A, configVersion: first.configVersion,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.version.metadata.status, "draft");
    assert.equal(restored.requiresApproval, true);
    assert.equal(restored.version.metadata.approvedAt, null);
    assert.equal(restored.version.metadata.activatedAt, null);
  });

  it("a malformed blueprint is refused with named errors, not a crash", async () => {
    const { service } = await twoLiveClients();
    for (const junk of [null, undefined, 42, "blueprint", []]) {
      const r = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: junk });
      assert.equal(r.ok, false, JSON.stringify(junk));
    }
    const broken = plumberC();
    broken.services = [];
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: broken });
    const validated = await service.validate({ principal: PRINCIPALS.editor(A), clientId: A, configVersion: draft.configVersion });
    assert.equal(validated.ok, false);
    assert.equal(validated.outcome, SERVICE_CODES.INVALID);
    assert.ok(validated.errors.some((e) => e.path === "services"));
  });

  it("unknown service ids are refused rather than silently accepted", async () => {
    const { service } = await twoLiveClients();
    const bad = plumberC();
    bad.callHandling.escalation.eligibleServices = ["burst_pipe", "a_service_that_does_not_exist"];
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: bad });
    const validated = await service.validate({ principal: PRINCIPALS.editor(A), clientId: A, configVersion: draft.configVersion });
    assert.equal(validated.ok, false);
    assert.ok(validated.errors.some((e) => e.path.includes("eligibleServices")));
  });

  it("untrusted source metadata is recorded, never believed", async () => {
    const { service } = await twoLiveClients();
    // A caller claiming an authoritative source gains no authority.
    const draft = await service.createDraft({
      principal: PRINCIPALS.viewer(A), clientId: A, blueprint: plumberC(), source: "operator",
    });
    assert.equal(draft.ok, false, "a viewer cannot draft, whatever source it claims");
    assert.equal(draft.outcome, SERVICE_CODES.FORBIDDEN);
  });

  it("the blueprint body cannot smuggle a different tenant past the service", async () => {
    const { service } = await twoLiveClients();
    const smuggled = garageDoorD();   // says rolladoor_repairs
    const r = await service.createDraft({ principal: PRINCIPALS.editor(A), clientId: A, blueprint: smuggled });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, SERVICE_CODES.FORBIDDEN);
  });
});

// ════════════════════════════════════════════════════════════════════
// P18A — END TO END, ONE FICTIONAL CLIENT
// ════════════════════════════════════════════════════════════════════

describe("P18A — a fictional client, end to end, with no network", () => {
  it("walks the whole flow and the hashes move exactly when they should", async () => {
    const { service, now } = harness();
    const clientId = "rolladoor_repairs";
    const editor = PRINCIPALS.editor(clientId, "sam@rolladoor.invalid");
    const owner = PRINCIPALS.owner(clientId, "nadia@rolladoor.invalid");
    const operator = PRINCIPALS.operator(clientId);

    //  1. an authorised operator creates a draft
    const draft = await service.createDraft({ principal: editor, clientId, blueprint: garageDoorD() });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const v1 = draft.configVersion;

    //  2. adds a service
    const added = await service.updateDraft({
      principal: editor, clientId, configVersion: v1,
      mutate: (bp) => {
        bp.services.push({
          serviceId: "motor_replacement", name: "Motor replacement",
          aliases: ["new motor"], enabled: true, urgencyCategory: "standard",
        });
      },
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    //  3. validates
    assert.equal((await service.validate({ principal: editor, clientId, configVersion: v1 })).ok, true);

    //  4. views a deterministic diff
    const diffA = await service.diff({ principal: editor, clientId, toVersion: v1 });
    const diffB = await service.diff({ principal: editor, clientId, toVersion: v1 });
    assert.equal(JSON.stringify(diffA.diff), JSON.stringify(diffB.diff), "the diff is deterministic");

    //  5. a SECOND actor approves — the editor may not
    const editorApproving = await service.approve({ principal: editor, clientId, configVersion: v1 });
    assert.equal(editorApproving.ok, false, "the person who wrote it cannot approve it");
    const approved = await service.approve({ principal: owner, clientId, configVersion: v1, reason: "Read it with Sam." });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.isLive, false);

    //  6. activation, by the operator
    const activated = await service.activate({ principal: operator, clientId, configVersion: v1 });
    assert.equal(activated.ok, true, JSON.stringify(activated));
    assert.equal(activated.providerUpdated, false);

    //  7. the active version is readable
    const active = await service.getActive({ principal: owner, clientId });
    assert.equal(active.configVersion, v1);
    assert.ok(active.version.services.some((s) => s.serviceId === "motor_replacement"));

    //  8 + 9 + 10. the compiler uses it, the preview compiles, the hashes are deterministic
    const p1 = await service.preview({ principal: owner, clientId });
    const p2 = await service.preview({ principal: owner, clientId });
    assert.equal(p1.ok, true, JSON.stringify(p1));
    assert.equal(p1.payloadHash, p2.payloadHash);
    assert.ok(p1.prompt.includes("Motor replacement"), "the new service reaches the prompt");

    // 11. a voice-originated patch proposes changed Saturday hours
    now.tick();
    const proposal = await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: {
        explanation: "We now close at 4pm Saturday.",
        transcriptRef: "call_e2e_0001",
        operations: [{ op: "set", path: "hours.weekly.saturday", value: { open: "08:00", close: "16:00" } }],
      },
    });

    // 12. a new draft appears
    assert.equal(proposal.ok, true, JSON.stringify(proposal));
    const v2 = proposal.configVersion;
    assert.ok(v2 > v1);
    assert.equal(proposal.status, "draft");

    // 13. the active version is unchanged
    const stillActive = await service.getActive({ principal: owner, clientId });
    assert.equal(stillActive.configVersion, v1);
    assert.deepEqual(stillActive.version.hours.weekly.saturday, { open: "08:00", close: "12:00" });
    assert.equal((await service.preview({ principal: owner, clientId })).payloadHash, p1.payloadHash);

    // 14. a human approves it
    assert.equal((await service.validate({ principal: editor, clientId, configVersion: v2 })).ok, true);
    assert.equal((await service.approve({ principal: owner, clientId, configVersion: v2, reason: "Confirmed by telephone." })).ok, true);

    // 15. activation changes the active version
    assert.equal((await service.activate({ principal: operator, clientId, configVersion: v2 })).ok, true);
    const nowActive = await service.getActive({ principal: owner, clientId });
    assert.equal(nowActive.configVersion, v2);
    assert.deepEqual(nowActive.version.hours.weekly.saturday, { open: "08:00", close: "16:00" });

    // 16. and the preview changes deterministically
    const p3 = await service.preview({ principal: owner, clientId });
    assert.notEqual(p3.payloadHash, p1.payloadHash, "a real change moves the payload hash");
    assert.equal(p3.payloadHash, (await service.preview({ principal: owner, clientId })).payloadHash);
    assert.equal(p3.provisioned, false);

    // Exactly one active version, throughout.
    const listed = await service.listVersions({ principal: owner, clientId });
    assert.equal(listed.versions.filter((x) => x.status === "active").length, 1);
    assert.deepEqual(listed.versions.map((x) => x.status), ["superseded", "active"]);
  });

  it("records the whole history, in order, with actors and roles", async () => {
    const { service } = harness();
    const clientId = "rolladoor_repairs";
    await activateThroughService(service, clientId, garageDoorD());
    const history = await service.history({ principal: PRINCIPALS.owner(clientId), clientId });
    const types = history.events.map((e) => e.eventType);
    for (const expected of ["draft_created", "validated", "approved", "activated"]) {
      assert.ok(types.includes(expected), `history is missing ${expected}`);
    }
    const approval = history.events.find((e) => e.eventType === "approved");
    assert.equal(approval.actor, "owner@x.invalid");
    assert.equal(approval.actorRole, "client_owner");
    const activation = history.events.find((e) => e.eventType === "activated");
    assert.equal(activation.actorRole, "operator");
  });

  it("never records a blueprint body, a secret or a transcript", async () => {
    const { service, audit } = harness();
    const clientId = "rolladoor_repairs";
    await activateThroughService(service, clientId, garageDoorD());
    await service.proposePatch({
      principal: PRINCIPALS.voice(clientId), clientId,
      patch: { explanation: "x", transcriptRef: "call_secret_0001", operations: [{ op: "set", path: "voice.tone", value: "brisk" }] },
    });
    const events = await audit.list(clientId, { limit: 100 });
    const json = JSON.stringify(events);
    assert.ok(!json.includes("Rolladoor Repairs Pty Ltd"), "no legal name / body content");
    assert.ok(!json.includes("+61355500411"), "no transfer numbers");
    assert.ok(!json.includes("call_secret_0001"), "no transcript reference");
    for (const e of events) {
      if (e.metadata) assert.ok(JSON.stringify(e.metadata).length <= 4096);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// THE HTTP SURFACE
// ════════════════════════════════════════════════════════════════════

describe("HTTP surface — handlers, without express", () => {
  function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }

  const clientReq = (clientId, { params = {}, body = {}, query = {}, email = "owner@x.invalid" } = {}) => ({
    clientId,
    client: { slug: clientId, platform_role: "client_owner" },
    clientAuth: { mode: "cookie", user: { email } },
    params, body, query,
  });

  const operatorReq = (clientId, { params = {}, body = {}, query = {} } = {}) => ({
    clientId, operatorSession: true, session: { operatorId: "Peter Dang" }, params, body, query,
  });

  async function liveHandlers() {
    const { service } = harness();
    await activateThroughService(service, "riverside_plumbing", plumberC());
    await activateThroughService(service, "rolladoor_repairs", garageDoorD());
    return { service, handlers: createPlatformConfigHandlers({ service, logger: { error() {} } }) };
  }

  it("serves a client their own active configuration", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.getActive(clientReq("riverside_plumbing", { params: { clientId: "riverside_plumbing" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.version.identity.tradingName, "Riverside Plumbing");
  });

  it("403s a client asking for another client's URL, and says nothing else", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.getActive(clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs" } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "Not authorised for this client.");
    assert.equal(JSON.stringify(res.body).includes("Rolladoor"), false, "no leak about the other client");
  });

  it("403s every write aimed at another client", async () => {
    const { handlers } = await liveHandlers();
    for (const [name, req] of [
      ["createDraft", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs" }, body: { blueprint: garageDoorD() } })],
      ["updateDraft", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs", versionId: "1" }, body: { blueprint: {} } })],
      ["validate", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs", versionId: "1" } })],
      ["approve", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs", versionId: "1" } })],
      ["preview", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs", versionId: "active" } })],
      ["proposePatch", clientReq("riverside_plumbing", { params: { clientId: "rolladoor_repairs" }, body: { patch: { operations: [{ op: "set", path: "voice.tone", value: "x" }] } } })],
    ]) {
      const res = fakeRes();
      await handlers[name](req, res);
      assert.equal(res.statusCode, 403, `${name} must refuse across tenants`);
    }
  });

  it("403s a request with no verified session at all", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.getActive({ params: { clientId: "riverside_plumbing" }, query: {}, body: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "no_authenticated_principal");
  });

  it("ignores a clientId supplied in the query or body", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.getActive(
      clientReq("riverside_plumbing", {
        params: { clientId: "riverside_plumbing" },
        query: { clientId: "rolladoor_repairs" },
        body: { clientId: "rolladoor_repairs" },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.version.identity.clientId, "riverside_plumbing");
  });

  it("404s a malformed version id rather than coercing it", async () => {
    const { handlers } = await liveHandlers();
    for (const versionId of ["abc", "-1", "0", "1.5", "1;drop table", "", "%20"]) {
      const res = fakeRes();
      await handlers.getVersion(clientReq("riverside_plumbing", { params: { clientId: "riverside_plumbing", versionId } }), res);
      assert.equal(res.statusCode, 404, `"${versionId}" must not resolve`);
    }
  });

  it("404s a version that does not exist under the caller's own client", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.getVersion(clientReq("riverside_plumbing", { params: { clientId: "riverside_plumbing", versionId: "999" } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, "Not found.");
  });

  it("refuses activation from a client session — only an operator activates", async () => {
    const { handlers } = await liveHandlers();
    const res = fakeRes();
    await handlers.activate(clientReq("riverside_plumbing", { params: { clientId: "riverside_plumbing", versionId: "1" } }), res);
    assert.equal(res.statusCode, 403);
  });

  it("lets the operator activate, and reports that nothing was provisioned", async () => {
    const { service, handlers } = await liveHandlers();
    const clientId = "riverside_plumbing";
    const changed = plumberC();
    changed.identity.description = "second version";
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: changed });
    await service.validate({ principal: PRINCIPALS.editor(clientId), clientId, configVersion: draft.configVersion });
    await service.approve({ principal: PRINCIPALS.owner(clientId), clientId, configVersion: draft.configVersion });

    const res = fakeRes();
    await handlers.activate(operatorReq(clientId, { params: { clientId, versionId: String(draft.configVersion) } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.providerUpdated, false);
    assert.match(res.body.note, /No provider resource/i);
  });

  it("returns 422 with named errors for an invalid draft", async () => {
    const { service, handlers } = await liveHandlers();
    const clientId = "riverside_plumbing";
    const broken = plumberC();
    broken.services = [];
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: broken });
    const res = fakeRes();
    await handlers.validate(clientReq(clientId, { params: { clientId, versionId: String(draft.configVersion) } }), res);
    assert.equal(res.statusCode, 422);
    assert.ok(res.body.errors.some((e) => e.path === "services"));
  });

  it("returns 409 for a conflict rather than pretending it worked", async () => {
    const { service, handlers } = await liveHandlers();
    const clientId = "riverside_plumbing";
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: plumberC() });
    const res = fakeRes();
    // Approving something never validated.
    await handlers.approve(clientReq(clientId, { params: { clientId, versionId: String(draft.configVersion) } }), res);
    assert.equal(res.statusCode, 409);
  });

  it("never leaks a stack trace or an internal message on an unexpected failure", async () => {
    const exploding = {
      getActive: async () => { throw new Error("SECRET: connection string postgres://user:pw@host/db"); },
    };
    const handlers = createPlatformConfigHandlers({ service: exploding, logger: { error() {} } });
    const res = fakeRes();
    await handlers.getActive(clientReq("riverside_plumbing", { params: { clientId: "riverside_plumbing" } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, "Configuration request failed.");
    assert.ok(!JSON.stringify(res.body).includes("SECRET"));
    assert.ok(!JSON.stringify(res.body).includes("postgres://"));
  });

  it("a PATCH cannot move a draft to another tenant or change its vertical", async () => {
    const { service, handlers } = await liveHandlers();
    const clientId = "riverside_plumbing";
    const draft = await service.createDraft({ principal: PRINCIPALS.editor(clientId), clientId, blueprint: plumberC() });
    const res = fakeRes();
    await handlers.updateDraft(
      clientReq(clientId, {
        params: { clientId, versionId: String(draft.configVersion) },
        body: { blueprint: { identity: { clientId: "rolladoor_repairs", vertical: "garage_doors", tradingName: "Renamed" } } },
      }),
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.version.identity.clientId, "riverside_plumbing", "the tenant is untouchable");
    assert.equal(res.body.version.identity.vertical, "plumbing", "and so is the vertical");
    assert.equal(res.body.version.identity.tradingName, "Renamed", "but ordinary fields do change");
  });

  it("has no handler that could provision, dial or enable anything", async () => {
    const { handlers } = await liveHandlers();
    const ACTING = /^(provision|deploy|publish|dial|call|enable|disable|send|suppress|wash)([A-Z]|$)/;
    for (const name of Object.keys(handlers)) {
      assert.ok(!ACTING.test(name), `no handler may be called "${name}"`);
    }
    assert.deepEqual(
      Object.keys(handlers).sort(),
      ["activate", "approve", "createDraft", "diff", "getActive", "getVersion", "history", "listVersions", "preview", "proposePatch", "restore", "updateDraft", "validate"],
    );
  });
});

describe("HTTP surface — the route file is gated OFF by default", () => {
  const SOURCE = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-config.js"), "utf8");

  it("exits the router entirely unless the exact string 'true' is set", () => {
    const { platformConfigApiEnabled, platformConfigGate } = require("../src/routes/platform-config");
    for (const value of [undefined, "", "TRUE", "1", "yes", "on", "false"]) {
      assert.equal(platformConfigApiEnabled({ PLATFORM_CONFIG_API_ENABLED: value }), false, `"${value}" must not enable it`);
    }
    assert.equal(platformConfigApiEnabled({ PLATFORM_CONFIG_API_ENABLED: "true" }), true);

    let exited = null;
    platformConfigGate({})({}, {}, (arg) => { exited = arg; });
    assert.equal(exited, "router", "an unset flag must 404 every path as if the file did not exist");
  });

  it("puts every path behind a session", () => {
    const routes = [...SOURCE.matchAll(/router\.(get|post|patch)\(`?\$?\{?BASE\}?([^`,]*)`?,\s*(\w+)/g)];
    assert.ok(routes.length >= 12, `expected the whole surface, found ${routes.length}`);
    for (const [, method, tail, guard] of routes) {
      assert.ok(
        ["requireClientAuth", "requireLogin"].includes(guard),
        `${method.toUpperCase()} ${tail} is guarded by "${guard}"`,
      );
    }
  });

  it("puts activation and restore behind the OPERATOR guard specifically", () => {
    assert.match(SOURCE, /activate`,\s*requireLogin/);
    assert.match(SOURCE, /restore`,\s*requireLogin/);
  });

  it("declares no provisioning, calling or dial route", () => {
    // Comments stripped: the file's own header explains it declares none of
    // these, and a raw sweep would match the explanation.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ["provision", "/dial", "enable-calling", "phone-number", "/sms"]) {
      assert.ok(!code.includes(forbidden), `the router must not declare ${forbidden}`);
    }
    assert.ok('router.post("/provision", h)'.includes("provision"), "the check still bites");
  });
});
