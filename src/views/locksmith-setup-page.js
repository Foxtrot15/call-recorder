// AIDA Locksmith Receptionist — the setup wizard pages (M8A).
//
// Server-rendered from the step declaration in locksmith-onboarding-steps.js.
// This file knows how to draw a `kind`; it does not know what any particular
// field means. Adding a question means editing the declaration, not this file.
//
// ─── CONSTRAINTS THAT SHAPED THE MARKUP ─────────────────────────────
// The page's own CSP is `style-src 'self'; script-src 'self'`, so there is not
// one inline style attribute or inline script anywhere below. Everything visual
// lives in /locksmith/setup.css and every behaviour in /locksmith/setup.js.
//
// Mobile first, and 320px is a real target rather than a rounding error: a
// locksmith fills this in on a phone, in a van, between jobs. Nothing is laid
// out in columns that cannot become one column, and no control is smaller than
// a thumb.
//
// Accessibility is structural rather than decorative: every input has a real
// <label for>, every group of related controls is a <fieldset> with a <legend>,
// errors are wired with aria-describedby and announced through a live region,
// the step indicator is an ordered list with aria-current, and the whole form
// is reachable and completable from the keyboard alone.
//
// ─── VOCABULARY ─────────────────────────────────────────────────────
// No provider names, no agent ids, no webhook or resource language, and never
// the internal transfer number of another tenant. The words on this page are
// the words a locksmith uses: "the number I put urgent callers through to", not
// "the transfer destination E.164".

const { escapeHtml, escapeAttr } = require("./escape");
const steps = require("../services/locksmith-onboarding-steps");
const S = require("../services/locksmith-profile-schema");

const BASE = "/client/locksmith-setup";

// ── Shell ───────────────────────────────────────────────────────────

function page({ title, stageId, progress = null, body, dataAttrs = "" }) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — AIDA setup</title>
<link rel="stylesheet" href="/locksmith/setup.css">
</head>
<body class="setup">
<a class="skip-link" href="#main">Skip to main content</a>

<header class="setup-header">
  <p class="setup-header__brand">AIDA <span>setup</span></p>
</header>

${renderStageNav(stageId, progress)}

<main id="main" class="setup-main"${dataAttrs}>
  <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>
  <noscript>
    <p class="notice notice--blocker">
      Setup needs JavaScript switched on to save your answers safely. If you can't
      switch it on, reply to your welcome email and we'll fill this in with you over
      the phone.
    </p>
  </noscript>
  ${body}
</main>

<footer class="setup-footer">
  <p>Nothing you enter here answers your phone until you've read it back and approved it.</p>
  <p>Your answers are treated as confidential business information.</p>
</footer>
<script src="/locksmith/setup.js" defer></script>
</body>
</html>
`;
}

/**
 * The eleven-stage journey indicator.
 *
 * An ordered list rather than a row of divs, because a screen-reader user needs
 * "step 3 of 11" without being told so in a visually-hidden paragraph that then
 * drifts out of date. `aria-current="step"` marks where they are.
 */
function renderStageNav(stageId, progress) {
  const done = new Set(progress ? progress.steps.filter((s) => s.complete).map((s) => s.id) : []);
  const items = steps.STAGES.map((stage) => {
    const isCurrent = stage.id === stageId;
    const isDone = done.has(stage.id);
    const state = isCurrent ? "current" : isDone ? "done" : "todo";
    const label = `${stage.number}. ${stage.title}`;
    const inner = stage.kind === "form" && (isDone || isCurrent)
      ? `<a href="${BASE}/step/${escapeAttr(stage.id)}">${escapeHtml(label)}</a>`
      : `<span>${escapeHtml(label)}</span>`;
    return `<li class="stage stage--${state}" data-state="${state}"${isCurrent ? ' aria-current="step"' : ""}>
      ${inner}${isDone ? '<span class="stage__tick" aria-label="done">✓</span>' : ""}
    </li>`;
  }).join("");

  const summary = progress
    ? `<p class="stage-nav__summary" id="stage-summary">Step ${escapeHtml(String(progress.complete))} of ${escapeHtml(String(progress.total))} answered.</p>`
    : "";

  return `<nav class="stage-nav" aria-label="Setup progress">
  ${summary}
  <ol class="stage-list">${items}</ol>
