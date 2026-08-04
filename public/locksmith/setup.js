// AIDA Locksmith Receptionist — setup wizard behaviour (M8A).
//
// ES5, no build step, no dependencies — the same constraints as
// public/locksmith/onboarding.js. Served under a CSP with `script-src 'self'`,
// so this file is the only place any behaviour can live.
//
// Why the form is submitted as JSON rather than posted normally: the repo's CSRF
// protection is that every state-changing endpoint requires
// Content-Type: application/json, which a cross-site form post cannot set
// without a preflight. Submitting this form the ordinary way would mean
// accepting urlencoded bodies, which would give that protection away.
//
// The <form> element is still a real form — Enter submits it, the browser
// exposes it as a form to assistive technology, and every control inside it is a
// labelled input. Only the transport is ours.

(function () {
  "use strict";

  var main = document.getElementById("main");
  if (!main) return;

  var BASE = main.getAttribute("data-base") || "/client/locksmith-setup";
  var statusBox = document.getElementById("form-status");

  // ── Status line ───────────────────────────────────────────────────
  // A single polite live region. Screen readers announce it; sighted users see
  // it change colour. Never two messages racing each other.

  function setStatus(state, message) {
    if (!statusBox) return;
    statusBox.setAttribute("data-state", state);
    statusBox.textContent = message || "";
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: response.status, data: data };
        });
    });
  }

  // ── Reading the form ──────────────────────────────────────────────
  // Composite controls (services, hours, callback estimates) are named with a
  // "prefix:key:field" convention so the collector can rebuild the nested shape
  // the step declaration expects, without the server having to know which
  // widget drew it.

  function collectAnswers(form) {
    var answers = {};
    var services = {};
    var hours = {};
    var estimate = {};
    var checkboxGroups = {};

    var inputs = form.querySelectorAll("input, select, textarea");

    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var name = el.getAttribute("name");
      if (!name) continue;

      if (name.indexOf("service:") === 0) {
        if (el.checked) services[name.slice("service:".length)] = el.value;
        continue;
      }

      if (name.indexOf("hours:") === 0) {
        var hourParts = name.split(":");
        var day = hourParts[1];
        var part = hourParts[2];
        if (!hours[day]) hours[day] = { closed: false, open: "", close: "" };
        if (part === "closed") hours[day].closed = el.checked;
        else hours[day][part] = el.value;
        continue;
      }

      if (name.indexOf("estimate:") === 0) {
        var estParts = name.split(":");
        var window_ = estParts[1];
        var bound = estParts[2];
        if (!estimate[window_]) estimate[window_] = {};
        // Empty stays empty: a blank estimate is a real answer meaning "don't
        // give a timeframe", not a missing one.
        estimate[window_][bound] = el.value === "" ? "" : el.value;
        continue;
      }

      if (el.type === "checkbox") {
        // A disabled checkbox is a locked, always-on option. It is still part of
        // the answer — the server re-adds it anyway, but sending it keeps the
        // payload an honest description of what the page showed.
        if (!checkboxGroups[name]) checkboxGroups[name] = [];
        if (el.checked) checkboxGroups[name].push(el.value);
        continue;
      }

      if (el.type === "radio") {
        if (el.checked) answers[name] = el.value;
        continue;
      }

      answers[name] = el.value;
    }

    for (var group in checkboxGroups) {
      if (Object.prototype.hasOwnProperty.call(checkboxGroups, group)) answers[group] = checkboxGroups[group];
    }

    if (hasKeys(services)) answers.services = services;
    if (hasKeys(hours)) answers.ordinary = cleanHours(hours);
    if (hasKeys(estimate)) answers.callbackEstimate = cleanEstimate(estimate);

    return answers;
  }

  function hasKeys(obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) return true;
    return false;
  }

  function cleanHours(hours) {
    var out = {};
    for (var day in hours) {
      if (!Object.prototype.hasOwnProperty.call(hours, day)) continue;
      var entry = hours[day];
      out[day] = entry.closed ? { closed: true } : { closed: false, open: entry.open, close: entry.close };
    }
    return out;
  }

  function cleanEstimate(estimate) {
    var out = {};
    for (var key in estimate) {
      if (!Object.prototype.hasOwnProperty.call(estimate, key)) continue;
      var window_ = estimate[key];
      var min = window_.minMinutes;
      var max = window_.maxMinutes;
      // Both boxes blank means this window is simply not set. Sending it as an
      // empty object would look like a half-filled answer and be refused.
      if ((min === "" || min == null) && (max === "" || max == null)) continue;
      out[key] = { minMinutes: min, maxMinutes: max };
    }
    return out;
  }

  // ── Errors ────────────────────────────────────────────────────────

  function clearErrors(form) {
    var boxes = form.querySelectorAll(".field__error");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].textContent = "";
      boxes[i].hidden = true;
    }
    var invalid = form.querySelectorAll('[aria-invalid="true"]');
    for (var j = 0; j < invalid.length; j++) invalid[j].removeAttribute("aria-invalid");
  }

  function showErrors(form, errors) {
    var firstField = null;
    for (var name in errors) {
      if (!Object.prototype.hasOwnProperty.call(errors, name)) continue;
      var box = document.getElementById("f-" + name + "-error");
      if (box) {
        box.textContent = errors[name];
        box.hidden = false;
      }
      var wrapper = form.querySelector('[data-field="' + cssEscape(name) + '"]');
      if (wrapper && !firstField) firstField = wrapper;
      var control = document.getElementById("f-" + name);
      if (control) control.setAttribute("aria-invalid", "true");
    }
    if (firstField) {
      // Move focus, not just the scroll position: a keyboard user who cannot see
      // the page needs to land on the thing that is wrong.
      var focusable = firstField.querySelector("input, select, textarea");
      if (focusable) focusable.focus();
      else firstField.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // ── Step form ─────────────────────────────────────────────────────

  var form = document.getElementById("setup-form");

  if (form) {
    var stepId = form.getAttribute("data-step");
    var saveContinue = document.getElementById("save-continue");
    var saveLater = document.getElementById("save-later");

    var save = function (allowIncomplete, onDone) {
      clearErrors(form);
      setStatus("saving", "Saving…");
      if (saveContinue) saveContinue.disabled = true;
      if (saveLater) saveLater.disabled = true;

      post(BASE + "/step/" + encodeURIComponent(stepId), {
        answers: collectAnswers(form),
        expectedUpdatedAt: main.getAttribute("data-updated-at") || null,
        allowIncomplete: allowIncomplete === true,
      })
        .then(function (result) {
          if (saveContinue) saveContinue.disabled = false;
          if (saveLater) saveLater.disabled = false;

          if (result.status === 200 && result.data.ok) {
            // Keep the concurrency token current so a second save from this same
            // page is not rejected as stale.
            main.setAttribute("data-updated-at", result.data.updatedAt || "");
            setStatus("saved", "Saved.");
            if (onDone) onDone(result.data);
            return;
          }

          if (result.data && result.data.errors && hasKeys(result.data.errors)) {
            setStatus("error", result.data.message || "Some answers need another look.");
            showErrors(form, result.data.errors);
            return;
          }

          setStatus("error", (result.data && result.data.message) || "We couldn't save that. Nothing was changed.");
        })
        .catch(function () {
          if (saveContinue) saveContinue.disabled = false;
          if (saveLater) saveLater.disabled = false;
          setStatus("error", "We couldn't reach the server. Your answers are still on this page — try again.");
        });
    };

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      save(false, function (data) {
        window.location.href = data.nextStepId ? BASE + "/step/" + encodeURIComponent(data.nextStepId) : BASE + "/review";
      });
    });

    if (saveLater) {
      saveLater.addEventListener("click", function () {
        save(true, function () {
          window.location.href = BASE;
        });
      });
    }

    // Time inputs follow their day's "closed" box. Disabled rather than hidden,
    // so the row does not reflow and lose the reader's place.
    var closedBoxes = form.querySelectorAll('input[name^="hours:"][name$=":closed"]');
    for (var c = 0; c < closedBoxes.length; c++) {
      (function (box) {
        box.addEventListener("change", function () {
          var row = box.closest(".hours-row");
          if (!row) return;
          var times = row.querySelectorAll(".input--time");
          for (var t = 0; t < times.length; t++) times[t].disabled = box.checked;
        });
      })(closedBoxes[c]);
    }
  }

  // ── Review: send for approval ─────────────────────────────────────

  var submitButton = document.getElementById("submit-setup");
  if (submitButton) {
    submitButton.addEventListener("click", function () {
      submitButton.disabled = true;
      setStatus("saving", "Sending for approval…");
      post(BASE + "/submit", { expectedUpdatedAt: main.getAttribute("data-updated-at") || null })
        .then(function (result) {
          if (result.status === 200 && result.data.ok) {
            setStatus("saved", "Sent. Open your review page to confirm each section and approve it.");
            window.location.reload();
            return;
          }
          submitButton.disabled = false;
          var message = (result.data && result.data.message) || "We couldn't send that for approval.";
          if (result.data && result.data.outstanding && result.data.outstanding.length) {
            var names = result.data.outstanding.map(function (o) {
              return o.title;
            });
            message += " Still to answer: " + names.join(", ") + ".";
          }
          setStatus("error", message);
        })
        .catch(function () {
          submitButton.disabled = false;
          setStatus("error", "We couldn't reach the server. Nothing was changed.");
        });
    });
  }

  // ── Review: tick a section ────────────────────────────────────────

  var confirmButtons = document.querySelectorAll(".confirm-button");
  var approveButton = document.getElementById("approve-setup");

  for (var b = 0; b < confirmButtons.length; b++) {
    (function (button) {
      button.addEventListener("click", function () {
        var section = button.getAttribute("data-section");
        button.disabled = true;
        setStatus("saving", "Recording that…");

        post(BASE + "/confirm", { section: section })
          .then(function (result) {
            if (result.status === 200 && result.data.ok) {
              main.setAttribute("data-updated-at", result.data.updatedAt || "");
              button.textContent = "Checked ✓";
              button.className = "btn btn--small btn--ghost confirm-button";
              var block = document.querySelector('.review-block[data-section="' + cssEscape(section) + '"]');
              if (block) block.classList.add("review-block--confirmed");

              var outstanding = result.data.outstanding || [];
              updateConfirmProgress(outstanding.length);
              // The approve button unlocks only when the server says every
              // section is ticked — never on a count kept in this file.
              if (approveButton && outstanding.length === 0) approveButton.disabled = false;
              setStatus("saved", outstanding.length === 0 ? "All sections checked. You can approve now." : "Recorded.");
              return;
            }
            button.disabled = false;
            setStatus("error", (result.data && result.data.message) || "We couldn't record that.");
          })
          .catch(function () {
            button.disabled = false;
            setStatus("error", "We couldn't reach the server. Nothing was changed.");
          });
      });
    })(confirmButtons[b]);
  }

  function updateConfirmProgress(outstandingSections) {
    var box = document.getElementById("confirm-progress");
    if (!box) return;
    var total = document.querySelectorAll(".confirm-button").length;
    var checked = document.querySelectorAll(".review-block--confirmed").length;
    box.textContent =
      outstandingSections === 0 ? "Every section checked." : checked + " of " + total + " sections checked.";
  }

  // ── Review: approve ───────────────────────────────────────────────

  if (approveButton) {
    approveButton.addEventListener("click", function () {
      if (approveButton.getAttribute("data-armed") !== "true") {
        approveButton.setAttribute("data-armed", "true");
        approveButton.textContent = "Approve — tap again to confirm";
        setStatus("idle", "Approving records your name against this version. It does not switch your phone over.");
        return;
      }

      approveButton.disabled = true;
      setStatus("saving", "Recording your approval…");
      post(BASE + "/approve", { expectedUpdatedAt: main.getAttribute("data-updated-at") || null })
        .then(function (result) {
          if (result.status === 200 && result.data.ok) {
            setStatus("saved", result.data.message || "Approved.");
            window.location.reload();
            return;
          }
          approveButton.disabled = false;
          approveButton.setAttribute("data-armed", "false");
          approveButton.textContent = "Approve these settings";
          var message = (result.data && result.data.message) || "We couldn't record your approval.";
          if (result.data && result.data.blockers && result.data.blockers.length) {
            message +=
              " " +
              result.data.blockers
                .map(function (blocker) {
                  return blocker.message;
                })
                .join(" ");
          }
          setStatus("error", message);
        })
        .catch(function () {
          approveButton.disabled = false;
          setStatus("error", "We couldn't reach the server. Nothing was changed.");
        });
    });
  }

  // ── Review: take it back for editing ──────────────────────────────

  var reopenButton = document.getElementById("reopen-setup");
  if (reopenButton) {
    reopenButton.addEventListener("click", function () {
      reopenButton.disabled = true;
      setStatus("saving", "Reopening your answers…");
      post(BASE + "/reopen", {})
        .then(function (result) {
          if (result.status === 200 && result.data.ok) {
            setStatus("saved", result.data.message || "Reopened.");
            window.location.href = BASE;
            return;
          }
          reopenButton.disabled = false;
          setStatus("error", (result.data && result.data.message) || "We couldn't reopen that.");
        })
        .catch(function () {
          reopenButton.disabled = false;
          setStatus("error", "We couldn't reach the server. Nothing was changed.");
        });
    });
  }

  // ── History: restore an earlier version ───────────────────────────

  var restoreButtons = document.querySelectorAll(".restore-button");
  for (var r = 0; r < restoreButtons.length; r++) {
    (function (button) {
      button.addEventListener("click", function () {
        var version = button.getAttribute("data-version");
        // Deliberately not window.confirm: a modal dialog blocks the page and
        // reads poorly on a phone. The button becomes its own confirmation.
        if (button.getAttribute("data-armed") !== "true") {
          button.setAttribute("data-armed", "true");
          button.textContent = "Restore version " + version + " — tap again to confirm";
          setStatus("idle", "Restoring copies those settings into a new draft. It doesn't switch anything on.");
          return;
        }

        button.disabled = true;
        setStatus("saving", "Restoring version " + version + "…");
        post(BASE + "/rollback", { version: Number(version) })
          .then(function (result) {
            if (result.status === 200 && result.data.ok) {
              setStatus("saved", result.data.message || "Restored.");
              window.location.href = BASE;
              return;
            }
            button.disabled = false;
            button.setAttribute("data-armed", "false");
            button.textContent = "Restore these settings";
            setStatus("error", (result.data && result.data.message) || "We couldn't restore that version.");
          })
          .catch(function () {
            button.disabled = false;
            setStatus("error", "We couldn't reach the server. Nothing was changed.");
          });
      });
    })(restoreButtons[r]);
  }
})();
