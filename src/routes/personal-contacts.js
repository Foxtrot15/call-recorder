
const express = require("express");
const router = express.Router();
const { addPersonalContact, removePersonalContact, getPersonalContacts } = require("../services/personal-filter");

// POST /personal-contacts/add
router.post("/add", async (req, res) => {
  const { phone, label } = req.body;
  const clientId = req.clientId;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  try {
    await addPersonalContact(clientId, phone, label);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /personal-contacts/remove
router.post("/remove", async (req, res) => {
  const { phone } = req.body;
  const clientId = req.clientId;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  try {
    await removePersonalContact(clientId, phone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /personal-contacts/list — clientId comes from the operator session (req.clientId)
router.get("/list", async (req, res) => {
  const clientId = req.clientId;
  try {
    const contacts = await getPersonalContacts(clientId);
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
