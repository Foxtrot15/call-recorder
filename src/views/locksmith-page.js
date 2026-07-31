// AIDA Locksmith Receptionist — public page renderer (M1).
//
// A pure function: (config, demo data, field contract) → HTML string. No
// Express, no filesystem, no template engine, no frontend framework — the repo
// serves plain HTML with a separate stylesheet, and this keeps that convention
// while letting the page read its values from src/config/locksmith.js instead
// of hardcoding them (the reason it is rendered rather than a static file in
// public/).
//
// Every interpolated value goes through escapeHtml. The page never echoes
// submitted form input back into HTML — the enquiry endpoint answers JSON and
// the client script writes messages with textContent — so there is no path
// from user input to markup at all.
//
// Accessibility contract enforced by test/locksmith-page.test.js:
//   - one <h1>; sections use <h2>, sub-items <h3>; no level is skipped
//   - <header>/<nav>/<main>/<footer> landmarks, each section labelled by its
//     heading via aria-labelledby
//   - every input has a <label for>; groups use <fieldset>/<legend>
//   - urgency is never colour-only: each badge carries a text label and a
//     non-colour marker
//   - the recent-calls table declares scope="col" headers and per-cell
//     data-label values, so the mobile stacked layout keeps every column

const { escapeHtml, escapeAttr } = require("./escape");

// ── Small building blocks ───────────────────────────────────────────

function urgencyBadge(urgency) {
  // marker + label: readable without colour, announced as text by a screen
  // reader. aria-hidden on the marker avoids "exclamation exclamation Urgent".
  return (
    `<span class="urgency urgency--${escapeAttr(urgency.key)}">` +
    `<span class="urgency__marker" aria-hidden="true">${escapeHtml(urgency.marker)}</span>` +
    `<span class="urgency__label">${escapeHtml(urgency.label)}</span>` +
    `</span>`
  );
}

function demoTag(label) {
  return `<p class="demo-tag"><span class="demo-tag__dot" aria-hidden="true">●</span> ${escapeHtml(label)}</p>`;
}

function money(currency, amount) {
  return `${escapeHtml(currency)}${escapeHtml(String(amount))}`;
}

// ── 1. Hero ─────────────────────────────────────────────────────────

function renderHero(config) {
  // The demo CTA is only a real tel: link once a number exists. Until then it
  // renders as a visibly unavailable control plus the placeholder marker from
  // config — the page must never show an invented number.
  const demoCta = config.cta.demoHref
    ? `<a class="btn btn--primary" href="${escapeAttr(config.cta.demoHref)}">` +
      `${escapeHtml(config.cta.demoLabel)} <span class="btn__sub">${escapeHtml(config.demoPhone)}</span></a>`
    : `<span class="btn btn--primary btn--pending" role="note" aria-describedby="demo-cta-note">` +
      `${escapeHtml(config.cta.demoLabel)}</span>`;

  const demoNote = config.cta.demoHref
    ? ""
    : `<p class="hero__note" id="demo-cta-note">Demo line not connected yet — ` +
      `<span class="placeholder">${escapeHtml(config.demoPhone)}</span>. ` +
      `Join the pilot below and we'll call you instead.</p>`;

  return `
    <section class="hero" aria-labelledby="hero-heading">
      <p class="eyebrow">${escapeHtml(config.productName)} · by ${escapeHtml(config.providerName)}</p>
      <h1 id="hero-heading">${escapeHtml(config.tagline)}</h1>
      <p class="hero__lead">
        AIDA answers missed and after-hours calls, captures the customer's location
        and lock problem, and escalates urgent jobs according to your rules.
      </p>
      <div class="hero__ctas">
        ${demoCta}
        <a class="btn btn--secondary" href="${escapeAttr(config.cta.pilotAnchor)}">${escapeHtml(config.cta.pilotLabel)}</a>
      </div>
      ${demoNote}
      <ul class="hero__points">
        <li>Fewer missed enquiries</li>
        <li>More after-hours jobs captured</li>
        <li>Urgent calls escalated quickly</li>
        <li>No night receptionist to employ</li>
      </ul>
    </section>`;
}

// ── 2. How it works ─────────────────────────────────────────────────

function renderHowItWorks(steps) {
  const items = steps
    .map(
      (s) => `
        <li class="step">
          <span class="step__number" aria-hidden="true">${escapeHtml(String(s.step))}</span>
          <h3 class="step__title">${escapeHtml(s.title)}</h3>
          <p class="step__detail">${escapeHtml(s.detail)}</p>
        </li>`
    )
    .join("");

  return `
    <section id="how-it-works" class="section" aria-labelledby="how-it-works-heading">
      <h2 id="how-it-works-heading">How it works</h2>
      <p class="section__lead">Five steps, from the customer's call to the summary in your inbox.</p>
      <ol class="steps">${items}</ol>
    </section>`;
}