</nav>`;
}

// ── Field rendering ─────────────────────────────────────────────────

function fieldId(field) {
  return `f-${field.name}`;
}

function describedBy(field, hasError) {
  const ids = [];
  if (field.help) ids.push(`${fieldId(field)}-help`);
  if (hasError) ids.push(`${fieldId(field)}-error`);
  return ids.length ? ` aria-describedby="${escapeAttr(ids.join(" "))}"` : "";
}

function renderHelp(field) {
  return field.help ? `<p class="field__help" id="${escapeAttr(fieldId(field))}-help">${escapeHtml(field.help)}</p>` : "";
}

function renderError(field, error) {
  return error
    ? `<p class="field__error" id="${escapeAttr(fieldId(field))}-error">${escapeHtml(error)}</p>`
    : `<p class="field__error" id="${escapeAttr(fieldId(field))}-error" hidden></p>`;
}

function requiredMark(field) {
  return field.required ? ' <span class="field__required" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>' : "";
}

function renderField(field, value, error) {
  const id = fieldId(field);
  const invalid = error ? ' aria-invalid="true"' : "";
  const described = describedBy(field, Boolean(error));
  const req = field.required ? " required" : "";

  // Grouped controls need a fieldset/legend rather than a label, because a
  // label pointing at one of several radios is a lie to a screen reader.
  const grouped = ["bool", "services", "hours", "checkboxes", "estimate"].includes(field.kind);

  const control = (() => {
    switch (field.kind) {
      case "textarea":
        return `<textarea id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" class="input input--area" rows="4"
          maxlength="${escapeAttr(String(field.maxLength))}"${req}${invalid}${described}
          ${field.placeholder ? `placeholder="${escapeAttr(field.placeholder)}"` : ""}>${escapeHtml(value)}</textarea>`;

      case "list":
        return `<textarea id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" class="input input--area input--list" rows="4"
          ${req}${invalid}${described}
          ${field.placeholder ? `placeholder="${escapeAttr(field.placeholder)}"` : ""}>${escapeHtml(value)}</textarea>`;

      case "select":
        return `<select id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" class="input input--select"${req}${invalid}${described}>
          <option value="">Choose one…</option>
          ${(field.options || [])
            .map((o) => `<option value="${escapeAttr(o.value)}"${String(value) === String(o.value) ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
            .join("")}
        </select>`;

      case "bool":
        return `<div class="choice-row">
          ${["true", "false"]
            .map((v) => {
              const checked = value === (v === "true") ? " checked" : "";
              return `<label class="choice"><input type="radio" name="${escapeAttr(field.name)}" value="${v}"${checked}${described}> <span>${v === "true" ? "Yes" : "No"}</span></label>`;
            })
            .join("")}
        </div>`;

      case "checkboxes":
        return `<div class="checkbox-list">
          ${(field.options || [])
            .map((o) => {
              const checked = Array.isArray(value) && value.includes(o.value) ? " checked" : "";
              // A locked option is always on. Rendered disabled AND as a hidden
              // input, so it is visibly non-negotiable but still submitted.
              const locked = o.locked === true;
              return `<label class="checkbox${locked ? " checkbox--locked" : ""}">
                <input type="checkbox" name="${escapeAttr(field.name)}" value="${escapeAttr(o.value)}"${checked || (locked ? " checked" : "")}${locked ? " disabled" : ""}>
                <span>${escapeHtml(o.label)}${locked ? ' <em class="locked-note">always collected</em>' : ""}</span>
              </label>`;
            })
            .join("")}
        </div>`;

      case "services":
        return renderServicesField(field, value);

      case "hours":
        return renderHoursField(field, value);

      case "estimate":
        return renderEstimateField(field, value);

      case "tel":
      case "email":
      default: {
        const type = field.kind === "tel" ? "tel" : field.kind === "email" ? "email" : "text";
        const mode = field.kind === "tel" ? ' inputmode="tel" autocomplete="tel"' : field.kind === "email" ? ' inputmode="email" autocomplete="email"' : "";
        return `<input type="${type}" id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" class="input"
          maxlength="${escapeAttr(String(field.maxLength))}"${mode}${req}${invalid}${described}
          value="${escapeAttr(value == null ? "" : value)}"
          ${field.placeholder ? `placeholder="${escapeAttr(field.placeholder)}"` : ""}>`;
      }
    }
  })();

  if (grouped) {
    return `<fieldset class="field field--group" data-field="${escapeAttr(field.name)}">
      <legend class="field__label">${escapeHtml(field.label)}${requiredMark(field)}</legend>
      ${renderHelp(field)}
      ${control}
      ${renderError(field, error)}
    </fieldset>`;
  }

  return `<div class="field" data-field="${escapeAttr(field.name)}">
    <label class="field__label" for="${escapeAttr(id)}">${escapeHtml(field.label)}${requiredMark(field)}</label>
    ${renderHelp(field)}
    ${control}
    ${renderError(field, error)}
  </div>`;
}

