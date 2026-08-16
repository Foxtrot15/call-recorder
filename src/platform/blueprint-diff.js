// AIDA PLATFORM — what changed, in words a person can approve (P4).
//
//   diffBlueprints(before, after)   -> { changes[], summary, hasChanges }
//
// ── WHY A DOMAIN DIFF RATHER THAN A TEXT DIFF ───────────────────────
// The person approving a configuration change is a business owner, not a
// reviewer of JSON. "hours.weekly.saturday.close 13:00 -> 16:00" is something
// they can say yes or no to. A unified diff of a 200-line object is something
// they will approve without reading, which is the same as not approving it.
//
// Deterministic: keys are walked in sorted order, so the same pair of versions
// always produces the same list in the same order. That is what lets a diff be
// hashed, stored beside an approval, and compared later.

const IGNORED_PATHS = new Set([
  // Metadata moves on every save and is not a change to what the assistant says.
  "metadata.configVersion",
  "metadata.status",
  "metadata.createdAt",
  "metadata.createdBy",
  "metadata.updatedAt",
  "metadata.updatedBy",
  "metadata.validatedAt",
  "metadata.approvedAt",
  "metadata.approvedBy",
  "metadata.approvalReason",
  "metadata.activatedAt",
  "metadata.activatedBy",
  "metadata.supersedes",
  "metadata.supersededAt",
  "metadata.supersededBy",
  "metadata.supersedeReason",
  "metadata.source",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Stable, human-facing rendering of a leaf value. */
function render(v) {
  if (v === undefined) return "(unset)";
  if (v === null) return "(none)";
  if (Array.isArray(v)) return v.length === 0 ? "(empty list)" : `[${v.map(render).join(", ")}]`;
  if (isObj(v)) return JSON.stringify(v, Object.keys(v).sort());
  return String(v);
}

/**
 * Arrays of objects are matched by their natural identity where one exists, so
 * reordering a service list is not reported as replacing every service.
 */
const IDENTITY_KEYS = ["serviceId", "ruleId", "factId", "typeId", "refId", "intentId", "capability", "id"];

function identityOf(item) {
  if (!isObj(item)) return null;
  for (const k of IDENTITY_KEYS) if (typeof item[k] === "string") return `${k}:${item[k]}`;
  return null;
}

function walk(before, after, path, changes) {
  if (IGNORED_PATHS.has(path)) return;

  const bothObjects = isObj(before) && isObj(after);
  if (bothObjects) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) walk(before[k], after[k], path ? `${path}.${k}` : k, changes);
    return;
  }

  const bothArrays = Array.isArray(before) && Array.isArray(after);
  if (bothArrays) {
    const bIds = before.map(identityOf);
    const aIds = after.map(identityOf);
    const identifiable = bIds.every(Boolean) && aIds.every(Boolean);

    if (identifiable) {
      const bMap = new Map(before.map((x, i) => [bIds[i], x]));
      const aMap = new Map(after.map((x, i) => [aIds[i], x]));
      for (const id of [...new Set([...bMap.keys(), ...aMap.keys()])].sort()) {
        const label = id.split(":").slice(1).join(":");
        if (!bMap.has(id)) {
          changes.push({ path: `${path}[${label}]`, kind: "added", before: undefined, after: aMap.get(id), summary: `added ${label} to ${path}` });
        } else if (!aMap.has(id)) {
          changes.push({ path: `${path}[${label}]`, kind: "removed", before: bMap.get(id), after: undefined, summary: `removed ${label} from ${path}` });
        } else {
          walk(bMap.get(id), aMap.get(id), `${path}[${label}]`, changes);
        }
      }
      return;
    }

    // Plain lists (suburbs, postcodes, field names): report as a set change.
    const bSet = before.map(render);
    const aSet = after.map(render);
    const added = aSet.filter((x) => !bSet.includes(x));
    const removed = bSet.filter((x) => !aSet.includes(x));
    if (added.length || removed.length) {
      const bits = [];
      if (added.length) bits.push(`added ${added.join(", ")}`);
      if (removed.length) bits.push(`removed ${removed.join(", ")}`);
      changes.push({ path, kind: "list_changed", before, after, summary: `${path}: ${bits.join("; ")}` });
    }
    return;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) return;

  const kind = before === undefined ? "added" : after === undefined ? "removed" : "changed";
  changes.push({
    path,
    kind,
    before,
    after,
    summary:
      kind === "added" ? `${path} set to ${render(after)}`
      : kind === "removed" ? `${path} removed (was ${render(before)})`
      : `${path}: ${render(before)} -> ${render(after)}`,
  });
}

function diffBlueprints(before, after) {
  const changes = [];
  if (!after) return Object.freeze({ hasChanges: false, changes: Object.freeze([]), summary: "nothing to compare" });
  if (!before) {
    return Object.freeze({
      hasChanges: true,
      changes: Object.freeze([{ path: "", kind: "created", before: undefined, after: undefined, summary: "first configuration for this client" }]),
      summary: "first configuration for this client",
    });
  }
  walk(before, after, "", changes);
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze({
    hasChanges: changes.length > 0,
    changes: Object.freeze(changes),
    summary: changes.length === 0 ? "no changes" : `${changes.length} change${changes.length === 1 ? "" : "s"}`,
  });
}

module.exports = { diffBlueprints };
