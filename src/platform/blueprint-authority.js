// AIDA PLATFORM — who owns a client's configuration, and when it changes (P3).
//
//   createBlueprintAuthority({ store, now })
//     .createDraft / getDraft / updateDraft / validateDraft / diffDraft
//     .approveDraft / activateApprovedVersion
//     .getActiveVersion / listVersions / supersedeVersion / restoreFromVersion
//
// ── THE FOUR RULES ──────────────────────────────────────────────────
//
// 1. DRAFT IS NOT ACTIVE. Editing configuration never changes what the
//    assistant says. Something must be approved by a person and then activated.
//
// 2. APPROVED IS IMMUTABLE. Once a human has said yes to a specific set of
//    words, those words cannot change underneath the approval. Every "edit" of
//    an approved version is a NEW version that must be approved again. This is
//    the same reason the acquisition side treats founder acceptance as a record
//    rather than a setting.
//
// 3. STALE WRITES ARE REFUSED, NOT MERGED. Two people editing from version 12
//    is normal. The second save silently overwriting the first is how a
//    business loses a change nobody notices for a month. The second save gets a
//    conflict naming both versions.
//
// 4. CONFIGURATION IS NOT PERMISSION. Activating a blueprint does not enable
//    calling, unpause anything, provision anything or authorise a dial. A
//    ratchet asserts this module imports nothing that could.
//
// ── STORE CONTRACT ──────────────────────────────────────────────────
// Injected, so the domain has no opinion about Supabase. An in-memory
// implementation lives beside this for tests and the CLI; nothing here writes
// to a database by itself.
//
//   listVersions(clientId)                -> version[]
//   getVersion(clientId, configVersion)   -> version | null
//   putVersion(version)                   -> version
//   replaceVersion(version)               -> version   (metadata transitions only)

const { validateBlueprint, BLUEPRINT_SCHEMA_VERSION } = require("./client-blueprint");
const { diffBlueprints } = require("./blueprint-diff");

const AUTHORITY_CODES = Object.freeze({
  OK: "ok",
  NOT_FOUND: "blueprint_not_found",
  NO_ACTIVE: "no_active_version",
  NOT_A_DRAFT: "not_a_draft",
  ALREADY_APPROVED: "already_approved",
  IMMUTABLE: "version_is_immutable",
  STALE: "stale_version_conflict",
  INVALID: "blueprint_invalid",
  NOT_APPROVED: "version_not_approved",
  NOT_A_PERSON: "approver_is_not_a_person",
  CROSS_TENANT: "cross_tenant_reference_refused",
});

/** The same rejection the acquisition approvals use. A system cannot approve itself. */
const NON_HUMAN_APPROVERS = /^(system|automation|automated|auto|aida|bot|robot|ai|agent|assistant|claude|gpt|llm|service|cron|scheduler|worker|daemon)$/i;

const IMMUTABLE_STATUSES = Object.freeze(["approved", "active", "superseded"]);

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
const okay = (value) => Object.freeze({ ok: true, code: AUTHORITY_CODES.OK, ...value });

/** Deep freeze, so an approved version cannot be edited through a held reference. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.getOwnPropertyNames(value).forEach((k) => deepFreeze(value[k]));
  return Object.freeze(value);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * An in-memory store. Deliberately the default: this batch designs the domain
 * before inventing SQL, and nothing here should be able to touch a database by
 * accident.
 */
function createInMemoryBlueprintStore() {
  const byClient = new Map();
  const list = (clientId) => byClient.get(clientId) || [];
  return {
    kind: "memory",
    async listVersions(clientId) {
      return list(clientId).map(clone);
    },
    async getVersion(clientId, configVersion) {
      const hit = list(clientId).find((v) => v.metadata.configVersion === configVersion);
      return hit ? clone(hit) : null;
    },
    async putVersion(version) {
      const arr = list(version.identity.clientId);
      arr.push(clone(version));
      byClient.set(version.identity.clientId, arr);
      return clone(version);
    },
    async replaceVersion(version) {
      const arr = list(version.identity.clientId);
      const i = arr.findIndex((v) => v.metadata.configVersion === version.metadata.configVersion);
      if (i === -1) throw new Error("replaceVersion: no such version");
      arr[i] = clone(version);
      byClient.set(version.identity.clientId, arr);
      return clone(version);
    },
  };
}