// ── 3. Scenarios ────────────────────────────────────────────────────

function renderScenarios(scenarios, demoLabel) {
  const cards = scenarios
    .map(
      (s) => `
        <article class="card scenario" aria-labelledby="scenario-${escapeAttr(s.id)}-heading">
          ${demoTag(s.demoLabel)}
          <h3 id="scenario-${escapeAttr(s.id)}-heading">${escapeHtml(s.title)}</h3>
          <dl class="facts">
            <div class="facts__row"><dt>Caller</dt><dd>${escapeHtml(s.caller)}</dd></div>
            <div class="facts__row"><dt>Suburb</dt><dd>${escapeHtml(s.suburb)}</dd></div>
            <div class="facts__row"><dt>Job type</dt><dd>${escapeHtml(s.jobType)}</dd></div>
            <div class="facts__row"><dt>Urgency</dt><dd>${urgencyBadge(s.urgency)}</dd></div>
          </dl>
          <p class="scenario__summary">${escapeHtml(s.summary)}</p>
          <p class="scenario__action"><strong>Action taken:</strong> ${escapeHtml(s.action)}</p>
        </article>`
    )
    .join("");

  return `
    <section id="scenarios" class="section" aria-labelledby="scenarios-heading">
      <h2 id="scenarios-heading">Locksmith scenarios</h2>
      <p class="section__lead">
        Four situations AIDA is set up to handle. ${escapeHtml(demoLabel)} — these are
        illustrations, not records of real customers.
      </p>
      <div class="grid grid--2">${cards}</div>
    </section>`;
}

// ── 4. Capabilities ─────────────────────────────────────────────────

function renderCapabilities(capabilities) {
  const items = capabilities
    .map(
      (c) => `
        <li class="capability">
          <h3 class="capability__title">${escapeHtml(c.title)}</h3>
          <p class="capability__detail">${escapeHtml(c.detail)}</p>
        </li>`
    )
    .join("");

  return `
    <section id="capabilities" class="section" aria-labelledby="capabilities-heading">
      <h2 id="capabilities-heading">What AIDA does</h2>
      <p class="section__lead">Everything below is part of the pilot build. Nothing here needs new hardware.</p>
      <ul class="grid grid--3 capabilities">${items}</ul>
    </section>`;
}

// ── 5. Example calls ────────────────────────────────────────────────

function renderExampleCalls(calls, demoLabel) {
  const cards = calls
    .map((call) => {
      const lines = call.transcript
        .map(
          (line) => `
            <li class="line line--${line.speaker === "AIDA" ? "aida" : "caller"}">
              <span class="line__speaker">${escapeHtml(line.speaker)}</span>
              <span class="line__text">${escapeHtml(line.text)}</span>
            </li>`
        )
        .join("");

      // <details> keeps long transcripts from burying the summary on a phone,
      // and is keyboard-operable natively — no hover, no custom JS.
      return `
        <article class="card example" aria-labelledby="example-${escapeAttr(call.id)}-heading">
          ${demoTag(`Example call — ${call.demoLabel.toLowerCase()}`)}
          <h3 id="example-${escapeAttr(call.id)}-heading">${escapeHtml(call.scenario)}</h3>
          <p class="example__meta">${urgencyBadge(call.urgency)} <span class="example__outcome">${escapeHtml(call.outcome)}</span></p>
          <details class="transcript">
            <summary>Read the example transcript</summary>
            <ol class="lines">${lines}</ol>
            <p class="transcript__note">Mock script written for illustration. No audio recording is attached to this example.</p>
          </details>
          <dl class="facts">
            <div class="facts__row"><dt>Summary</dt><dd>${escapeHtml(call.summary)}</dd></div>
            <div class="facts__row"><dt>Outcome</dt><dd>${escapeHtml(call.outcome)}</dd></div>
            <div class="facts__row"><dt>Action taken</dt><dd>${escapeHtml(call.action)}</dd></div>
          </dl>
        </article>`;
    })
    .join("");

  return `
    <section id="example-calls" class="section" aria-labelledby="example-calls-heading">
      <h2 id="example-calls-heading">Example calls</h2>
      <p class="section__lead">
        ${escapeHtml(demoLabel)}. Every transcript below is a mock script — no real
        call, caller or recording is shown.
      </p>
      <div class="grid grid--2">${cards}</div>
    </section>`;
}

