// AIDA Locksmith Receptionist — the onboarding interview specification (M2).
//
// A VERSIONED SPECIFICATION, NOT A LIVE AGENT. Nothing here dials, speaks or
// connects to a voice provider. It defines what the onboarding call must
// establish, in what order, with which read-backs — so that when a voice agent
// is built it is built against a reviewed document rather than improvised.
//
// The design tension this file resolves: the call must sound like a
// conversation with someone who knows the trade, while still guaranteeing that
// every safety-critical fact is either collected or explicitly recorded as not
// given. The resolution is that question GROUPS are conversational and
// re-orderable, but each group lists `mustEstablish` keys, and the interview is
// not complete until every one is either answered or marked
// "owner_did_not_know" — silence is never treated as an answer.
//
// Also contains a full demonstration transcript (clearly labelled) that the
// deterministic fixture adapter parses, so the whole M2 workflow is testable
// end-to-end without a call ever happening.
//
// Pure + dep-free.

const INTERVIEW_SPEC_VERSION = "locksmith-interview-2026-08-01";

// ── Opening ─────────────────────────────────────────────────────────

const OPENING = Object.freeze({
  // Said before anything is asked. The recording/transcription disclosure is a
  // PLACEHOLDER pending legal review — the wording below is what we intend to
  // say, not advice that it is sufficient (see spec §13, legal-review items).
  disclosure:
    "Before we start — I'm AIDA, an automated assistant, not a person. " +
    "This call is being transcribed so I can set up your receptionist, and " +
    "you'll get to review everything I write down before anything goes live.",
  transcriptionDisclosurePlaceholder: true,
  purpose:
    "I'm going to ask about how your locksmith business runs — what work you take, " +
    "where you go, when you're available and what should happen when someone calls " +
    "you at two in the morning. It takes about ten minutes. Nothing goes live until " +
    "you've read it back and approved it.",
  reassurance:
    "There are no wrong answers, and 'I don't know yet' is a perfectly good one — " +
    "I'll note it and we can leave that part switched off until you decide.",
});

// ── Handling rules ──────────────────────────────────────────────────

const HANDLING = Object.freeze({
  uncertainty:
    "If the owner is unsure, record the uncertainty rather than the guess. Mark the " +
    "field as not established and move on — an unanswered question is safe, a " +
    "fabricated answer is not.",
  contradiction:
    "If a later answer contradicts an earlier one, say so plainly, quote both back, " +
    "and ask which is right. Never silently keep the most recent answer.",
  ownerDoesNotKnow:
    "Accept it, record `owner_did_not_know` for that key, and tell them it will show " +
    "on the review page as something to decide before launch.",
  neverInfer: Object.freeze([
    "That an unlisted service is accepted. Services are opt-in, always.",
    "That a suburb is covered because it is near one that is.",
    "That after-hours work is accepted because a mobile number was given.",
    "That a price mentioned in passing may be quoted to callers.",
    "That a transfer number is correct because it sounded plausible — read every digit back.",
    "That emergency services will attend, or that AIDA can summon them.",
    "That the business is licensed, insured or verified in any way.",
  ]),
});

// ── Question groups ─────────────────────────────────────────────────
// `mustEstablish` keys map onto canonical profile paths. `readBack: true` means
// AIDA repeats the captured value and waits for confirmation IN THE CALL —
// separate from, and additional to, the review page.

