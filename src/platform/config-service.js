// AIDA PLATFORM — the Client Configuration Service (P17).
//
//   createConfigService({ store, now, audit, providerRefs })
//
// The ONE entry point the application layer uses. Every operation takes a
// PRINCIPAL, checks authority before touching anything, records what happened
// (including refusals), and returns a result rather than throwing.
//
//   UI / voice configurator / operator API
//                 |
//         >>> this module <<<          authority + audit
//                 |
//        blueprint authority           draft -> validate -> approve -> activate
//                 |
//        durable versioned store
//                 |
//        behaviour spec compiler
//                 |
//        provider payload PREVIEW
//
// ── ACTIVATION IS NOT DEPLOYMENT ────────────────────────────────────
// `activate` means: this approved version is the configuration AIDA considers
// current for this client. It does NOT update a Retell agent, does not touch a
// response engine, provisions nothing, changes no phone routing and enables no
// call. There is no code path from here to any of those, and the boundary
// ratchets read this file's imports to prove it.
//
// Provider provisioning is a separate authority that does not exist yet. When
// it does, it will READ an active version — it will never be triggered by one.
//
// ── PREVIEW IS PURE ─────────────────────────────────────────────────
// `preview` compiles a behaviour spec and a provider payload and returns
// hashes. It needs no API key, opens no socket, and the compiler it calls
// imports no transport.

const { validateBlueprint } = require("./client-blueprint");
const { createBlueprintAuthority, AUTHORITY_CODES } = require("./blueprint-authority");
const { compileBehaviourSpec } = require("./behaviour-spec");
const { compileRetellPreview } = require("./provider-compiler-retell");
const { proposeConfigPatch, PATCH_CODES } = require("./config-patch");
const { authorise, ACCESS_CODES } = require("./config-access");

const SERVICE_CODES = Object.freeze({
  OK: "ok",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  INVALID: "invalid",
  CONFLICT: "conflict",
  UNAVAILABLE: "unavailable",
});

/**
 * Authority codes -> what a caller (and an HTTP layer) should make of them.
 * Mapped explicitly rather than by string-matching, so a new authority code
 * without a mapping is a visible gap rather than a silent 500.
 */
const OUTCOME_BY_AUTHORITY_CODE = Object.freeze({
  [AUTHORITY_CODES.NOT_FOUND]: SERVICE_CODES.NOT_FOUND,
  [AUTHORITY_CODES.NO_ACTIVE]: SERVICE_CODES.NOT_FOUND,
  [AUTHORITY_CODES.CROSS_TENANT]: SERVICE_CODES.FORBIDDEN,
  [AUTHORITY_CODES.NOT_A_PERSON]: SERVICE_CODES.FORBIDDEN,
  [AUTHORITY_CODES.INVALID]: SERVICE_CODES.INVALID,
  [AUTHORITY_CODES.NOT_A_DRAFT]: SERVICE_CODES.CONFLICT,
  [AUTHORITY_CODES.ALREADY_APPROVED]: SERVICE_CODES.CONFLICT,
  [AUTHORITY_CODES.IMMUTABLE]: SERVICE_CODES.CONFLICT,
  [AUTHORITY_CODES.STALE]: SERVICE_CODES.CONFLICT,
  [AUTHORITY_CODES.NOT_APPROVED]: SERVICE_CODES.CONFLICT,
  [AUTHORITY_CODES.STORE_UNAVAILABLE]: SERVICE_CODES.UNAVAILABLE,
  [AUTHORITY_CODES.STORE_REFUSED]: SERVICE_CODES.CONFLICT,
});

const outcomeFor = (code) => OUTCOME_BY_AUTHORITY_CODE[code] || SERVICE_CODES.INVALID;

const ok = (value = {}) => Object.freeze({ ok: true, outcome: SERVICE_CODES.OK, ...value });
const no = (outcome, code, message, extra = {}) =>
  Object.freeze({ ok: false, outcome, code, message, ...extra });

/** Audit events this service emits. Refusals are recorded too — a rejected approval is history. */
const EVENT_FOR = Object.freeze({
  createDraft: "draft_created",
  updateDraft: "draft_updated",
  validate: "validated",
  approve: "approved",
  activate: "activated",
  restore: "restored",
  proposePatch: "voice_patch_proposed",
  preview: "previewed",
});
const REFUSAL_EVENT_FOR = Object.freeze({
  validate: "validation_failed",
  approve: "approval_refused",
  activate: "activation_refused",
  proposePatch: "voice_patch_refused",
});

