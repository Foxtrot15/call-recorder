// Deterministic grounding guard for LLM-generated email drafts.
//
// Prompts instruct Claude not to fabricate; this module ENFORCES it. A draft
// is checked against the evidence (transcript + transcript-derived analysis):
// any proper-noun entity or concrete date/time in the draft that has no
// support in the evidence marks the draft ungrounded, and the caller falls
// back to the safe template (prompts.buildFallbackEmailBody) instead of
// sending fiction to a customer.
//
// Heuristic by design: it prefers false positives (rejecting an awkward but
// honest draft costs a blander email) over false negatives (a hallucinated
// company name reaching a customer costs trust). Pure module, no deps —
// tested in test/draft-guard.test.js.

// Words that are capitalised for grammatical reasons, not because they name
// an entity. Kept deliberately small and generic.
const COMMON_CAPITALISED = new Set([
  "i", "i'll", "i'm", "i've", "i'd",
  "hi", "hello", "dear", "hey",
  "thanks", "thank", "cheers", "kind", "best", "warm", "regards",
  "the", "a", "an", "and", "but", "or", "so", "if", "as", "at", "on", "in", "to", "for", "of", "with",
  "it", "it's", "we", "we'll", "we're", "you", "your", "yours", "my", "our", "me", "us", "this", "that", "these", "those", "he", "she", "they",
  "please", "sorry", "great", "good", "morning", "afternoon", "evening", "today", "tomorrow", "yesterday",
  "just", "also", "once", "after", "before", "when", "while", "then", "there", "here", "let", "let's",
  "am", "pm", "no", "not", "will", "would", "can", "could", "should", "looking", "speak", "talk", "call", "phone", "email", "message", "voicemail",
]);

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function normalise(s) {
  return (s || "").toLowerCase();
}

// Extract candidate entities from a draft:
//  - multi-word capitalised runs ("Streamline Software", "North Sydney Plumbing")
//  - single capitalised words that are not sentence-initial and not common
function extractCandidateEntities(draft) {
  const entities = new Set();
  const lines = (draft || "").split(/\n+/);
  for (const line of lines) {
    // Split into sentences so we know which words are sentence-initial.
    const sentences = line.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).filter(Boolean);
      let run = [];
      for (let i = 0; i < words.length; i++) {
        const raw = words[i].replace(/^[("'‘“]+|[,.;:!?)("'’”]+$/g, "");
        const isCap = /^[A-Z][a-zA-Z'&-]*$/.test(raw);
        if (isCap) {
          run.push({ word: raw, index: i });
        } else {
          flushRun(run, entities);
          run = [];
        }
      }
      flushRun(run, entities);
    }
  }
  return [...entities];
}

function flushRun(run, entities) {
  if (!run.length) return;
  if (run.length >= 2) {
    // Multi-word capitalised run — strong entity signal even at sentence start,
    // but trim leading common words ("Thanks Streamline Software" → drop "Thanks").
    const trimmed = run.filter((r, idx) => !(idx === 0 && COMMON_CAPITALISED.has(r.word.toLowerCase())));
    if (trimmed.length >= 2) {
      entities.add(trimmed.map((r) => r.word).join(" "));
      return;
    }
    run = trimmed;
  }
  for (const r of run) {
    const lower = r.word.toLowerCase();
    if (r.index === 0) continue; // sentence-initial single word: grammatical capital
    if (COMMON_CAPITALISED.has(lower)) continue;
    if (DAY_NAMES.includes(lower) || MONTH_NAMES.includes(lower)) continue; // handled as temporal claims
    entities.add(r.word);
  }
}

// Extract temporal claims: day names, month names, and clock times.
function extractTemporalClaims(draft) {
  const text = normalise(draft);
  const claims = new Set();
  for (const d of DAY_NAMES) if (new RegExp(`\\b${d}\\b`).test(text)) claims.add(d);
  for (const m of MONTH_NAMES) if (new RegExp(`\\b${m}\\b`).test(text)) claims.add(m);
  const times = text.match(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/g) || [];
  for (const t of times) claims.add(t.replace(/\s+/g, ""));
  return [...claims];
}

// Is an entity supported by the evidence? Case-insensitive containment; for
// multi-word entities, also accept all individual significant words being
// present (handles "Streamline Software Pty" vs "streamline software").
function isSupported(entity, evidence) {
  const ev = normalise(evidence);
  const ent = normalise(entity);
  if (ev.includes(ent)) return true;
  const words = ent.split(/\s+/).filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => ev.includes(w));
}

/**
 * Validate a draft against its evidence.
 * @param draft       the LLM-generated email body
 * @param evidence    { transcript, analysis, allowlist } — allowlist covers
 *                    values legitimately known outside the transcript
 *                    (caller first name used in the greeting, owner sign-off).
 * @returns { ok, ungroundedEntities, ungroundedTemporals }
 */
function validateDraft(draft, { transcript = "", analysis = null, allowlist = [] } = {}) {
  const evidenceParts = [transcript, JSON.stringify(analysis || {}), ...allowlist];
  const evidence = evidenceParts.join("\n");

  const ungroundedEntities = extractCandidateEntities(draft).filter((e) => !isSupported(e, evidence));
  const ungroundedTemporals = extractTemporalClaims(draft).filter((t) => !normalise(evidence).replace(/\s+/g, " ").includes(t.replace(/(am|pm)$/, " $1").trim()) && !normalise(evidence).includes(t));

  return {
    ok: ungroundedEntities.length === 0 && ungroundedTemporals.length === 0,
    ungroundedEntities,
    ungroundedTemporals,
  };
}

module.exports = { validateDraft, extractCandidateEntities, extractTemporalClaims };
