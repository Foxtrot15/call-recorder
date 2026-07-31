// AIDA — client onboarding-call page (M4).
//
//   "Talk with AIDA to configure your receptionist"
//
// Behind requireClientAuth. Shows where the locksmith is in the journey, takes
// their consent, and lets them ask for the call.
//
// TRUTHFULNESS RULES
//   * When the provider is disabled, the page says so plainly. It never shows a
//     "Call me" button that would silently do nothing.
//   * Consent boxes are NEVER pre-ticked. The markup has no `checked` attribute
//     on any consent input, and a test asserts it.
//   * The destination number is shown back in full so the client can check it.
//   * Recording is presented as separate from transcription, and as optional.
//   * Core status is readable without JavaScript — the timeline and state are
//     server-rendered.

const { escapeHtml, escapeAttr } = require("./escape");

// The journey, in the order a client experiences it.
const JOURNEY_STATES = Object.freeze([
  { key: "not_ready", label: "Not ready yet", detail: "We're still getting your account set up." },
  { key: "ready_to_request", label: "Ready to start", detail: "Confirm your number and we'll ring you." },
  { key: "consent_required", label: "Needs your go-ahead", detail: "Confirm your number and tick the boxes." },
  { key: "call_queued", label: "Call requested", detail: "We're about to ring you." },
  { key: "dialling", label: "Ringing you now", detail: "Answer when your phone rings." },
  { key: "connected", label: "On the call", detail: "AIDA is talking with you now." },
  { key: "completed", label: "Call finished", detail: "Writing up your answers." },
  { key: "transcript_processing", label: "Writing up your answers", detail: "This usually takes under a minute." },
  { key: "needs_review", label: "Ready for you to check", detail: "Read what AIDA understood and approve it." },
  { key: "approved", label: "Approved", detail: "You've approved your settings." },
  { key: "provisioning_ready", label: "Being prepared", detail: "Your receptionist configuration is being prepared." },
  { key: "failed", label: "Something went wrong", detail: "We'll help you sort it out." },
  { key: "cancelled", label: "Cancelled", detail: "This setup was cancelled." },
]);

function stateIndex(key) {
  return JOURNEY_STATES.findIndex((s) => s.key === key);
}

function renderTimeline(currentState) {
  const current = stateIndex(currentState);
  // The linear part of the journey; failure states are shown separately.
  const shown = JOURNEY_STATES.filter((s) => !["failed", "cancelled", "consent_required"].includes(s.key));
  return `<ol class="timeline">${shown
    .map((state) => {
      const idx = stateIndex(state.key);
      const status = idx < current ? "done" : idx === current ? "current" : "todo";
      const marker = status === "done" ? "✓" : status === "current" ? "▶" : "○";
      return `<li class="timeline__step timeline__step--${escapeAttr(status)}"${status === "current" ? ' aria-current="step"' : ""}>
        <span class="timeline__marker" aria-hidden="true">${marker}</span>
        <span class="timeline__label">${escapeHtml(state.label)}</span>
        ${status === "current" ? `<span class="timeline__detail">${escapeHtml(state.detail)}</span>` : ""}
      </li>`;
    })
    .join("")}</ol>`;
}

function renderAvailability({ providerAvailable, mode, reasons }) {
  if (providerAvailable) return "";
  // Truthful, not apologetic-and-vague. The client is told the honest state.
  return `<div class="notice notice--blocking" role="note">
    <strong>Setup calls aren't switched on yet.</strong>
    <p>You can review everything here, but AIDA can't ring you until we finish connecting the phone system.
    ${mode === "mock" ? "This account is in demonstration mode." : "We'll let you know as soon as it's ready."}</p>
    ${reasons && reasons.length ? `<p class="note-inline">Technical status: ${escapeHtml(reasons.join("; "))}</p>` : ""}
  </div>`;
}

function renderConsentForm({ disclosure, destinationNumber, existingConsent, canRequest }) {
  const number = destinationNumber || "";
  return `
    <form id="consent-form" class="card form-card" method="post" action="#" novalidate>
      <h3>Confirm your number</h3>
      <p class="note-inline">This is the number AIDA will ring. Check it carefully.</p>

      <div class="field" data-field="destinationNumber">
        <label for="destination-number">Number to ring</label>
        <input type="tel" id="destination-number" name="destinationNumber"
               value="${escapeAttr(number)}" maxlength="40" autocomplete="tel" required
               aria-describedby="destination-number-hint">
        <p class="hint" id="destination-number-hint">Australian mobile or landline, e.g. 04XX XXX XXX.</p>
        <p class="field__error" data-error-for="destinationNumber"></p>
      </div>

      <h3>Your go-ahead</h3>
      <div class="field field--check" data-field="callConsent">
        <div class="check">
          <!-- No checked attribute anywhere: a pre-ticked consent is not consent. -->
          <input type="checkbox" id="consent-call" name="callConsent" value="true" required>
          <label for="consent-call">${escapeHtml(disclosure.callConsent)}</label>
        </div>
        <p class="field__error" data-error-for="callConsent"></p>
      </div>

      <div class="field field--check" data-field="transcriptionConsent">
        <div class="check">
          <input type="checkbox" id="consent-transcription" name="transcriptionConsent" value="true" required>
          <label for="consent-transcription">${escapeHtml(disclosure.transcriptionConsent)}</label>
        </div>
        <p class="field__error" data-error-for="transcriptionConsent"></p>
      </div>

      <div class="field field--check" data-field="recordingConsent">
        <div class="check">
          <input type="checkbox" id="consent-recording" name="recordingConsent" value="true">
          <label for="consent-recording">${escapeHtml(disclosure.recordingConsent)} <span class="opt">(optional)</span></label>
        </div>
      </div>

      <p class="note-inline">${escapeHtml(disclosure.notMarketing)}</p>

      <button type="submit" class="btn btn--primary btn--block" id="request-call" ${canRequest ? "" : "disabled"}>
        ${canRequest ? "Ask AIDA to ring me" : "Not available yet"}
      </button>
      ${
        existingConsent
          ? `<p class="note-inline">You gave permission for ${escapeHtml(existingConsent.destinationNumber)} — ${escapeHtml(String(existingConsent.attemptsRemaining))} attempt(s) left.
             <button type="button" class="btn btn--small btn--danger-ghost" id="revoke-consent">Withdraw permission</button></p>`
          : ""
      }
    </form>`;
}

