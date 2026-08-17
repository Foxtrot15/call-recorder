// AIDA PLATFORM UI — the page shell and the form primitives (P29).
//
//   page({ title, nav, body, ... })   the whole document
//   renderField(field, value)         one accessible control
//   chip(chipModel)                   a status chip that survives greyscale
//   lockedNote(reason) / statement()  a platform requirement, visibly locked
//   table({ caption, columns, rows })
//
// ── THE CONTRACT THIS FILE KEEPS ────────────────────────────────────
// The same one src/views/locksmith-page.js keeps, because it is already
// test-enforced in this repo and there is no reason for a second standard:
//
//   * one <header>, one <main id="main">, one <footer>, and a skip link
//   * every control has a <label for> whose id exists
//   * multi-choice controls are <fieldset>/<legend>
//   * every control's aria-describedby names its hint AND its error slot
//   * required/optional is stated in TEXT, never an asterisk or a colour
//   * no state is communicated by colour alone — every chip carries a marker
//     and a word
//   * every data cell carries data-label so a stacked mobile table hides
//     nothing
//
// ── AND THE ONE THE CSP KEEPS ───────────────────────────────────────
// These pages are served with the repo's PAGE_SECURITY_HEADERS, whose CSP is
// `script-src 'self'; style-src 'self'`. So: no inline <script>, no inline
// <style>, no style="" and no onclick="". Behaviour is attached in
// /platform/platform.js by delegation on data-action, and server state travels
// on data-* attributes. A test asserts all four, the same way the locksmith
// page's does.

const { escapeHtml, escapeAttr } = require("./escape");

const CSS_HREF = "/platform/platform.css";
const JS_SRC = "/platform/platform.js";

/**
 * A status chip. The tone is a colour; the MARKER and the TEXT are the meaning.
 * A person reading this in greyscale, or through a screen reader, gets the
 * state — which is the whole requirement, and is not satisfied by choosing
 * accessible colours.
 */
function chip(model) {
  if (!model) return "";
  const help = model.help ? ` title="${escapeAttr(model.help)}"` : "";
  const unknown = model.known === false ? ' data-unknown="true"' : "";
  return `<span class="chip chip--${escapeAttr(model.tone || "neutral")}"${help}${unknown}>` +
    `<span class="chip__marker" aria-hidden="true">${escapeHtml(model.mark || "•")}</span>` +
    `<span class="chip__text">${escapeHtml(model.text)}</span></span>`;
}

/** PLATFORM REQUIREMENT — LOCKED. Rendered as prose, never as a disabled input. */
function lockedNote(label, reason) {
  return `<div class="locked" role="note">
  <p class="locked__label"><span class="locked__marker" aria-hidden="true">🔒</span>PLATFORM REQUIREMENT — LOCKED</p>
  <p class="locked__what">${escapeHtml(label)}</p>
  ${reason ? `<p class="locked__why">${escapeHtml(reason)}</p>` : ""}
</div>`;
}

/** A sentence the platform states and the client cannot change. No control beside it. */
function statement(label, text, reason) {
  return `<div class="statement" role="note">
  <p class="statement__label">${escapeHtml(label)}</p>
  <p class="statement__text">${escapeHtml(text)}</p>
  ${reason ? `<p class="statement__why"><span aria-hidden="true">🔒</span> ${escapeHtml(reason)}</p>` : ""}
</div>`;
}

const notice = (text, tone = "info") =>
  `<p class="notice notice--${escapeAttr(tone)}">${escapeHtml(text)}</p>`;

// ── FIELDS ──────────────────────────────────────────────────────────

