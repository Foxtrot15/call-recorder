require("dotenv").config();
const express = require("express");
const path    = require("path");
const app     = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));
app.set("trust proxy", true);

const { twilioWebhook } = require("./middleware/auth");

app.use("/inbound",           twilioWebhook, require("./routes/inbound"));
app.use("/outbound",          twilioWebhook, require("./routes/outbound"));
app.use("/recording",         twilioWebhook, require("./routes/recording"));
app.use("/call",              require("./routes/call"));
app.use("/auth",              require("./routes/auth"));
app.use("/test",              require("./routes/test")); // TODO: needs dashboard login, see note
app.use("/personal-contacts", require("./routes/personal-contacts"));
app.use("/voicemail",         require("./routes/voicemail")); // TODO: needs dashboard login, see note
app.get("/health", (req, res) => res.json({ status: "ok" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