const QUESTION_GROUPS = Object.freeze([
  {
    id: "identity",
    title: "Business identity",
    intent: "How the phone should be answered, and who is answering it.",
    questions: [
      "What's the business called — the name you'd want me to say when I pick up?",
      "Is that the same as the name on your invoices, or is the legal name different?",
      "What should I call myself when I answer? Some owners like a receptionist name, some prefer 'the answering service'.",
      "How would you like me to greet people? I can read you a couple of options.",
      "Which state are you based in?",
      "How would you describe the business to someone who's never called before?",
    ],
    mustEstablish: ["identity.spokenName", "identity.receptionistName", "identity.greeting", "identity.timezone"],
    readBack: true,
  },
  {
    id: "tone",
    title: "Preferred tone",
    intent: "How AIDA should sound. Offered as choices, not as an open question.",
    questions: [
      "When someone's locked out at midnight, do you want me straightforward and quick, or warm and reassuring first?",
      "Some owners want it quite formal, others want it to sound like a local trade business. Which is closer to you?",
    ],
    mustEstablish: ["identity.tone"],
    readBack: false,
  },
  {
    id: "services_accepted",
    title: "Services accepted",
    intent: "Every category of work the business will actually take. Opt-in only.",
    questions: [
      "Let's go through the work you take. Residential lockouts — yes?",
      "Car work? That's a big one — lockouts, lost keys, cutting a replacement key?",
      "Commercial? Shopfronts, offices, that sort of thing?",
      "Rekeying, lock installs, broken keys, safes, access control — which of those are you set up for?",
      "Anything you do that I haven't mentioned?",
    ],
    mustEstablish: ["servicesAccepted"],
    conditionalFollowUps: [
      { when: "automotive accepted", ask: "For car jobs, do you need the make, model and year before you'd come out?" },
      { when: "safe opening accepted", ask: "Do you do safes any time, or is that business-hours only?" },
      { when: "commercial accepted", ask: "Do commercial jobs go to a different number after hours?" },
    ],
    readBack: true,
  },
  {
    id: "services_declined",
    title: "Services declined",
    intent: "Explicit exclusions, recorded separately so nothing is inferred.",
    questions: [
      "Is there anything you'd rather I never take a job for? Some locksmiths don't touch cars, some won't do safes.",
      "If someone rings asking for that, should I say you don't do it, or take their details anyway?",
    ],
    mustEstablish: ["servicesDeclined"],
    readBack: true,
    note: "An empty list is a valid answer and is recorded as such — it is not the same as 'unknown'.",
  },
  {
    id: "service_areas",
    title: "Service areas",
    intent: "Where the van actually goes, and what happens when it is somewhere else.",
    questions: [
      "Which suburbs or areas do you cover day to day?",
      "Anywhere you'll stretch to if the job's worth it?",
      "Anywhere you definitely won't go?",
      "Does that change after hours — smaller area at 2am?",
      "If someone rings from outside your area, what do you want me to do? I can take their details for you to look at, politely tell them it's outside your area, or put them through to you to decide.",
    ],
    mustEstablish: ["serviceAreas.primary", "serviceAreas.outsideAreaAction"],
    readBack: true,
  },
  {
    id: "hours",
    title: "Hours",
    intent: "Ordinary trading hours, day by day, in the business's own timezone.",
    questions: [
      "What are your normal hours, Monday to Friday?",
      "Saturdays?",
      "Sundays?",
      "Public holidays — closed, or by arrangement?",
    ],
    mustEstablish: ["hours.ordinary", "hours.timezone"],
    readBack: true,
  },
  {
    id: "after_hours",
    title: "After-hours work",
    intent: "Whether the phone should ever wake someone up, and on what terms.",
    questions: [
      "Do you take call-outs after hours?",
      "All night, or up to a certain time?",
      "Is after-hours only for certain kinds of job — lockouts but not quotes, say?",
    ],
    mustEstablish: ["hours.afterHoursAvailable"],
    readBack: true,
  },
  {
    id: "urgency",
    title: "What counts as urgent",
    intent: "The rules that decide whether a phone rings at 3am. Safety-critical.",
    questions: [
      "If someone's locked outside their house late at night, is that a wake-you-up job?",
      "What if there's a child in the car, or someone vulnerable — elderly, unwell?",
      "Someone's been broken into and can't secure the house — urgent?",
      "A shop that can't open in the morning?",
      "And on the other side: a quote for new locks, or a spare key cut — those can wait until business hours?",
    ],
    mustEstablish: ["urgencyRules"],
    readBack: true,
    note: "AIDA must not offer to contact emergency services and must not imply they are coming.",
  },
  {
    id: "transfer",
    title: "Transfers",
    intent: "Where an urgent call actually goes. The most safety-critical group.",
    questions: [
      "When it's urgent, what number should I put them through to?",
      "Let me read that back to you digit by digit.",
      "Between what hours is it alright to put calls through to that number?",
      "Should I take their details before I transfer, or put them straight through?",
    ],
    mustEstablish: ["transfer.primaryNumber"],
    readBack: true,
    safetyCritical: true,
  },
  {
    id: "fallback",
    title: "Backup rules",
    intent: "What happens when the transfer is not answered.",
    questions: [
      "If you don't pick up, is there a second number I should try?",
      "How many times should I try before I take a message instead?",
      "And if nobody answers at all — take a message and text you, or just take the message?",
    ],
    mustEstablish: ["transfer.unansweredAction"],
    readBack: true,
    safetyCritical: true,
  },
  {
    id: "notifications",
    title: "Notifications",
    intent: "Who hears about a call, how, and how quickly.",
    questions: [
      "Where should I send the summary of each call — text, email, both?",
      "Same for urgent ones, or somewhere different?",
      "Anyone else who should get them — a partner, an office manager?",
    ],
    mustEstablish: ["notifications"],
    readBack: false,
  },
  {
    id: "pricing",
    title: "Pricing permissions",
    intent: "Whether AIDA may say anything at all about money. Defaults to no.",
    questions: [
      "Do you want me to give people any idea of price, or keep that between you and them?",
      "If yes — what's the wording you're comfortable with me using?",
      "Is there anything I should never say about price?",
      "Do you want to confirm every price yourself before it's given?",
    ],
    mustEstablish: ["pricing.mayMentionPricing", "pricing.humanConfirmsEveryPrice"],
    readBack: true,
    safetyCritical: true,
    note: "If the owner is unsure, the safe default is recorded: no price given, locksmith confirms.",
  },
  {
    id: "caller_info",
    title: "Required caller details",
    intent: "What AIDA must get before ending any call.",
    questions: [
      "What do you need to know before you'd get in the van?",
      "Name and number obviously — what about the address, or is the suburb enough to start?",
      "For car jobs, do you need the make and model up front?",
      "Should I remind people they'll need proof it's their car or their house?",
    ],
    mustEstablish: ["callerInfo.always"],
    readBack: true,
  },
  {
    id: "forbidden",
    title: "Things AIDA must never say",
    intent: "Read out, not asked. The floor is not negotiable; extra items are welcome.",
    questions: [
      "There are some things I'll never say, and I want you to know what they are: I won't guarantee someone's available, I won't promise a time, I won't quote a fixed price unless you've approved the words, I won't tell anyone a locksmith is already on the way, and I won't give legal or insurance advice.",
      "Is there anything else you'd never want me to say?",
    ],
    mustEstablish: ["forbiddenPromises"],
    readBack: false,
    safetyCritical: true,
  },
  {
    id: "privacy",
    title: "Recording and privacy",
    intent: "The client's stated preference. Not a legal determination.",
    questions: [
      "Do you want calls recorded, or just transcribed?",
      "How long should we keep transcripts?",
      "Do you want personal details like card numbers taken out of the transcripts automatically?",
    ],
    mustEstablish: ["privacy.callsMayBeRecorded"],
    readBack: false,
    note: "Recording law varies by state. AIDA records the preference and flags that legal review is required before recording is enabled.",
  },
  {
    id: "read_back",
    title: "Final read-back",
    intent: "The whole configuration, summarised aloud, before anything is written.",
    questions: [
      "Let me read the important bits back. Stop me if any of it's wrong.",
      "That's your transfer number, your hours, what you take, what you don't, where you go, and what I'm allowed to say about price.",
      "I'll send this to you to read properly. Nothing switches on until you've approved it.",
    ],
    mustEstablish: [],
    readBack: true,
    safetyCritical: true,
  },
]);