/**
 * The tri-state services grid. One fieldset per service, three radios inside.
 *
 * "Don't offer" is the default and is deliberately different from "never take":
 * we never mention work you have not opted into, but we only tell a caller
 * plainly that you refuse something when you have said so.
 */
function renderServicesField(field, value) {
  const state = value && typeof value === "object" ? value : {};
  const choices = [
    { value: "accepted", label: "We take this" },
    { value: "not_offered", label: "Don't offer it" },
    { value: "declined", label: "Never take it" },
  ];
  return `<div class="service-grid">
    ${(field.options || [])
      .map((service) => {
        const current = steps.lookup(state, service.value) || "not_offered";
        return `<fieldset class="service-row">
          <legend class="service-row__name">${escapeHtml(service.label)}</legend>
          <div class="choice-row choice-row--three">
            ${choices
              .map(
                (c) =>
                  `<label class="choice"><input type="radio" name="service:${escapeAttr(service.value)}" value="${c.value}"${current === c.value ? " checked" : ""}> <span>${escapeHtml(c.label)}</span></label>`
              )
              .join("")}
          </div>
        </fieldset>`;
      })
      .join("")}
  </div>`;
}

/** The day grid. A "closed" checkbox plus two time inputs per day. */
function renderHoursField(field, value) {
  const state = value && typeof value === "object" ? value : {};
  return `<div class="hours-grid">
    ${(field.options || [])
      .map((day) => {
        const entry = steps.lookup(state, day.value) || { closed: true, open: "08:00", close: "17:00" };
        const closed = entry.closed === true;
        return `<fieldset class="hours-row" data-day="${escapeAttr(day.value)}">
          <legend class="hours-row__day">${escapeHtml(day.label)}</legend>
          <label class="checkbox checkbox--inline">
            <input type="checkbox" name="hours:${escapeAttr(day.value)}:closed" value="true"${closed ? " checked" : ""}>
            <span>Closed</span>
          </label>
          <span class="hours-row__times">
            <label class="visually-hidden" for="h-${escapeAttr(day.value)}-open">${escapeHtml(day.label)} opening time</label>
            <input type="time" id="h-${escapeAttr(day.value)}-open" name="hours:${escapeAttr(day.value)}:open" class="input input--time" value="${escapeAttr(entry.open || "08:00")}"${closed ? " disabled" : ""}>
            <span class="hours-row__to" aria-hidden="true">to</span>
            <label class="visually-hidden" for="h-${escapeAttr(day.value)}-close">${escapeHtml(day.label)} closing time</label>
            <input type="time" id="h-${escapeAttr(day.value)}-close" name="hours:${escapeAttr(day.value)}:close" class="input input--time" value="${escapeAttr(entry.close || "17:00")}"${closed ? " disabled" : ""}>
          </span>
        </fieldset>`;
      })
      .join("")}
  </div>`;
}

/** Three optional callback windows, each a pair of whole-minute inputs. */
function renderEstimateField(field, value) {
  const state = value && typeof value === "object" ? value : {};
  return `<div class="estimate-grid">
    ${(field.options || [])
      .map((window) => {
        const entry = steps.lookup(state, window.value) || null;
        return `<fieldset class="estimate-row">
          <legend class="estimate-row__name">${escapeHtml(window.label)}</legend>
          <label class="visually-hidden" for="e-${escapeAttr(window.value)}-min">${escapeHtml(window.label)} — soonest, in minutes</label>
          <input type="number" id="e-${escapeAttr(window.value)}-min" name="estimate:${escapeAttr(window.value)}:minMinutes" class="input input--minutes"
            min="1" max="1440" step="1" inputmode="numeric" value="${escapeAttr(entry ? entry.minMinutes : "")}">
          <span class="estimate-row__to" aria-hidden="true">to</span>
          <label class="visually-hidden" for="e-${escapeAttr(window.value)}-max">${escapeHtml(window.label)} — latest, in minutes</label>
          <input type="number" id="e-${escapeAttr(window.value)}-max" name="estimate:${escapeAttr(window.value)}:maxMinutes" class="input input--minutes"
            min="1" max="1440" step="1" inputmode="numeric" value="${escapeAttr(entry ? entry.maxMinutes : "")}">
          <span class="estimate-row__unit">minutes</span>
        </fieldset>`;
      })
      .join("")}
    <p class="estimate-note">Leave every box blank if you'd rather we didn't give a timeframe at all.</p>
  </div>`;
}

