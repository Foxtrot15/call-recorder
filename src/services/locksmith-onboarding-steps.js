// AIDA Locksmith Receptionist — the onboarding step specification (M8A).
//
// ONE MODEL, TWO CHANNELS. This file declares what a locksmith is asked during
// setup, in what order, with what wording, and how each answer lands in the
// canonical profile. The conventional web wizard renders it today. The Release 2
// voice configuration agent will read the SAME declaration and ask the SAME
// questions — which is the whole point, because a second declaration is always
// the one that drifts.
//
// The relationship to the three things that already existed:
//
//   locksmith-profile-schema.js   WHAT a receptionist is (the canonical shape).
//                                 Owns the enums. This file never invents one.
//   locksmith-interview-spec.js   WHAT the onboarding CALL must establish, as
//                                 conversational question groups. Every step
//                                 here names the group(s) it covers, and a test
//                                 asserts the `mustEstablish` keys are all
//                                 reachable through some field below.
//   THIS FILE                     HOW a human answers it in a form, and how that
//                                 answer becomes profile data.
//
// Each field carries `read` and `apply` rather than a dot-path, because several
// canonical fields are not simple scalars — services are a tri-state across two
// arrays, hours are a day grid, urgency rules are objects behind presets. A
// path-setter would have forced those shapes into the UI. The declaration owns
// both directions instead, so the renderer, the validator, the resume path and a
// future voice agent all agree by construction.
//
// `apply` NEVER mutates its argument. It returns a new profile. The approved
// profile is loaded fresh on every request and must survive being read.
//
// Pure + dep-free.

const S = require("./locksmith-profile-schema");
const { normaliseAuNumber, isValidEmail, isValidTime, MAX_SHORT_TEXT, MAX_LONG_TEXT } = require("./locksmith-profile");

const STEP_SPEC_VERSION = "locksmith-onboarding-steps-2026-08-04";

// ── Safe table lookup ───────────────────────────────────────────────
// Request bodies name steps and fields. `TABLE[userInput]` reaches
// Object.prototype for "constructor"/"toString"/"valueOf" and returns a truthy
// function — the exact hazard found in the M7I compiler review. Every lookup
// keyed by anything a request can influence goes through this.

function lookup(table, key) {
  if (typeof key !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// ── Small helpers shared by the field declarations ──────────────────

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function clone(profile) {
  return JSON.parse(JSON.stringify(profile));
}

/** Split a textarea of suburbs/lines into a clean list. Commas or newlines. */
function toList(value, { max = 60, maxLength = 80 } = {}) {
  if (Array.isArray(value)) value = value.join("\n");
  return String(value == null ? "" : value)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(0, maxLength))
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, max);
}

function fromList(list) {
  return Array.isArray(list) ? list.join("\n") : "";
}

function toBool(value) {
  if (value === true || value === false) return value;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  return null;
}

function enumOptions(values, labels) {
  return Object.freeze(
    values.map((value) => Object.freeze({ value, label: labels ? lookup(labels, value) || value : humanise(value) }))
  );
}