// Groups whose facts must be individually confirmed before approval.
const SAFETY_CRITICAL_GROUPS = Object.freeze(QUESTION_GROUPS.filter((g) => g.safetyCritical).map((g) => g.id));

const COMPLETION_CRITERIA = Object.freeze({
  rule: "Every mustEstablish key is either answered or explicitly recorded as owner_did_not_know.",
  neverComplete: [
    "A safety-critical group with an unanswered key and no explicit 'don't know'.",
    "A transfer number that was not read back digit by digit.",
    "A contradiction that was raised and not resolved.",
  ],
  closing:
    "Thanks — that's everything I need. I'll write it up and send you a link to check it. " +
    "Nothing answers your phone until you've approved it.",
});

// ── Demonstration transcript ────────────────────────────────────────
// DEMONSTRATION DATA. A fictional Melbourne locksmith, invented for testing and
// documentation. Not a real business, not a real person, not a real call.
//
// The phone numbers come from the ACMA fictitious-number range reserved for
// drama and training (0491 570 006 - 0491 570 156). They are valid Australian
// mobile numbers by format — so they exercise the real validator rather than
// being waved through — but they are permanently unallocated, so no test,
// fixture or screenshot can ever ring a real handset. The email domain is
// example-only and the suburbs are real Melbourne suburbs attached to an
// invented business.