// ── Step page ───────────────────────────────────────────────────────

function renderSetupStep({ step, answers, errors = {}, progress, version, updatedAt }) {
  const previous = steps.previousStepId(step.id);
  const next = steps.nextStepId(step.id);

  const body = `
  <h1>${escapeHtml(step.title)}</h1>
  <p class="lead">${escapeHtml(step.intent)}</p>

  <form class="setup-form" id="setup-form" data-step="${escapeAttr(step.id)}" novalidate>
    ${step.fields.map((f) => renderField(f, steps.lookup(answers, f.name), steps.lookup(errors, f.name))).join("")}

    <div class="form-actions">
      <button type="submit" class="btn btn--primary" id="save-continue">
        ${next ? "Save and continue" : "Save and review"}
      </button>
      <button type="button" class="btn btn--ghost" id="save-later">Save and finish later</button>
    </div>
    <p class="form-actions__note">
      Your answers are saved against your account, not this browser. You can close this
      and come back to it whenever you like.
    </p>
  </form>

  <nav class="step-nav" aria-label="Move between steps">
    ${previous ? `<a class="btn btn--ghost" href="${BASE}/step/${escapeAttr(previous)}">← Back</a>` : `<a class="btn btn--ghost" href="${BASE}">← Setup home</a>`}
    ${next ? `<a class="btn btn--link" href="${BASE}/step/${escapeAttr(next)}">Skip for now →</a>` : ""}
  </nav>
`;

  return page({
    title: step.title,
    stageId: step.id,
    progress,
    body,
    dataAttrs: ` data-step="${escapeAttr(step.id)}" data-version="${escapeAttr(String(version))}" data-updated-at="${escapeAttr(updatedAt || "")}" data-next="${escapeAttr(next || "")}" data-base="${escapeAttr(BASE)}"`,
  });
}

// ── Setup home ──────────────────────────────────────────────────────

function renderSetupHome({ progress, version, updatedAt, hasApproved, approvedVersion }) {
  const body = `
  <h1>Set up your receptionist</h1>
  <p class="lead">
    Seven short steps about how your business runs. You can stop at any point and
    pick it up later — nothing is lost, and nothing answers your phone until you've
    read it back and approved it.
  </p>

  ${
    hasApproved
      ? `<p class="notice notice--info">
           You already have an approved receptionist (version ${escapeHtml(String(approvedVersion))}), and it keeps
           answering exactly as it does now. These changes become a new version that you
           approve separately.
         </p>`
      : ""
  }

  <ol class="step-cards">
    ${progress.steps
      .map(
        (s) => `<li class="step-card step-card--${s.complete ? "done" : "todo"}">
          <a href="${BASE}/step/${escapeAttr(s.id)}">
            <span class="step-card__number">${escapeHtml(String(s.number))}</span>
            <span class="step-card__title">${escapeHtml(s.title)}</span>
            <span class="step-card__state">${s.complete ? "Answered" : "Not yet answered"}</span>
          </a>
        </li>`
      )
      .join("")}
  </ol>

  <div class="form-actions">
    <a class="btn btn--primary" href="${BASE}/step/${escapeAttr(progress.nextIncomplete || steps.STEP_IDS[0])}">
      ${progress.complete === 0 ? "Start" : progress.allComplete ? "Review your answers" : "Carry on"}
    </a>
    ${progress.allComplete ? `<a class="btn btn--ghost" href="${BASE}/review">Read it back</a>` : ""}
  </div>

  <p class="muted">
    <a href="${BASE}/history">See every version of your settings</a>
  </p>
`;

  return page({
    title: "Set up your receptionist",
    stageId: progress.nextIncomplete || "identity",
    progress,
    body,
    dataAttrs: ` data-version="${escapeAttr(String(version))}" data-updated-at="${escapeAttr(updatedAt || "")}" data-base="${escapeAttr(BASE)}"`,
  });
}

// ── Review ──────────────────────────────────────────────────────────

