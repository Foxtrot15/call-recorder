// AIDA PLATFORM — canonical JSON, so a hash means something.
//
//   stableStringify(value)  -> JSON with recursively sorted object keys
//
// Layer 0. It is a pure serialisation rule with no opinion about blueprints,
// behaviour or providers, and both the behaviour compiler and the durable
// store legitimately need it: one hashes what the assistant will say, the
// other hashes what a person approved.
//
// It lived inside behaviour-spec.js until the durable store needed it too,
// which made a layer-1 module import a layer-2 one. The dependency ratchet
// caught it. Moving the utility down is the honest fix; making the store
// layer 3 would have been rearranging the map to match the wrong road.
//
// ── WHY KEYS ARE SORTED AND ARRAYS ARE NOT ──────────────────────────
// Object key order is an artefact of how something was built — a form, an
// editor, a JSON parser. Two objects with the same keys in a different order
// mean the same thing, and must hash the same.
//
// Array order is MEANING. A list of urgency rules in a different order is a
// different list, and the caller who wants order-insensitivity sorts the array
// itself before hashing, deliberately and visibly.

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

module.exports = { stableStringify };
