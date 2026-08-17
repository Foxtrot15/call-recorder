// A faithful-enough browser form submission, over the REAL rendered HTML.
//
// P36 bug #2 was caused by HTML semantics rather than by application logic: an
// unchecked radio group is not submitted at all, and a disabled control is not
// submitted either. A test that builds a values object by hand cannot catch
// that, because building it by hand is precisely the assumption that failed.
//
// So this parses the markup the server actually emits and applies the rules a
// browser applies:
//
//   * <template> content is INERT and is NOT submitted
//   * disabled controls are NOT submitted
//   * unchecked radios and checkboxes are NOT submitted
//   * readonly controls ARE submitted
//   * hidden inputs ARE submitted
//   * a control with no name is NOT submitted
//
// and then converts values exactly the way public/platform/platform.js's
// readForm() does — the "yes"/"no" mapping, data-list splitting on newlines,
// number coercion, and empty string becoming null. A ratchet in
// platform-ui-repeatable-save.test.js asserts those conversion rules still
// match the browser file, so this helper cannot quietly drift into being
// kinder than the real thing.
//
// It is not a browser and does not pretend to be one. It has no layout, no
// events and no radio-group invariant — the radio-group behaviour that caused
// the bug is asserted separately, as a ratchet over the browser source.

const TEMPLATE = /<template\b[^>]*>[\s\S]*?<\/template>/gi;
const TAG = /<(input|select|textarea)\b([^>]*)>/gi;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;

/**
 * A <template>'s contents are inert: not part of the form, never submitted.
 * That is exactly why the blank row lives in one, and why it can safely carry
 * the same control names as row 0 while it waits.
 */
const stripTemplates = (html) => String(html).replace(TEMPLATE, "");

const unescape = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function attrsOf(raw) {
  const out = {};
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(raw)) !== null) out[m[1].toLowerCase()] = m[2] === undefined ? "" : unescape(m[2]);
  return out;
}

/** Every control in the markup, with the attributes that decide submission. */
function controlsIn(html) {
  const out = [];
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const a = attrsOf(m[2]);
    let value = a.value;

    if (tag === "textarea") {
      // <textarea …>THE VALUE</textarea> — the value is the content.
      const rest = html.slice(m.index + m[0].length);
      const end = rest.indexOf("</textarea>");
      value = unescape(end === -1 ? "" : rest.slice(0, end));
    }
    if (tag === "select") {
      // The selected option, or the first if none says so — the browser rule.
      const rest = html.slice(m.index + m[0].length);
      const end = rest.indexOf("</select>");
      const body = end === -1 ? "" : rest.slice(0, end);
      const opts = [...body.matchAll(/<option\b([^>]*)>/gi)].map((o) => attrsOf(o[1]));
      const chosen = opts.find((o) => "selected" in o) || opts[0];
      value = chosen ? chosen.value : "";
    }

    out.push({
      tag,
      type: (a.type || (tag === "select" || tag === "textarea" ? tag : "text")).toLowerCase(),
      name: a.name,
      id: a.id,
      value: value === undefined ? "" : value,
      checked: "checked" in a,
      disabled: "disabled" in a,
      readonly: "readonly" in a,
      list: a["data-list"] === "true",
    });
  }
  return out;
}

/**
 * What the browser POSTs for this markup, as readForm() would build it.
 * Mirrors public/platform/platform.js readForm().
 */
function submit(html) {
  const values = {};
  for (const el of controlsIn(stripTemplates(html))) {
    if (!el.name) continue;
    if (el.disabled) continue; // a disabled control is not submitted

    if (el.type === "checkbox") {
      if (!values[el.name]) values[el.name] = [];
      if (el.checked) values[el.name].push(el.value);
      continue;
    }
    if (el.type === "radio") {
      if (!el.checked) continue; // an unchecked radio is not submitted AT ALL
      if (el.value === "yes") values[el.name] = true;
      else if (el.value === "no") values[el.name] = false;
      else if (el.value === "closed") values[el.name] = true;
      else if (el.value === "open") values[el.name] = false;
      else values[el.name] = el.value;
      continue;
    }
    if (el.list) {
      values[el.name] = el.value.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
      continue;
    }
    if (el.type === "number") {
      values[el.name] = el.value === "" ? null : Number(el.value);
      continue;
    }
    values[el.name] = el.value === "" ? null : el.value;
  }
  return values;
}

/** The markup for one row, so a test can assert what a single service renders. */
function rowsOf(html) {
  const out = [];
  const re = /<li class="item"[\s\S]*?(?=<li class="item"|<\/ul>)/g;
  let m;
  while ((m = re.exec(stripTemplates(html))) !== null) out.push(m[0]);
  return out;
}

/** The <template> a new row is stamped from. */
function templateOf(html) {
  const m = String(html).match(/<template class="item-template"[^>]*>([\s\S]*?)<\/template>/);
  return m ? m[1] : null;
}

module.exports = { submit, controlsIn, rowsOf, templateOf, stripTemplates };
