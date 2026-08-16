// AIDA PLATFORM — the contract a future voice configuration agent will use (P4).
//
//   proposeConfigPatch({ authority, clientId, patch, proposedBy, source })
//   applyPatchToBlueprint(blueprint, patch)   -> { ok, blueprint } | { ok:false }
//   PATCH_OPERATIONS / PATCH_SOURCES
//
// ── WHAT THIS IS, AND WHAT IT REFUSES TO BE ─────────────────────────
// Eventually a business owner will telephone AIDA and say "we don't do Saturday
// mornings any more" or "stop mentioning prices unless they ask". This is the
// shape that request must take.
//
// It must NEVER be:
//
//   voice request -> active configuration
//
// It is always:
//
//   voice request -> proposed patch -> new DRAFT version -> validation
//                 -> diff -> human review -> approval -> activation
//
// The reason is not process for its own sake. A speech-to-intent pipeline
// mishears things. "Don't service Brunswick" and "don't service Brunswick East"
// differ by one word and by a suburb's worth of revenue, and the person who
// finds out is a customer being told no. So the machine proposes and a person
// disposes, and there is no code path that skips the middle.
//
// No speech recognition here, and no Retell configuration agent. This is the
// domain contract such an agent will call, built first so the eventual voice
// work has something safe to aim at.

const { validateBlueprint } = require("./client-blueprint");
const { diffBlueprints } = require("./blueprint-diff");

/** Where a proposal came from. Recorded, and never used to grant trust. */
const PATCH_SOURCES = Object.freeze(["ui", "voice", "api", "import"]);

const PATCH_OPERATIONS = Object.freeze(["set", "unset", "add_to_list", "remove_from_list"]);

const PATCH_CODES = Object.freeze({
  OK: "ok",
  BAD_SOURCE: "unknown_patch_source",
  NO_OPERATIONS: "patch_has_no_operations",
  BAD_OPERATION: "unknown_patch_operation",
  BAD_PATH: "patch_path_not_permitted",
  NO_ACTIVE: "no_active_version_to_patch",
  CONFLICT: "patch_conflicts_with_current_value",
  INVALID_RESULT: "patched_blueprint_is_invalid",
  NOT_APPLIED: "patch_produced_no_change",
});

/**
 * Paths a patch may touch. An allowlist rather than a denylist, because the
 * question "could a mishearing change something dangerous?" should be answered
 * by what is reachable, not by what somebody remembered to forbid.
 *
 * Nothing under `metadata` is here: status, approval and activation are the
 * authority's business, and a patch that could set status:"active" would be
 * precisely the bypass this module exists to prevent.
 */
const PATCHABLE_PREFIXES = Object.freeze([
  "identity.legalName",
  "identity.tradingName",
  "identity.assistantName",
  "identity.description",
  "identity.website",
  "identity.businessPhone",
  "services",
  "serviceArea",
  "hours",
  "callHandling",
  "knowledge",
  "booking",
  "voice",
  "outbound",
  "integrations",
  "extensions",
]);

/** Paths no patch may ever touch, checked in addition to the allowlist. */
const FORBIDDEN_PATHS = Object.freeze([
  "identity.clientId",
  "identity.vertical",
  "schemaVersion",
  "metadata",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });

function pathAllowed(path) {
  if (typeof path !== "string" || !path.trim()) return false;
  if (FORBIDDEN_PATHS.some((f) => path === f || path.startsWith(`${f}.`))) return false;
  return PATCHABLE_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
}

function getAt(obj, path) {
  return path.split(".").reduce((acc, key) => (isObj(acc) || Array.isArray(acc) ? acc[key] : undefined), obj);
}

