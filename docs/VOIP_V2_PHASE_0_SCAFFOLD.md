# VoIP v2 — Phase 0 Scaffold

**Status:** implemented on branch `feature/voip-v2-planning`. **Owns:** the
exact inventory of Phase 0 code, its safety argument, and the exit criteria to
Phase 1. Companions: [VOIP_V2_IMPLEMENTATION_PLAN.md](VOIP_V2_IMPLEMENTATION_PLAN.md)
(phases/gates), [VOIP_V2_BACKEND_SPEC.md](VOIP_V2_BACKEND_SPEC.md) (what Phase 1
will build into these placeholders).

> **One-line summary:** the repo now contains a VoIP v2 *shape* — flag, route
> surface, config validation — that is provably inert until someone sets
> `VOIP_V2_ENABLED=true`, which no production environment does.

---

## 1. What Phase 0 landed (complete inventory)

| File | What | New/modified |
|---|---|---|
| `src/config/voip.js` | The ONE flag parse (`isVoipV2Enabled`, strict `=== "true"`) + `assessVoipConfig` (D9 conditional fail-closed) | New |
| `src/config/startup-check.js` | Merges `assessVoipConfig` results into the existing fatal/warning lists | Modified (4 lines) |
| `src/routes/voip-scaffold.js` | Placeholder router claiming the spec §5 route surface; `next()` when disabled, `501` when enabled | New |
| `src/server.js` | One `app.use(require("./routes/voip-scaffold"))` mount before `/health` | Modified (1 line + comment) |
| `test/voip-config.test.js` | Unit tests for flag strictness, disabled-invisibility, enabled-fail-closed | New |
| `.env.example` | `VOIP_V2_ENABLED=false` + commented VoIP secret vars | Modified |
| `docs/VOIP_V2_*` (4 docs) | Implementation plan, backend spec, mobile app spec, this file | New |

**Nothing else.** No Twilio routing change, no SQL run, no auth change, no
pipeline change, no deploy, no push.

## 2. Safety argument — why production cannot notice this

1. **Flag default-off and strict.** Only the exact string `"true"` enables
   (`VOIP_V2_ENABLED=1`, `TRUE`, `yes` all stay off — unit-tested). No
   production environment sets it at all.
2. **Disabled ⇒ pass-through, not 404-handler.** Every placeholder route calls
   `next()` when disabled, so Express falls through to the same default 404
   these paths produce today. There is no observable difference — not status,
   not headers, not body.
3. **Disabled ⇒ zero config surface.** `assessVoipConfig` returns empty lists
   when disabled: no new warnings, no new fatals, no log lines. A non-VoIP
   deploy's startup output is unchanged (unit-tested).
4. **Enabled-but-unconfigured ⇒ refuses to boot.** If someone flips the flag
   without the Twilio API key pair (or with no push credential at all), the
   existing fail-closed startup path exits 1 with a named-var message — the
   ENCRYPTION_KEY pattern extended to the new secret class (D9, unit-tested).
5. **Enabled-and-configured ⇒ still does nothing real.** Every placeholder
   returns a static `501 {"error":"Not Implemented","feature":"voip-v2"}`. No
   auth is attached because nothing is served; real auth arrives with the real
   handlers in Phase 1 (per-route: client session vs Twilio signature).
6. **No existing route was touched.** `inbound.js`, `call.js`, `recording.js`
   are byte-identical to the branch point. The two files the architecture doc
   says will change (INV-1 guard, inbound branch) change in **Phase 1**, not
   Phase 0.

## 3. How to see it working (dev only)

```powershell
# In a LOCAL dev shell (never Railway):
$env:VOIP_V2_ENABLED = "true"
$env:TWILIO_API_KEY_SID = "SKxxxx"; $env:TWILIO_API_KEY_SECRET = "xxxx"
$env:TWILIO_APNS_PUSH_CREDENTIAL_SID = "CRxxxx"
npm run dev
# then:  curl -X POST http://localhost:3000/voice/token   → 501 voip-v2 JSON
# unset the flag → same request → plain 404 (identical to production today)
```

Boot-refusal check: set only `VOIP_V2_ENABLED=true` (no secrets) → server
exits 1 naming `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`.

## 4. Exit criteria → Phase 1

- [x] `npm test` green including `test/voip-config.test.js`
- [x] `node --check` clean across `src/`
- [x] Docs indexed in `docs/INDEX.md`; linkcheck clean
- [ ] This branch reviewed + merged (human)
- [ ] `hardening/p0-autonomous` deployed first (plan gate B4 — ENCRYPTION_KEY
      precondition), since this branch descends from it
- [ ] `devices` DDL in the backend spec §3 reviewed by a human (applied at
      Phase 1 entry, not before, same process as `create_personal_contacts.sql`)

## 5. What Phase 1 replaces here

Phase 1 deletes routes out of `voip-scaffold.js` one at a time as each real
handler lands (spec §5), until the scaffold file is empty and removed. Any
path still returning 501 is by definition unfinished — the scaffold doubles as
a progress checklist.
