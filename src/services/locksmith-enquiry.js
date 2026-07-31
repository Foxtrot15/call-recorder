// AIDA Locksmith Receptionist — pilot enquiry form: field contract, server-side
// validation, and the submission boundary (M1).
//
// FIELDS is the single source of truth for the form: the renderer builds the
// HTML from it and the validator checks against it, so a field can never exist
// in one and not the other. Changing a label, an option list, or a max length
// happens here once.
//
// PERSISTENCE STATUS (M1): there is NO sink. Nothing is written to Supabase, no
// table exists, no migration ships with this milestone, and no email is sent.
// createEnquirySubmitter() defines the interface a real sink will implement
// later and refuses cleanly until one is injected AND the flag is on. That
// refusal is a first-class, tested state — not an error path we hope nobody
// hits. See docs/LOCKSMITH_PILOT_SPEC.md §7 for what remains before
// submissions can be enabled.
//
// Pure + dep-free (no Supabase, no network) so it runs in the bare-checkout
// test environment. See test/locksmith-enquiry.test.js.

const MAX_NOTES = 2000;
const MAX_SHORT = 120;
const MAX_URL = 300;

// type: text | email | tel | url | textarea | select | radio | checkboxes | consent
const FIELDS = Object.freeze([
  {
    name: "businessName",
    label: "Business name",
    type: "text",
    required: true,
    maxLength: MAX_SHORT,
    autocomplete: "organization",
    hint: "The name callers hear when AIDA answers.",
  },
  {
    name: "contactName",
    label: "Contact name",
    type: "text",
    required: true,
    maxLength: MAX_SHORT,
    autocomplete: "name",
  },
  {
    name: "phone",
    label: "Phone",
    type: "tel",
    required: true,
    maxLength: 40,
    autocomplete: "tel",
    hint: "Australian mobile or landline, e.g. 04XX XXX XXX or 03 XXXX XXXX.",
  },
  {
    name: "email",
    label: "Email",
    type: "email",
    required: true,
    maxLength: MAX_SHORT,
    autocomplete: "email",
  },
  {
    name: "website",
    label: "Website",
    type: "url",
    required: false,
    maxLength: MAX_URL,
    autocomplete: "url",
    hint: "Optional.",
  },
  {
    name: "serviceArea",
    label: "Primary service area",
    type: "text",
    required: true,
    maxLength: MAX_SHORT,
    hint: "Suburbs or regions you cover, e.g. inner north and eastern suburbs.",
  },
  {
    name: "services",
    label: "Services offered",
    type: "checkboxes",
    required: true,
    hint: "Select all that apply.",
    options: Object.freeze([
      { value: "residential", label: "Residential" },
      { value: "automotive", label: "Automotive" },
      { value: "commercial", label: "Commercial" },
      { value: "safes", label: "Safes" },
      { value: "access-control", label: "Access control" },
    ]),
  },
  {
    name: "afterHours",
    label: "Do you take after-hours work?",
    type: "radio",
    required: true,
    options: Object.freeze([
      { value: "yes", label: "Yes" },
      { value: "sometimes", label: "Sometimes" },
      { value: "no", label: "No" },
    ]),
  },
  {
    name: "missedCallHandling",
    label: "What happens to missed calls now?",
    type: "select",
    required: true,
    options: Object.freeze([
      { value: "voicemail", label: "Goes to voicemail" },
      { value: "family", label: "Answered by family or staff" },
      { value: "answering-service", label: "An answering service takes them" },
      { value: "diverted", label: "Diverted to another locksmith" },
      { value: "nothing", label: "Nothing — they ring out" },
      { value: "other", label: "Something else" },
    ]),
  },
  {
    name: "preferredContact",
    label: "Preferred contact method",
    type: "radio",
    required: true,
    options: Object.freeze([
      { value: "phone", label: "Phone call" },
      { value: "sms", label: "SMS" },
      { value: "email", label: "Email" },
    ]),
  },
  {
    name: "notes",
    label: "Anything else we should know?",
    type: "textarea",
    required: false,
    maxLength: MAX_NOTES,
    hint: "Optional.",
  },
  {
    name: "consent",
    label: "I agree to be contacted about the AIDA Locksmith Receptionist pilot.",
    // The full sentence is the right label next to the checkbox but far too
    // long to repeat in the error summary — that entry uses summaryLabel.
    summaryLabel: "Consent",
    type: "consent",
    required: true,
    hint: "Required. We use these details only to respond to this enquiry.",
  },
]);