function humanise(value) {
  return String(value).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ── Urgency presets ─────────────────────────────────────────────────
// A locksmith does not hand-author rule objects. They tick the situations that
// wake them up. Each preset expands to a complete, valid urgencyRules entry.
//
// `approvedWording` is deliberately absent on every preset: it is optional in
// the schema, and an unreviewed sentence is exactly the kind of thing that ends
// up spoken to a caller. The compiler renders the classification instead.

const URGENCY_PRESETS = Object.freeze([
  {
    id: "residential_lockout_after_hours",
    label: "Someone is locked out of their home, after hours",
    rule: {
      ruleId: "residential_lockout_after_hours",
      condition: "A caller is locked out of their home outside ordinary hours",
      classification: "urgent",
      action: "notify_urgently_and_collect",
      transferEligible: true,
      notificationPriority: "immediate",
    },
  },
  {
    id: "vulnerable_person",
    label: "A child, an elderly person or someone unwell is at risk",
    rule: {
      ruleId: "vulnerable_person",
      condition: "A child, elderly or unwell person is locked out, locked in, or exposed",
      classification: "urgent",
      action: "transfer_immediately",
      transferEligible: true,
      notificationPriority: "immediate",
    },
  },
  {
    id: "break_in_unsecured",
    label: "A break-in has left a property unsecured",
    rule: {
      ruleId: "break_in_unsecured",
      condition: "A property cannot be secured after a break-in or forced entry",
      classification: "urgent",
      action: "transfer_immediately",
      transferEligible: true,
      notificationPriority: "immediate",
    },
  },
  {
    id: "business_cannot_open",
    label: "A business cannot open or cannot lock up",
    rule: {
      ruleId: "business_cannot_open",
      condition: "A commercial premises cannot open for trade or cannot be secured",
      classification: "priority",
      action: "notify_urgently_and_collect",
      transferEligible: true,
      notificationPriority: "high",
    },
  },
  {
    id: "vehicle_lockout",
    label: "Someone is locked out of a vehicle",
    rule: {
      ruleId: "vehicle_lockout",
      condition: "A caller is locked out of a vehicle",
      classification: "priority",
      action: "collect_and_notify",
      transferEligible: false,
      notificationPriority: "high",
    },
  },
  {
    id: "quote_or_spare_key",
    label: "A quote, a spare key, or anything that can wait until morning",
    rule: {
      ruleId: "quote_or_spare_key",
      condition: "A quote, spare key, or other work with no immediate access or security impact",
      classification: "non_urgent",
      action: "collect_for_business_hours",
      transferEligible: false,
      notificationPriority: "normal",
    },
  },
]);

const URGENCY_PRESET_BY_ID = Object.freeze(
  URGENCY_PRESETS.reduce((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, Object.create(null))
);

// ── Field constructors ──────────────────────────────────────────────
// Each returns a frozen declaration. `kind` is the renderer's instruction and
// the voice agent's hint about what an acceptable spoken answer looks like.

function scalarField({ name, label, kind = "text", section, get, set, required = false, help = null, spoken, options = null, maxLength = MAX_SHORT_TEXT, placeholder = null, validate = null }) {
  return Object.freeze({
    name,
    label,
    kind,
    section,
    required,
    help,
    spoken,
    options,
    maxLength,
    placeholder,
    read: (profile) => get(profile),
    apply: (profile, value) => {
      const next = clone(profile);
      set(next, value);
      return next;
    },
    validate: validate || (() => null),
  });
}

// ── Step declarations ───────────────────────────────────────────────
//
// Seven data-entry steps. Review, approve, test and activate are stages of the
// journey but collect no business answers, so they are declared in STAGES below
// rather than here — a stage with no fields would otherwise render as an empty
// form.

const STEPS = Object.freeze([
  // ── 1. Business identity ──────────────────────────────────────────
  Object.freeze({
    id: "identity",
    number: 1,
    title: "Your business",
    intent: "How the phone is answered, and who is answering it.",
    interviewGroups: Object.freeze(["identity"]),
    // The canonical profile sections this step is responsible for. The union
    // across every step must equal CONFIRMATION_KEYS, so ticking all seven steps
    // ticks all twelve safety-critical sections and none is left unread.
    // Asserted in test/locksmith-setup-journey.test.js.
    profileSections: Object.freeze(["identity"]),
    fields: Object.freeze([
      scalarField({
        name: "spokenName",
        label: "Business name callers hear",
        section: "identity",
        required: true,
        spoken: "What's the business called — the name you'd want me to say when I pick up?",
        help: "Say it the way you'd say it on the phone. Most owners leave off the Pty Ltd.",
        get: (p) => p.identity.spokenName,
        set: (p, v) => { p.identity.spokenName = text(v) || null; },
        validate: (v) => (text(v) ? null : "Tell us what to call your business when we answer."),
      }),
      scalarField({
        name: "legalName",
        label: "Registered or legal name",
        section: "identity",
        spoken: "Is that the same as the name on your invoices, or is the legal name different?",
        help: "Optional. Only used on your account, never spoken to a caller.",
        get: (p) => p.identity.legalName,
        set: (p, v) => { p.identity.legalName = text(v) || null; },
      }),
      scalarField({
        name: "businessPhone",
        label: "Your public business number",
        kind: "tel",
        section: "identity",
        required: true,
        placeholder: "03 9000 0000 or 0400 000 000",
        spoken: "What number do customers already ring you on?",
        // M7 fix, kept explicit here because it is the mistake this field
        // invites: a published contact number is not where urgent calls go.
        help: "The number already on your van and your website. This is NOT where we put urgent callers through — you'll set that separately in Notifications and transfers.",
        get: (p) => p.identity.businessPhone,
        set: (p, v) => { p.identity.businessPhone = text(v) || null; },
        validate: (v) => (!text(v) ? "We need your public business number." : normaliseAuNumber(v) ? null : "That doesn't look like an Australian phone number."),
      }),
      scalarField({
        name: "ownerName",
        label: "Your name",
        section: "identity",
        required: true,
        spoken: "And who am I speaking with — who owns or runs the business?",
        help: "So we know who approved the settings. Never spoken to a caller.",
        get: (p) => (p.extensions && p.extensions.ownerName) || null,
        set: (p, v) => {
          p.extensions = p.extensions && typeof p.extensions === "object" ? p.extensions : {};
          const name = text(v).slice(0, MAX_SHORT_TEXT);
          if (name) p.extensions.ownerName = name;
          else delete p.extensions.ownerName;
        },
        validate: (v) => (text(v) ? null : "Tell us who to record as the owner."),
      }),
      scalarField({
        name: "ownerEmail",
        label: "Your email",
        kind: "email",
        section: "identity",
        required: true,
        spoken: "What's the best email for you?",
        help: "Where we send your setup summary. Never spoken to a caller.",
        get: (p) => (p.extensions && p.extensions.ownerEmail) || null,
        set: (p, v) => {
          p.extensions = p.extensions && typeof p.extensions === "object" ? p.extensions : {};
          const email = text(v).slice(0, MAX_SHORT_TEXT);
          if (email) p.extensions.ownerEmail = email;
          else delete p.extensions.ownerEmail;
        },
        validate: (v) => (!text(v) ? "We need an email for you." : isValidEmail(text(v)) ? null : "That doesn't look like an email address."),
      }),
      scalarField({
        name: "receptionistName",
        label: "What we call ourselves when we answer",
        section: "identity",
        required: true,
        placeholder: "Mel",
        spoken: "What should I call myself when I answer? Some owners like a receptionist name, some prefer 'the answering service'.",
        help: "A first name sounds friendlier than 'the answering service'. Callers are always told they're speaking to an automated assistant.",
        get: (p) => p.identity.receptionistName,
        set: (p, v) => { p.identity.receptionistName = text(v) || null; },
        validate: (v) => (text(v) ? null : "Give us a name to answer with."),
      }),
      scalarField({
        name: "greeting",
        label: "Your greeting",
        kind: "textarea",
        section: "identity",
        required: true,
        maxLength: MAX_LONG_TEXT,
        placeholder: "Northside Lock and Key, this is Mel, how can I help?",
        spoken: "How would you like me to greet people?",
        help: "The first thing every caller hears.",
        get: (p) => p.identity.greeting,
        set: (p, v) => { p.identity.greeting = text(v) || null; },
        validate: (v) => (text(v) ? null : "Write the greeting you want callers to hear."),
      }),
      scalarField({
        name: "timezone",
        label: "Your state",
        kind: "select",
        section: "identity",
        required: true,
        options: Object.freeze([
          { value: "Australia/Melbourne", label: "Victoria" },
          { value: "Australia/Sydney", label: "New South Wales or ACT" },
          { value: "Australia/Brisbane", label: "Queensland" },
          { value: "Australia/Adelaide", label: "South Australia" },
          { value: "Australia/Perth", label: "Western Australia" },
          { value: "Australia/Hobart", label: "Tasmania" },
          { value: "Australia/Darwin", label: "Northern Territory" },
        ]),
        spoken: "Which state are you based in?",
        help: "Every hours and after-hours rule is applied in your local time.",
        get: (p) => p.identity.timezone,
        set: (p, v) => {
          const tz = S.TIMEZONES.includes(v) ? v : null;
          p.identity.timezone = tz;
          // The hours section carries its own copy and the compiler reads that
          // one. Keeping them in step here means a reviewer can never approve a
          // profile whose two timezones disagree.
          p.hours.timezone = tz;
        },
        validate: (v) => (S.TIMEZONES.includes(v) ? null : "Choose your state."),
      }),
      scalarField({
        name: "description",
        label: "How would you describe the business?",
        kind: "textarea",
        section: "identity",
        maxLength: MAX_LONG_TEXT,
        spoken: "How would you describe the business to someone who's never called before?",
        help: "A sentence or two. It helps us sound like we know you rather than like a script.",
        get: (p) => p.identity.description,
        set: (p, v) => { p.identity.description = text(v) || null; },
      }),
    ]),
  }),

  // ── 2. Services ───────────────────────────────────────────────────
  Object.freeze({
    id: "services",
    number: 2,
    title: "The work you take",
    intent: "Every category of work the business will actually accept. Opt-in only.",
    interviewGroups: Object.freeze(["services_accepted", "services_declined"]),
    profileSections: Object.freeze(["servicesAccepted", "servicesDeclined"]),
    fields: Object.freeze([
      Object.freeze({
        name: "services",
        label: "Work you take, and work you don't",
        kind: "services",
        section: "servicesAccepted",
        required: true,
        spoken: "Let's go through the work you take. Residential lockouts — yes? Car work? Commercial?",
        help: "Anything left as 'don't offer' is simply never mentioned. Mark something as 'never take' only when you want us to tell callers plainly that you don't do it.",
        options: enumOptions(S.SERVICE_IDS, S.SERVICE_LABELS),
        maxLength: MAX_SHORT_TEXT,
        placeholder: null,
        read: (profile) => {
          const state = {};
          for (const id of S.SERVICE_IDS) state[id] = "not_offered";
          for (const svc of profile.servicesAccepted || []) {
            if (svc && S.SERVICE_IDS.includes(svc.serviceId) && svc.enabled === true) state[svc.serviceId] = "accepted";
          }
          for (const svc of profile.servicesDeclined || []) {
            if (svc && S.SERVICE_IDS.includes(svc.serviceId)) state[svc.serviceId] = "declined";
          }
          return state;
        },
        apply: (profile, value) => {
          const next = clone(profile);
          const state = value && typeof value === "object" ? value : {};
          const accepted = [];
          const declined = [];
          for (const id of S.SERVICE_IDS) {
            const choice = lookup(state, id);
            const previous = (profile.servicesAccepted || []).find((s) => s && s.serviceId === id);
            if (choice === "accepted") {
              accepted.push({
                serviceId: id,
                publicName: S.SERVICE_LABELS[id],
                enabled: true,
                // Preserved rather than reset: a note or urgency flag set on a
                // later step must survive re-saving this one.
                availability: previous ? previous.availability || null : null,
                notes: previous ? previous.notes || null : null,
                mayBeUrgent: previous ? previous.mayBeUrgent === true : false,
                mustCollect: previous && Array.isArray(previous.mustCollect) ? previous.mustCollect : [],
              });
            } else if (choice === "declined") {
              const was = (profile.servicesDeclined || []).find((s) => s && s.serviceId === id);
              declined.push({ serviceId: id, reason: was && was.reason ? was.reason : "The owner does not offer this work." });
            }
          }
          next.servicesAccepted = accepted;
          next.servicesDeclined = declined;
          return next;
        },
        validate: (value) => {
          const state = value && typeof value === "object" ? value : {};
          const any = S.SERVICE_IDS.some((id) => lookup(state, id) === "accepted");
          return any ? null : "Tick at least one kind of work you take, or we'd have nothing to book.";
        },
      }),
      scalarField({
        name: "proofOfOwnership",
        label: "Remind callers they'll need proof it's their property or vehicle",
        kind: "bool",
        section: "callerInfo",
        spoken: "Should I remind people they'll need proof it's their car or their house?",
        help: "Saves an argument on the doorstep. We only ever mention it — we never verify anything, and we never claim to have.",
        get: (p) => (Array.isArray(p.callerInfo.always) ? p.callerInfo.always.includes("proof_of_ownership_reminder") : false),
        // Adds or removes exactly one entry. The rest of `always` belongs to the
        // job-handling step, and neither step may clobber the other's answers.
        set: (p, v) => {
          const on = toBool(v) === true;
          const list = Array.isArray(p.callerInfo.always) ? p.callerInfo.always.slice() : [];
          const at = list.indexOf("proof_of_ownership_reminder");
          if (on && at === -1) list.push("proof_of_ownership_reminder");
          if (!on && at !== -1) list.splice(at, 1);
          p.callerInfo.always = list;
        },
      }),
      scalarField({
        name: "declinedNote",
        label: "Anything else you'd never take a job for?",
        kind: "textarea",
        section: "servicesDeclined",
        maxLength: MAX_LONG_TEXT,
        spoken: "Is there anything you'd rather I never take a job for?",
        help: "In your own words. Anything here is reviewed before it is ever spoken.",
        get: (p) => (p.extensions && p.extensions.declinedNote) || null,
        set: (p, v) => {
          p.extensions = p.extensions && typeof p.extensions === "object" ? p.extensions : {};
          const note = text(v).slice(0, MAX_LONG_TEXT);
          if (note) p.extensions.declinedNote = note;
          else delete p.extensions.declinedNote;
        },
      }),
    ]),
  }),

  // ── 3. Service areas ──────────────────────────────────────────────
  Object.freeze({
    id: "areas",
    number: 3,
    title: "Where you go",
    intent: "Three states, plus the rule for a suburb nobody listed.",
    interviewGroups: Object.freeze(["service_areas"]),
    profileSections: Object.freeze(["serviceAreas"]),
    fields: Object.freeze([
      scalarField({
        name: "primary",
        label: "Suburbs you cover day to day",
        kind: "list",
        section: "serviceAreas",
        required: true,
        placeholder: "Frankston\nSeaford\nCarrum Downs",
        spoken: "Which suburbs or areas do you cover day to day?",
        help: "One per line. These are the ones we say yes to without hesitating.",
        get: (p) => fromList(p.serviceAreas.primary),
        set: (p, v) => { p.serviceAreas.primary = toList(v); },
        validate: (v) => (toList(v).length ? null : "List at least one suburb you cover."),
      }),
      scalarField({
        name: "extended",
        label: "Suburbs you'll stretch to",
        kind: "list",
        section: "serviceAreas",
        placeholder: "Mornington",
        spoken: "Anywhere you'll stretch to if the job's worth it?",
        help: "We take the details and tell the caller you'll confirm — we never promise you're coming.",
        get: (p) => fromList(p.serviceAreas.extended),
        set: (p, v) => { p.serviceAreas.extended = toList(v); },
      }),
      scalarField({
        name: "declined",
        label: "Suburbs you definitely won't go to",
        kind: "list",
        section: "serviceAreas",
        placeholder: "Dandenong",
        spoken: "Anywhere you definitely won't go?",
        help: "We tell these callers plainly and politely that it's outside your area.",
        get: (p) => fromList(p.serviceAreas.declined),
        set: (p, v) => { p.serviceAreas.declined = toList(v); },
      }),
      scalarField({
        name: "outsideAreaAction",
        label: "A suburb nobody listed",
        kind: "select",
        section: "serviceAreas",
        required: true,
        options: Object.freeze([
          { value: "collect_details_for_confirmation", label: "Take their details and tell them you'll confirm" },
          { value: "transfer_for_manual_assessment", label: "Put them through to you to decide" },
          { value: "politely_decline", label: "Tell them it's outside your area" },
          { value: "other_reviewed_action", label: "Something else — we'll write it with you" },
        ]),
        spoken: "If someone rings from a suburb you haven't mentioned, what do you want me to do?",
        // The M7I product rule, stated where the choice is made rather than
        // discovered later in a compiled prompt.
        help: "This covers suburbs on none of the three lists. Whatever you choose, we never flatly refuse someone we simply haven't heard of — an unlisted suburb is a question, not a no.",
        get: (p) => p.serviceAreas.outsideAreaAction,
        set: (p, v) => { p.serviceAreas.outsideAreaAction = S.OUTSIDE_AREA_ACTIONS.includes(v) ? v : null; },
        validate: (v) => (S.OUTSIDE_AREA_ACTIONS.includes(v) ? null : "Choose what happens for a suburb you haven't listed."),
      }),
      scalarField({
        name: "afterHoursAreas",
        label: "A smaller area after hours?",
        kind: "list",
        section: "serviceAreas",
        placeholder: "Leave blank if it's the same area day and night",
        spoken: "Does that change after hours — smaller area at 2am?",
        help: "Leave blank to use the same suburbs at every hour.",
        get: (p) => (p.serviceAreas.afterHoursAreas == null ? "" : fromList(p.serviceAreas.afterHoursAreas)),
        set: (p, v) => {
          const list = toList(v);
          p.serviceAreas.afterHoursAreas = list.length ? list : null;
        },
      }),
    ]),
  }),

  // ── 4. Hours and availability ─────────────────────────────────────
  Object.freeze({
    id: "hours",
    number: 4,
    title: "When you work",
    intent: "Ordinary hours, after hours, holidays, and how quickly someone rings back.",
    interviewGroups: Object.freeze(["hours", "after_hours"]),
    profileSections: Object.freeze(["hours"]),
    fields: Object.freeze([
      Object.freeze({
        name: "ordinary",
        label: "Your ordinary hours",
        kind: "hours",
        section: "hours",
        required: true,
        spoken: "What are your normal hours, Monday to Friday? Saturdays? Sundays?",
        help: "In your local time. Tick 'closed' for days you don't trade.",
        options: Object.freeze(S.DAYS.map((d) => Object.freeze({ value: d, label: humanise(d) }))),
        maxLength: 5,
        placeholder: null,
        read: (profile) => {
          const out = {};
          const ordinary = profile.hours && profile.hours.ordinary ? profile.hours.ordinary : {};
          for (const day of S.DAYS) {
            const entry = lookup(ordinary, day);
            out[day] = entry && entry.closed !== true && entry.open && entry.close
              ? { closed: false, open: entry.open, close: entry.close }
              : { closed: true, open: "08:00", close: "17:00" };
          }
          return out;
        },
        apply: (profile, value) => {
          const next = clone(profile);
          const given = value && typeof value === "object" ? value : {};
          const ordinary = {};
          for (const day of S.DAYS) {
            const entry = lookup(given, day);
            if (!entry || entry.closed === true || entry.closed === "true") {
              ordinary[day] = { closed: true };
              continue;
            }
            const open = text(entry.open);
            const close = text(entry.close);
            ordinary[day] = isValidTime(open) && isValidTime(close) ? { open, close } : { closed: true };
          }
          next.hours.ordinary = ordinary;
          return next;
        },
        validate: (value) => {
          const given = value && typeof value === "object" ? value : {};
          let open = 0;
          for (const day of S.DAYS) {
            const entry = lookup(given, day);
            if (!entry || entry.closed === true || entry.closed === "true") continue;
            if (!isValidTime(text(entry.open)) || !isValidTime(text(entry.close))) {
              return `Check the times for ${humanise(day)} — they need to be like 08:00 and 17:00.`;
            }
            if (text(entry.open) >= text(entry.close)) {
              return `${humanise(day)} closes before it opens.`;
            }
            open += 1;
          }
          return open ? null : "Set hours for at least one day, or we can't tell an after-hours call from a normal one.";
        },
      }),
      scalarField({
        name: "afterHoursAvailable",
        label: "Do you take call-outs after hours?",
        kind: "bool",
        section: "hours",
        required: true,
        spoken: "Do you take call-outs after hours?",
        help: "If not, we take the details and tell the caller you'll be in touch in business hours. We never say someone is on the way.",
        get: (p) => p.hours.afterHoursAvailable,
        set: (p, v) => { p.hours.afterHoursAvailable = toBool(v); },
        validate: (v) => (toBool(v) === null ? "Tell us whether you work after hours." : null),
      }),
      scalarField({
        name: "afterHoursNote",
        label: "Anything we should know about after-hours work?",
        kind: "textarea",
        section: "hours",
        maxLength: MAX_LONG_TEXT,
        spoken: "All night, or up to a certain time? Only for certain kinds of job?",
        help: "For example: lockouts and break-ins all night, but nothing else.",
        get: (p) => p.hours.afterHoursNote,
        set: (p, v) => { p.hours.afterHoursNote = text(v) || null; },
      }),
      scalarField({
        name: "publicHolidays",
        label: "Public holidays",
        kind: "select",
        section: "hours",
        options: Object.freeze([
          { value: "closed", label: "Closed" },
          { value: "byArrangement", label: "By arrangement — take details and you'll decide" },
          { value: "open", label: "Open, same as an ordinary day" },
        ]),
        spoken: "Public holidays — closed, or by arrangement?",
        get: (p) => {
          const h = p.hours.publicHolidays;
          if (!h) return "closed";
          if (h.byArrangement === true) return "byArrangement";
          if (h.closed === true) return "closed";
          return "open";
        },
        set: (p, v) => {
          if (v === "byArrangement") p.hours.publicHolidays = { byArrangement: true };
          else if (v === "open") p.hours.publicHolidays = { open: "09:00", close: "17:00" };
          else p.hours.publicHolidays = { closed: true };
        },
      }),
      Object.freeze({
        name: "callbackEstimate",
        label: "How long until someone rings back",
        kind: "estimate",
        section: "hours",
        required: false,
        spoken: "Realistically, how long before you or one of your blokes rings someone back?",
        // The distinction this field exists to protect. Stated in the UI because
        // the schema comment cannot reach the person filling in the form.
        help: "An estimate of when a PERSON rings back — not when anyone arrives. Leave it blank and we'll say we can't give a reliable timeframe, which is always safer than a number you can't hit. We never state it as a promise.",
        options: Object.freeze([
          { value: "standard", label: "Ordinary enquiries" },
          { value: "urgent", label: "Urgent calls" },
          { value: "afterHours", label: "After hours" },
        ]),
        maxLength: 4,
        placeholder: null,
        read: (profile) => {
          const est = profile.hours && profile.hours.callbackEstimate;
          const out = { standard: null, urgent: null, afterHours: null };
          if (!est || typeof est !== "object") return out;
          for (const key of ["standard", "urgent", "afterHours"]) {
            const window = lookup(est, key);
            if (window && Number.isInteger(window.minMinutes) && Number.isInteger(window.maxMinutes)) {
              out[key] = { minMinutes: window.minMinutes, maxMinutes: window.maxMinutes };
            }
          }
          return out;
        },
        apply: (profile, value) => {
          const next = clone(profile);
          const given = value && typeof value === "object" ? value : {};
          const built = {};
          for (const key of ["standard", "urgent", "afterHours"]) {
            const window = lookup(given, key);
            if (!window) continue;
            const min = Number.parseInt(window.minMinutes, 10);
            const max = Number.parseInt(window.maxMinutes, 10);
            if (Number.isInteger(min) && Number.isInteger(max)) built[key] = { minMinutes: min, maxMinutes: max };
          }
          // `standard` is the anchor: urgent and after-hours are refinements of
          // it, so without it there is no estimate at all. Absent stays absent —
          // null is a first-class "no approved estimate", not a missing value.
          next.hours.callbackEstimate = built.standard ? built : null;
          return next;
        },
        validate: (value) => {
          const given = value && typeof value === "object" ? value : {};
          // `filled` must treat a NUMBER as filled. An earlier version used the
          // string helper here, which reported every numeric estimate as blank
          // and waved the whole field through unvalidated.
          const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
          const present = ["standard", "urgent", "afterHours"].filter((k) => {
            const w = lookup(given, k);
            return w && (filled(w.minMinutes) || filled(w.maxMinutes));
          });
          if (!present.length) return null; // blank is valid and is the default
          for (const key of present) {
            const w = lookup(given, key);
            const min = Number.parseInt(w.minMinutes, 10);
            const max = Number.parseInt(w.maxMinutes, 10);
            if (!Number.isInteger(min) || !Number.isInteger(max)) return "Callback estimates need whole minutes in both boxes.";
            if (min < 1) return "A callback estimate has to be at least one minute.";
            if (min > max) return "A callback estimate starts later than it ends.";
            if (max > 24 * 60) return "That estimate is longer than a day — leave it blank rather than quoting a window that long.";
          }
          const standard = lookup(given, "standard");
          if (!standard || !filled(standard.minMinutes) || !filled(standard.maxMinutes)) {
            return "Fill in the ordinary-enquiry estimate, or clear them all — the others are refinements of it.";
          }
          return null;
        },
      }),
    ]),
  }),

  // ── 5. Job handling ───────────────────────────────────────────────
  Object.freeze({
    id: "jobs",
    number: 5,
    title: "How we handle a job",
    intent: "What counts as urgent, what we must find out, and what we may say about money.",
    interviewGroups: Object.freeze(["urgency", "caller_info", "pricing", "forbidden"]),
    // `forbiddenPromises` has no editable field — it is the always-on safety
    // floor. It is confirmed here because this is the step where the owner is
    // told what we will never say, and the review page prints the full list.
    profileSections: Object.freeze(["urgencyRules", "pricing", "callerInfo", "forbiddenPromises"]),
    fields: Object.freeze([
      Object.freeze({
        name: "urgencyPresets",
        label: "Which of these wake you up?",
        kind: "checkboxes",
        section: "urgencyRules",
        required: true,
        spoken: "If someone's locked outside their house late at night, is that a wake-you-up job? What about a child in the car?",
        help: "Tick everything that should be treated as urgent or high priority. Anything you leave unticked is handled as ordinary work.",
        options: Object.freeze(URGENCY_PRESETS.map((p) => Object.freeze({ value: p.id, label: p.label }))),
        maxLength: URGENCY_PRESETS.length,
        placeholder: null,
        read: (profile) => (Array.isArray(profile.urgencyRules) ? profile.urgencyRules.map((r) => r && r.ruleId).filter((id) => lookup(URGENCY_PRESET_BY_ID, id)) : []),
        apply: (profile, value) => {
          const next = clone(profile);
          const chosen = Array.isArray(value) ? value : [value];
          // Rules the owner authored elsewhere are not preset-backed and must
          // survive this step. Only preset rules are replaced.
          const custom = (profile.urgencyRules || []).filter((r) => r && !lookup(URGENCY_PRESET_BY_ID, r.ruleId));
          const selected = URGENCY_PRESETS.filter((p) => chosen.includes(p.id)).map((p) => ({ ...p.rule }));
          next.urgencyRules = [...selected, ...custom];
          return next;
        },
        validate: (value) => {
          const chosen = Array.isArray(value) ? value : [value];
          return chosen.filter((v) => lookup(URGENCY_PRESET_BY_ID, v)).length
            ? null
            : "Tick at least one — otherwise every call is treated exactly the same.";
        },
      }),
      Object.freeze({
        name: "callerInfoAlways",
        label: "What we must find out on every call",
        kind: "checkboxes",
        section: "callerInfo",
        // Not `required`: this field cannot be answered wrongly. `apply` forces
        // the callback number back in whatever is ticked, so every possible
        // submission is valid. Thinness of the rest is a warning
        // (`no_caller_name`), which is assessProvisioning's job, not a blocker
        // that would strand the owner on a step they have already answered.
        required: false,
        spoken: "What do you need to know before you'd get in the van?",
        help: "A callback number is always collected — without it a job is unusable.",
        // proof_of_ownership_reminder is deliberately absent: it belongs to the
        // services step, and a field may only manage the options it declares.
        options: Object.freeze(
          S.CALLER_INFO_FIELDS.filter((f) => f !== "proof_of_ownership_reminder" && f !== "other_reviewed_question").map((f) =>
            Object.freeze({ value: f, label: S.CALLER_INFO_LABELS[f], locked: f === "callback_number" })
          )
        ),
        maxLength: S.CALLER_INFO_FIELDS.length,
        placeholder: null,
        read: (profile) => (Array.isArray(profile.callerInfo.always) ? profile.callerInfo.always.slice() : []),
        apply: (profile, value) => {
          const next = clone(profile);
          const chosen = Array.isArray(value) ? value : [value];
          const managed = new Set(
            S.CALLER_INFO_FIELDS.filter((f) => f !== "proof_of_ownership_reminder" && f !== "other_reviewed_question")
          );
          const kept = (profile.callerInfo.always || []).filter((f) => !managed.has(f));
          const picked = [...managed].filter((f) => chosen.includes(f));
          // Non-negotiable: assessProvisioning blocks without it, and a lead with
          // no number is not a lead.
          if (!picked.includes("callback_number")) picked.unshift("callback_number");
          next.callerInfo.always = [...picked, ...kept];
          return next;
        },
        validate: () => null,
      }),
      scalarField({
        name: "mayMentionPricing",
        label: "May we say anything about price?",
        kind: "bool",
        section: "pricing",
        required: true,
        spoken: "Do you want me to give people any idea of price, or keep that between you and them?",
        help: "Most owners say no. We never quote a fixed price unless you've approved the exact words.",
        get: (p) => p.pricing.mayMentionPricing,
        set: (p, v) => { p.pricing.mayMentionPricing = toBool(v); },
        validate: (v) => (toBool(v) === null ? "Tell us whether we may mention price." : null),
      }),
      scalarField({
        name: "calloutWording",
        label: "The wording you're comfortable with",
        kind: "textarea",
        section: "pricing",
        maxLength: MAX_LONG_TEXT,
        spoken: "What's the wording you're comfortable with me using?",
        help: "Only used if you said we may mention price. Reviewed before it is ever spoken.",
        get: (p) => p.pricing.calloutWording,
        set: (p, v) => { p.pricing.calloutWording = text(v) || null; },
      }),
      scalarField({
        name: "humanConfirmsEveryPrice",
        label: "Do you confirm every price yourself?",
        kind: "bool",
        section: "pricing",
        required: true,
        spoken: "Do you want to confirm every price yourself before it's given?",
        help: "Saying yes is the safe answer and the one we recommend.",
        get: (p) => p.pricing.humanConfirmsEveryPrice,
        set: (p, v) => { p.pricing.humanConfirmsEveryPrice = toBool(v); },
        validate: (v) => (toBool(v) === null ? "Tell us who confirms a price." : null),
      }),
      scalarField({
        name: "neverState",
        label: "Anything we should never say?",
        kind: "list",
        section: "pricing",
        placeholder: "That we're the cheapest",
        spoken: "Is there anything else you'd never want me to say?",
        help: "One per line. These are added to the safety limits every AIDA receptionist already has.",
        get: (p) => fromList(p.pricing.neverState),
        set: (p, v) => { p.pricing.neverState = toList(v, { max: 20, maxLength: MAX_SHORT_TEXT }); },
      }),
    ]),
  }),

  // ── 6. Notifications and transfers ────────────────────────────────
  Object.freeze({
    id: "contact",
    number: 6,
    title: "Reaching you",
    intent: "Where an urgent call goes, and who hears about the rest.",
    interviewGroups: Object.freeze(["transfer", "fallback", "notifications"]),
    profileSections: Object.freeze(["transfer", "notifications"]),
    fields: Object.freeze([
      scalarField({
        name: "transferPrimary",
        label: "Number to put urgent callers through to",
        kind: "tel",
        section: "transfer",
        required: true,
        placeholder: "0400 000 000",
        spoken: "When it's urgent, what number should I put them through to?",
        help: "Usually a mobile you carry. This is separate from your public business number on purpose — putting a caller back into your own switchboard is how a genuine emergency gets lost.",
        get: (p) => p.transfer.primaryNumber,
        set: (p, v) => { p.transfer.primaryNumber = text(v) || null; },
        validate: (v) => (!text(v) ? "We need a number for urgent calls." : normaliseAuNumber(v) ? null : "That doesn't look like an Australian phone number."),
      }),
      scalarField({
        name: "transferBackup",
        label: "A second number to try",
        kind: "tel",
        section: "transfer",
        placeholder: "Optional",
        spoken: "If you don't pick up, is there a second number I should try?",
        help: "Optional. A partner, or whoever is on call with you.",
        get: (p) => p.transfer.backupNumber,
        set: (p, v) => { p.transfer.backupNumber = text(v) || null; },
        validate: (v) => (!text(v) || normaliseAuNumber(v) ? null : "That doesn't look like an Australian phone number."),
      }),
      scalarField({
        name: "permittedHours",
        label: "When may we put calls through?",
        kind: "select",
        section: "transfer",
        options: Object.freeze([
          { value: "always", label: "Any hour — if it's genuinely urgent, I want it" },
          { value: "businessHoursOnly", label: "Business hours only" },
        ]),
        spoken: "Between what hours is it alright to put calls through to that number?",
        get: (p) => (p.transfer.permittedHours && p.transfer.permittedHours.businessHoursOnly === true ? "businessHoursOnly" : "always"),
        set: (p, v) => { p.transfer.permittedHours = v === "businessHoursOnly" ? { businessHoursOnly: true } : { always: true }; },
      }),
      scalarField({
        name: "collectDetailsFirst",
        label: "Take their details before putting them through?",
        kind: "bool",
        section: "transfer",
        spoken: "Should I take their details before I transfer, or put them straight through?",
        help: "Taking details first means that if the call drops, you can still ring back.",
        get: (p) => p.transfer.collectDetailsFirst,
        set: (p, v) => { p.transfer.collectDetailsFirst = toBool(v); },
      }),
      scalarField({
        name: "unansweredAction",
        label: "If nobody answers",
        kind: "select",
        section: "transfer",
        required: true,
        options: Object.freeze([
          { value: "try_backup_number", label: "Try the second number, then take a message" },
          { value: "take_message_and_notify", label: "Take a message and tell me straight away" },
          { value: "take_message_only", label: "Just take a message" },
        ]),
        spoken: "And if nobody answers at all — take a message and text you, or just take the message?",
        get: (p) => p.transfer.unansweredAction,
        set: (p, v) => { p.transfer.unansweredAction = S.UNANSWERED_TRANSFER_ACTIONS.includes(v) ? v : null; },
        validate: (v, profile) => {
          if (!S.UNANSWERED_TRANSFER_ACTIONS.includes(v)) return "Choose what happens when nobody answers.";
          if (v === "try_backup_number" && profile && !normaliseAuNumber(profile.transfer.backupNumber)) {
            return "You've chosen to try a second number, but haven't given one.";
          }
          return null;
        },
      }),
      scalarField({
        name: "notifySms",
        label: "Mobile for call summaries",
        kind: "tel",
        section: "notifications",
        placeholder: "0400 000 000",
        spoken: "Where should I send the summary of each call — text, email, both?",
        // Truthful availability. Text messaging is built and tested but not yet
        // approved for live sending, and a customer must not discover that after
        // a missed job.
        help: "Text-message delivery is built but not switched on yet — it is pending carrier approval. Until it is, summaries go by email and everything is in your portal.",
        get: (p) => (Array.isArray(p.notifications.sms) && p.notifications.sms.length ? p.notifications.sms[0] : null),
        set: (p, v) => {
          const number = text(v);
          p.notifications.sms = number ? [number] : [];
        },
        validate: (v) => (!text(v) || normaliseAuNumber(v) ? null : "That doesn't look like an Australian mobile number."),
      }),
      scalarField({
        name: "notifyEmail",
        label: "Email for call summaries",
        kind: "email",
        section: "notifications",
        required: true,
        spoken: "And an email address for a copy?",
        help: "Where every call summary is sent today.",
        get: (p) => (Array.isArray(p.notifications.email) && p.notifications.email.length ? p.notifications.email[0] : null),
        set: (p, v) => {
          const email = text(v);
          p.notifications.email = email ? [email] : [];
        },
        validate: (v) => (!text(v) ? "We need somewhere to send your call summaries." : isValidEmail(text(v)) ? null : "That doesn't look like an email address."),
      }),
      scalarField({
        name: "notifyExtraEmail",
        label: "Anyone else who should get them?",
        kind: "list",
        section: "notifications",
        placeholder: "office@example.com",
        spoken: "Anyone else who should get them — a partner, an office manager?",
        help: "One address per line. Optional.",
        get: (p) => {
          const all = Array.isArray(p.notifications.email) ? p.notifications.email : [];
          return fromList(all.slice(1));
        },
        set: (p, v) => {
          const all = Array.isArray(p.notifications.email) ? p.notifications.email : [];
          const primary = all.length ? [all[0]] : [];
          p.notifications.email = [...primary, ...toList(v, { max: 10, maxLength: MAX_SHORT_TEXT })];
        },
        validate: (v) => {
          const bad = toList(v, { max: 10, maxLength: MAX_SHORT_TEXT }).find((e) => !isValidEmail(e));
          return bad ? `"${bad}" doesn't look like an email address.` : null;
        },
      }),
      scalarField({
        name: "notificationTiming",
        label: "How soon do you want to hear?",
        kind: "select",
        section: "notifications",
        options: Object.freeze([
          { value: "immediate", label: "As soon as the call ends" },
          { value: "end_of_call", label: "When the call finishes, with the full summary" },
          { value: "hourly_digest", label: "Hourly digest" },
          { value: "daily_digest", label: "Once a day" },
        ]),
        spoken: "How soon do you want to hear about a call?",
        get: (p) => p.notifications.timing,
        set: (p, v) => { p.notifications.timing = S.NOTIFICATION_TIMINGS.includes(v) ? v : null; },
      }),
    ]),
  }),

  // ── 7. Tone ───────────────────────────────────────────────────────
  Object.freeze({
    id: "tone",
    number: 7,
    title: "How we sound",
    intent: "The voice a caller hears, in your words.",
    interviewGroups: Object.freeze(["tone", "privacy"]),
    // `identity` is confirmed on step 1; tone writes into it but does not own it.
    profileSections: Object.freeze(["privacy"]),
    fields: Object.freeze([
      scalarField({
        name: "tone",
        label: "How should we sound?",
        kind: "select",
        section: "identity",
        required: true,
        options: Object.freeze([
          { value: "friendly_australian_trade", label: "Like a local trade business — direct, but not cold" },
          { value: "straightforward_efficient", label: "Straightforward and quick" },
          { value: "warm_reassuring", label: "Warm and reassuring first" },
          { value: "professional", label: "Formal and professional" },
          { value: "custom_reviewed", label: "Something else — we'll write it with you" },
        ]),
        spoken: "When someone's locked out at midnight, do you want me straightforward and quick, or warm and reassuring first?",
        get: (p) => p.identity.tone,
        set: (p, v) => { p.identity.tone = S.TONES.includes(v) ? v : null; },
        validate: (v) => (S.TONES.includes(v) ? null : "Choose how you'd like us to sound."),
      }),
      scalarField({
        name: "toneWording",
        label: "Phrases to use, or to avoid",
        kind: "textarea",
        section: "identity",
        maxLength: MAX_LONG_TEXT,
        spoken: "Anything you'd like me to say, or never say, in the way I talk to people?",
        help: "For example: say 'no worries' rather than 'certainly'. Reviewed before anything is spoken.",
        get: (p) => p.identity.toneWording,
        set: (p, v) => { p.identity.toneWording = text(v) || null; },
      }),
      scalarField({
        name: "callsMayBeRecorded",
        label: "Record calls, or transcribe only?",
        kind: "select",
        section: "privacy",
        required: true,
        options: Object.freeze([
          { value: "false", label: "Transcribe only — no audio kept" },
          { value: "true", label: "Record the audio as well" },
        ]),
        spoken: "Do you want calls recorded, or just transcribed?",
        help: "Recording law varies by state. We record your preference and flag it for review before recording is ever switched on.",
        get: (p) => (p.privacy.callsMayBeRecorded === true ? "true" : "false"),
        set: (p, v) => { p.privacy.callsMayBeRecorded = v === "true"; },
      }),
      scalarField({
        name: "transcriptRetention",
        label: "How long do we keep transcripts?",
        kind: "select",
        section: "privacy",
        options: Object.freeze([
          { value: "keep_12_months", label: "Twelve months" },
          { value: "keep_6_months", label: "Six months" },
          { value: "keep_3_months", label: "Three months" },
          { value: "keep_indefinitely_until_changed", label: "Until I say otherwise" },
          { value: "delete_after_summary", label: "Delete once I've had the summary" },
        ]),
        spoken: "How long should we keep transcripts?",
        get: (p) => p.privacy.transcriptRetention,
        set: (p, v) => { p.privacy.transcriptRetention = S.RETENTION_PREFERENCES.includes(v) ? v : null; },
      }),
      scalarField({
        name: "redactSensitiveData",
        label: "Strip card numbers and the like out of transcripts?",
        kind: "bool",
        section: "privacy",
        spoken: "Do you want personal details like card numbers taken out of the transcripts automatically?",
        get: (p) => p.privacy.redactSensitiveData,
        set: (p, v) => { p.privacy.redactSensitiveData = toBool(v); },
      }),
    ]),
  }),
]);

const STEP_IDS = Object.freeze(STEPS.map((s) => s.id));
const STEP_BY_ID = Object.freeze(
  STEPS.reduce((acc, s) => {
    acc[s.id] = s;
    return acc;
  }, Object.create(null))
);

// ── Journey stages ──────────────────────────────────────────────────
// The seven data steps plus the four that collect nothing. This is what the
// progress indicator walks, and what the brief calls the journey.

const STAGES = Object.freeze([
  ...STEPS.map((s) => Object.freeze({ id: s.id, number: s.number, title: s.title, kind: "form" })),
  Object.freeze({ id: "review", number: 8, title: "Check it over", kind: "review" }),
  Object.freeze({ id: "approve", number: 9, title: "Approve", kind: "approve" }),
  Object.freeze({ id: "test", number: 10, title: "Test it", kind: "test" }),
  Object.freeze({ id: "activate", number: 11, title: "Go live", kind: "activate" }),
]);

// ── Accessors ───────────────────────────────────────────────────────

function getStep(stepId) {
  return lookup(STEP_BY_ID, stepId) || null;
}

function getField(stepId, fieldName) {
  const step = getStep(stepId);
  if (!step) return null;
  return step.fields.find((f) => f.name === fieldName) || null;
}

/** The step after this one, or null at the end. Order is the declaration order. */
function nextStepId(stepId) {
  const at = STEP_IDS.indexOf(stepId);
  return at === -1 || at === STEP_IDS.length - 1 ? null : STEP_IDS[at + 1];
}

function previousStepId(stepId) {
  const at = STEP_IDS.indexOf(stepId);
  return at <= 0 ? null : STEP_IDS[at - 1];
}

/**
 * Read every field of a step out of a profile, keyed by field name. This is what
 * makes resume work: the stored draft IS the answer set, so there is no second
 * copy of the owner's answers to fall out of step with the profile.
 */
function readStep(stepId, profile) {
  const step = getStep(stepId);
  if (!step) return {};
  const out = {};
  for (const field of step.fields) out[field.name] = field.read(profile);
  return out;
}

/**
 * Validate one step's answers without applying them.
 * Returns { ok, errors: { fieldName: message } }.
 */
function validateStep(stepId, answers, profile) {
  const step = getStep(stepId);
  if (!step) return { ok: false, errors: { _step: "Unknown step." } };
  const given = answers && typeof answers === "object" ? answers : {};
  const errors = {};
  for (const field of step.fields) {
    const value = lookup(given, field.name);
    const message = field.validate(value, profile);
    if (message) errors[field.name] = message;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Apply one step's answers to a profile, returning a NEW profile.
 *
 * Applies field by field so a field absent from the payload leaves its stored
 * value alone — which is what makes a partially-filled step safe to save. A
 * field present but empty is an intentional clear and IS applied.
 */
function applyStep(stepId, answers, profile) {
  const step = getStep(stepId);
  if (!step) return profile;
  const given = answers && typeof answers === "object" ? answers : {};
  let next = profile;
  for (const field of step.fields) {
    if (!Object.prototype.hasOwnProperty.call(given, field.name)) continue;
    next = field.apply(next, lookup(given, field.name));
  }
  return next;
}

/**
 * Has this step been answered well enough to count as done?
 *
 * Only required fields count. An optional field left blank is a complete step —
 * treating it otherwise would leave a progress bar permanently short of 100%
 * and teach the owner to ignore it.
 */
function isStepComplete(stepId, profile) {
  const step = getStep(stepId);
  if (!step) return false;
  const answers = readStep(stepId, profile);
  for (const field of step.fields) {
    if (!field.required) continue;
    if (field.validate(lookup(answers, field.name), profile)) return false;
  }
  return true;
}

/** Per-step completion plus an overall count, for the progress indicator. */
function assessProgress(profile) {
  const steps = STEPS.map((step) => ({
    id: step.id,
    number: step.number,
    title: step.title,
    complete: isStepComplete(step.id, profile),
  }));
  const complete = steps.filter((s) => s.complete).length;
  return {
    steps,
    complete,
    total: steps.length,
    percent: Math.round((complete / steps.length) * 100),
    allComplete: complete === steps.length,
    nextIncomplete: (steps.find((s) => !s.complete) || { id: null }).id,
  };
}

module.exports = {
  STEP_SPEC_VERSION,
  STEPS,
  STEP_IDS,
  STAGES,
  URGENCY_PRESETS,
  URGENCY_PRESET_BY_ID,
  lookup,
  getStep,
  getField,
  nextStepId,
  previousStepId,
  readStep,
  validateStep,
  applyStep,
  isStepComplete,
  assessProgress,
  // exported for tests and for the review renderer
  toList,
  fromList,
  toBool,
};