function createBlueprintAuthority({ store, now } = {}) {
  if (!store) throw new Error("createBlueprintAuthority requires a store");
  if (typeof now !== "function") throw new Error("createBlueprintAuthority requires an injected now()");

  const stamp = () => now().toISOString();

  /**
   * Every read is scoped by clientId, and a version whose body disagrees with
   * the clientId it was fetched under is refused rather than returned. That
   * combination is what makes cross-tenant leakage a refusal instead of a bug.
   */
  async function load(clientId, configVersion) {
    const v = await store.getVersion(clientId, configVersion);
    if (!v) return null;
    if (v.identity.clientId !== clientId) return { crossTenant: true, version: v };
    return { crossTenant: false, version: v };
  }

  async function nextVersionNumber(clientId) {
    const all = await store.listVersions(clientId);
    return all.reduce((m, v) => Math.max(m, v.metadata.configVersion || 0), 0) + 1;
  }

  async function createDraft({ clientId, blueprint, createdBy, source = "ui", supersedes = null }) {
    if (!clientId) return fail(AUTHORITY_CODES.NOT_FOUND, "clientId is required");
    if (!blueprint) return fail(AUTHORITY_CODES.INVALID, "a blueprint body is required");
    if (blueprint.identity && blueprint.identity.clientId && blueprint.identity.clientId !== clientId) {
      return fail(AUTHORITY_CODES.CROSS_TENANT, `blueprint belongs to "${blueprint.identity.clientId}", not "${clientId}"`);
    }

    const version = clone(blueprint);
    version.schemaVersion = BLUEPRINT_SCHEMA_VERSION;
    version.identity = { ...version.identity, clientId };
    version.metadata = {
      ...(version.metadata || {}),
      configVersion: await nextVersionNumber(clientId),
      status: "draft",
      createdAt: stamp(),
      createdBy: createdBy || null,
      source,
      supersedes,
      // A new draft has never been edited. Stated as null rather than left
      // absent, so "never edited" is a value an editor can hold and present
      // back as an expectation — see updateDraft.
      updatedAt: null,
      updatedBy: null,
      approvedAt: null,
      approvedBy: null,
      activatedAt: null,
    };
    const saved = await store.putVersion(version);
    return okay({ version: saved });
  }

  async function getDraft(clientId, configVersion) {
    const found = await load(clientId, configVersion);
    if (!found) return fail(AUTHORITY_CODES.NOT_FOUND, `no version ${configVersion} for ${clientId}`);
    if (found.crossTenant) return fail(AUTHORITY_CODES.CROSS_TENANT, "version belongs to another client");
    return okay({ version: found.version });
  }

  /**
   * Optimistic concurrency. `expectedUpdatedAt` is the stamp the editor had on
   * screen; if the stored draft has moved on, the write is refused with both
   * stamps so the caller can show a real conflict rather than a silent
   * overwrite.
   *
   * OMITTED and null mean different things, and conflating them was a live bug:
   * a brand-new draft legitimately has updatedAt === null, so an editor working
   * from one could not express any expectation at all and their stale write was
   * accepted. Omit the argument to skip the check; pass null to assert "this
   * draft had never been edited when I read it".
   */
  async function updateDraft({ clientId, configVersion, expectedUpdatedAt, mutate, updatedBy = null }) {
    const found = await load(clientId, configVersion);
    if (!found) return fail(AUTHORITY_CODES.NOT_FOUND, `no version ${configVersion} for ${clientId}`);
    if (found.crossTenant) return fail(AUTHORITY_CODES.CROSS_TENANT, "version belongs to another client");

    const current = found.version;
    if (IMMUTABLE_STATUSES.includes(current.metadata.status)) {
      return fail(
        AUTHORITY_CODES.IMMUTABLE,
        `version ${configVersion} is ${current.metadata.status} and cannot be edited — create a new draft from it instead`,
      );
    }
    if (expectedUpdatedAt !== undefined && (current.metadata.updatedAt ?? null) !== expectedUpdatedAt) {
      return fail(AUTHORITY_CODES.STALE, "this draft changed since it was read", {
        expectedUpdatedAt,
        actualUpdatedAt: current.metadata.updatedAt ?? null,
      });
    }

    const next = clone(current);
    if (typeof mutate === "function") mutate(next);
    // The body may not reassign itself to another tenant.
    if (next.identity.clientId !== clientId) {
      return fail(AUTHORITY_CODES.CROSS_TENANT, "a draft may not change its clientId");
    }
    next.metadata = { ...next.metadata, status: "draft", updatedAt: stamp(), updatedBy };
    const saved = await store.replaceVersion(next);
    return okay({ version: saved });
  }

  async function validateDraft(clientId, configVersion) {
    const got = await getDraft(clientId, configVersion);
    if (!got.ok) return got;
    const result = validateBlueprint(got.version);
    if (!result.ok) return fail(AUTHORITY_CODES.INVALID, "blueprint is not valid", { errors: result.errors, warnings: result.warnings });

    // Validation is a state transition, not just a report: it records that this
    // exact body passed, so approval cannot be granted to something unchecked.
    const next = clone(got.version);
    next.metadata = { ...next.metadata, status: "validated", validatedAt: stamp() };
    const saved = await store.replaceVersion(next);
    return okay({ version: saved, warnings: result.warnings });
  }

  async function diffDraft({ clientId, fromVersion = null, toVersion }) {
    const to = await getDraft(clientId, toVersion);
    if (!to.ok) return to;
    let fromBody = null;
    if (fromVersion !== null) {
      const from = await getDraft(clientId, fromVersion);
      if (!from.ok) return from;
      fromBody = from.version;
    } else {
      const active = await getActiveVersion(clientId);
      fromBody = active.ok ? active.version : null;
    }
    return okay({ diff: diffBlueprints(fromBody, to.version) });
  }

  /**
   * Approval is the moment a person takes responsibility for the words. It
   * requires a validated body and a named human, and it freezes the content.
   */
  async function approveDraft({ clientId, configVersion, approvedBy, reason = null }) {
    const got = await getDraft(clientId, configVersion);
    if (!got.ok) return got;
    const v = got.version;

    if (IMMUTABLE_STATUSES.includes(v.metadata.status)) {
      return fail(AUTHORITY_CODES.ALREADY_APPROVED, `version ${configVersion} is already ${v.metadata.status}`);
    }
    if (v.metadata.status !== "validated") {
      return fail(AUTHORITY_CODES.NOT_A_DRAFT, "only a validated draft may be approved — run validate first");
    }
    const who = typeof approvedBy === "string" ? approvedBy.trim() : "";
    if (!who) return fail(AUTHORITY_CODES.NOT_A_PERSON, "approval requires a named person");
    if (NON_HUMAN_APPROVERS.test(who)) {
      return fail(AUTHORITY_CODES.NOT_A_PERSON, `"${who}" is not a person — configuration cannot approve itself`);
    }
    // Re-validate at the moment of approval: the body may have been edited
    // after it was validated, and approving on a stale verdict is the whole
    // failure this guards.
    const recheck = validateBlueprint(v);
    if (!recheck.ok) return fail(AUTHORITY_CODES.INVALID, "blueprint is no longer valid", { errors: recheck.errors });

    const next = clone(v);
    next.metadata = { ...next.metadata, status: "approved", approvedAt: stamp(), approvedBy: who, approvalReason: reason };
    const saved = await store.replaceVersion(next);
    return okay({ version: deepFreeze(saved) });
  }

  /**
   * Activation is separate from approval on purpose: approving copy and putting
   * it live are different decisions, and a business may want the second at a
   * particular moment.
   */
  async function activateApprovedVersion({ clientId, configVersion, activatedBy = null }) {
    const got = await getDraft(clientId, configVersion);
    if (!got.ok) return got;
    const v = got.version;
    if (v.metadata.status === "active") return okay({ version: v, alreadyActive: true });
    if (v.metadata.status !== "approved") {
      return fail(AUTHORITY_CODES.NOT_APPROVED, `version ${configVersion} is ${v.metadata.status} — only an approved version may be activated`);
    }

    // Supersede the incumbent first, so there is never a moment with two.
    const all = await store.listVersions(clientId);
    for (const other of all) {
      if (other.metadata.status === "active" && other.metadata.configVersion !== configVersion) {
        const sup = clone(other);
        sup.metadata = { ...sup.metadata, status: "superseded", supersededAt: stamp(), supersededBy: configVersion };
        await store.replaceVersion(sup);
      }
    }
    const next = clone(v);
    next.metadata = { ...next.metadata, status: "active", activatedAt: stamp(), activatedBy };
    const saved = await store.replaceVersion(next);
    return okay({ version: deepFreeze(saved) });
  }

  async function getActiveVersion(clientId) {
    const all = await store.listVersions(clientId);
    const active = all.filter((v) => v.metadata.status === "active" && v.identity.clientId === clientId);
    if (active.length === 0) return fail(AUTHORITY_CODES.NO_ACTIVE, `no active configuration for ${clientId}`);
    if (active.length > 1) {
      // Should be impossible; refuse rather than pick one.
      return fail(AUTHORITY_CODES.NO_ACTIVE, `${active.length} active versions for ${clientId} — refusing to choose`);
    }
    return okay({ version: deepFreeze(active[0]) });
  }

  async function listVersions(clientId) {
    const all = await store.listVersions(clientId);
    return okay({
      versions: all
        .filter((v) => v.identity.clientId === clientId)
        .map((v) => ({
          configVersion: v.metadata.configVersion,
          status: v.metadata.status,
          createdAt: v.metadata.createdAt,
          createdBy: v.metadata.createdBy,
          approvedAt: v.metadata.approvedAt,
          approvedBy: v.metadata.approvedBy,
          activatedAt: v.metadata.activatedAt,
          supersedes: v.metadata.supersedes,
          source: v.metadata.source,
        }))
        .sort((a, b) => a.configVersion - b.configVersion),
    });
  }

  async function supersedeVersion({ clientId, configVersion, reason = null }) {
    const got = await getDraft(clientId, configVersion);
    if (!got.ok) return got;
    const next = clone(got.version);
    next.metadata = { ...next.metadata, status: "superseded", supersededAt: stamp(), supersedeReason: reason };
    const saved = await store.replaceVersion(next);
    return okay({ version: saved });
  }

  /**
   * Restore never resurrects. It copies an old body into a NEW draft, which has
   * to be validated and approved like anything else — because "put back what we
   * had in March" is a proposal, not a fact, and the person approving it should
   * see it as a change.
   */
  async function restoreFromVersion({ clientId, configVersion, createdBy, source = "ui" }) {
    const got = await getDraft(clientId, configVersion);
    if (!got.ok) return got;
    const body = clone(got.version);
    return createDraft({
      clientId,
      blueprint: body,
      createdBy,
      source,
      supersedes: configVersion,
    });
  }

  return Object.freeze({
    createDraft,
    getDraft,
    updateDraft,
    validateDraft,
    diffDraft,
    approveDraft,
    activateApprovedVersion,
    getActiveVersion,
    listVersions,
    supersedeVersion,
    restoreFromVersion,
  });
}

module.exports = {
  createBlueprintAuthority,
  createInMemoryBlueprintStore,
  AUTHORITY_CODES,
  NON_HUMAN_APPROVERS,
  IMMUTABLE_STATUSES,
};