function renderSetupReview({
  summary,
  version,
  updatedAt,
  submitted = false,
  status = "draft",
  confirmations = {},
  outstandingConfirmations = [],
  outstandingSteps = [],
}) {
  const approved = status === "approved";
  const canApprove = submitted && summary.ready && outstandingConfirmations.length === 0;
  const checkedSteps = steps.STEPS.length - outstandingSteps.length;

  const body = `
  <h1>${approved ? "Your approved settings" : "Here's what we understood"}</h1>
  <p class="lead">
    ${
      approved
        ? "These are the settings we'd build your receptionist from. Any change starts a new version that you approve separately."
        : submitted
          ? "Tick each section once you've read it. Nothing is switched on until you've ticked them all and approved."
          : "Read it through. If anything's wrong, go back to that step and change it — nothing is switched on yet."
    }
  </p>

  ${renderIssueList("blocker", "Needs fixing before we can build it", summary.blockers)}
  ${renderIssueList("warning", "Worth a look, but not blocking", summary.warnings)}

  ${
    submitted && !approved
      ? `<div class="confirm-progress" role="status" aria-live="polite" id="confirm-progress">
           <p><strong>${escapeHtml(String(checkedSteps))}</strong> of <strong>${escapeHtml(String(steps.STEPS.length))}</strong> sections checked.</p>
         </div>`
      : ""
  }

  ${summary.sections.map((s) => renderReviewSection(s, { submitted, approved, outstandingSteps })).join("")}

  <section class="review-block review-block--floor" aria-labelledby="floor-heading">
    <h2 id="floor-heading">Things we will never say</h2>
    <p>These apply to every AIDA receptionist and cannot be switched off.</p>
    <ul class="floor-list">
      ${summary.safetyFloor.map((label) => `<li>${escapeHtml(label)}</li>`).join("")}
    </ul>
  </section>

  ${
    approved
      ? `<p class="notice notice--ok"><span aria-hidden="true">✓</span> Approved. See <a href="${BASE}/test">what to test</a> before going live.</p>`
      : submitted
        ? `<section class="review-decision" aria-labelledby="decision-heading">
             <h2 id="decision-heading">Ready to approve?</h2>
             <p>
               ${
                 canApprove
                   ? "You've checked every section and nothing is blocking us. Approving records your name and the time against this version."
                   : outstandingConfirmations.length
                     ? `Tick each section above first. Still to check: ${escapeHtml(outstandingSteps.map((id) => (steps.getStep(id) || { title: id }).title).join(", "))}.`
                     : "Fix the items listed above before approving."
               }
             </p>
             <div class="form-actions">
               <button type="button" class="btn btn--primary" id="approve-setup" ${canApprove ? "" : "disabled"}>
                 Approve these settings
               </button>
               <button type="button" class="btn btn--ghost" id="reopen-setup">Change something</button>
             </div>
             <p class="form-actions__note">
               Approving does not switch anything on by itself. It makes these settings the
               ones we'd build your receptionist from — your phone stays exactly as it is
               until you and we arrange the switch-over together.
             </p>
           </section>`
        : `<div class="form-actions">
             <button type="button" class="btn btn--primary" id="submit-setup" ${summary.ready ? "" : "disabled"}>
               Send for approval
             </button>
             <a class="btn btn--ghost" href="${BASE}">Back to the steps</a>
           </div>
           <p class="form-actions__note">
             ${
               summary.ready
                 ? "Approving is a separate step, and you'll tick each section one at a time before anything is built."
                 : "Fix the items above first — each one links to the step that sets it."
             }
           </p>`
  }
`;

  return page({
    title: "Check it over",
    stageId: "review",
    progress: summary.progress,
    body,
    dataAttrs: ` data-version="${escapeAttr(String(version))}" data-updated-at="${escapeAttr(updatedAt || "")}" data-base="${escapeAttr(BASE)}"`,
  });
}

function renderIssueList(kind, heading, issues) {
  if (!issues || !issues.length) {
    return kind === "blocker"
      ? `<p class="notice notice--ok"><span aria-hidden="true">✓</span> Nothing is blocking us from building your receptionist.</p>`
      : "";
  }
  return `<section class="issues issues--${kind}" aria-labelledby="issues-${kind}">
    <h2 id="issues-${kind}">${escapeHtml(heading)} (${escapeHtml(String(issues.length))})</h2>
    <ul>
      ${issues
        .map(
          (i) =>
            `<li>${escapeHtml(i.message)}${i.stepId ? ` <a class="issue-link" href="${BASE}/step/${escapeAttr(i.stepId)}">Fix this</a>` : ""}</li>`
        )
        .join("")}
    </ul>
  </section>`;
}

