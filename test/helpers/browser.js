// A real DOM, running the real client script against the real rendered page.
//
// P36 produced three browser bugs in a row. Two of them were invisible to
// tests that built the submitted values by hand, and the third could not be
// reproduced at all without somewhere to click. So this boots jsdom, loads the
// page src/views/platform-config-pages.js actually renders, and executes
// public/platform/platform.js inside it — unmodified, the same file the
// browser is served.
//
// jsdom is a devDependency and is used ONLY by the browser regression suite.
// Nothing in src/ knows it exists.
//
// ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────
// It is a real DOM: real elements, real attributes, real event dispatch, real
// radio-group semantics, real <template> inertness, real focus. It is not a
// real browser: no layout, no rendering, no autofill, no password manager, and
// its focus model is simpler than Chrome's. So a green test here means the
// scripted interaction is right, not that a person's browser will agree —
// which is why the founder still walks the screen.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "..", "public", "platform", "platform.js"), "utf8");

/**
 * Boot a page. Returns handles plus `posted`, which collects every request the
 * script makes — nothing leaves the process, and a test that expects a save
 * must assert on what was sent.
 */
function open(html, { onFetch } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/platform/clients/c/edit/services" });
  const { window } = dom;
  const posted = [];

  // The only network the script has. Same-origin paths only; a test asserts it.
  window.fetch = (url, init = {}) => {
    const entry = {
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    posted.push(entry);
    const reply = (onFetch && onFetch(entry)) || { status: 200, body: { ok: true } };
    return Promise.resolve({
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    });
  };

  // Element.prototype.closest exists in jsdom; matches() too. Run the script
  // exactly as a <script src> would, in the window's own context.
  window.eval(SCRIPT);

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  const click = (el) => {
    if (!el) throw new Error("click: no element");
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };

  /** Type into a control the way a person does: focus it, then set its value. */
  const type = (el, text) => {
    if (!el) throw new Error("type: no element");
    el.focus();
    const target = window.document.activeElement && window.document.activeElement !== window.document.body
      ? window.document.activeElement
      : el;
    target.value = text;
    target.dispatchEvent(new window.Event("input", { bubbles: true }));
    return target;
  };

  /**
   * Type wherever focus currently is, appending — a person who has just
   * pressed a button and starts typing without clicking anything first.
   * Returns the element that actually received the text, which is the point.
   */
  const typeAtFocus = (text) => {
    const el = window.document.activeElement;
    if (!el || el === window.document.body || !("value" in el)) return null;
    el.value = (el.value ? el.value + "\n" : "") + text;
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    return el;
  };

  /** Submit the section form through the real submit handler. */
  const submit = () => {
    const form = $("#section-form");
    if (!form) throw new Error("submit: no #section-form");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    // The handler is async; let its promise chain settle.
    return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  };

  return { dom, window, document: window.document, $, $$, click, type, typeAtFocus, submit, posted };
}

/** Every service row, in visual order, as a test wants to see it. */
function rows(document) {
  return [...document.querySelectorAll(".items > li.item")];
}

/** A named control inside a row, by the field it holds. */
function fieldIn(row, fieldName) {
  return row.querySelector(`[name$=".${fieldName}"]`);
}

module.exports = { open, rows, fieldIn };
