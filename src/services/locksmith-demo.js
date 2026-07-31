// AIDA Locksmith Receptionist — demonstration dataset (M1).
//
// EVERY record in this file is invented for illustration. Nothing here is a
// real customer, a real call, a real recording, or a real phone number, and
// nothing in this module reads from a database. It exists so the public page
// can show what the product produces before a single live call has been taken.
//
// Hard rules this file obeys, enforced by test/locksmith-config.test.js:
//   1. Every record carries `demo: true` and DEMO_LABEL. The renderer prints
//      the label; a record without it must never reach the page.
//   2. Caller names are obviously illustrative first-name + initial forms.
//      No surnames, no addresses beyond a suburb, no email addresses.
//   3. Phone numbers are the reserved Australian fiction range (+61 4xx 5xx xxx
//      style numbers from 0491 570 006 etc. are NOT used either) — we simply
//      do not include caller phone numbers at all. There is no field for them.
//   4. Example calls carry `audioUrl: null`. The shape is ready for real audio
//      later; M1 ships no audio and embeds no third-party player.
//   5. Timestamps are fixed strings, not Date.now() — the page must render
//      identically on every request so it is testable and cacheable.

const DEMO_LABEL = "Demonstration data";
const DEMO_WORKSPACE_LABEL = "Demonstration workspace — example locksmith calls";

// Urgency is never signalled by colour alone (WCAG 1.4.1): each level carries
// a text label AND a shape/word marker the renderer prints next to it.
const URGENCY = Object.freeze({
  urgent: { key: "urgent", label: "Urgent", marker: "!!", description: "Answered and escalated immediately" },
  standard: { key: "standard", label: "Standard", marker: "!", description: "Booked or called back same day" },
  routine: { key: "routine", label: "Routine", marker: "–", description: "Summary sent, no interruption" },
});

function demo(record) {
  return Object.freeze({ ...record, demo: true, demoLabel: DEMO_LABEL });
}

// ── 3. Locksmith scenarios ──────────────────────────────────────────
const SCENARIOS = Object.freeze([
  demo({
    id: "residential-lockout",
    title: "Residential lockout after hours",
    caller: "Danielle R.",
    suburb: "Preston",
    jobType: "Residential lockout",
    urgency: URGENCY.urgent,
    summary:
      "Locked out of her unit at 11:40pm after the door closed behind her. " +
      "Standing in the carpark, has photo ID inside, no spare key with a neighbour.",
    action:
      "Transferred straight to the on-call locksmith. Suburb, callback number " +
      "and lock type were read out before the transfer connected.",
  }),
  demo({
    id: "vehicle-key",
    title: "Lost or damaged vehicle key",
    caller: "Sam T.",
    suburb: "Sunshine West",
    jobType: "Automotive — lost key",
    urgency: URGENCY.urgent,
    summary:
      "Only key to a 2016 hatchback lost at a worksite. Vehicle is in a public " +
      "car park that locks at midnight. Caller has registration papers on hand.",
    action:
      "Escalated as urgent. Make, model, year and whether a spare exists were " +
      "captured so the locksmith could confirm key-cutting capability first.",
  }),
  demo({
    id: "commercial-access",
    title: "Commercial lock or access failure",
    caller: "Marcus L.",
    suburb: "Port Melbourne",
    jobType: "Commercial — access control failure",
    urgency: URGENCY.urgent,
    summary:
      "Warehouse roller-door lock failed at 5:15am; morning shift cannot get in. " +
      "Site has an existing master-key system and a nominated after-hours contact.",
    action:
      "Transferred to the commercial on-call number. Site address, contact on " +
      "site and the existing system type were passed through in the summary.",
  }),
  demo({
    id: "lock-replacement",
    title: "Non-urgent lock replacement enquiry",
    caller: "Priya K.",
    suburb: "Glen Waverley",
    jobType: "Residential — lock upgrade",
    urgency: URGENCY.routine,
    summary:
      "Wants three external door locks replaced with keyed-alike deadbolts. " +
      "Flexible on timing, asked for a written quote and available dates.",
    action:
      "No transfer — the locksmith's rules mark quotes as non-urgent. Details " +
      "were emailed as a summary for follow-up during business hours.",
  }),
]);