function setAt(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (!isObj(cur[p]) && !Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

function unsetAt(obj, path) {
  const parts = path.split(".");
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (!isObj(cur[p]) && !Array.isArray(cur[p])) return;
    cur = cur[p];
  }
  if (Array.isArray(cur)) return;
  cur[last] = null;
}

/**
 * Apply a patch to a COPY. Never mutates the input, so a caller holding an
 * active version cannot have it changed underneath them.
 */
function applyPatchToBlueprint(blueprint, patch) {
  if (!isObj(blueprint)) return fail(PATCH_CODES.INVALID_RESULT, "a blueprint is required");
  if (!isObj(patch) || !Array.isArray(patch.operations) || patch.operations.length === 0) {
    return fail(PATCH_CODES.NO_OPERATIONS, "a patch must carry at least one operation");
  }

  const next = JSON.parse(JSON.stringify(blueprint));

  for (let i = 0; i < patch.operations.length; i += 1) {
    const op = patch.operations[i];
    const where = `operations[${i}]`;
    if (!isObj(op)) return fail(PATCH_CODES.BAD_OPERATION, `${where} must be an object`);
    if (!PATCH_OPERATIONS.includes(op.op)) {
      return fail(PATCH_CODES.BAD_OPERATION, `${where}.op "${op.op}" is not one of ${PATCH_OPERATIONS.join(", ")}`);
    }
    if (!pathAllowed(op.path)) {
      return fail(PATCH_CODES.BAD_PATH, `${where}.path "${op.path}" is not a patchable path`, { path: op.path });
    }

    // Optional guard: the proposer states what it believed the current value
    // was. A mismatch means the world moved between hearing and applying, and
    // that is a conflict rather than something to overwrite.
    if (Object.prototype.hasOwnProperty.call(op, "expectedCurrent")) {
      const actual = getAt(next, op.path);
      if (JSON.stringify(actual) !== JSON.stringify(op.expectedCurrent)) {
        return fail(PATCH_CODES.CONFLICT, `${where}: "${op.path}" is not what the proposal expected`, {
          path: op.path,
          expected: op.expectedCurrent,
          actual,
        });
      }
    }

    if (op.op === "set") setAt(next, op.path, op.value);
    else if (op.op === "unset") unsetAt(next, op.path);
    else if (op.op === "add_to_list") {
      const cur = getAt(next, op.path);
      if (!Array.isArray(cur)) return fail(PATCH_CODES.BAD_PATH, `${where}: "${op.path}" is not a list`);
      if (!cur.some((x) => JSON.stringify(x) === JSON.stringify(op.value))) cur.push(op.value);
    } else if (op.op === "remove_from_list") {
      const cur = getAt(next, op.path);
      if (!Array.isArray(cur)) return fail(PATCH_CODES.BAD_PATH, `${where}: "${op.path}" is not a list`);
      const idx = cur.findIndex((x) => JSON.stringify(x) === JSON.stringify(op.value));
      if (idx !== -1) cur.splice(idx, 1);
    }
  }

  return Object.freeze({ ok: true, code: PATCH_CODES.OK, blueprint: next });
}

/**
 * The whole point: turn a proposal into a DRAFT that a human must approve.
 *
 * Returns the new draft, the validation result and the diff — everything a
 * review screen or a read-back-to-the-caller needs, and nothing that activates.
 */
async function proposeConfigPatch({ authority, clientId, patch, proposedBy = null, source = "voice" }) {
  if (!authority) throw new Error("proposeConfigPatch requires the blueprint authority");
  if (!PATCH_SOURCES.includes(source)) {
    return fail(PATCH_CODES.BAD_SOURCE, `source must be one of ${PATCH_SOURCES.join(", ")}`);
  }

  const active = await authority.getActiveVersion(clientId);
  if (!active.ok) return fail(PATCH_CODES.NO_ACTIVE, `no active configuration for ${clientId} to change`);

  const applied = applyPatchToBlueprint(active.version, patch);
  if (!applied.ok) return applied;

  const diff = diffBlueprints(active.version, applied.blueprint);
  if (!diff.hasChanges) {
    return fail(PATCH_CODES.NOT_APPLIED, "the patch would change nothing", { diff });
  }

  const validation = validateBlueprint(applied.blueprint);

  const created = await authority.createDraft({
    clientId,
    blueprint: applied.blueprint,
    createdBy: proposedBy,
    source,
    supersedes: active.version.metadata.configVersion,
  });
  if (!created.ok) return created;

  return Object.freeze({
    ok: true,
    code: PATCH_CODES.OK,
    // A DRAFT. Not active, not approved, and it says so.
    version: created.version,
    status: created.version.metadata.status,
    requiresHumanApproval: true,
    diff,
    validation: Object.freeze({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings }),
    provenance: Object.freeze({
      source,
      proposedBy,
      explanation: typeof patch.explanation === "string" ? patch.explanation : null,
      transcriptRef: typeof patch.transcriptRef === "string" ? patch.transcriptRef : null,
      basedOnVersion: active.version.metadata.configVersion,
    }),
  });
}

module.exports = {
  proposeConfigPatch,
  applyPatchToBlueprint,
  pathAllowed,
  PATCH_OPERATIONS,
  PATCH_SOURCES,
  PATCH_CODES,
  PATCHABLE_PREFIXES,
  FORBIDDEN_PATHS,
};
