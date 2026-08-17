// AIDA PLATFORM UI — repeatable list semantics, as arithmetic rather than DOM (P36).
//
//   blankItem(repeatable)                -> a new item, from the SCHEMA
//   itemNameFor(path, index, field)      -> "services[3].serviceId"
//   idForName(name)                      -> "f-services-3--serviceId"
//   reindexToken(value, path, index)     -> the same token, at a new index
//   parseItems(values, repeatable)       -> flat submitted map -> ordered array
//   planAdd / planRemove / planMove      -> { order, focus }
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────
// A founder clicked "Add service" on a list of five real services and did not
// get a sixth blank one. The browser code built the new row by cloning a live
// row and blanking its fields, which is wrong in a way no amount of blanking
// fixes: a row is not just its values. It is also its name attributes, its
// element ids, its <label for>, its aria-describedby, its error slot and its
// data-index — and cloning duplicated every one of those while blanking only
// the values. The clone was, in every respect the browser cares about for
// identity, a second copy of an existing service.
//
// The fix is to stop deriving a new row from an existing row. A new row comes
// from the schema, and every identifier in every row is a pure function of
// (path, index, field). That function is here, where a test can run it,
// instead of inside a click handler where nothing could.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────
// It does not touch the DOM and does not know the DOM exists. public/platform/
// platform.js applies what these functions return. So this file cannot prove
// the event wiring is right — only the semantics. The wiring is covered by
// ratchets over platform.js that assert it never clones a live row and never
// resolves a list without being told which list.
//
// It also does not validate. validateBlueprint() remains the authority; a
// blank row is allowed to be incomplete, and saving it is refused by the
// domain with a message naming the field, which is the correct place for a
// person to find out.

const ID_PREFIX = "f-";

/** Mirrors idFor() in src/views/platform-shell.js. A ratchet asserts they agree. */
const escapeForId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "-");

const idForName = (name) => `${ID_PREFIX}${escapeForId(name)}`;

const itemNameFor = (path, index, field) => `${path}[${index}].${field}`;

/** Escape a path for use inside a RegExp — paths contain "." and would match anything. */
const escapeForRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every attribute that carries an item's index, and is therefore wrong the
 * moment the item moves. Missing any one of these is its own bug:
 *
 *   name               the value is submitted under the wrong item
 *   id                 two rows share an id; querySelector finds the first
 *   for                the label focuses another row's control
 *   aria-describedby   a screen reader reads another row's hint and error
 *   data-error-for     a server error lands beside the wrong field
 *   data-index         Move up / Remove act on another row
 *
 * The list is exported so a ratchet can assert the browser code rewrites all
 * of them and not just the one somebody happened to think of.
 */
const INDEXED_ATTRIBUTES = Object.freeze([
  "name", "id", "for", "aria-describedby", "data-error-for", "data-index",
]);

/**
 * Rewrite every index token in one attribute value.
 *
 * Handles all the shapes the server emits for a repeatable at `path`:
 *
 *   services[2].serviceId              a name
 *   f-services-2--serviceId            an id, a for, a data-error-for
 *   f-services-2--serviceId-error      an error slot id
 *   f-services-2--name-hint f-services-2--name-error    an aria-describedby
 *   2                                  a bare data-index
 *
 * aria-describedby holds SEVERAL tokens, so this replaces globally rather than
 * once. The previous implementation used a single non-global replace on the
 * name only, which is why a row could move and take another row's error slot
 * with it.
 */
function reindexToken(value, path, index) {
  if (value === null || value === undefined) return value;
  const text = String(value);

  // A bare index, as on data-index.
  if (/^\d+$/.test(text)) return String(index);

  const p = escapeForRegExp(path);
  const idPath = escapeForRegExp(escapeForId(path));

  return text
    // services[7].field  ->  services[3].field
    .replace(new RegExp(`${p}\\[\\d+\\]`, "g"), `${path}[${index}]`)
    // f-services-7--field  ->  f-services-3--field
    .replace(new RegExp(`(${ID_PREFIX}${idPath}-)\\d+(-)`, "g"), `$1${index}$2`);
}

