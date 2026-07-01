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

// Parse day names into next occurrence of that day
function nextDayOfWeek(dayName) {
  const days = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const target = days[dayName.toLowerCase()];
  if (target === undefined) return null;
  
  const now = new Date();
  const currentDay = now.getDay();
  let diff = (target - currentDay + 7) % 7;
  if (diff === 0) diff = 7; // same day = next week
  
  const result = new Date(now);
  result.setDate(result.getDate() + diff);
  result.setHours(9, 0, 0, 0);
  return result;
}

// Parse time string like "2pm", "9am", "14:00" into hours/minutes
function parseTime(timeStr) {
  if (!timeStr) return { hours: 9, minutes: 0 };
  const clean = timeStr.trim().toLowerCase();
  const match12 = clean.match(/^(\d+)(?::(\d+))?\s*(am|pm)$/);
  if (match12) {
    let hours = parseInt(match12[1]);
    const minutes = parseInt(match12[2] || "0");
    if (match12[3] === "pm" && hours !== 12) hours += 12;
    if (match12[3] === "am" && hours === 12) hours = 0;
    return { hours, minutes };
  }
  const match24 = clean.match(/^(\d+):(\d+)$/);
  if (match24) return { hours: parseInt(match24[1]), minutes: parseInt(match24[2]) };
  return { hours: 9, minutes: 0 };
}

// Parse "July 14", "14 July", "14/7", "2026-07-14" into a Date
function parseMonthDay(str) {
  if (!str) return null;
  const months = { january:1,february:2,march:3,april:4,may:5,june:6,
                   july:7,august:8,september:9,october:10,november:11,december:12,
                   jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  
  // "July 14" or "14 July"
  const monthDay = str.match(/([a-z]+)\s+(\d+)/i) || str.match(/(\d+)\s+([a-z]+)/i);
  if (monthDay) {
    const monthStr = (monthDay[1].match(/[a-z]/i) ? monthDay[1] : monthDay[2]).toLowerCase();
    const day = parseInt(monthDay[1].match(/\d/) ? monthDay[1] : monthDay[2]);
    const month = months[monthStr];
    if (month && day) {
      const now = new Date();
      let year = now.getFullYear();
      const candidate = new Date(year, month - 1, day, 9, 0, 0);
      if (candidate <= now) candidate.setFullYear(year + 1);
      return candidate;
    }
  }

  // ISO format
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(parseInt(iso[1]), parseInt(iso[2])-1, parseInt(iso[3]), 9, 0, 0);

  // dd/mm or mm/dd
  const slashed = str.match(/(\d+)\/(\d+)/);
  if (slashed) {
    const now = new Date();
    // Assume dd/mm for AU
    const d = new Date(now.getFullYear(), parseInt(slashed[2])-1, parseInt(slashed[1]), 9, 0, 0);
    if (d <= now) d.setFullYear(now.getFullYear() + 1);
    return d;
  }

  return null;
}

function parseEventDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const clean = dateStr.trim();

  // Try day name first
  const dayNames = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const lowerClean = clean.toLowerCase();
  for (const day of dayNames) {
    if (lowerClean.includes(day)) {
      const date = nextDayOfWeek(day);
      if (date && timeStr) {
        const { hours, minutes } = parseTime(timeStr);
        date.setHours(hours, minutes, 0, 0);
      }
      return date;
    }
  }

  // Try month+day
  const date = parseMonthDay(clean);
  if (date && timeStr) {
    const { hours, minutes } = parseTime(timeStr);
    date.setHours(hours, minutes, 0, 0);
  }
  return date;
}

async function createEvent(clientId, {
  title,
  description,
  attendeeEmail,
  startTime,
  endTime,
  facts = {},
}) {
  const accessToken = await getAccessToken(clientId);
  let event;

  console.log("📅 Creating calendar event with facts:", JSON.stringify(facts));

  // ── Multi-day job ──────────────────────────────────────────
  if (facts.job_start_date) {
    const startDate = parseEventDate(facts.job_start_date);
    if (startDate) {
      const durationDays = parseInt(facts.job_duration_days) || 1;
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + durationDays);
      const fmt = d => d.toISOString().split("T")[0];

      event = {
        summary:     title,
        description,
        start: { date: fmt(startDate) },
        end:   { date: fmt(endDate) },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      };
      console.log(`📅 Multi-day job: ${fmt(startDate)} to ${fmt(endDate)}`);
    }
  }

  // ── Timed appointment ──────────────────────────────────────
  if (!event && (facts.appointment_date || facts.visit_date || startTime)) {
    const dateStr = facts.appointment_date || facts.visit_date;
    const timeStr = facts.appointment_time || facts.visit_time;
    let start = dateStr ? parseEventDate(dateStr, timeStr) : (startTime ? new Date(startTime) : null);

    if (start && !isNaN(start.getTime())) {
      const durationHours = (title.toLowerCase().includes("visit") || title.toLowerCase().includes("quote")) ? 2 : 1;
      
      // Build local datetime string to avoid UTC offset issues
      // Format: "2026-07-04T14:00:00"
      const pad = n => String(n).padStart(2,"0");
      const localDT = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
      
      const endDT = new Date(start.getTime() + durationHours * 3600000);
      event = {
        summary:     title,
        description,
        start: { dateTime: localDT(start), timeZone: "Australia/Melbourne" },
        end:   { dateTime: localDT(endDT), timeZone: "Australia/Melbourne" },
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      };
      console.log(`📅 Appointment: ${start.toLocaleString("en-AU")} (local: ${localDT(start)})`);
    }
  }

  // No date found — skip rather than creating a misleading event
  if (!event) {
    console.log("📅 No date found in facts — skipping calendar event");
    return null;
  }

  const res = await axios.post(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
    event,
    {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 10000,
    }
  );

  console.log("📅 Calendar event created:", res.data.id);
  return res.data.id;
}

module.exports = { createEvent };