// ── 4. Core capabilities ────────────────────────────────────────────
// Deliberately phrased as what the system does, not as marketing claims.
const CAPABILITIES = Object.freeze([
  {
    title: "After-hours and missed-call answering",
    detail: "Calls that ring out, arrive after hours, or come in while you're on a job are answered instead of lost.",
  },
  {
    title: "Locksmith-specific greeting",
    detail: "AIDA answers using your business name and a greeting written for locksmith work, not a generic script.",
  },
  {
    title: "Caller name and callback number",
    detail: "Captured and read back for confirmation, so you can reach the customer even if the call drops.",
  },
  {
    title: "Address and suburb capture",
    detail: "Where the job actually is — checked against the service area you configure.",
  },
  {
    title: "Residential, automotive and commercial classification",
    detail: "Each enquiry is categorised so automotive jobs you can't take never reach your phone at 2am.",
  },
  {
    title: "Urgency assessment",
    detail: "Lockouts and access failures are separated from quotes and upgrades using rules you set.",
  },
  {
    title: "Live transfer on your rules",
    detail: "Urgent calls can be transferred to your mobile or an on-call number, within the hours you nominate.",
  },
  {
    title: "Backup escalation",
    detail: "If the first transfer isn't answered, the call falls through to your nominated backup contact.",
  },
  {
    title: "Email or SMS summaries",
    detail: "A short written summary of every call, sent the way you prefer to receive it.",
  },
  {
    title: "Call transcripts and history",
    detail: "Every answered call is transcribed and kept, so you can check exactly what the customer said.",
  },
  {
    title: "Works with your existing number",
    detail: "Your number stays yours. Conditional call forwarding sends only unanswered calls to AIDA.",
  },
]);

// ── 2. How it works ─────────────────────────────────────────────────
const HOW_IT_WORKS = Object.freeze([
  { step: 1, title: "A customer calls", detail: "They ring your usual number. Nothing changes for them." },
  { step: 2, title: "AIDA answers as your business", detail: "Using your business name when you can't pick up." },
  { step: 3, title: "The job details are captured", detail: "Name, callback number, suburb and what's actually wrong." },
  { step: 4, title: "Urgent calls are escalated", detail: "Transferred to you or your on-call contact, on your rules." },
  { step: 5, title: "You get a concise summary", detail: "A short written record of the call by email or SMS." },
]);

// ── Setup: how a receptionist gets configured (M2 strategy, not yet live) ──
// Describes the autonomous-onboarding approach the product is being built
// around. Deliberately future-tense and labelled as upcoming: none of this is
// running yet (docs/LOCKSMITH_ONBOARDING_SPEC.md). No competitor comparison, no
// invented time savings, no claim that anything is available today.
const SETUP_STATUS_LABEL = "Coming in the founding pilot — not available yet";

const SETUP_SUMMARY =
  "Speak with AIDA once. AIDA learns how your locksmith business works, prepares " +
  "your receptionist settings, and asks you to approve them before launch.";

const SETUP_STEPS = Object.freeze([
  {
    step: 1,
    title: "One setup call",
    detail: "AIDA asks about your work, your area, your hours and what counts as urgent. About ten minutes, in plain language.",
  },
  {
    step: 2,
    title: "AIDA writes it up",
    detail: "The call is transcribed and turned into your receptionist's settings. You don't write prompts or configure anything.",
  },
  {
    step: 3,
    title: "You check it",
    detail: "You get a page headed \"Here is what AIDA understood about your business\", section by section, with anything missing flagged.",
  },
  {
    step: 4,
    title: "You approve it",
    detail: "Nothing answers your phone until you've approved it. Transfer numbers, hours and pricing rules are confirmed one at a time.",
  },
]);

