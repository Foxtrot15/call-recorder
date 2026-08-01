# Retell sandbox validation plan

**Status: NOT EXECUTED.** Nothing in this document has been run. No Retell
account is connected, no API key exists in this environment, no resource has
been created, and no phone or web call has been placed.

This is the procedure for the first real provider validation, written while the
contracts were being corrected so that the plan reflects what the code now
actually sends.

---

## Why a web call first, not a phone number

The first validation should use **`POST /v2/create-web-call`**, before buying or
importing an Australian phone number.

- A web call needs no number, so it costs less and commits to nothing.
- It exercises the parts most likely to be wrong — knowledge base, LLM, agent,
  dynamic variables, transcript, analysis — without the phone-binding contract
  in the way.
- An Australian number is a recurring cost and a porting decision; making it a
  prerequisite for learning whether the agent payload is even accepted is the
  wrong order.
- Phone binding can then be validated separately, once the agent is known good.

---

## Prerequisites (all currently absent)

| Requirement | Status |
|---|---|
| Retell account | not created |
| `RETELL_API_KEY` | not set |
| Confirmed `voice_id` from the dashboard | unknown — **no voice id may be invented** |
| Confirmed language/locale (is `en-AU` supported?) | unverified |
| Publicly reachable `RETELL_WEBHOOK_BASE_URL` | not available |
| Node runtime compatible with the Retell SDK | unverified |
| **Explicit user permission to create billable resources** | **not given** |

`ANTHROPIC_API_KEY` is **not** required for provider-contract validation. It is
only needed later, for the real Claude extraction adapter, which is a separate
concern.

---

## Sequence

Run with `RETELL_ALLOWED_TAG=dev`. The execution gate refuses `prod`.

1. **Create a knowledge base** — one temporary KB, multipart, one text item.
   Capture `knowledge_base_id`.
2. **Poll until `status` is `complete`.** Record how long it takes; this is
   currently unknown and affects whether provisioning can be synchronous.
3. **Create the Retell LLM**, attaching `knowledge_base_ids`. Capture `llm_id`
   and `version`.
4. **Confirm `llm_id` was captured** before continuing. The reference resolver
   fails closed here, so a missing id stops the run rather than sending null.
5. **Create the agent** with `response_engine: {type: "retell-llm", llm_id}` and
   a real `voice_id`. Capture `agent_id` and `version`.
6. **Create a web call** for that agent.
7. **Supply controlled dynamic variables** — a fictitious transfer number from
   the ACMA range (0491 570 006–156) and a fictitious business name. **Never a
   real client's data.**
8. **Join in the browser** using `access_token`.
9. **Speak a fictional locksmith scenario**, including one in-area suburb and
   one out-of-area suburb, to test the service-area boundary.
10. **Retrieve the call** and record `call_status`.
11. **Verify transcript and analysis** against `post_call_analysis_data`: are
    the custom enum fields populated, and with valid values?
12. **Verify no cross-client data** appears anywhere in the transcript,
    analysis, or knowledge retrieval.
13. **Delete or archive** every temporary resource (see cleanup below).
14. **Record actual cost.**

### What to watch for specifically

These are the assumptions most likely to break, in order:

1. Multipart KB encoding accepted verbatim.
2. `general_prompt` accepted at its compiled length.
3. `en-AU` supported, or silently coerced to `en-US`.
4. Whether `{{variable}}` placeholders resolve as documented.
5. Whether an unsupplied variable really renders literally — the failure mode
   that would read `{{runtime}}` aloud to a caller.
6. Analysis timing: attached to `call_ended` or only to `call_analyzed`.

---

## Expected billable actions

Every step below costs money. None has been incurred.

| Action | Cost |
|---|---|
| Knowledge base creation/storage | provider-dependent, likely small |
| LLM + agent creation | typically free to create |
| **Web call minutes** | **charged per minute — the main cost** |
| Phone number (deferred) | recurring monthly |
| Inbound call minutes (deferred) | per minute |

Keep the first web call short. A minute is enough to prove the contract.

---

## Cleanup

Run immediately after recording results:

1. Delete the web call record if the provider allows it; otherwise note the id.
2. Delete the temporary knowledge base.
3. Delete or archive the agent and the Retell LLM.
4. **Retell exposes no delete endpoint for agents or LLMs** (the basis of AIDA's
   re-point rollback model). If that is still true, mark the AIDA registry rows
   superseded instead and record the orphaned provider ids so a later manual
   cleanup is possible.
5. Confirm no resource carries a real client identifier.
6. Revoke the sandbox API key if it will not be reused.

---

## What this plan does NOT do

- It does not connect a production number.
- It does not use a real client's profile — only the demonstration fixture.
- It does not enable `RETELL_LIVE_CALLS_ENABLED` for outbound calls.
- It does not validate billing, which is a separate provider entirely.
- It does not make the receptionist live for anyone.