const DEMO_LABEL = "Demonstration data — mock onboarding interview, not a real call";

const DEMO_TRANSCRIPT = `AIDA: Before we start — I'm AIDA, an automated assistant, not a person. This call is being transcribed so I can set up your receptionist, and you'll get to review everything I write down before anything goes live. Is that alright?
Owner: Yeah, no worries.
AIDA: I'm going to ask about how your locksmith business runs — what work you take, where you go, when you're available, and what should happen when someone calls at two in the morning. About ten minutes. Nothing goes live until you approve it.
Owner: Righto.
AIDA: What's the business called — the name you'd want me to say when I pick up?
Owner: Northside Lock and Key.
AIDA: And is that the name on your invoices too?
Owner: It's Northside Lock and Key Pty Ltd on the paperwork, but nobody says the Pty Ltd bit.
AIDA: Understood. What should I call myself when I answer?
Owner: Just say you're the after-hours line. Actually — give yourself a name, it's friendlier. Call yourself Mel.
AIDA: Mel it is. How would you like me to greet people?
Owner: Something like "Northside Lock and Key, this is Mel, how can I help?"
AIDA: "Northside Lock and Key, this is Mel, how can I help?" Which state are you based in?
Owner: Victoria. Melbourne, northern suburbs.
AIDA: How would you describe the business to someone who's never called?
Owner: Family-run, been going nineteen years, mostly residential and commercial. We're not a big franchise, it's me and two other blokes.
AIDA: When someone's locked out at midnight, do you want me straightforward and quick, or warm and reassuring first?
Owner: Bit of both, but don't be stiff about it. We're a trade business, not a bank.
AIDA: I'll use a friendly Australian trade tone — direct, but not cold.
Owner: That's it.
AIDA: Let's go through the work you take. Residential lockouts — yes?
Owner: Yep, that's most of what we do at night.
AIDA: Car work — lockouts, lost keys, cutting replacement keys?
Owner: No. We don't touch cars at all. Don't have the gear for the transponder stuff, so don't send me any of that.
AIDA: Noted — no automotive work of any kind. Commercial? Shopfronts, offices?
Owner: Yeah, we do a fair bit of commercial. Rekeying, master key systems, that sort of thing.
AIDA: Rekeying, lock installs, broken key extraction, safes, access control — which of those are you set up for?
Owner: Rekeying yes, lock installs yes, broken keys yes. Safes no — that's a specialist thing. Access control, we can do basic stuff, electric strikes, but not the full card system.
AIDA: I'll record access control as accepted with a note that it's basic hardware only, not full card systems. Break-ins — someone's been forced and needs securing?
Owner: Definitely, that's a priority job for us.
AIDA: Anything you do that I haven't mentioned?
Owner: Key cutting, but only at the shop during the day. Don't come out for it.
AIDA: Is there anything you'd rather I never take a job for?
Owner: Cars, like I said. And safes. And don't take key cutting as a call-out — tell them to come in.
AIDA: Understood. If someone rings about cars, should I say you don't do it, or take their details anyway?
Owner: Just tell them straight. No point wasting their time.
AIDA: Which suburbs do you cover day to day?
Owner: Preston, Reservoir, Coburg, Brunswick, Thornbury, Northcote. That's the core.
AIDA: Anywhere you'll stretch to if the job's worth it?
Owner: Epping and Bundoora, if it's commercial. Not for a lockout.
AIDA: Anywhere you definitely won't go?
Owner: Anything past the city. No Frankston, no Geelong, nothing like that.
AIDA: Does the area shrink after hours?
Owner: Yeah — at night just the core suburbs. I'm not driving to Epping at 3am.
AIDA: If someone rings from outside your area, what should I do? I can take their details for you to look at, politely tell them it's outside your area, or put them through to you.
Owner: Take their details. Sometimes I'll do it if it's quiet.
AIDA: What are your normal hours, Monday to Friday?
Owner: Eight to five.
AIDA: Saturdays?
Owner: Eight till one.
AIDA: Sundays?
Owner: Closed, except emergencies.
AIDA: Public holidays?
Owner: Closed, same deal — emergencies only, by arrangement.
AIDA: Do you take call-outs after hours?
Owner: Yeah, that's half the business.
AIDA: All night, or up to a certain time?
Owner: All night for lockouts and break-ins. Not for anything else.
AIDA: If someone's locked outside their house late at night, is that a wake-you-up job?
Owner: Yes. Especially if they're outside in the cold.
AIDA: What if there's a child involved, or someone elderly or unwell?
Owner: Straight through to me, any hour. That's the top priority.
AIDA: Someone's been broken into and can't secure the house?
Owner: Same — straight through.
AIDA: A shop that can't open in the morning?
Owner: Urgent, yeah, but that's usually early morning rather than the middle of the night.
AIDA: And a quote for new locks, or a spare key cut?
Owner: Those can wait. Don't ring me for those.
AIDA: When it's urgent, what number should I put them through to?
Owner: Oh four nine one, five seven oh, oh oh six.
AIDA: Let me read that back — oh four nine one, five seven oh, oh oh six. Is that right?
Owner: That's the one.
AIDA: Between what hours is it alright to put calls through to that number?
Owner: Any time. If it's genuinely urgent I want it.
AIDA: Should I take their details before I transfer, or put them straight through?
Owner: Get their name, number and suburb first. Then put them through. If we get cut off at least I can ring back.
AIDA: If you don't pick up, is there a second number I should try?
Owner: Try Dave — oh four nine one, five seven oh, oh one five.
AIDA: Reading the backup back — oh four nine one, five seven oh, oh one five. How many times should I try before taking a message?
Owner: Give it two goes, then just take a message.
AIDA: And if nobody answers at all?
Owner: Take a message and text me straight away.
AIDA: Where should I send the summary of each call?
Owner: Text me on the main number, and email a copy to the office.
AIDA: What's the office email?
Owner: office at northsidelockandkey dot example dot com.
AIDA: Do you want me to give people any idea of price, or keep that between you and them?
Owner: Keep it between us. I'm not having a computer quote a job it hasn't seen.
AIDA: So I won't mention pricing at all, and you'll confirm every price yourself?
Owner: Correct. If they push, just say I'll confirm when I know what I'm looking at.
AIDA: What do you need to know before you'd get in the van?
Owner: Name, number, suburb, and what's actually happened. Whether the house is secure matters too — if a door's hanging open that changes how fast I move.
AIDA: Should I get the street address as well?
Owner: Yeah, get the address before you put them through.
AIDA: Should I remind people they'll need proof it's their property?
Owner: Yes. Saves an argument on the doorstep.
AIDA: There are some things I'll never say, and I want you to know what they are: I won't guarantee someone's available, I won't promise an arrival time, I won't quote a fixed price unless you've approved the words, I won't tell anyone a locksmith is already on the way, I won't claim anyone's licensing has been checked, I won't advise anyone how to force entry, I won't promise police or ambulance will attend, and I won't give legal or insurance advice.
Owner: Good. Definitely don't promise a time — that's how you get complaints.
AIDA: Anything else you'd never want me to say?
Owner: Don't tell them we're the cheapest. We're not, and I don't want that fight.
AIDA: Do you want calls recorded, or just transcribed?
Owner: Just transcribed is fine. Don't need recordings sitting around.
AIDA: How long should we keep transcripts?
Owner: Twelve months, then get rid of them.
AIDA: Do you want personal details like card numbers taken out automatically?
Owner: Yeah, do that.
AIDA: Let me read the important bits back. Stop me if any of it's wrong. You're Northside Lock and Key, I answer as Mel, you're in Melbourne. You take residential lockouts, commercial work, rekeying, lock installs, broken key extraction, basic access control and break-in security. You don't do cars, safes, or key-cutting call-outs. Core area is Preston, Reservoir, Coburg, Brunswick, Thornbury and Northcote, stretching to Epping and Bundoora for commercial only, nothing past the city, and just the core suburbs after hours. Eight to five weekdays, eight till one Saturday, closed Sunday and public holidays except emergencies. Urgent calls go to your mobile any hour, after I've taken name, number, suburb and address; if you don't answer I try Dave, twice, then take a message and text you. I don't discuss price at all — you confirm everything. Transcripts kept twelve months, no recordings, sensitive details redacted.
Owner: That's all correct.
AIDA: Thanks — that's everything I need. I'll write it up and send you a link to check it. Nothing answers your phone until you've approved it.
Owner: Beauty. Thanks.`;

module.exports = {
  INTERVIEW_SPEC_VERSION,
  OPENING,
  HANDLING,
  QUESTION_GROUPS,
  SAFETY_CRITICAL_GROUPS,
  COMPLETION_CRITERIA,
  DEMO_LABEL,
  DEMO_TRANSCRIPT,
};