/**
 * A new item, defined by the schema rather than by whatever happened to be on
 * the screen. Every field is absent — meaning blank — except those that
 * declare a blankDefault, which exists so a required yes/no is not silently
 * left unanswered.
 *
 * Note what is NOT defaulted: urgencyCategory. Defaulting it would mean the
 * platform quietly deciding how urgent a caller's problem is, and the person
 * adding the service would never be asked. Validation refuses the save and
 * names the field, which is the right place to find out.
 */
function blankItem(repeatable) {
  const item = {};
  for (const f of (repeatable && repeatable.fields) || []) {
    if (Object.prototype.hasOwnProperty.call(f, "blankDefault")) item[f.name] = f.blankDefault;
  }
  return item;
}

/**
 * Turn the flat map a form submits back into an ordered array.
 *
 * The browser posts `{ "services[0].serviceId": "…", "services[0].name": "…" }`
 * because that is what the name attributes say. Nothing was reading it: the
 * previous applySection() walked only the section's non-repeatable fields, so
 * every add, edit, removal and reorder of a service was accepted by the UI,
 * posted to the server, and silently dropped. A save appeared to succeed and
 * changed nothing.
 *
 * Indexes are treated as ORDER, not identity — they are compacted, so a
 * payload skipping index 2 yields a contiguous list rather than a hole. The
 * visual order is the submitted order, which is the whole contract for a list
 * the assistant reads out in sequence.
 */
function parseItems(values, repeatable) {
  if (!values || !repeatable) return [];
  const path = repeatable.path;
  const known = new Set((repeatable.fields || []).map((f) => f.name));
  const prefix = `${path}[`;
  const byIndex = new Map();

  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix)) continue;
    const m = key.slice(path.length).match(/^\[(\d+)\]\.(.+)$/);
    if (!m) continue;
    const [, rawIndex, field] = m;
    // A field the schema does not declare is dropped, for the same reason
    // applySection drops locked fields: a browser posting it is not a decision
    // a person made.
    if (!known.has(field)) continue;
    const index = Number(rawIndex);
    if (!byIndex.has(index)) byIndex.set(index, {});
    byIndex.get(index)[field] = values[key];
  }

  return [...byIndex.keys()]
    .sort((a, b) => a - b)
    .map((i) => byIndex.get(i))
    .filter((item) => Object.keys(item).length > 0);
}

// ── operations, as an ordering ──────────────────────────────────────
//
// Each returns `order`: the new list expressed as source positions, where
// `null` means "a new row from the schema". The caller moves DOM nodes to
// match and then reindexes. Expressing it this way is what makes the
// semantics testable without a browser — and it is also simply correct, since
// every operation on a list is a permutation plus an insertion or a deletion.

/** Append. Never inserts next to anything, never derives from anything. */
function planAdd(count) {
  const order = [];
  for (let i = 0; i < count; i += 1) order.push(i);
  order.push(null);
  return { order: Object.freeze(order), focus: count, changed: true };
}

function planRemove(count, index) {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return { order: null, focus: null, changed: false };
  }
  const order = [];
  for (let i = 0; i < count; i += 1) if (i !== index) order.push(i);
  // Focus the row that took its place, or the new last row if it was the last.
  return { order: Object.freeze(order), focus: Math.min(index, order.length - 1), changed: true };
}

function planMove(count, index, delta) {
  const target = index + delta;
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return { order: null, focus: null, changed: false };
  }
  // A refusal, not a clamp. "Move up" on the first row must do nothing at all;
  // silently moving it somewhere else is worse than not moving it.
  if (target < 0 || target >= count) return { order: null, focus: null, changed: false };

  const order = [];
  for (let i = 0; i < count; i += 1) order.push(i);
  order[index] = target;
  order[target] = index;
  return { order: Object.freeze(order), focus: target, changed: true };
}

module.exports = {
  INDEXED_ATTRIBUTES, ID_PREFIX,
  idForName, itemNameFor, escapeForId, reindexToken,
  blankItem, parseItems,
  planAdd, planRemove, planMove,
};