const FIELDS_BY_NAME = Object.freeze(
  FIELDS.reduce((acc, f) => {
    acc[f.name] = f;
    return acc;
  }, {})
);

// ── Normalisation ───────────────────────────────────────────────────
// Collapse whitespace, trim, and coerce non-strings to "" rather than throwing.
// Nothing here strips or escapes HTML: escaping is the renderer's job at output
// time (views/locksmith-page.js), and the route never echoes input back into
// HTML at all. Sanitising on input would corrupt legitimate values like
// "Smith & Sons".
function normaliseText(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

function normaliseMultiline(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

// Accepts a single value or an array (checkbox groups post either shape).
function normaliseList(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.map((v) => normaliseText(v)).filter(Boolean);
}

// HTML checkboxes post their value when ticked and are absent when not; JSON
// clients send a real boolean. The accepted set covers the browser default
// ("on"), the value this form actually renders ("true" — see the consent input
// in views/locksmith-page.js), and "yes" so a hand-rolled form can't silently
// fail the consent check. Anything else is not consent.
function isChecked(raw) {
  return raw === true || raw === 1 || raw === "true" || raw === "on" || raw === "1" || raw === "yes";
}

// ── Format checks ───────────────────────────────────────────────────
// Deliberately permissive-but-sane: reject what is obviously not an address
// rather than trying to out-guess RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function isValidEmail(value) {
  return typeof value === "string" && value.length <= MAX_SHORT && EMAIL_RE.test(value);
}

// Australian numbers only — this is an Australian pilot and a number we can't
// ring is worse than no number. Accepts spaces, dashes, brackets and dots as
// separators; +61 or 0 national form; plus 13/1300/1800 business numbers.
function isValidAuPhone(value) {
  if (typeof value !== "string") return false;
  const cleaned = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return false;
  const national = cleaned.startsWith("+61")
    ? `0${cleaned.slice(3)}`
    : cleaned.startsWith("61") && cleaned.length === 11
      ? `0${cleaned.slice(2)}`
      : cleaned;
  if (/^0[2-478]\d{8}$/.test(national)) return true; // mobile + landline
  if (/^1300\d{6}$/.test(national)) return true;
  if (/^1800\d{6}$/.test(national)) return true;
  if (/^13\d{4}$/.test(national)) return true;
  return false;
}

// Optional field: blank is fine. When present it must look like a web address;
// javascript:/data: schemes are refused outright (they'd be a stored-XSS vector
// the day this value is ever rendered as a link).
function isValidWebsite(value) {
  if (!value) return true;
  if (value.length > MAX_URL) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return false;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return Boolean(url.hostname) && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// ── Validation ──────────────────────────────────────────────────────
// Returns { ok, values, errors, errorList } where errors is name → message and
// errorList preserves FIELDS order so the error summary reads top-to-bottom
// like the form does.
function validateEnquiry(body) {
  // A null/undefined/primitive body is treated as an empty submission, not a
  // crash — a public endpoint must never 500 on a malformed request.
  const source = body && typeof body === "object" ? body : {};
  const values = {};
  const errors = {};

  for (const field of FIELDS) {
    const raw = source[field.name];

    if (field.type === "consent") {
      values[field.name] = isChecked(raw);
      if (!values[field.name]) {
        errors[field.name] = "Please tick this box so we can contact you about the pilot.";
      }
      continue;
    }

    if (field.type === "checkboxes") {
      const picked = normaliseList(raw);
      const allowed = field.options.map((o) => o.value);
      const invalid = picked.filter((v) => !allowed.includes(v));
      values[field.name] = picked.filter((v) => allowed.includes(v));
      if (invalid.length) {
        errors[field.name] = "Please choose from the listed services.";
      } else if (field.required && values[field.name].length === 0) {
        errors[field.name] = "Please select at least one service.";
      }
      continue;
    }

    if (field.type === "radio" || field.type === "select") {
      const picked = normaliseText(raw);
      const allowed = field.options.map((o) => o.value);
      values[field.name] = allowed.includes(picked) ? picked : "";
      if (field.required && !values[field.name]) {
        errors[field.name] = picked
          ? "Please choose one of the listed options."
          : `Please choose an option for “${field.label}”.`;
      }
      continue;
    }

    const value = field.type === "textarea" ? normaliseMultiline(raw) : normaliseText(raw);
    values[field.name] = value;

    if (field.required && !value) {
      errors[field.name] = `${field.label} is required.`;
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      errors[field.name] = `${field.label} must be ${field.maxLength} characters or fewer.`;
      continue;
    }
    if (field.type === "email" && value && !isValidEmail(value)) {
      errors[field.name] = "Enter a valid email address, e.g. name@example.com.";
      continue;
    }
    if (field.type === "tel" && value && !isValidAuPhone(value)) {
      errors[field.name] = "Enter a valid Australian phone number, e.g. 04XX XXX XXX or 03 XXXX XXXX.";
      continue;
    }
    if (field.type === "url" && value && !isValidWebsite(value)) {
      errors[field.name] = "Enter a valid website address, e.g. example.com.au.";
    }
  }

  const errorList = FIELDS.filter((f) => errors[f.name]).map((f) => ({
    field: f.name,
    label: f.summaryLabel || f.label,
    message: errors[f.name],
  }));

  return { ok: errorList.length === 0, values, errors, errorList };
}

// ── Submission boundary ─────────────────────────────────────────────
// The seam a real persistence mechanism plugs into. `sink` is an async
// function (values, meta) → void; injecting one is the ONLY way submissions
// are ever stored. M1 injects nothing, so every submission ends at "disabled"
// or "unavailable" — both surfaced to the caller honestly rather than being
// swallowed as a fake success.
const SUBMISSION_RESULTS = Object.freeze({
  received: { ok: true, code: "received", status: 200 },
  disabled: { ok: false, code: "disabled", status: 503 },
  unavailable: { ok: false, code: "unavailable", status: 503 },
  failed: { ok: false, code: "error", status: 502 },
});

function createEnquirySubmitter(deps = {}) {
  const { sink = null, logger = console } = deps;
  const isEnabled = deps.isEnabled || (() => require("../config/locksmith").isEnquiryFormEnabled());

  return async function submitEnquiry(values, meta = {}) {
    if (!isEnabled()) return SUBMISSION_RESULTS.disabled;
    if (typeof sink !== "function") return SUBMISSION_RESULTS.unavailable;

    try {
      await sink(values, meta);
      // Structured single-line log, house style. Deliberately free of PII:
      // no name, phone, email or notes — only the shape of what arrived.
      logger.log(
        `locksmith.enquiry.received services=${(values.services || []).length} ` +
          `afterHours=${values.afterHours || "-"} contact=${values.preferredContact || "-"}`
      );
      return SUBMISSION_RESULTS.received;
    } catch (err) {
      logger.error("locksmith.enquiry.sink_failed", err && err.message);
      return SUBMISSION_RESULTS.failed;
    }
  };
}

// User-facing copy for each non-success result. The route returns these; the
// page prints them verbatim in the form's status region.
const SUBMISSION_MESSAGES = Object.freeze({
  received: "Thanks — your pilot enquiry has been received. We'll be in touch shortly.",
  disabled:
    "Online enquiries aren't switched on yet. The pilot is being set up — please use the contact details in the footer and we'll get straight back to you.",
  unavailable:
    "We can't record enquiries just yet. Please use the contact details in the footer and we'll get straight back to you.",
  error: "Something went wrong at our end and your enquiry wasn't saved. Please try again, or use the contact details in the footer.",
  invalid: "Please check the highlighted fields and try again.",
  rateLimited: "That's a few submissions in a short time. Please wait a moment and try again.",
});

module.exports = {
  FIELDS,
  FIELDS_BY_NAME,
  validateEnquiry,
  isValidEmail,
  isValidAuPhone,
  isValidWebsite,
  isChecked,
  normaliseText,
  createEnquirySubmitter,
  SUBMISSION_RESULTS,
  SUBMISSION_MESSAGES,
  MAX_NOTES,
  MAX_SHORT,
};