function createConfigService({ store, now, audit = null, providerRefs = {} } = {}) {
  const authority = createBlueprintAuthority({ store, now });

  /** Record an event, and never let auditing failure break the operation. */
  async function record(operation, { principal, clientId, configVersion, refused, detail }) {
    if (!audit || typeof audit.append !== "function") return;
    const eventType = refused ? REFUSAL_EVENT_FOR[operation] : EVENT_FOR[operation];
    if (!eventType) return;
    try {
      await audit.append({
        clientId,
        configVersion: configVersion ?? null,
        eventType,
        actor: principal ? principal.actorId : null,
        actorRole: principal ? principal.role : null,
        source: principal && principal.role === "voice_agent" ? "voice" : (principal && principal.role === "operator" ? "operator" : "ui"),
        // Bounded and safe: a code and a short reason, never a blueprint body,
        // never an integration credential, never a transcript.
        metadata: detail ? { detail: String(detail).slice(0, 500) } : null,
      });
    } catch {
      /* An audit sink that is down must not take configuration down with it. */
    }
  }

  /** Authority check first, always. Returns a refusal or null. */
  function gate(principal, operation, clientId) {
    const decision = authorise({ principal, operation, clientId });
    if (decision.ok) return null;
    const outcome = decision.code === ACCESS_CODES.NO_PRINCIPAL ? SERVICE_CODES.FORBIDDEN : SERVICE_CODES.FORBIDDEN;
    return no(outcome, decision.code, decision.message);
  }

  const relay = (result) => no(outcomeFor(result.code), result.code, result.message, result.errors ? { errors: result.errors } : {});

  // ── reads ─────────────────────────────────────────────────────────

  async function getActive({ principal, clientId }) {
    const denied = gate(principal, "config:view", clientId);
    if (denied) return denied;
    const result = await authority.getActiveVersion(clientId);
    if (!result.ok) return relay(result);
    return ok({ version: result.version, configVersion: result.version.metadata.configVersion });
  }

  async function listVersions({ principal, clientId }) {
    const denied = gate(principal, "config:view", clientId);
    if (denied) return denied;
    const result = await authority.listVersions(clientId);
    if (!result.ok) return relay(result);
    return ok({ versions: result.versions });
  }

  async function getVersion({ principal, clientId, configVersion }) {
    const denied = gate(principal, "config:view", clientId);
    if (denied) return denied;
    const result = await authority.getDraft(clientId, configVersion);
    if (!result.ok) return relay(result);
    return ok({ version: result.version });
  }

  async function diff({ principal, clientId, fromVersion = null, toVersion }) {
    const denied = gate(principal, "config:view", clientId);
    if (denied) return denied;
    const result = await authority.diffDraft({ clientId, fromVersion, toVersion });
    if (!result.ok) return relay(result);
    return ok({ diff: result.diff });
  }

  async function history({ principal, clientId, limit = 100 }) {
    const denied = gate(principal, "config:view", clientId);
    if (denied) return denied;
    if (!audit || typeof audit.list !== "function") return ok({ events: [] });
    return ok({ events: await audit.list(clientId, { limit }) });
  }

  // ── writes ────────────────────────────────────────────────────────

  async function createDraft({ principal, clientId, blueprint, source = "ui" }) {
    const denied = gate(principal, "config:draft", clientId);
    if (denied) return denied;
    const result = await authority.createDraft({
      clientId, blueprint, createdBy: principal.actorId, source,
    });
    if (!result.ok) return relay(result);
    await record("createDraft", { principal, clientId, configVersion: result.version.metadata.configVersion });
    return ok({ version: result.version, configVersion: result.version.metadata.configVersion });
  }

  async function updateDraft({ principal, clientId, configVersion, mutate, expectedUpdatedAt }) {
    const denied = gate(principal, "config:draft", clientId);
    if (denied) return denied;
    const args = { clientId, configVersion, mutate, updatedBy: principal.actorId };
    if (expectedUpdatedAt !== undefined) args.expectedUpdatedAt = expectedUpdatedAt;
    const result = await authority.updateDraft(args);
    if (!result.ok) return relay(result);
    await record("updateDraft", { principal, clientId, configVersion });
    return ok({ version: result.version });
  }

  async function validate({ principal, clientId, configVersion }) {
    const denied = gate(principal, "config:validate", clientId);
    if (denied) return denied;
    const result = await authority.validateDraft(clientId, configVersion);
    if (!result.ok) {
      await record("validate", { principal, clientId, configVersion, refused: true, detail: result.code });
      return relay(result);
    }
    await record("validate", { principal, clientId, configVersion });
    return ok({ version: result.version, warnings: result.warnings });
  }

  async function approve({ principal, clientId, configVersion, reason = null }) {
    const denied = gate(principal, "config:approve", clientId);
    if (denied) {
      await record("approve", { principal, clientId, configVersion, refused: true, detail: denied.code });
      return denied;
    }
    const result = await authority.approveDraft({
      clientId, configVersion, approvedBy: principal.actorId, reason,
    });
    if (!result.ok) {
      await record("approve", { principal, clientId, configVersion, refused: true, detail: result.code });
      return relay(result);
    }
    await record("approve", { principal, clientId, configVersion });
    // Said out loud in the response, not merely in a comment: approving is not
    // putting anything live, and it certainly is not provisioning anything.
    return ok({
      version: result.version,
      isLive: false,
      note: "Approved. This is NOT the active configuration until it is activated, and activation provisions nothing.",
    });
  }

  async function activate({ principal, clientId, configVersion }) {
    const denied = gate(principal, "config:activate", clientId);
    if (denied) {
      await record("activate", { principal, clientId, configVersion, refused: true, detail: denied.code });
      return denied;
    }
    const result = await authority.activateApprovedVersion({
      clientId, configVersion, activatedBy: principal.actorId,
    });
    if (!result.ok) {
      await record("activate", { principal, clientId, configVersion, refused: true, detail: result.code });
      return relay(result);
    }
    await record("activate", { principal, clientId, configVersion });
    return ok({
      version: result.version,
      alreadyActive: result.alreadyActive === true,
      // ACTIVATION IS NOT DEPLOYMENT. Stated in the payload so a UI cannot
      // present it as one without deliberately deleting the sentence.
      meaning: "This is now the configuration AIDA considers current for this client.",
      providerUpdated: false,
      note: "No provider resource was created or updated. Provisioning is a separate, explicitly authorised act.",
    });
  }

  async function restore({ principal, clientId, configVersion }) {
    const denied = gate(principal, "config:draft", clientId);
    if (denied) return denied;
    const result = await authority.restoreFromVersion({
      clientId, configVersion, createdBy: principal.actorId,
    });
    if (!result.ok) return relay(result);
    await record("restore", { principal, clientId, configVersion: result.version.metadata.configVersion });
    return ok({ version: result.version, requiresApproval: true });
  }

  // ── the voice path ────────────────────────────────────────────────

  /**
   * A proposal, from anywhere, becomes a DRAFT. `config:propose` is strictly
   * weaker than `config:draft`: a voice agent holds only this one capability,
   * so there is no operation it can reach that approves or activates.
   */
  async function proposePatch({ principal, clientId, patch, source = "voice" }) {
    const denied = gate(principal, "config:propose", clientId);
    if (denied) {
      await record("proposePatch", { principal, clientId, refused: true, detail: denied.code });
      return denied;
    }
    const result = await proposeConfigPatch({
      authority, clientId, patch, proposedBy: principal.actorId, source,
    });
    if (!result.ok) {
      await record("proposePatch", { principal, clientId, refused: true, detail: result.code });
      const outcome = result.code === PATCH_CODES.CONFLICT ? SERVICE_CODES.CONFLICT
        : result.code === PATCH_CODES.NO_ACTIVE ? SERVICE_CODES.NOT_FOUND
          : SERVICE_CODES.INVALID;
      return no(outcome, result.code, result.message, result.path ? { path: result.path } : {});
    }
    await record("proposePatch", { principal, clientId, configVersion: result.version.metadata.configVersion });
    return ok({
      version: result.version,
      configVersion: result.version.metadata.configVersion,
      status: result.status,
      requiresHumanApproval: true,
      isLive: false,
      diff: result.diff,
      validation: result.validation,
      provenance: result.provenance,
    });
  }

  // ── preview ───────────────────────────────────────────────────────

  /**
   * Compile whatever a person is about to approve, or has approved, into what
   * a provider would be told. Pure: no key, no socket, no write.
   */
  async function preview({ principal, clientId, configVersion = null, direction = "inbound", refs = null }) {
    const denied = gate(principal, "config:preview", clientId);
    if (denied) return denied;

    const found = configVersion === null
      ? await authority.getActiveVersion(clientId)
      : await authority.getDraft(clientId, configVersion);
    if (!found.ok) return relay(found);

    const validation = validateBlueprint(found.version);
    if (!validation.ok) {
      return no(SERVICE_CODES.INVALID, "blueprint_invalid",
        "refusing to preview an invalid configuration — a preview of something that cannot ship is misleading",
        { errors: validation.errors });
    }

    const { spec, behaviourHash } = compileBehaviourSpec(found.version);
    const compiled = compileRetellPreview({ spec, providerRefs: refs || providerRefs, direction });

    await record("preview", { principal, clientId, configVersion: found.version.metadata.configVersion });

    return ok({
      clientId,
      configVersion: found.version.metadata.configVersion,
      status: found.version.metadata.status,
      direction,
      blueprintHash: found.version.metadata.contentHash ?? null,
      behaviourHash,
      responseEngineHash: compiled.responseEngineHash,
      agentHash: compiled.agentHash,
      payloadHash: compiled.payloadHash,
      ready: compiled.ready,
      unresolved: compiled.unresolved,
      openingLine: compiled.responseEngine.begin_message,
      prompt: compiled.responseEngine.general_prompt,
      analysisFields: compiled.agent.post_call_analysis_data,
      // Repeated at every layer on purpose.
      provisioned: false,
      note: "PREVIEW ONLY. Nothing was sent to any provider and no resource exists because of this call.",
    });
  }

  return Object.freeze({
    getActive, listVersions, getVersion, diff, history,
    createDraft, updateDraft, validate, approve, activate, restore,
    proposePatch, preview,
  });
}

module.exports = { createConfigService, SERVICE_CODES, OUTCOME_BY_AUTHORITY_CODE, EVENT_FOR, REFUSAL_EVENT_FOR };
