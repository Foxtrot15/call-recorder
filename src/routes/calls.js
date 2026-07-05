const express = require("express");
const router = express.Router();
const supabase = require("../services/supabase");

// Server-side calls API for the operator dashboard. Replaces the dashboard's
// old direct browser-to-Supabase PostgREST access (anon key embedded in
// index.html), which left the calls table readable/writable by anyone with
// the key while RLS is disabled. Mounted behind requireLogin in server.js,
// so req.clientId is always the operator's client slug.

const MAX_LIMIT = 300;

// TRANSITIONAL: rows written before per-client stamping carry
// client_id='default' (or NULL for the oldest rows). Include them alongside
// the operator's own slug so the dashboard keeps showing existing history.
// After the Phase 5 data backfill migrates those rows to the real slug,
// collapse this to a plain .eq("client_id", clientId).
function scopeToTenant(query, clientId) {
  return query.or(`client_id.eq.${clientId},client_id.eq.default,client_id.is.null`);
}

// GET /calls?limit=N — newest first, bare array (same shape PostgREST
// returned, so the dashboard's existing rendering code is unchanged).
router.get("/", async (req, res) => {
  const requested = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : MAX_LIMIT, MAX_LIMIT);

  try {
    const { data, error } = await scopeToTenant(
      supabase.from("calls").select("*"),
      req.clientId
    )
      .order("recorded_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("⚠️  Calls list failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Only the fields the dashboard actually edits — everything else on a calls
// row (transcript, analysis, client_id, call_sid, ...) is pipeline-owned and
// not writable from the browser.
const PATCHABLE_FIELDS = [
  "status",
  "instruction",
  "caller_name",
  "caller_company",
  "caller_email",
  "from_number",
  "crm_notes",
  "crm_verified",
  "crm_verified_at",
];

// PATCH /calls/:id — update whitelisted fields on one call.
router.patch("/:id", async (req, res) => {
  const updates = {};
  for (const field of PATCHABLE_FIELDS) {
    // Presence check, not truthiness — clearing a contact sets fields to null.
    if (field in req.body) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields in request body" });
  }

  try {
    const { data, error } = await scopeToTenant(
      supabase.from("calls").update(updates).eq("id", req.params.id),
      req.clientId
    ).select("id");

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Call not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("⚠️  Call update failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
