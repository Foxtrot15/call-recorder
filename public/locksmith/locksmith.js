/* AIDA Locksmith Receptionist — pilot enquiry form behaviour (M1).
 *
 * Progressive enhancement over a real <form>: without this file the markup is
 * still a valid, labelled, keyboard-usable form (the page carries a <noscript>
 * fallback pointing at the footer contact details).
 *
 * Four states, all announced: idle → submitting → success | error.
 *
 * Security note: every message written here uses textContent, never innerHTML.
 * The server answers JSON and never echoes submitted values back into markup,
 * so there is no path from what a visitor types to executable markup.
 */
(function () {
  "use strict";

  var form = document.getElementById("pilot-form");
  if (!form) return;

  var statusEl = document.getElementById("form-status");
  var summaryEl = document.getElementById("error-summary");
  var summaryList = document.getElementById("error-summary-list");
  var submitBtn = document.getElementById("pilot-submit");
  var submitLabel = submitBtn ? submitBtn.textContent : "Send";
  var submitting = false;

  function setStatus(state, message) {
    if (!statusEl) return;
    statusEl.setAttribute("data-state", state);
    statusEl.textContent = message || "";
  }

  function fieldWrapper(name) {
    return form.querySelector('[data-field="' + name + '"]');
  }

  function clearErrors() {
    if (summaryEl) {
      summaryEl.hidden = true;
      if (summaryList) summaryList.textContent = "";
    }
    var slots = form.querySelectorAll("[data-error-for]");
    for (var i = 0; i < slots.length; i++) slots[i].textContent = "";
    var wrappers = form.querySelectorAll("[data-field]");
    for (var j = 0; j < wrappers.length; j++) {
      wrappers[j].classList.remove("field--invalid");
      var control = wrappers[j].querySelector("input, select, textarea");
      if (control) control.removeAttribute("aria-invalid");
    }
  }

  // Focuses the first control of a field — the target of the error-summary
  // links, so keyboard users land on the input that needs fixing.
  function focusField(name) {
    var wrapper = fieldWrapper(name);
    if (!wrapper) return;
    var control = wrapper.querySelector("input, select, textarea");
    if (control && typeof control.focus === "function") control.focus();
  }

  function showErrors(errors) {
    clearErrors();
    if (!errors || !errors.length) return;

    for (var i = 0; i < errors.length; i++) {
      var err = errors[i];
      var wrapper = fieldWrapper(err.field);
      var slot = form.querySelector('[data-error-for="' + err.field + '"]');
      if (slot) slot.textContent = err.message;
      if (wrapper) {
        wrapper.classList.add("field--invalid");
        var control = wrapper.querySelector("input, select, textarea");
        if (control) control.setAttribute("aria-invalid", "true");
      }
      if (summaryList) {
        var li = document.createElement("li");
        var link = document.createElement("a");
        link.href = "#";
        link.textContent = err.label + ": " + err.message;
        (function (fieldName) {
          link.addEventListener("click", function (ev) {
            ev.preventDefault();
            focusField(fieldName);
          });
        })(err.field);
        li.appendChild(link);
        summaryList.appendChild(li);
      }
    }

    if (summaryEl) {
      summaryEl.hidden = false;
      // role="alert" announces it; the focus move puts a keyboard user at the
      // top of the list rather than leaving them on the submit button.
      summaryEl.focus();
    }
  }

  // Client-side mirror of the server rules. The server re-checks everything —
  // this only saves a round trip and gives immediate feedback.
  var REQUIRED_TEXT = ["businessName", "contactName", "phone", "email", "serviceArea"];
  var LABELS = {};
  (function collectLabels() {
    var wrappers = form.querySelectorAll("[data-field]");
    for (var i = 0; i < wrappers.length; i++) {
      var name = wrappers[i].getAttribute("data-field");
      // data-summary-label is the short name for the error summary (the
      // consent checkbox's own label is a full sentence); everything else
      // falls back to its visible legend or label.
      var summary = wrappers[i].getAttribute("data-summary-label");
      var legend = wrappers[i].querySelector("legend");
      var label = wrappers[i].querySelector("label");
      var text = summary || (legend ? legend.textContent : label ? label.textContent : name);
      LABELS[name] = text.replace(/\s*\((required|optional)\)\s*$/i, "").trim();
    }
  })();

  function validateLocally(data) {
    var errors = [];
    function add(field, message) {
      errors.push({ field: field, label: LABELS[field] || field, message: message });
    }

    for (var i = 0; i < REQUIRED_TEXT.length; i++) {
      var name = REQUIRED_TEXT[i];
      if (!String(data.get(name) || "").trim()) add(name, LABELS[name] + " is required.");
    }

    var email = String(data.get("email") || "").trim();
    if (email && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
      add("email", "Enter a valid email address, e.g. name@example.com.");
    }

    var phone = String(data.get("phone") || "").trim();
    if (phone) {
      var cleaned = phone.replace(/[\s().-]/g, "");
      var national = cleaned.indexOf("+61") === 0 ? "0" + cleaned.slice(3) : cleaned;
      var okPhone =
        /^0[2-478]\d{8}$/.test(national) ||
        /^1300\d{6}$/.test(national) ||
        /^1800\d{6}$/.test(national) ||
        /^13\d{4}$/.test(national);
      if (!okPhone) add("phone", "Enter a valid Australian phone number, e.g. 04XX XXX XXX or 03 XXXX XXXX.");
    }

    if (!data.getAll("services").length) add("services", "Please select at least one service.");
    if (!data.get("afterHours")) add("afterHours", "Please choose an option for “" + LABELS.afterHours + "”.");
    if (!data.get("missedCallHandling")) add("missedCallHandling", "Please choose an option for “" + LABELS.missedCallHandling + "”.");
    if (!data.get("preferredContact")) add("preferredContact", "Please choose an option for “" + LABELS.preferredContact + "”.");
    if (!data.get("consent")) add("consent", "Please tick this box so we can contact you about the pilot.");

    return errors;
  }

  function toPayload(data) {
    var payload = {};
    var keys = ["businessName", "contactName", "phone", "email", "website", "serviceArea", "afterHours", "missedCallHandling", "preferredContact", "notes"];
    for (var i = 0; i < keys.length; i++) payload[keys[i]] = String(data.get(keys[i]) || "");
    payload.services = data.getAll("services").map(String);
    payload.consent = Boolean(data.get("consent"));
    return payload;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (submitting) return;

    var data = new FormData(form);
    var localErrors = validateLocally(data);
    if (localErrors.length) {
      setStatus("error", "Please check the highlighted fields and try again.");
      showErrors(localErrors);
      return;
    }

    clearErrors();
    submitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }
    setStatus("submitting", "Sending your enquiry…");

    fetch(form.getAttribute("action"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(toPayload(data)),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body || {} };
        });
      })
      .then(function (result) {
        if (result.body.ok) {
          setStatus("success", result.body.message || "Thanks — your enquiry has been received.");
          form.reset();
          return;
        }
        setStatus("error", result.body.message || "Your enquiry couldn't be sent. Please try again.");
        if (result.body.errors) showErrors(result.body.errors);
      })
      .catch(function () {
        setStatus("error", "Network error — your enquiry wasn't sent. Please check your connection and try again.");
      })
      .then(function () {
        submitting = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = submitLabel;
        }
      });
  });
})();