// ── 6. Dashboard preview ────────────────────────────────────────────

function renderDashboard(dashboard) {
  const metrics = dashboard.metrics
    .map(
      (m) => `
        <li class="metric">
          <span class="metric__value">${escapeHtml(String(m.value))}</span>
          <span class="metric__label">${escapeHtml(m.label)}</span>
          <span class="metric__detail">${escapeHtml(m.detail)}</span>
        </li>`
    )
    .join("");

  // Responsive table, not a hidden-column table: at narrow widths CSS stacks
  // each row into a block and the data-label on every cell supplies the column
  // name in-place. No column is ever dropped.
  const rows = dashboard.recentCalls
    .map(
      (c) => `
        <tr>
          <td data-label="Date and time">${escapeHtml(c.when)}</td>
          <td data-label="Caller">${escapeHtml(c.caller)}</td>
          <td data-label="Suburb">${escapeHtml(c.suburb)}</td>
          <td data-label="Service type">${escapeHtml(c.serviceType)}</td>
          <td data-label="Urgency">${urgencyBadge(c.urgency)}</td>
          <td data-label="Outcome">${escapeHtml(c.outcome)}</td>
          <td data-label="Summary">${escapeHtml(c.summary)}</td>
        </tr>`
    )
    .join("");

  return `
    <section id="dashboard" class="section" aria-labelledby="dashboard-heading">
      <h2 id="dashboard-heading">What you see afterwards</h2>
      <div class="dashboard" role="group" aria-labelledby="dashboard-workspace-label">
        <p class="dashboard__label" id="dashboard-workspace-label">
          <span class="demo-tag__dot" aria-hidden="true">●</span> ${escapeHtml(dashboard.label)}
        </p>
        <p class="dashboard__period">${escapeHtml(dashboard.period)} · figures are illustrative and do not represent any real business.</p>
        <ul class="metrics">${metrics}</ul>
        <h3 class="dashboard__subheading" id="recent-calls-heading">Recent calls</h3>
        <div class="table-scroll">
          <table class="calls" aria-labelledby="recent-calls-heading">
            <caption class="visually-hidden">Example locksmith calls — demonstration data only</caption>
            <thead>
              <tr>
                <th scope="col">Date and time</th>
                <th scope="col">Caller</th>
                <th scope="col">Suburb</th>
                <th scope="col">Service type</th>
                <th scope="col">Urgency</th>
                <th scope="col">Outcome</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </section>`;
}

// ── 7. Pricing ──────────────────────────────────────────────────────

function renderPricing(config) {
  const { pricing, pilot } = config;
  return `
    <section id="pricing" class="section" aria-labelledby="pricing-heading">
      <h2 id="pricing-heading">Founding pilot pricing</h2>
      <p class="section__lead">Provisional pricing for the first ${escapeHtml(String(pilot.limit))} ${escapeHtml(pilot.region)} ${escapeHtml(pilot.audience)}.</p>
      <div class="card pricing">
        <ul class="pricing__lines">
          <li><span class="pricing__label">Setup</span><span class="pricing__value">${money(pricing.currency, pricing.setupAmount)} once</span></li>
          <li><span class="pricing__label">First ${escapeHtml(String(pricing.includedDays))} days</span><span class="pricing__value">Included</span></li>
          <li><span class="pricing__label">Ongoing</span><span class="pricing__value">${money(pricing.currency, pricing.monthlyAmount)} per month</span></li>
          <li><span class="pricing__label">Usage allowance and overage</span><span class="pricing__value">${escapeHtml(pricing.usageAllowance)}</span></li>
          <li><span class="pricing__label">Commitment</span><span class="pricing__value">${escapeHtml(pricing.commitment)}</span></li>
        </ul>
        <p class="pricing__note">
          Provisional founding-pilot pricing, limited to the first
          ${escapeHtml(String(pilot.limit))} ${escapeHtml(pilot.region)} ${escapeHtml(pilot.audience)}.
          Confirmed in writing before anything starts. No payment is taken on this page.
        </p>
        <a class="btn btn--secondary" href="${escapeAttr(config.cta.pilotAnchor)}">${escapeHtml(config.cta.pilotLabel)}</a>
      </div>
    </section>`;
}

// ── 8. Enquiry form ─────────────────────────────────────────────────

