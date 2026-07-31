/* AIDA Locksmith Receptionist — review + founder console behaviour (M2).
 *
 * Progressive enhancement over server-rendered HTML: without this file every
 * page still renders and reads correctly, it just cannot submit actions.
 *
 * Two safety rules this file follows:
 *   1. Every message is written with textContent. The server answers JSON and
 *      never echoes stored values into markup, so there is no path from a
 *      transcript or a profile value to executable markup.
 *   2. Every request carries the draft's updatedAt as expectedUpdatedAt, and
 *      the answer's updatedAt replaces it. That is the stale-review guard: if
 *      the draft moved, the server refuses and this page says so rather than
 *      letting someone approve text they never saw.
 */
(function () {
  "use strict";

  var main = document.getElementById("main");
  if (!main) return;

  var statusEl = document.getElementById("form-status");
  var sessionId = main.getAttribute("data-session-id");
  var expectedUpdatedAt = main.getAttribute("data-updated-at") || null;

  function setStatus(state, message) {
    if (!statusEl) return;
    statusEl.setAttribute("data-state", state);
    statusEl.textContent = message || "";
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // Same-origin only: these endpoints are session-authenticated and must
      // never be reachable with credentials from another site.
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, body: data || {} };
      });
    });
  }

  function describeFailure(result) {
    var body = result.body || {};
    if (body.blockers && body.blockers.length) {
      return body.blockers
        .map(function (b) { return b.message; })
        .join(" ");
    }
    return body.message || "That didn't work. Reload the page and try again.";
  }

  // ── Review page: per-section actions ──────────────────────────────

  function clientBase() {
    return "/client/locksmith-onboarding/" + encodeURIComponent(sessionId);
  }

  main.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-action]") : null;
    if (!button) return;
    var action = button.getAttribute("data-action");
    var section = button.getAttribute("data-section");

    if (action === "correct" || action === "discuss") {
      var panel = document.getElementById("correct-" + section);
      if (!panel) return;
      var showing = panel.hasAttribute("hidden");
      if (showing) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      var toggle = main.querySelector('button[data-action="correct"][data-section="' + section + '"]');
      if (toggle) toggle.setAttribute("aria-expanded", showing ? "true" : "false");
      if (showing) {
        var field = document.getElementById("note-" + section);
        if (field) field.focus();
      }
      panel.setAttribute("data-mode", action === "discuss" ? "discuss" : "correct");
      return;
    }

    if (action === "confirm") {
      button.disabled = true;
      setStatus("saving", "Saving…");
      post(clientBase() + "/confirm", { section: section, expectedUpdatedAt: expectedUpdatedAt })
        .then(function (result) {
          if (result.body.ok) {
            expectedUpdatedAt = result.body.updatedAt || expectedUpdatedAt;
            button.textContent = "Confirmed";
            var wrapper = main.querySelector('[data-section="' + section + '"]');
            if (wrapper && wrapper.classList) wrapper.classList.add("review-section--confirmed");
            setStatus("success", "Saved. Reload when you've finished to update the summary at the top.");
          } else {
            button.disabled = false;
            setStatus("error", describeFailure(result));
          }
        })
        .catch(function () {
          button.disabled = false;
          setStatus("error", "Network error — nothing was saved.");
        });
      return;
    }

    if (action === "save-note") {
      var textarea = document.querySelector('[data-note-for="' + section + '"]');
      var note = textarea ? textarea.value.trim() : "";
      if (!note) {
        setStatus("error", "Add a note before saving.");
        if (textarea) textarea.focus();
        return;
      }
      var container = document.getElementById("correct-" + section);
      var forDiscussion = container && container.getAttribute("data-mode") === "discuss";
      button.disabled = true;
      setStatus("saving", "Saving…");
      post(clientBase() + "/note", { section: section, note: note, forDiscussion: forDiscussion, expectedUpdatedAt: expectedUpdatedAt })
        .then(function (result) {
          button.disabled = false;
          if (result.body.ok) {
            expectedUpdatedAt = result.body.updatedAt || expectedUpdatedAt;
            setStatus("success", "Noted. That section is marked as needing another look.");
            var confirmBtn = main.querySelector('button[data-action="confirm"][data-section="' + section + '"]');
            if (confirmBtn) {
              confirmBtn.disabled = false;
              confirmBtn.textContent = "This section is correct";
            }
          } else {
            setStatus("error", describeFailure(result));
          }
        })
        .catch(function () {
          button.disabled = false;
          setStatus("error", "Network error — nothing was saved.");
        });
    }
  });

  // ── Review page: approve / reject ─────────────────────────────────

  var approveButton = document.getElementById("approve-button");
  if (approveButton) {
    approveButton.addEventListener("click", function () {
      approveButton.disabled = true;
      setStatus("saving", "Approving…");
      post(clientBase() + "/approve", { expectedUpdatedAt: expectedUpdatedAt })
        .then(function (result) {
          if (result.body.ok) {
            setStatus("success", "Approved. These settings are now the approved version of your receptionist.");
          } else {
            approveButton.disabled = false;
            setStatus("error", describeFailure(result));
          }
        })
        .catch(function () {
          approveButton.disabled = false;
          setStatus("error", "Network error — nothing was approved.");
        });
    });
  }

  var rejectButton = document.getElementById("reject-button");
  var rejectPanel = document.getElementById("reject-panel");
  if (rejectButton && rejectPanel) {
    rejectButton.addEventListener("click", function () {
      var showing = rejectPanel.hasAttribute("hidden");
      if (showing) {
        rejectPanel.removeAttribute("hidden");
        var reason = document.getElementById("reject-reason");
        if (reason) reason.focus();
      } else {
        rejectPanel.setAttribute("hidden", "");
      }
    });
  }
  var rejectConfirm = document.getElementById("reject-confirm");
  if (rejectConfirm) {
    rejectConfirm.addEventListener("click", function () {
      var reasonField = document.getElementById("reject-reason");
      var reason = reasonField ? reasonField.value.trim() : "";
      if (!reason) {
        setStatus("error", "Tell us what's wrong so it can be fixed.");
        if (reasonField) reasonField.focus();
        return;
      }
      rejectConfirm.disabled = true;
      setStatus("saving", "Sending…");
      post(clientBase() + "/reject", { reason: reason })
        .then(function (result) {
          rejectConfirm.disabled = false;
          if (result.body.ok) setStatus("success", "Rejected. We'll go through your notes and send a corrected version.");
          else setStatus("error", describeFailure(result));
        })
        .catch(function () {
          rejectConfirm.disabled = false;
          setStatus("error", "Network error — nothing was sent.");
        });
    });
  }

  // ── Founder console ──────────────────────────────────────────────

  var actions = document.querySelector(".decision-actions[data-session-id]");
  if (actions) {
    var founderSessionId = actions.getAttribute("data-session-id");
    var founderBase = "/locksmith-founder/sessions/" + encodeURIComponent(founderSessionId);

    var rerun = document.getElementById("rerun-extraction");
    if (rerun) {
      rerun.addEventListener("click", function () {
        rerun.disabled = true;
        setStatus("saving", "Re-running extraction…");
        post(founderBase + "/re-extract", {})
          .then(function (result) {
            rerun.disabled = false;
            if (result.body.ok) {
              setStatus("success", "New draft version " + result.body.version + " created. Any approved version was left untouched.");
            } else {
              setStatus("error", describeFailure(result));
            }
          })
          .catch(function () {
            rerun.disabled = false;
            setStatus("error", "Network error — nothing changed.");
          });
      });
    }

    var failButton = document.getElementById("fail-session");
    var failPanel = document.getElementById("fail-panel");
    if (failButton && failPanel) {
      failButton.addEventListener("click", function () {
        if (failPanel.hasAttribute("hidden")) {
          failPanel.removeAttribute("hidden");
          var f = document.getElementById("fail-reason");
          if (f) f.focus();
        } else {
          failPanel.setAttribute("hidden", "");
        }
      });
    }
    var failConfirm = document.getElementById("fail-confirm");
    if (failConfirm) {
      failConfirm.addEventListener("click", function () {
        var field = document.getElementById("fail-reason");
        var reason = field ? field.value.trim() : "";
        if (!reason) {
          setStatus("error", "A failure reason is required.");
          if (field) field.focus();
          return;
        }
        failConfirm.disabled = true;
        setStatus("saving", "Saving…");
        post(founderBase + "/fail", { code: reason })
          .then(function (result) {
            failConfirm.disabled = false;
            if (result.body.ok) setStatus("success", "Session marked failed.");
            else setStatus("error", describeFailure(result));
          })
          .catch(function () {
            failConfirm.disabled = false;
            setStatus("error", "Network error — nothing changed.");
          });
      });
    }
  }
})();