const idFor = (field) => `f-${String(field.name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** The three ids every control needs, and the aria-describedby that ties them. */
function describe(field) {
  const id = idFor(field);
  const hintId = field.hint ? `${id}-hint` : null;
  const errorId = `${id}-error`;
  return {
    id,
    hintId,
    errorId,
    describedBy: ` aria-describedby="${escapeAttr([hintId, errorId].filter(Boolean).join(" "))}"`,
    hint: field.hint ? `<p class="field__hint" id="${escapeAttr(hintId)}">${escapeHtml(field.hint)}</p>` : "",
    errorSlot: `<p class="field__error" id="${escapeAttr(errorId)}" data-error-for="${escapeAttr(field.name)}"></p>`,
    // Stated as words. An asterisk is a convention people have to already know,
    // and a colour is not available to everybody.
    req: field.required
      ? ` <span class="req">(required)</span>`
      : ` <span class="opt">(optional)</span>`,
  };
}

function renderField(field, value) {
  if (field.locked) {
    if (field.type === "statement") return statement(field.label, field.statement || "", field.lockReason);
    if (field.type === "locked-list") {
      const items = (field.options || []).map((o) => `<li>${escapeHtml(o.label)}</li>`).join("");
      return `${lockedNote(field.label, field.lockReason)}<ul class="locked__list">${items}</ul>`;
    }
    return `${lockedNote(field.label, field.lockReason)}${
      value === undefined || value === null || value === "" ? "" : `<p class="locked__value">${escapeHtml(String(value))}</p>`
    }`;
  }

  const d = describe(field);
  const wrap = (inner) =>
    `<div class="field" data-field="${escapeAttr(field.name)}" data-path="${escapeAttr(field.path || "")}">${inner}${d.errorSlot}</div>`;

  if (field.type === "boolean") {
    // A yes/no a person must answer explicitly gets a real radio pair rather
    // than a checkbox, because an unticked checkbox and "no" are different
    // answers and the domain refuses the first one.
    const name = escapeAttr(field.name);
    const checked = (v) => (value === v ? " checked" : "");
    return wrap(`<fieldset class="field__group" data-boolean="true">
  <legend>${escapeHtml(field.label)}${d.req}</legend>
  ${d.hint}
  <label class="choice"><input type="radio" name="${name}" id="${escapeAttr(d.id)}-yes" value="yes"${checked(true)}${d.describedBy}> Yes</label>
  <label class="choice"><input type="radio" name="${name}" id="${escapeAttr(d.id)}-no" value="no"${checked(false)}${d.describedBy}> No</label>
</fieldset>`);
  }

  if (field.type === "select") {
    const opts = [`<option value=""${value ? "" : " selected"}>— choose —</option>`]
      .concat((field.options || []).map((o) =>
        `<option value="${escapeAttr(o.value)}"${o.value === value ? " selected" : ""}>${escapeHtml(o.label)}</option>`))
      .join("");
    return wrap(`<label for="${escapeAttr(d.id)}">${escapeHtml(field.label)}${d.req}</label>
  ${d.hint}
  <select id="${escapeAttr(d.id)}" name="${escapeAttr(field.name)}"${field.required ? " required" : ""}${d.describedBy}>${opts}</select>`);
  }

  if (field.type === "checkboxes") {
    const boxes = (field.options || []).map((o, i) => {
      const on = Array.isArray(value) && value.includes(o.value);
      return `<label class="choice"><input type="checkbox" name="${escapeAttr(field.name)}" id="${escapeAttr(d.id)}-${i}" value="${escapeAttr(o.value)}"${on ? " checked" : ""}${d.describedBy}> ${escapeHtml(o.label)}</label>`;
    }).join("");
    return wrap(`<fieldset class="field__group">
  <legend>${escapeHtml(field.label)}${d.req}</legend>
  ${d.hint}
  ${boxes}