function renderCallStatus(call) {
  if (!call) return "";
  return `<div class="card">
    <h3>Your call</h3>
    <dl class="facts">
      <div class="fact"><dt>Status</dt><dd><span class="value">${escapeHtml(call.status)}</span></dd></div>
      <div class="fact"><dt>Number</dt><dd><span class="value">${escapeHtml(call.destinationNumberMasked || "—")}</span></dd></div>
      ${call.startedAt ? `<div class="fact"><dt>Started</dt><dd><span class="value">${escapeHtml(call.startedAt)}</span></dd></div>` : ""}
      ${call.endedAt ? `<div class="fact"><dt>Finished</dt><dd><span class="value">${escapeHtml(call.endedAt)}</span></dd></div>` : ""}
      ${call.endReason ? `<div class="fact"><dt>Outcome</dt><dd><span class="value">${escapeHtml(call.endReason)}</span></dd></div>` : ""}
      ${call.failureCode ? `<div class="fact"><dt>Problem</dt><dd><span class="value value--missing">${escapeHtml(call.failureCode)}</span></dd></div>` : ""}
    </dl>
  </div>`;
}

function renderCallPage({
  clientId,
  session,
  state,
  disclosure,
  destinationNumber = null,
  existingConsent = null,
  call = null,
  providerAvailable = false,
  providerMode = "disabled",
  providerReasons = [],
  reviewUrl = null,
  provisioningStatus = null,
  isDemo = false,
}) {
  const canRequest = providerAvailable && ["ready_to_request", "consent_required", "failed"].includes(state);

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Set up your AIDA receptionist</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
</head>
<body class="locksmith locksmith-call">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA Locksmith Receptionist</span>
    <span class="site-header__provider">Setup</span>
  </p>
</header>

<main id="main" data-session-id="${escapeAttr(session ? session.sessionId : "")}" data-state="${escapeAttr(state)}">
  <h1>Talk with AIDA to configure your receptionist</h1>
  <p class="lead">
    AIDA rings you and asks how your business runs — what work you take, where you go,
    your hours, and what counts as urgent. It takes about ten minutes.
  </p>

  ${isDemo ? '<p class="demo-banner"><span aria-hidden="true">●</span> Demonstration data — this is an example setup, not a real business.</p>' : ""}

  <div class="card">
    <h2>What to expect</h2>
    <ul class="value-list">
      <li>The interview usually covers your services, service areas, hours and how urgent calls should be handled.</li>
      <li>AIDA will repeat the important details back to you, and read any phone number out digit by digit.</li>
      <li><strong>The call will be transcribed</strong> so your answers can be written up.</li>
      <li>Recording the audio is a separate, optional choice and follows whatever you set here.</li>
      <li><strong>Nothing goes live until you've read what AIDA understood and approved it.</strong></li>
    </ul>
  </div>

  ${renderAvailability({ providerAvailable, mode: providerMode, reasons: providerReasons })}

  <section aria-labelledby="progress-heading">
    <h2 id="progress-heading">Where you're up to</h2>
    ${renderTimeline(state)}
  </section>

  <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>

  ${
    ["needs_review", "approved", "provisioning_ready"].includes(state)
      ? `<div class="card">
           <h2>Your settings</h2>
           ${
             state === "needs_review"
               ? `<p>AIDA has written up your answers. Have a read and tell us if anything's wrong.</p>
                  ${reviewUrl ? `<a class="btn btn--primary" href="${escapeAttr(reviewUrl)}">Review what AIDA understood</a>` : ""}`
               : state === "approved"
                 ? "<p>You've approved your settings. We're getting your receptionist ready.</p>"
                 : `<p>${escapeHtml(provisioningStatus || "Your receptionist configuration has been approved and is being prepared.")}</p>`
           }
         </div>`
      : renderConsentForm({ disclosure, destinationNumber, existingConsent, canRequest })
  }

  ${renderCallStatus(call)}

  ${
    state === "failed"
      ? `<div class="notice notice--blocking"><strong>That call didn't work out.</strong>
           <p>Nothing is lost. Check your number and ask us to try again, or get in touch and we'll ring you the old-fashioned way.</p></div>`
      : ""
  }
</main>

<footer class="footer">
  <p>AIDA is an AI-powered assistant, not a person. Your answers are treated as confidential business information.</p>
  <p>Transcription is required for setup. Recording the audio is optional and separate.</p>
</footer>
<script src="/locksmith/onboarding.js" defer></script>
</body>
</html>
`;
}

module.exports = { renderCallPage, renderTimeline, renderConsentForm, renderAvailability, JOURNEY_STATES, stateIndex };