// ── 5. Example calls ────────────────────────────────────────────────
// Mock scripts, written by hand. No real recordings, no third-party audio
// embeds. `audioUrl` is the slot a future recording drops into unchanged.
const EXAMPLE_CALLS = Object.freeze([
  demo({
    id: "example-residential-lockout",
    scenario: "Residential lockout after hours — 11:42pm",
    audioUrl: null,
    transcript: Object.freeze([
      { speaker: "AIDA", text: "Good evening, you've reached the after-hours line for the locksmith. I'm an automated assistant. Are you locked out right now?" },
      { speaker: "Caller", text: "Yeah, I've just locked myself out of my flat. The door shut behind me." },
      { speaker: "AIDA", text: "That's no good. Can I get your first name and the best number to call you back on, in case we get cut off?" },
      { speaker: "Caller", text: "Danielle, and it's the number I'm calling from." },
      { speaker: "AIDA", text: "Thanks Danielle. Which suburb are you in, and is it a standard front door lock or a deadbolt?" },
      { speaker: "Caller", text: "Preston. It's a deadbolt on the front door, and my keys are inside." },
      { speaker: "AIDA", text: "Understood — a residential lockout in Preston, deadbolt, keys inside. I'm putting you through to the on-call locksmith now. Please stay on the line." },
    ]),
    summary: "Residential lockout, Preston. Deadbolt, keys inside, caller waiting outside the building. Callback number confirmed.",
    urgency: URGENCY.urgent,
    outcome: "Transferred to the on-call locksmith",
    action: "Live transfer at 11:43pm; SMS summary sent to the business owner at the same time.",
  }),
  demo({
    id: "example-vehicle-key",
    scenario: "Lost vehicle key — 9:05pm",
    audioUrl: null,
    transcript: Object.freeze([
      { speaker: "AIDA", text: "You've reached the after-hours locksmith line. I'm an automated assistant. How can I help?" },
      { speaker: "Caller", text: "I've lost my car key. It's the only one I've got." },
      { speaker: "AIDA", text: "I can help with that. What's the make, model and year of the vehicle?" },
      { speaker: "Caller", text: "It's a 2016 hatchback — a Mazda 3." },
      { speaker: "AIDA", text: "Thanks. Where is the vehicle parked, and can I get your first name and callback number?" },
      { speaker: "Caller", text: "Sam. It's in the public car park in Sunshine West, and they lock the gates at midnight." },
      { speaker: "AIDA", text: "Got it, Sam — 2016 Mazda 3, only key lost, car park in Sunshine West closing at midnight. That's time-critical, so I'm escalating this to the locksmith now." },
    ]),
    summary: "Automotive lost-key job, Sunshine West. 2016 Mazda 3, no spare key, vehicle in a car park closing at midnight.",
    urgency: URGENCY.urgent,
    outcome: "Escalated to the on-call locksmith",
    action: "Transfer attempted, then escalated to the backup number when the first attempt wasn't answered.",
  }),
  demo({
    id: "example-commercial-access",
    scenario: "Commercial access failure — 5:15am",
    audioUrl: null,
    transcript: Object.freeze([
      { speaker: "AIDA", text: "You've reached the after-hours locksmith line. I'm an automated assistant. What's happened?" },
      { speaker: "Caller", text: "The roller door lock at our warehouse has failed. The morning shift starts at six and nobody can get in." },
      { speaker: "AIDA", text: "Understood. What's the site address, and who will be on site when the locksmith arrives?" },
      { speaker: "Caller", text: "Port Melbourne — I'm the site supervisor, Marcus, I'll be here." },
      { speaker: "AIDA", text: "Thanks Marcus. Do you know if the site is on a master-key system?" },
      { speaker: "Caller", text: "Yes, it is. Same system across all our doors." },
      { speaker: "AIDA", text: "Commercial access failure in Port Melbourne, master-key system, shift starting at six, you're on site. Connecting you to the commercial on-call number now." },
    ]),
    summary: "Commercial access failure, Port Melbourne. Roller-door lock on an existing master-key system; shift starts 6:00am; supervisor on site.",
    urgency: URGENCY.urgent,
    outcome: "Transferred to the commercial on-call number",
    action: "Live transfer at 5:17am; email summary sent with the site address and master-key detail.",
  }),
  demo({
    id: "example-lock-replacement",
    scenario: "Lock replacement quote — 7:50pm",
    audioUrl: null,
    transcript: Object.freeze([
      { speaker: "AIDA", text: "You've reached the locksmith's after-hours line. I'm an automated assistant. How can I help?" },
      { speaker: "Caller", text: "I'm after a quote to replace the locks on three doors." },
      { speaker: "AIDA", text: "Happy to take those details. Are the doors at a home or a business, and which suburb?" },
      { speaker: "Caller", text: "Home, in Glen Waverley. Three external doors." },
      { speaker: "AIDA", text: "And would you like them all keyed alike, so one key opens all three?" },
      { speaker: "Caller", text: "Yes, that'd be ideal. Deadbolts if possible." },
      { speaker: "AIDA", text: "Thanks Priya. That's a quote for three keyed-alike deadbolts in Glen Waverley. This isn't an emergency, so rather than waking anyone I'll send it through and the locksmith will come back to you during business hours." },
    ]),
    summary: "Quote request, Glen Waverley. Three external doors, keyed-alike deadbolts, customer flexible on timing.",
    urgency: URGENCY.routine,
    outcome: "No transfer — summary sent for business-hours follow-up",
    action: "Email summary queued for 7:00am. The locksmith's phone did not ring.",
  }),
]);

