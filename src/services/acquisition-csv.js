// AIDA Locksmith Acquisition — CSV parsing (M8F).
//
//   parseCsv(text, { maxRows })  → { ok, headers, rows, problems }
//
// The first thing a real export file touches. Everything downstream assumes
// this got it right, so this module is deliberately boring and total: it never
// throws on malformed input, it reports what it could not read, and it does not
// try to be clever about what a field means.
//
// ── WHY NOT A LIBRARY ───────────────────────────────────────────────
// The dep-free convention: `npm test` runs on a bare checkout with no
// node_modules, and every acquisition module honours that. A CSV parser is
// also one of the few places where "it mostly works" is indistinguishable from
// correct until a business name containing a comma silently shifts every column
// one to the left and a phone number becomes a postcode. Written out, tested
// against the quirks that actually occur in export tools.
//
// ── WHAT IT HANDLES, BECAUSE REAL EXPORTS CONTAIN ALL OF IT ─────────
//   * RFC 4180 quoting, including "" as an escaped quote
//   * embedded commas inside quoted fields
//   * embedded NEWLINES inside quoted fields — common in address and
//     "about" columns from Google Maps exports
//   * CRLF, LF and lone CR line endings, mixed within one file
//   * a UTF-8 BOM, which Excel adds and which otherwise corrupts the first
//     header name so `name` never matches
//   * trailing newline, or none
//   * ragged rows — fewer or more cells than headers
//
// A ragged row is a PROBLEM, not a crash and not a silent truncation: a row
// with more cells than headers usually means an unquoted comma, and the cells
// after it are misaligned. Reporting it lets the importer refuse that one row
// while the other nine hundred proceed.
//
// Pure + dep-free. See test/acquisition-csv.test.js.

const BOM = "﻿";

/** A hard ceiling so a malformed or hostile file cannot exhaust memory. */
const DEFAULT_MAX_ROWS = 50000;

/**
 * Split CSV text into rows of cells.
 *
 * A single pass with an explicit in-quotes flag. Written as a state machine
 * rather than a regex because quoted newlines make the row boundary depend on
 * parser state, and no regex over lines can see that.
 */
function splitRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      // Only opens a quoted field at the START of one. A stray quote mid-field
      // ("Bob's "Best" Locks" unquoted) is kept as a literal character rather
      // than swallowing the rest of the file.
      if (field === "") {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }

    if (ch === "\r") {
      // CRLF, or a lone CR from an old Mac export.
      endRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // A file not ending in a newline still has a final row.
  if (field !== "" || row.length > 0) endRow();

  return { rows, unterminatedQuote: inQuotes };
}

/**
 * Parse CSV text into headers and keyed rows.
 *
 * Never throws. `problems` carries anything a human needs to know, each naming
 * the line it came from.
 */
function parseCsv(text, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const problems = [];

  if (typeof text !== "string") {
    return Object.freeze({ ok: false, headers: Object.freeze([]), rows: Object.freeze([]), problems: Object.freeze([{ code: "not_text", message: "The file could not be read as text." }]) });
  }

  const cleaned = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (cleaned.trim() === "") {
    return Object.freeze({ ok: false, headers: Object.freeze([]), rows: Object.freeze([]), problems: Object.freeze([{ code: "empty_file", message: "The file is empty." }]) });
  }

  const { rows: raw, unterminatedQuote } = splitRows(cleaned);
  if (unterminatedQuote) {
    // Everything after the opening quote became one field. Whatever came back
    // is not trustworthy, so it is refused wholesale rather than half-read.
    problems.push({ code: "unterminated_quote", message: 'A quoted field was never closed. The file is malformed and no row from it can be trusted.' });
    return Object.freeze({ ok: false, headers: Object.freeze([]), rows: Object.freeze([]), problems: Object.freeze(problems) });
  }

  // Drop rows that are entirely empty — a trailing blank line, or the blank
  // separator rows some export tools emit between result pages.
  const meaningful = raw.filter((cells) => cells.some((c) => c.trim() !== ""));
  if (meaningful.length === 0) {
    return Object.freeze({ ok: false, headers: Object.freeze([]), rows: Object.freeze([]), problems: Object.freeze([{ code: "empty_file", message: "The file has no rows." }]) });
  }

  const headers = meaningful[0].map((h) => h.trim());
  if (headers.every((h) => h === "")) {
    return Object.freeze({ ok: false, headers: Object.freeze([]), rows: Object.freeze([]), problems: Object.freeze([{ code: "no_headers", message: "The first row is blank, so there are no column names." }]) });
  }

  const duplicated = headers.filter((h, idx) => h !== "" && headers.indexOf(h) !== idx);
  if (duplicated.length > 0) {
    // Not fatal — the later column wins, as it would in any keyed read — but a
    // founder mapping columns needs to know one of them is unreachable.
    problems.push({ code: "duplicate_header", message: `These column names appear more than once, and only the last of each is readable: ${[...new Set(duplicated)].join(", ")}.` });
  }

  const rows = [];
  for (let r = 1; r < meaningful.length; r += 1) {
    if (rows.length >= maxRows) {
      problems.push({ code: "row_limit", message: `Stopped after ${maxRows} rows. The rest of the file was not read.` });
      break;
    }
    const cells = meaningful[r];
    // `line` is the row's position among meaningful rows, which is what a
    // founder scrolling a spreadsheet counts. Header is line 1.
    const line = r + 1;

    if (cells.length !== headers.length) {
      problems.push({
        code: cells.length > headers.length ? "too_many_cells" : "too_few_cells",
        line,
        message: `Line ${line} has ${cells.length} cells but there are ${headers.length} columns. ${cells.length > headers.length ? "An unquoted comma usually causes this, and everything after it is in the wrong column." : "The missing columns are read as empty."}`,
      });
      if (cells.length > headers.length) continue; // misaligned; not guessable
    }

    const record = {};
    headers.forEach((h, idx) => {
      if (h === "") return;
      record[h] = (cells[idx] === undefined ? "" : cells[idx]).trim();
    });
    rows.push(Object.freeze({ line, values: Object.freeze(record) }));
  }

  return Object.freeze({
    ok: rows.length > 0,
    headers: Object.freeze(headers),
    rows: Object.freeze(rows),
    problems: Object.freeze(problems),
  });
}

module.exports = { parseCsv, DEFAULT_MAX_ROWS };