</fieldset>`);
  }

  if (field.type === "textarea") {
    return wrap(`<label for="${escapeAttr(d.id)}">${escapeHtml(field.label)}${d.req}</label>
  ${d.hint}
  <textarea id="${escapeAttr(d.id)}" name="${escapeAttr(field.name)}" rows="3"${field.required ? " required" : ""}${d.describedBy}>${escapeHtml(value ?? "")}</textarea>`);
  }

  if (field.type === "list") {
    // One entry per line beats a comma-separated box: a suburb with a comma in
    // it is rare, and a person pasting a list from anywhere gets lines.
    const text = Array.isArray(value) ? value.join("\n") : (value ?? "");
    return wrap(`<label for="${escapeAttr(d.id)}">${escapeHtml(field.label)}${d.req}</label>
  ${d.hint || `<p class="field__hint" id="${escapeAttr(d.id)}-hint">One per line.</p>`}
  <textarea id="${escapeAttr(d.id)}" name="${escapeAttr(field.name)}" rows="4" data-list="true" aria-describedby="${escapeAttr(d.id)}-hint ${escapeAttr(d.errorId)}">${escapeHtml(text)}</textarea>`);
  }

  const type = field.type === "number" ? "number" : field.type === "tel" ? "tel" : field.type === "url" ? "url" : "text";
  // readonly, never disabled. A disabled control is NOT submitted, so using it
  // to protect a value is how the value gets erased on the next save; readonly
  // is submitted, is not editable, and is not autofilled.
  const ro = field.readonly ? ' readonly aria-readonly="true"' : "";
  const auto = field.autocomplete ? ` autocomplete="${escapeAttr(field.autocomplete)}"` : "";
  return wrap(`<label for="${escapeAttr(d.id)}">${escapeHtml(field.label)}${d.req}</label>
  ${d.hint}
  <input type="${escapeAttr(type)}" id="${escapeAttr(d.id)}" name="${escapeAttr(field.name)}" value="${escapeAttr(value ?? "")}"${ro}${auto}${field.required ? " required" : ""}${d.describedBy}>`);
}

// ── STRUCTURE ───────────────────────────────────────────────────────

/**
 * A data table that does not lose a column when it stacks on a narrow screen.
 * Every cell repeats its column name in data-label, which the stylesheet shows
 * below 760px — the same technique the locksmith call table uses.
 */
function table({ caption, columns, rows, className = "" }) {
  const head = columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join("");
  const body = rows.map((r) =>
    `<tr${r._notable ? ' class="row--notable"' : ""}>${columns.map((c) =>
      `<td data-label="${escapeAttr(c.label)}">${r[c.key] ?? ""}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table class="data-table ${escapeAttr(className)}">
  <caption>${escapeHtml(caption)}</caption>
  <thead><tr>${head}</tr></thead>
  <tbody>${body || `<tr><td colspan="${columns.length}">Nothing to show.</td></tr>`}</tbody>
</table></div>`;
}

const card = (title, inner, opts = {}) =>
  `<section class="card${opts.tone ? ` card--${escapeAttr(opts.tone)}` : ""}"${opts.id ? ` id="${escapeAttr(opts.id)}"` : ""}>
  <h2>${escapeHtml(title)}</h2>
  ${opts.blurb ? `<p class="card__blurb">${escapeHtml(opts.blurb)}</p>` : ""}
  ${inner}
</section>`;

/** Definition list — the right element for "label: value" and it reads correctly aloud. */
const facts = (pairs) =>
  `<dl class="facts">${pairs
    .filter(Boolean)
    .map(([k, v]) => `<div class="facts__row"><dt>${escapeHtml(k)}</dt><dd>${v === null || v === undefined || v === "" ? "<span class=\"muted\">not set</span>" : v}</dd></div>`)
    .join("")}</dl>`;

/**
 * A button. `action.offered === false` renders a DISABLED button with its
 * reason beside it, rather than nothing at all — a person who cannot see why
 * something is impossible assumes it is broken.
 */
function button(action, opts = {}) {
  if (!action) return "";
  const kind = opts.primary ? "btn--primary" : "btn--secondary";
  if (!action.offered) {
    return `<span class="btn-with-reason">
  <button type="button" class="btn ${kind}" disabled aria-disabled="true">${escapeHtml(action.label)}</button>
  ${action.why ? `<span class="btn__why">${escapeHtml(action.why)}</span>` : ""}
</span>`;
  }
  const attrs = Object.entries(opts.data || {})
    .map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(v)}"`).join("");
  if (opts.href) return `<a class="btn ${kind}" href="${escapeAttr(opts.href)}"${attrs}>${escapeHtml(action.label)}</a>`;
  return `<button type="${opts.submit ? "submit" : "button"}" class="btn ${kind}" data-action="${escapeAttr(action.id)}"${attrs}>${escapeHtml(action.label)}</button>`;
}

const NAV = Object.freeze([
  { key: "overview", label: "Overview" },
  { key: "edit", label: "Edit" },
  { key: "review", label: "Review changes" },
  { key: "preview", label: "Behaviour preview" },
  { key: "provisioning", label: "Provisioning" },
  { key: "history", label: "History" },
]);

function renderNav(active, basePath) {
  return `<nav class="platform-nav" aria-label="Configuration sections">
  <ul>${NAV.map((t) => {
    const on = t.key === active;
    return `<li><a class="platform-nav__link${on ? " platform-nav__link--active" : ""}" href="${escapeAttr(basePath)}/${escapeAttr(t.key)}"${on ? ' aria-current="page"' : ""}>${escapeHtml(t.label)}</a></li>`;
  }).join("")}</ul>
</nav>`;
}

/**
 * The whole document.
 *
 * `state` becomes data-* attributes on <main>, which is how the browser gets
 * the CAS token and the client id without an inline <script> the CSP forbids.
 */
function page({ title, heading, active, basePath, body, state = {}, banner = null, clientName = null }) {
  const data = Object.entries(state)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(String(v))}"`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — AIDA</title>
<link rel="stylesheet" href="${CSS_HREF}">
</head>
<body class="platform">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA</span>
    <span class="site-header__provider">${escapeHtml(clientName || "Configuration")}</span>
  </p>
</header>

${renderNav(active, basePath)}

<main id="main"${data}>
  <h1>${escapeHtml(heading)}</h1>
  ${banner || ""}
  <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>
  <div class="error-summary" id="error-summary" role="alert" tabindex="-1" hidden>
    <h2 class="error-summary__title">There's a problem with this configuration</h2>
    <ul class="error-summary__list" id="error-summary-list"></ul>
  </div>
  ${body}
</main>

<footer class="site-footer">
  <p>AIDA is an AI phone receptionist. Nothing on these screens contacts a telephony provider, places a call, or provisions anything.</p>
</footer>
<script src="${JS_SRC}" defer></script>
</body>
</html>`;
}

module.exports = {
  page, renderNav, renderField, describe, idFor,
  chip, lockedNote, statement, notice, table, card, facts, button,
  NAV, CSS_HREF, JS_SRC,
};