function renderReviewSection(section, { submitted = false, approved = false, outstandingSteps = [] } = {}) {
  const step = steps.getStep(section.id);
  const confirmed = submitted && !outstandingSteps.includes(section.id);
  const rows = step.fields
    .map((field) => {
      const shown = describeAnswer(field, steps.lookup(section.answers, field.name));
      return `<div class="answer">
        <dt>${escapeHtml(field.label)}</dt>
        <dd${shown ? "" : ' class="answer--empty"'}>${shown ? escapeHtml(shown) : "Not answered"}</dd>
      </div>`;
    })
    .join("");

  return `<section class="review-block${confirmed ? " review-block--confirmed" : ""}" aria-labelledby="rb-${escapeAttr(section.id)}" data-section="${escapeAttr(section.id)}">
    <div class="review-block__head">
      <h2 id="rb-${escapeAttr(section.id)}">${escapeHtml(section.title)}</h2>
      ${
        approved
          ? ""
          : `<a class="btn btn--small btn--ghost" href="${BASE}/step/${escapeAttr(section.id)}">Change</a>`
      }
    </div>
    ${
      section.contradictions.length
        ? `<ul class="section-issues">${section.contradictions.map((c) => `<li class="section-issue section-issue--${escapeAttr(c.severity)}">${escapeHtml(c.message)}</li>`).join("")}</ul>`
        : ""
    }
    <dl class="answers">${rows}</dl>
    ${
      submitted && !approved
        ? `<div class="section-confirm">
             <button type="button" class="btn btn--small ${confirmed ? "btn--ghost" : "btn--primary"} confirm-button"
                     data-section="${escapeAttr(section.id)}" ${confirmed ? "disabled" : ""}>
               ${confirmed ? "Checked ✓" : "I've read this and it's right"}
             </button>
           </div>`
        : ""
    }
  </section>`;
}

/**
 * Turn a stored answer into a sentence a locksmith recognises.
 *
 * Never prints a raw enum, a JSON blob or an internal id — a review page that
 * says `collect_details_for_confirmation` has not actually been read back.
 */
function describeAnswer(field, value) {
  if (value === null || value === undefined || value === "") return "";

  switch (field.kind) {
    case "bool":
      return value === true ? "Yes" : value === false ? "No" : "";

    case "select": {
      const option = (field.options || []).find((o) => String(o.value) === String(value));
      return option ? option.label : "";
    }

    case "list":
      return steps.toList(value).join(", ");

    case "checkboxes": {
      const chosen = Array.isArray(value) ? value : [];
      const labels = chosen
        .map((v) => {
          const option = (field.options || []).find((o) => o.value === v);
          return option ? option.label : null;
        })
        .filter(Boolean);
      return labels.length ? labels.join(", ") : "";
    }

    case "services": {
      const state = value && typeof value === "object" ? value : {};
      const accepted = S.SERVICE_IDS.filter((id) => steps.lookup(state, id) === "accepted").map((id) => S.SERVICE_LABELS[id]);
      const declined = S.SERVICE_IDS.filter((id) => steps.lookup(state, id) === "declined").map((id) => S.SERVICE_LABELS[id]);
      const parts = [];
      if (accepted.length) parts.push(`We take: ${accepted.join(", ")}`);
      if (declined.length) parts.push(`We never take: ${declined.join(", ")}`);
      return parts.join(". ");
    }

    case "hours": {
      const state = value && typeof value === "object" ? value : {};
      const lines = S.DAYS.map((day) => {
        const entry = steps.lookup(state, day);
        const name = day.charAt(0).toUpperCase() + day.slice(1);
        if (!entry || entry.closed) return `${name}: closed`;
        return `${name}: ${entry.open}–${entry.close}`;
      });
      return lines.join("; ");
    }

    case "estimate": {
      const state = value && typeof value === "object" ? value : {};
      const names = { standard: "Ordinary", urgent: "Urgent", afterHours: "After hours" };
      const parts = ["standard", "urgent", "afterHours"]
        .map((key) => {
          const w = steps.lookup(state, key);
          return w ? `${names[key]}: ${w.minMinutes}–${w.maxMinutes} minutes` : null;
        })
        .filter(Boolean);
      return parts.length ? parts.join("; ") : "";
    }

    default:
      return String(value);
  }
}

// ── Version history ─────────────────────────────────────────────────

