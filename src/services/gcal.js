const axios   = require("axios");
const { getToken, storeToken } = require("./token");

async function refreshAccessToken(tokenData) {
  const params = new URLSearchParams();
  params.append("client_id",     process.env.GOOGLE_CLIENT_ID);
  params.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  params.append("refresh_token", tokenData.refreshToken);
  params.append("grant_type",    "refresh_token");

  const res = await axios.post("https://oauth2.googleapis.com/token", params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
  });
  return res.data.access_token;
}

async function getAccessToken(clientId) {
  const tokenData = await getToken(clientId, "google");
  if (!tokenData) throw new Error("No Google token found for client " + clientId);

  const expiry = tokenData.expiry ? new Date(tokenData.expiry).getTime() : 0;
  let accessToken = tokenData.accessToken;

  if (!expiry || expiry < Date.now() + 60000) {
    accessToken = await refreshAccessToken(tokenData);
    await storeToken(clientId, "google", {
      accessToken,
      refreshToken: tokenData.refreshToken,
      expiry:       new Date(Date.now() + 3600000).toISOString(),
      email:        tokenData.email,
    });
  }
  return accessToken;
}

/**
 * Parse a date string like "Friday", "July 14", "Thursday 2pm" into a Date object.
 * Falls back to tomorrow if unparseable.
 */
function parseEventDate(dateStr, timeStr) {
  if (!dateStr) return null;

  const now = new Date();
  const combined = timeStr ? `${dateStr} ${timeStr}` : dateStr;

  // Try direct parse first
  const direct = new Date(combined);
  if (!isNaN(direct.getTime()) && direct > now) return direct;

  // Try with current year
  const withYear = new Date(`${combined} ${now.getFullYear()}`);
  if (!isNaN(withYear.getTime()) && withYear > now) return withYear;

  // Try next year if date has passed
  const nextYear = new Date(`${combined} ${now.getFullYear() + 1}`);
  if (!isNaN(nextYear.getTime())) return nextYear;

  return null;
}

/**
 * Create a calendar event — handles meetings, appointments, and multi-day jobs.
 */
async function createEvent(clientId, {
  title,
  description,
  attendeeEmail,
  // Meeting/appointment fields
  startTime,
  endTime,
  // Extracted facts for smart scheduling
  facts = {},
}) {
  const accessToken = await getAccessToken(clientId);

  let event;

  // ── Multi-day job (trades, projects) ──────────────────────
  if (facts.job_start_date) {
    const startDate = parseEventDate(facts.job_start_date);
    if (startDate) {
      const durationDays = parseInt(facts.job_duration_days) || 1;
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + durationDays);

      // Format as YYYY-MM-DD for all-day events
      const fmt = d => d.toISOString().split("T")[0];

      event = {
        summary:     title,
        description,
        start: { date: fmt(startDate) },
        end:   { date: fmt(endDate) },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      };
      console.log(`📅 Multi-day job: ${fmt(startDate)} to ${fmt(endDate)} (${durationDays} days)`);
    }
  }

  // ── Timed appointment (meeting, consultation, site visit) ──
  if (!event && (facts.appointment_date || startTime)) {
    let start, end;

    if (facts.appointment_date) {
      start = parseEventDate(facts.appointment_date, facts.appointment_time);
    }
    if (!start && startTime) {
      start = new Date(startTime);
    }

    if (start && !isNaN(start.getTime())) {
      // Default duration: 1 hour for meetings, 2 hours for site visits/quotes
      const durationHours = title.toLowerCase().includes("visit") || 
                            title.toLowerCase().includes("quote") ? 2 : 1;
      end = endTime ? new Date(endTime) : new Date(start.getTime() + durationHours * 60 * 60 * 1000);

      event = {
        summary:     title,
        description,
        start: { dateTime: start.toISOString(), timeZone: "Australia/Melbourne" },
        end:   { dateTime: end.toISOString(),   timeZone: "Australia/Melbourne" },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      };
      console.log(`📅 Timed appointment: ${start.toLocaleString("en-AU")}`);
    }
  }

  // ── Fallback: reminder event tomorrow ─────────────────────
  if (!event) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const end = new Date(tomorrow.getTime() + 60 * 60 * 1000);

    event = {
      summary:     title,
      description: description + "\n\n⚠️ No specific date found — please reschedule.",
      start: { dateTime: tomorrow.toISOString(), timeZone: "Australia/Melbourne" },
      end:   { dateTime: end.toISOString(),      timeZone: "Australia/Melbourne" },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    };
    console.log(`📅 Fallback reminder event created for tomorrow 9am`);
  }

  const res = await axios.post(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
    event,
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  console.log("📅 Calendar event created:", res.data.id);
  return res.data.id;
}

module.exports = { createEvent };