function renderField(field) {
  const id = `f-${field.name}`;
  // The error slot is named in aria-describedby from the start (it's empty
  // until validation fills it), so a screen reader reads the message when
  // focus lands on the field — not only from the error summary.
  const describedBy = ` aria-describedby="${escapeAttr(
    [field.hint ? `${id}-hint` : null, `${id}-error`].filter(Boolean).join(" ")
  )}"`;
  const hint = field.hint ? `<p class="hint" id="${escapeAttr(`${id}-hint`)}">${escapeHtml(field.hint)}</p>` : "";
  const req = field.required
    ? ` <span class="req">(required)</span>`
    : ` <span class="opt">(optional)</span>`;
  const requiredAttr = field.required ? " required" : "";
  const maxAttr = field.maxLength ? ` maxlength="${escapeAttr(String(field.maxLength))}"` : "";
  const autocomplete = field.autocomplete ? ` autocomplete="${escapeAttr(field.autocomplete)}"` : "";
  const errorId = `${id}-error`;
  const errorSlot = `<p class="field__error" id="${escapeAttr(errorId)}" data-error-for="${escapeAttr(field.name)}"></p>`;

  if (field.type === "consent") {
    return `
      <div class="field field--check" data-field="${escapeAttr(field.name)}" data-summary-label="${escapeAttr(field.summaryLabel || field.label)}">
        <div class="check">
          <!-- value must be one isChecked() accepts: a plain form POST sends
               this string verbatim, with no JavaScript involved. -->
          <input type="checkbox" id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" value="true"${requiredAttr}${describedBy}>
          <label for="${escapeAttr(id)}">${escapeHtml(field.label)}${req}</label>
        </div>
        ${hint}
        ${errorSlot}
      </div>`;
  }

  if (field.type === "checkboxes" || field.type === "radio") {
    const inputType = field.type === "radio" ? "radio" : "checkbox";
    const options = field.options
      .map((o, i) => {
        const optId = `${id}-${o.value}`;
        return `
          <div class="check">
            <input type="${inputType}" id="${escapeAttr(optId)}" name="${escapeAttr(field.name)}" value="${escapeAttr(o.value)}"${
              inputType === "radio" && field.required && i === 0 ? " required" : ""
            }>
            <label for="${escapeAttr(optId)}">${escapeHtml(o.label)}</label>
          </div>`;
      })
      .join("");
    return `
      <fieldset class="field field--group" data-field="${escapeAttr(field.name)}" data-summary-label="${escapeAttr(field.summaryLabel || field.label)}">
        <legend>${escapeHtml(field.label)}${req}</legend>
        ${hint}
        <div class="checks">${options}</div>
        ${errorSlot}
      </fieldset>`;
  }

  if (field.type === "select") {
    const options = field.options
      .map((o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    return `
      <div class="field" data-field="${escapeAttr(field.name)}" data-summary-label="${escapeAttr(field.summaryLabel || field.label)}">
        <label for="${escapeAttr(id)}">${escapeHtml(field.label)}${req}</label>
        ${hint}
        <select id="${escapeAttr(id)}" name="${escapeAttr(field.name)}"${requiredAttr}${describedBy}>
          <option value="">Please choose…</option>
          ${options}
        </select>
        ${errorSlot}
      </div>`;
  }

  if (field.type === "textarea") {
    return `
      <div class="field" data-field="${escapeAttr(field.name)}" data-summary-label="${escapeAttr(field.summaryLabel || field.label)}">
        <label for="${escapeAttr(id)}">${escapeHtml(field.label)}${req}</label>
        ${hint}
        <textarea id="${escapeAttr(id)}" name="${escapeAttr(field.name)}" rows="4"${maxAttr}${requiredAttr}${describedBy}></textarea>
        ${errorSlot}
      </div>`;
  }

  return `
    <div class="field" data-field="${escapeAttr(field.name)}" data-summary-label="${escapeAttr(field.summaryLabel || field.label)}">
      <label for="${escapeAttr(id)}">${escapeHtml(field.label)}${req}</label>
      ${hint}
      <input type="${escapeAttr(field.type)}" id="${escapeAttr(id)}" name="${escapeAttr(field.name)}"${maxAttr}${requiredAttr}${autocomplete}${describedBy}>
      ${errorSlot}
    </div>`;
}

function renderEnquiryForm(config, fields) {
  const disabledNotice = config.flags.enquiryEnabled
    ? ""
    : `<p class="notice" role="note">
         <strong>Online enquiries aren't switched on yet.</strong>
         The pilot is still being set up, so this form won't record your details.
         Use the contact details in the footer and we'll come straight back to you.
       </p>`;

  return `
    <section id="pilot-enquiry" class="section" aria-labelledby="pilot-enquiry-heading">
      <h2 id="pilot-enquiry-heading">${escapeHtml(config.cta.pilotLabel)}</h2>
      <p class="section__lead">
        Tell us how your calls work now. We'll confirm whether the pilot suits your
        business before anything is set up.
      </p>
      ${disabledNotice}
      <div class="card form-card">
        <noscript>
          <p class="notice">This form needs JavaScript to submit. Please use the contact details in the footer instead.</p>
        </noscript>

        <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>

        <div class="error-summary" id="error-summary" role="alert" tabindex="-1" hidden>
          <h3 class="error-summary__title">There's a problem with this form</h3>
          <ul class="error-summary__list" id="error-summary-list"></ul>
        </div>

        <form id="pilot-form" method="post" action="${escapeAttr(config.enquiryPath)}" novalidate>
          ${fields.map(renderField).join("")}
          <button type="submit" class="btn btn--primary btn--block" id="pilot-submit">${escapeHtml(config.cta.pilotLabel)}</button>
          <p class="form-footnote">
            We use these details only to respond to this enquiry. No payment is taken on this page.
          </p>
        </form>
      </div>
    </section>`;
}

// ── 9. Trust + footer ───────────────────────────────────────────────

function trustValue(value, config) {
  const { isPlaceholder } = require("../config/locksmith");
  return isPlaceholder(value)
    ? `<span class="placeholder">${escapeHtml(value)}</span>`
    : escapeHtml(value);
}

function trustLink(value, label) {
  const { isPlaceholder } = require("../config/locksmith");
  return isPlaceholder(value)
    ? `<span class="placeholder">${escapeHtml(label)}: ${escapeHtml(value)}</span>`
    : `<a href="${escapeAttr(value)}">${escapeHtml(label)}</a>`;
}

function renderFooter(config) {
  const { trust } = config;
  const emailLine = config.trust.contactEmail.startsWith("[")
    ? trustValue(trust.contactEmail, config)
    : `<a href="mailto:${escapeAttr(trust.contactEmail)}">${escapeHtml(trust.contactEmail)}</a>`;

  return `
    <footer class="footer" aria-labelledby="footer-heading">
      <h2 id="footer-heading" class="visually-hidden">About ${escapeHtml(config.providerName)} and this service</h2>
      <div class="footer__grid">
        <div>
          <p class="footer__brand">${escapeHtml(config.productName)}</p>
          <p class="footer__provider">A service of ${escapeHtml(config.providerName)}</p>
          <p class="footer__line">ABN: ${trustValue(trust.abn, config)}</p>
          <p class="footer__line">Contact: ${emailLine}</p>
          <p class="footer__line">${escapeHtml(trust.contactRegion)}</p>
        </div>
        <div>
          <p class="footer__line">${trustLink(trust.privacyUrl, "Privacy policy")}</p>
          <p class="footer__line">${trustLink(trust.termsUrl, "Terms")}</p>
        </div>
      </div>
      <div class="footer__disclosures">
        <p>${escapeHtml(trust.aiDisclosure)}</p>
        <p>${escapeHtml(trust.rulesDisclosure)}</p>
        <p>All calls, callers, suburbs, transcripts and dashboard figures shown on this page are demonstration data.</p>
      </div>
    </footer>`;
}

// ── Page shell ──────────────────────────────────────────────────────

function renderLocksmithPage({ config, demo, fields }) {
  const title = `${config.productName} — ${config.tagline}`;
  const description =
    "AIDA answers missed and after-hours locksmith calls, captures the customer's " +
    "location and lock problem, and escalates urgent jobs according to your rules.";

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeAttr(description)}">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/locksmith/locksmith.css">
</head>
<body class="locksmith">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">${escapeHtml(config.productName)}</span>
    <span class="site-header__provider">by ${escapeHtml(config.providerName)}</span>
  </p>
  <nav class="site-nav" aria-label="Page sections">
    <ul>
      <li><a href="#how-it-works">How it works</a></li>
      <li><a href="#example-calls">Example calls</a></li>
      <li><a href="#pricing">Pricing</a></li>
      <li><a href="${escapeAttr(config.cta.pilotAnchor)}">Join the pilot</a></li>
    </ul>
  </nav>
</header>

<main id="main">
${renderHero(config)}
${renderHowItWorks(demo.HOW_IT_WORKS)}
${renderScenarios(demo.SCENARIOS, demo.DEMO_LABEL)}
${renderCapabilities(demo.CAPABILITIES)}
${renderExampleCalls(demo.EXAMPLE_CALLS, demo.DEMO_LABEL)}
${renderDashboard(demo.DASHBOARD)}
${renderPricing(config)}
${renderEnquiryForm(config, fields)}
</main>

${renderFooter(config)}
<script src="/locksmith/locksmith.js" defer></script>
</body>
</html>
`;
}

module.exports = { renderLocksmithPage };