// ── 6. Dashboard preview ────────────────────────────────────────────
// Figures are illustrative for a single fictional locksmith business over one
// week. They are not aggregates of anything and must never be described as
// results, averages, or what a customer should expect.
const DASHBOARD = Object.freeze({
  label: DEMO_WORKSPACE_LABEL,
  demo: true,
  demoLabel: DEMO_LABEL,
  period: "Example week",
  metrics: Object.freeze([
    { key: "answered", label: "Calls answered", value: 38, detail: "Calls AIDA picked up" },
    { key: "urgent", label: "Urgent calls", value: 11, detail: "Classified as urgent by your rules" },
    { key: "transfers", label: "Transfers", value: 9, detail: "Connected live to a locksmith" },
    { key: "leads", label: "Leads captured", value: 26, detail: "Name and callback number recorded" },
    { key: "afterHours", label: "After-hours calls", value: 21, detail: "Outside 8am–5pm weekdays" },
    { key: "summaries", label: "Summaries sent", value: 38, detail: "Email or SMS, one per call" },
  ]),
  recentCalls: Object.freeze([
    demo({
      id: "demo-call-1",
      when: "Tue 11:42pm",
      caller: "Danielle R.",
      suburb: "Preston",
      serviceType: "Residential lockout",
      urgency: URGENCY.urgent,
      outcome: "Transferred",
      summary: "Locked out of a unit, deadbolt, keys inside. Callback number confirmed.",
    }),
    demo({
      id: "demo-call-2",
      when: "Tue 9:05pm",
      caller: "Sam T.",
      suburb: "Sunshine West",
      serviceType: "Automotive — lost key",
      urgency: URGENCY.urgent,
      outcome: "Escalated to backup",
      summary: "2016 Mazda 3, only key lost, car park closes at midnight.",
    }),
    demo({
      id: "demo-call-3",
      when: "Wed 5:15am",
      caller: "Marcus L.",
      suburb: "Port Melbourne",
      serviceType: "Commercial — access failure",
      urgency: URGENCY.urgent,
      outcome: "Transferred",
      summary: "Roller-door lock failed, master-key system, shift starts 6:00am.",
    }),
    demo({
      id: "demo-call-4",
      when: "Wed 7:50pm",
      caller: "Priya K.",
      suburb: "Glen Waverley",
      serviceType: "Residential — lock upgrade",
      urgency: URGENCY.routine,
      outcome: "Summary sent",
      summary: "Quote for three keyed-alike deadbolts. Business-hours follow-up.",
    }),
    demo({
      id: "demo-call-5",
      when: "Thu 6:20am",
      caller: "Owen B.",
      suburb: "Coburg",
      serviceType: "Residential lockout",
      urgency: URGENCY.standard,
      outcome: "Callback booked",
      summary: "Locked out of a rear door, safe indoors, happy to wait until 8am.",
    }),
    demo({
      id: "demo-call-6",
      when: "Thu 10:11pm",
      caller: "Nadia S.",
      suburb: "Brunswick East",
      serviceType: "Key cutting enquiry",
      urgency: URGENCY.routine,
      outcome: "Summary sent",
      summary: "Wants two spare house keys cut. No emergency, no transfer made.",
    }),
  ]),
});

module.exports = {
  DEMO_LABEL,
  DEMO_WORKSPACE_LABEL,
  URGENCY,
  SCENARIOS,
  CAPABILITIES,
  HOW_IT_WORKS,
  EXAMPLE_CALLS,
  DASHBOARD,
  SETUP_STATUS_LABEL,
  SETUP_SUMMARY,
  SETUP_STEPS,
};