function renderSetupHistory({ versions, progress }) {
  const body = `
  <h1>Every version of your settings</h1>
  <p class="lead">
    Nothing is ever deleted. Restoring an older version copies it into a new draft
    for you to read back and approve — it doesn't switch anything on by itself.
  </p>

  ${
    versions.length
      ? `<ul class="version-list">
          ${versions
            .map(
              (v) => `<li class="version version--${escapeAttr(v.status)}">
                <div class="version__head">
                  <h2>Version ${escapeHtml(String(v.version))}</h2>
                  <span class="badge badge--${escapeAttr(v.status)}">${escapeHtml(statusLabel(v.status))}</span>
                </div>
                <p class="version__meta">
                  Created ${escapeHtml(formatDate(v.createdAt))}${v.approvedAt ? `, approved ${escapeHtml(formatDate(v.approvedAt))}` : ""}.
                  ${v.supersededByVersion ? `Replaced by version ${escapeHtml(String(v.supersededByVersion))}.` : ""}
                </p>
                ${v.rejectionReason ? `<p class="version__reason">Rejected: ${escapeHtml(v.rejectionReason)}</p>` : ""}
                ${
                  v.restorable
                    ? `<button type="button" class="btn btn--small btn--ghost restore-button" data-version="${escapeAttr(String(v.version))}">Restore these settings</button>`
                    : `<p class="muted">This is the version you're editing now.</p>`
                }
              </li>`
            )
            .join("")}
        </ul>`
      : `<p class="notice notice--info">You haven't saved any settings yet.</p>`
  }

  <p class="muted"><a href="${BASE}">← Back to setup</a></p>
`;

  return page({
    title: "Version history",
    stageId: "review",
    progress,
    body,
    dataAttrs: ` data-base="${escapeAttr(BASE)}"`,
  });
}

function statusLabel(status) {
  const labels = {
    draft: "Being edited",
    needs_review: "Waiting for your approval",
    approved: "Live",
    superseded: "Replaced",
    rejected: "Rejected",
  };
  return steps.lookup(labels, status) || status;
}

function formatDate(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

// ── Test centre ─────────────────────────────────────────────────────

function renderSetupTest({ plan, testStatus, profileVersion, progress, canTest, blockers }) {
  const body = `
  <h1>Test your receptionist</h1>
  <p class="lead">
    Before it answers a real customer, ring it yourself and check it says what you
    expect. Here's what to try.
  </p>

  ${
    canTest
      ? `<p class="notice notice--ok"><span aria-hidden="true">✓</span> Your approved settings (version ${escapeHtml(String(profileVersion))}) are ready to build a test receptionist from.</p>`
      : `<div class="notice notice--blocker">
           <p>There's nothing to test yet.</p>
           <ul>${(blockers || []).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
         </div>`
  }

  <section class="test-status" aria-labelledby="test-status-heading">
    <h2 id="test-status-heading">Test status</h2>
    ${
      testStatus.total === 0
        ? `<p class="muted">No test calls have been recorded against version ${escapeHtml(String(profileVersion || "—"))} yet.</p>`
        : `<p>${escapeHtml(String(testStatus.passed))} passed, ${escapeHtml(String(testStatus.failed))} failed, ${escapeHtml(String(testStatus.pending))} not yet checked.
           ${testStatus.stale ? "These results are from an older version of your settings and no longer count." : ""}</p>`
    }
  </section>

  <section class="test-plan" aria-labelledby="test-plan-heading">
    <h2 id="test-plan-heading">What to try on the call</h2>
    ${
      plan && plan.cases && plan.cases.length
        ? `<p class="muted">${escapeHtml(String(plan.caseCount))} things to check. The starred ones are the safety cases — if any of those is wrong, stop and tell us before going live.</p>
          <ol class="checklist">
            ${plan.cases
              .map((c) => {
                const isSafety = (plan.safetyCaseIds || []).includes(c.id);
                return `<li class="checklist__item${isSafety ? " checklist__item--safety" : ""}">
                  <h3 class="checklist__title">${escapeHtml(c.title)}${isSafety ? ' <span class="safety-flag">safety check</span>' : ""}</h3>
                  <p class="checklist__say"><strong>Try this:</strong> ${escapeHtml(c.scenario)}</p>
                  ${renderExpectations(c.expectations)}
                  <p class="checklist__pass"><strong>It passes if:</strong> ${escapeHtml(c.passCriteria)}</p>
                </li>`;
              })
              .join("")}
          </ol>`
        : `<p class="muted">A checklist appears once your settings are approved.</p>`
    }
  </section>

  <p class="muted"><a href="${BASE}">← Back to setup</a></p>
`;

  return page({ title: "Test your receptionist", stageId: "test", progress, body, dataAttrs: ` data-base="${escapeAttr(BASE)}"` });
}

/**
 * Turn the plan's expectation kinds into instructions a person can follow on a
 * phone call. `must_not_say` is rendered separately and last, because "what you
 * should never hear" is the half of a test people skip.
 */
const EXPECTATION_LEAD = Object.freeze({
  must_ask: "It should ask for",
  must_classify: "It should treat this as",
  must_transfer: "It should put you through to",
  must_refuse: "It should decline",
  must_capture: "It should write down",
});

function renderExpectations(expectations) {
  const list = Array.isArray(expectations) ? expectations : [];
  const positives = list.filter((e) => e.kind !== "must_not_say");
  const negatives = list.filter((e) => e.kind === "must_not_say");
  const detail = (d) => (Array.isArray(d) ? d.join(", ") : String(d == null ? "" : d));

  return `${
    positives.length
      ? `<ul class="checklist__expect">${positives
          .map((e) => `<li>${escapeHtml(steps.lookup(EXPECTATION_LEAD, e.kind) || "It should")} ${escapeHtml(detail(e.detail))}.</li>`)
          .join("")}</ul>`
      : ""
  }${
    negatives.length
      ? `<ul class="checklist__never"><li class="never-heading">You should never hear:</li>${negatives
          .map((e) => `<li>${escapeHtml(detail(e.detail))}</li>`)
          .join("")}</ul>`
      : ""
  }`;
}

// ── Activation ──────────────────────────────────────────────────────

/**
 * The go-live page.
 *
 * `blockers` are things the client can act on. `nextSteps` are things WE do —
 * kept separate because an earlier version listed the phone switch-over as a
 * blocker, which made the blocker list permanently non-empty, the "ready" branch
 * permanently dead, and the button permanently labelled "Not ready yet" even
 * for a client who had done everything asked of them.
 *
 * The control stays disabled either way. Switching a real business's phone over
 * is arranged on a call with a person, and a button that claims to do it would
 * be the page's one dishonest element.
 */
function renderSetupActivate({ readiness, progress, blockers, nextSteps = [] }) {
  const body = `
  <h1>Going live</h1>
  <p class="lead">
    Your receptionist answers real customers only once every item below is done and
    you've asked us to switch it on. Nothing here happens automatically.
  </p>

  <section class="gates" aria-labelledby="gates-heading">
    <h2 id="gates-heading">What still has to happen</h2>
    ${
      blockers.length
        ? `<ul class="gate-list">
            ${blockers
              .map(
                (b) => `<li class="gate gate--blocked">
                  <span class="gate__label">${escapeHtml(b.label)}</span>
                  <span class="gate__detail">${escapeHtml(b.detail)}</span>
                  ${b.stepId ? `<a class="issue-link" href="${BASE}/step/${escapeAttr(b.stepId)}">Fix this</a>` : ""}
                </li>`
              )
              .join("")}
          </ul>`
        : `<p class="notice notice--ok"><span aria-hidden="true">✓</span> Everything we need from you is done.</p>`
    }
  </section>

  <section class="activation" aria-labelledby="activation-heading">
    <h2 id="activation-heading">Switching on</h2>
    <p>
      Going live is done with you, not to you. When you're ready, we book a short call,
      switch your number over together, and stay on the line while you test it.
    </p>

    ${
      nextSteps.length
        ? `<h3>What happens next</h3>
           <ul class="gate-list">
             ${nextSteps
               .map(
                 (s) => `<li class="gate gate--next">
                   <span class="gate__label">${escapeHtml(s.label)}</span>
                   <span class="gate__detail">${escapeHtml(s.detail)}</span>
                 </li>`
               )
               .join("")}
           </ul>`
        : ""
    }

    <p class="muted">
      Your previous settings stay saved. If anything is wrong after going live you can
      restore an earlier version from your
      <a href="${BASE}/history">version history</a> at any time.
    </p>

    <button type="button" class="btn btn--primary" id="request-activation" disabled>
      ${blockers.length ? "Not ready yet" : "We'll book your switch-over"}
    </button>
    <p class="form-actions__note">
      ${
        blockers.length
          ? "Clear the list above and we'll get in touch to book your switch-over."
          : "Nothing left for you to do. We'll be in touch to book it in — your phone keeps working exactly as it does now until then."
      }
    </p>
  </section>

  <p class="muted"><a href="${BASE}">← Back to setup</a></p>
`;

  return page({ title: "Going live", stageId: "activate", progress, body, dataAttrs: ` data-base="${escapeAttr(BASE)}"` });
}

module.exports = {
  BASE,
  renderSetupStep,
  renderSetupHome,
  renderSetupReview,
  renderSetupHistory,
  renderSetupTest,
  renderSetupActivate,
  renderStageNav,
  renderField,
  describeAnswer,
  statusLabel,
};
