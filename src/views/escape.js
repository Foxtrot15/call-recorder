// HTML escaping for server-rendered pages.
//
// The repo previously served only static HTML, so nothing needed escaping.
// views/locksmith-page.js interpolates config and demo values into markup, so
// it needs one shared, dep-free escaper rather than an ad-hoc regex per call
// site. Escapes at OUTPUT time — values are stored and validated unmodified.
//
// Both functions coerce non-strings (null/undefined/numbers) rather than
// throwing: a missing config value must render as empty text, never crash a
// public page or emit the literal "undefined" as markup.

const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

// For text nodes. Escapes quotes too, so it is also safe inside an attribute.
function escapeHtml(value) {
  return toText(value).replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
}

// For attribute values. Identical rules today (quotes and angle brackets are
// the whole attack surface for a quoted attribute); kept as a distinct name so
// call sites read as intentional and the two can diverge if ever needed.
function escapeAttr(value) {
  return escapeHtml(value);
}

module.exports = { escapeHtml, escapeAttr };
