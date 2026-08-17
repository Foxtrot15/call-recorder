/* AIDA PLATFORM UI — progressive enhancement.
 *
 * The pages work as HTML: every form has a real method and action, every
 * navigation is a real link. This file makes saving feel immediate and puts
 * server validation errors beside the fields they belong to.
 *
 * ── WHAT IT MAY NOT DO ─────────────────────────────────────────────
 *   * It never decides anything. Whether Approve is offered, whether a state
 *     is dangerous, what a field is called — all decided server-side, in
 *     modules a test can run. This file draws and posts.
 *   * It never retries a request the server refused. A 409 is shown, not
 *     resolved; there is no "save anyway" and no force parameter.
 *   * It contacts nothing but this origin. No SDK, no CDN, no analytics, no
 *     provider. A ratchet reads this file and asserts every fetch target is a
 *     same-origin path.
 *
 * ── CSP ────────────────────────────────────────────────────────────
 * These pages are served with `script-src 'self'`, so there is no inline
 * script and no onclick anywhere. Everything is delegated from `main` on
 * `data-action`, and server state arrives on `data-*` attributes.
 *
 * ES5, IIFE, strict mode — matching public/locksmith/*.js, which is the
 * established convention for enhancement scripts in this repo.
 */
(function () {
  "use strict";

  var main = document.getElementById("main");
  if (!main) return;

  var statusEl = document.getElementById("form-status");
  var summaryEl = document.getElementById("error-summary");
  var summaryList = document.getElementById("error-summary-list");

  var clientId = main.getAttribute("data-client");
  var screen = main.getAttribute("data-screen");
  var section = main.getAttribute("data-section");
  var version = main.getAttribute("data-version");
  // The compare-and-swap token. Round-tripped verbatim; never invented.
  var expectedUpdatedAt = main.getAttribute("data-expected-updated-at") || null;

  var base = "/platform/clients/" + encodeURIComponent(clientId || "");

  // ── status and errors ────────────────────────────────────────────

  function setStatus(state, message) {
    if (!statusEl) return;
    statusEl.setAttribute("data-state", state);
    statusEl.textContent = message || "";
  }

  function clearErrors() {
    var slots = main.querySelectorAll(".field__error");
    for (var i = 0; i < slots.length; i += 1) slots[i].textContent = "";
    var invalid = main.querySelectorAll(".field--invalid");
    for (var j = 0; j < invalid.length; j += 1) invalid[j].classList.remove("field--invalid");
    var flagged = main.querySelectorAll('[aria-invalid="true"]');
    for (var k = 0; k < flagged.length; k += 1) flagged[k].removeAttribute("aria-invalid");
    if (summaryEl) { summaryEl.hidden = true; }
    if (summaryList) { summaryList.innerHTML = ""; }
  }

  /**
   * Put each server error beside its field and list it in the summary. The
   * summary entries are links that move focus to the control, which is the
   * part that makes a long form usable with a keyboard.
   */
  function showErrors(errors) {
    clearErrors();
    if (!errors || !errors.length) return;

    for (var i = 0; i < errors.length; i += 1) {
      var e = errors[i];
      var path = e.path || e.field || "";
      var slot = main.querySelector('[data-error-for="' + cssEscape(path) + '"]');
      var leaf = path.split(".").pop().split("[")[0];
      if (!slot) slot = main.querySelector('[data-error-for="' + cssEscape(leaf) + '"]');

      var target = null;
      if (slot) {
        slot.textContent = e.message || "This value was refused.";
        var wrapper = slot.closest ? slot.closest(".field") : null;
        if (wrapper) {
          wrapper.classList.add("field--invalid");
          target = wrapper.querySelector("input, select, textarea");
          if (target) target.setAttribute("aria-invalid", "true");
        }
      }

      if (summaryList) {
        var li = document.createElement("li");
        if (target && target.id) {
          var a = document.createElement("a");
          a.href = "#" + target.id;
          a.textContent = (e.path || "") + " — " + (e.message || "");
          li.appendChild(a);
        } else {
          li.textContent = (e.path || "") + " — " + (e.message || "");
        }
        summaryList.appendChild(li);
      }
    }

    if (summaryEl) {
      summaryEl.hidden = false;
      summaryEl.focus();
    }
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // ── requests: same origin, no retry, no force ────────────────────

  function send(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // Same-origin only. These endpoints are session-authenticated and must
      // never be reachable with credentials from another site.
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, body: data || {} };
      });
    });
  }

  function describeFailure(result) {
    var body = result.body || {};
    if (body.errors && body.errors.length) return body.errors.length + " problem(s) — see below.";
    return body.error || body.message || "That didn't work. Reload the page and try again.";
  }

  // ── reading the form ─────────────────────────────────────────────

  function readForm(form) {
    var values = {};
    var els = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      if (!el.name) continue;

      if (el.type === "checkbox") {
        if (!values[el.name]) values[el.name] = [];
        if (el.checked) values[el.name].push(el.value);
        continue;
      }
      if (el.type === "radio") {
        if (!el.checked) continue;
        if (el.value === "yes") values[el.name] = true;
        else if (el.value === "no") values[el.name] = false;
        else if (el.value === "closed") values[el.name] = true;
        else if (el.value === "open") values[el.name] = false;
        else values[el.name] = el.value;
        continue;
      }
      if (el.getAttribute("data-list") === "true") {
        values[el.name] = el.value.split("\n").map(trim).filter(nonEmpty);
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

  function trim(s) { return String(s).trim(); }
  function nonEmpty(s) { return s.length > 0; }

  // ── save ─────────────────────────────────────────────────────────

  function save(form) {
    var btn = form.querySelector('[data-action="save"]');
    if (btn) { btn.disabled = true; }
    setStatus("submitting", "Saving…");
    clearErrors();

    var payload = {
      section: form.getAttribute("data-section") || section,
      values: readForm(form),
    };
    // Only send the token when we actually have one. Sending null would ask
    // the server to skip the check, which is the opposite of the point.
    if (expectedUpdatedAt) payload.expectedUpdatedAt = expectedUpdatedAt;

    return send("PATCH", base + "/drafts/" + encodeURIComponent(version || ""), payload)
      .then(function (result) {
        if (btn) btn.disabled = false;

        if (result.status === 409) {
          // A conflict is NOT resolved here. Show it and stop.
          setStatus("error", "This draft changed after you opened it.");
          showConflict(result.body);
          return;
        }
        if (result.status >= 400) {
          setStatus("error", describeFailure(result));
          showErrors(result.body.errors);
          return;
        }

        // The token moves forward only on a successful save.
        if (result.body.updatedAt) {
          expectedUpdatedAt = result.body.updatedAt;
          main.setAttribute("data-expected-updated-at", expectedUpdatedAt);
        }
        if (result.body.configVersion) {
          version = String(result.body.configVersion);
          main.setAttribute("data-version", version);
        }
        setStatus("success", "Saved. This is still a draft — nothing is live until it is approved and activated.");
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        setStatus("error", "Network error — nothing was saved. Try again.");
      });
  }

  /** Render the conflict block if the server sent one and the page has none. */
  function showConflict(body) {
    var existing = document.getElementById("conflict");
    if (existing) { existing.hidden = false; existing.focus(); return; }

    var box = document.createElement("div");
    box.className = "conflict";
    box.id = "conflict";
    box.setAttribute("role", "alert");
    box.setAttribute("tabindex", "-1");

    var h = document.createElement("h2");
    h.className = "conflict__title";
    h.textContent = "This draft changed after you opened it";
    box.appendChild(h);

    var p = document.createElement("p");
    p.textContent = (body && body.error) || "Somebody else saved a change while you were editing.";
    box.appendChild(p);

    var note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Your changes are still on this page and have not been sent. Reload to see the latest version — there is no way to overwrite somebody else's edit without reading it first.";
    box.appendChild(note);

    var actions = document.createElement("div");
    actions.className = "actions";
    var reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn btn--primary";
    reload.setAttribute("data-action", "reload-latest");
    reload.textContent = "Reload the latest version";
    actions.appendChild(reload);
    box.appendChild(actions);

    main.insertBefore(box, main.firstChild);
    box.focus();
  }

  // ── repeatable items ─────────────────────────────────────────────

  // Kept in step with src/platform/ui/ui-repeatable.js, which is where these
  // rules are defined and tested. A ratchet reads both files and fails if they
  // drift, because a browser that indexes rows differently from the server
  // that parses them is a data-loss bug wearing a working UI.
  var INDEXED_ATTRIBUTES = ["name", "id", "for", "aria-describedby", "data-error-for", "data-index"];
  var ID_PREFIX = "f-";

  function escapeForId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, "-"); }
  function escapeForRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /** Every index token in one attribute value, rewritten. */
  function reindexToken(value, path, index) {
    if (value === null || value === undefined) return value;
    var text = String(value);
    if (/^\d+$/.test(text)) return String(index);
    var p = escapeForRegExp(path);
    var idPath = escapeForRegExp(escapeForId(path));
    return text
      .replace(new RegExp(p + "\\[\\d+\\]", "g"), path + "[" + index + "]")
      .replace(new RegExp("(" + ID_PREFIX + idPath + "-)\\d+(-)", "g"), "$1" + index + "$2");
  }

  /**
   * The list a control belongs to, resolved from the control itself.
   *
   * Previously every operation called main.querySelector(".items") and got
   * whichever list happened to come first in the document — so on the
   * Knowledge screen, which renders two lists, "Add reference" added an
   * approved fact. The button already carried data-repeatable; it was passed
   * to addItem and then discarded with `void path`.
   */
  function listFor(el) {
    var wrap = el.closest ? el.closest(".repeatable") : null;
    if (!wrap) return null;
    var list = wrap.querySelector(".items");
    if (!list || list.getAttribute("data-repeatable") !== wrap.getAttribute("data-repeatable")) return null;
    return list;
  }

  /** Direct children only — a nested list's rows are not this list's rows. */
  function rowsOf(list) {
    var out = [];
    var kids = list.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].className && String(kids[i].className).split(" ").indexOf("item") !== -1) out.push(kids[i]);
    }
    return out;
  }

  /**
   * Stamp position onto a row: name, id, for, aria-describedby, data-error-for
   * and data-index, on the row and on everything inside it.
   *
   * The old version rewrote `name` only, and only its first [n] occurrence. So
   * a moved row kept another row's element ids, its label's `for`, its
   * aria-describedby and its error slot — which is how a row could be moved
   * and a server error then appear beside a different service.
   */
  function stampIndex(row, path, index) {
    var nodes = [row];
    var inner = row.querySelectorAll("*");
    for (var n = 0; n < inner.length; n += 1) nodes.push(inner[n]);

    for (var i = 0; i < nodes.length; i += 1) {
      for (var a = 0; a < INDEXED_ATTRIBUTES.length; a += 1) {
        var attr = INDEXED_ATTRIBUTES[a];
        if (!nodes[i].hasAttribute(attr)) continue;
        nodes[i].setAttribute(attr, reindexToken(nodes[i].getAttribute(attr), path, index));
      }
    }
  }

  /**
   * Run a mutation that renames controls, without any radio losing its answer.
   *
   * Renaming a checked radio unchecks every other radio in the group it joins.
   * That is HTML working as specified, not a browser quirk — and it bites here
   * twice, because names carry the row index:
   *
   *   - reordering restamps rows in order, so two rows briefly share a name
   *     and the one waiting its turn is silently unchecked;
   *   - a new row arrives from the template still named index 0, so appending
   *     it unchecks row 0 before it is stamped.
   *
   * The victim is never the row being stamped, so this cannot be done per row.
   * It is also never re-checked afterwards, and an unchecked radio group is
   * not submitted AT ALL — so the value reaches the server as absent, and
   * three services on DEV came back with `enabled` missing after a reorder
   * nobody thought was risky.
   *
   * Checkedness is therefore captured across the WHOLE list before the
   * mutation and restored after it. What a person answered is not something a
   * reindex is allowed to have an opinion about.
   */
  function preservingAnswers(list, mutate) {
    var boxes = list.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    var was = [];
    var i;
    for (i = 0; i < boxes.length; i += 1) was.push([boxes[i], boxes[i].checked]);

    mutate();

    for (i = 0; i < was.length; i += 1) {
      if (was[i][0].checked !== was[i][1]) was[i][0].checked = was[i][1];
    }
  }

  function reindex(list, path) {
    preservingAnswers(list, function () {
      var rows = rowsOf(list);
      for (var i = 0; i < rows.length; i += 1) stampIndex(rows[i], path, i);
    });
  }

  /** Reorder the DOM to match a plan's `order`, then restamp every position. */
  function applyOrder(list, path, order) {
    var rows = rowsOf(list);
    var next = [];
    for (var i = 0; i < order.length; i += 1) next.push(order[i] === null ? null : rows[order[i]]);
    for (var j = 0; j < next.length; j += 1) if (next[j]) list.appendChild(next[j]);
    reindex(list, path);
  }

  function moveItem(el, index, delta) {
    var list = listFor(el);
    if (!list) return;
    var path = list.getAttribute("data-repeatable");
    var rows = rowsOf(list);
    var target = index + delta;
    // A refusal, not a clamp: Move up on the first row does nothing at all.
    if (target < 0 || target >= rows.length || !rows[index]) return;

    var order = [];
    for (var i = 0; i < rows.length; i += 1) order.push(i);
    order[index] = target;
    order[target] = index;
    applyOrder(list, path, order);
    focusRow(list, target);
    setStatus("idle", "Order changed. Save to keep it.");
  }

  function removeItem(el, index) {
    var list = listFor(el);
    if (!list) return;
    var path = list.getAttribute("data-repeatable");
    var rows = rowsOf(list);
    if (!rows[index]) return;
    rows[index].parentNode.removeChild(rows[index]);
    reindex(list, path);
    var left = rowsOf(list);
    if (left.length) focusRow(list, Math.min(index, left.length - 1));
    setStatus("idle", "Removed. Save to keep the change.");
  }

  /**
   * Add a row built from the server's blank template — never from a live row.
   *
   * The template is rendered by the same server function that renders a real
   * row, from the schema's blank item, so "what does a new one look like?" has
   * exactly one answer and it is not "whatever is currently on screen".
   */
  function addItem(el) {
    var wrap = el.closest ? el.closest(".repeatable") : null;
    var list = listFor(el);
    if (!wrap || !list) return;
    var path = list.getAttribute("data-repeatable");

    var template = wrap.querySelector(".item-template");
    if (!template || !template.content) {
      // No silent fallback to cloning a row. That fallback WAS the bug.
      setStatus("error", "This page cannot add a row — reload it.");
      return;
    }

    var row = template.content.firstElementChild.cloneNode(true);
    var empty = list.querySelector(".items__empty");
    if (empty) empty.parentNode.removeChild(empty);

    // The template's controls are still named index 0. Appending them would
    // unseat row 0's radios, so the insert and the restamp happen together
    // under one preservation.
    preservingAnswers(list, function () {
      list.appendChild(row);
      stampIndex(row, path, rowsOf(list).length - 1);
    });

    var first = row.querySelector("input, select, textarea");
    if (first) first.focus();
    setStatus("idle", "Added. Fill it in and save.");
  }

  function focusRow(list, index) {
    var rows = rowsOf(list);
    if (!rows[index]) return;
    var btn = rows[index].querySelector('[data-action="move-up"], [data-action="remove-item"]');
    if (btn && btn.focus) btn.focus();
  }

  // ── delegation ───────────────────────────────────────────────────

  main.addEventListener("click", function (event) {
    var el = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!el) return;
    var act = el.getAttribute("data-action");
    var index = Number(el.getAttribute("data-index"));

    if (act === "reload-latest") { event.preventDefault(); window.location.reload(); return; }
    if (act === "show-my-changes") { event.preventDefault(); revealMyChanges(); return; }
    // Every one of these resolves its list from the clicked control, so a
    // screen with two lists cannot act on the wrong one.
    if (act === "move-up") { event.preventDefault(); moveItem(el, index, -1); return; }
    if (act === "move-down") { event.preventDefault(); moveItem(el, index, 1); return; }
    if (act === "remove-item") { event.preventDefault(); removeItem(el, index); return; }
    if (act === "add-item") { event.preventDefault(); addItem(el); return; }
  });

  main.addEventListener("submit", function (event) {
    var form = event.target;

    if (form.id === "section-form") {
      event.preventDefault();
      save(form);
      return;
    }

    // Approvals and activations post normally — they are deliberate, one-shot,
    // and a full page response is the honest way to show what happened. The
    // only enhancement is a confirmation, and only where the page asked for one.
    var confirmText = form.getAttribute("data-confirm");
    if (confirmText && !window.confirm(confirmText)) {
      event.preventDefault();
    }
  });

  /** Show what is currently in the form, so a conflict can be compared by eye. */
  function revealMyChanges() {
    var target = document.getElementById("conflict-mine");
    var form = document.getElementById("section-form");
    if (!target || !form) return;
    target.hidden = false;
    target.textContent = "";

    var values = readForm(form);
    var dl = document.createElement("dl");
    dl.className = "facts";
    Object.keys(values).sort().forEach(function (k) {
      var row = document.createElement("div");
      row.className = "facts__row";
      var dt = document.createElement("dt");
      dt.textContent = k;
      var dd = document.createElement("dd");
      // textContent, never innerHTML: this is unvalidated input from a form.
      dd.textContent = Array.isArray(values[k]) ? values[k].join(", ") : String(values[k]);
      row.appendChild(dt);
      row.appendChild(dd);
      dl.appendChild(row);
    });
    target.appendChild(dl);
  }

  void screen;
})();
