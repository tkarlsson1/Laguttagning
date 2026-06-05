/**
 * Cloud Functions for Laguttagning — laget.se import
 *
 * importLaget: Given a laget.se team start-page URL, fetches the team's
 * public ICS feed, parses match events, derives the team's own name from
 * the matches, and scrapes the public match page of each unique serie to
 * read the serie name (which encodes difficulty: grön/blå/röd/svart).
 *
 * Returns ready-to-import match objects. The app shows a preview where the
 * user can adjust before writing to Firestore. This function only reads and
 * returns data; it never writes.
 *
 * Runtime: Node 24 (native global fetch), firebase-functions v2.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

// ─── Constants ──────────────────────────────────────────────────────────────

// Serie colour → app difficulty value. The serie name contains exactly one of
// these four colours; they map 1:1 to the app's difficulty levels.
const COLOUR_MAP = {
  "grön": "green",
  "blå": "blue",
  "röd": "red",
  "svart": "black",
};

// Match a laget.se Game link and capture BOTH serie-id and match-id.
//   .../Division/Game/{serieId}/{matchId}
const GAME_LINK_RE = /\/Game\/(\d+)\/(\d+)/;

// ICS DTSTART value, e.g. 20260503T130000 (with optional trailing Z).
const ICS_DT_RE = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/;

// ─── Small helpers ────────────────────────────────────────────────────────

/**
 * Decode the HTML entities laget.se uses (numeric like &#246; and a few named
 * ones). Needed because scraped serie names contain entities (Röd = R&#246;d).
 */
function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&aring;/g, "å").replace(/&Aring;/g, "Å")
    .replace(/&auml;/g, "ä").replace(/&Auml;/g, "Ä")
    .replace(/&ouml;/g, "ö").replace(/&Ouml;/g, "Ö")
    .replace(/&nbsp;/g, " ");
}

/** Unescape ICS text values (\, \; \n \\). */
function unescapeICS(str) {
  if (!str) return "";
  return str
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Unfold ICS lines: a CRLF/LF followed by a space or tab is a continuation. */
function unfoldICS(raw) {
  return raw.replace(/\r?\n[ \t]/g, "");
}

/** Map a serie name to a difficulty value via the colour it contains. */
function difficultyFromSerie(serieName) {
  const lower = (serieName || "").toLowerCase();
  for (const [colour, val] of Object.entries(COLOUR_MAP)) {
    // Boundary test that tolerates å/ä/ö (which \b mishandles).
    const re = new RegExp(`(^|[^a-zåäö])${colour}([^a-zåäö]|$)`);
    if (re.test(lower)) return val;
  }
  return "green"; // safe default if no colour found
}

// ─── ICS parsing ─────────────────────────────────────────────────────────

/** Parse raw ICS text into an array of event objects keyed by property name. */
function parseICS(raw) {
  const lines = unfoldICS(raw).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = left.split(";")[0]; // strip params like ;TZID=...
    cur[key] = value;
  }
  return events;
}

/** Extract {date:'YYYY-MM-DD', time:'HH:MM'} from an ICS DTSTART value. */
function icsDateTime(v) {
  if (!v) return { date: "", time: "" };
  const m = v.match(ICS_DT_RE);
  if (!m) return { date: "", time: "" };
  const [, y, mo, d, h, mi] = m;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

/**
 * Derive the team's own name as the longest word-prefix shared by one side of
 * every match. With multiple serie-teams (e.g. "IK Oden P14" + "... Blå"
 * + "... Vit"), this yields the stem "IK Oden P14"; the suffix becomes the
 * teamlabel per match.
 */
function deriveTeamName(pairs) {
  if (!pairs.length) return "";
  const cands = [];
  for (const side of [pairs[0].home, pairs[0].away]) {
    const words = side.split(" ");
    for (let n = words.length; n >= 1; n--) {
      cands.push(words.slice(0, n).join(" "));
    }
  }
  cands.sort((a, b) => b.length - a.length); // longest first
  for (const cand of cands) {
    if (!cand) continue;
    const ok = pairs.every(
      (p) => p.home.startsWith(cand) || p.away.startsWith(cand)
    );
    if (ok) return cand;
  }
  return "";
}

/**
 * Parse match events from ICS into intermediate records.
 * Returns { teamName, matches: [...] } where each match has home/away resolved.
 */
function parseMatches(rawICS) {
  const events = parseICS(rawICS).filter(
    (e) => (e.CATEGORIES || "") === "Match"
  );

  // Build home/away pairs first so we can derive the team name.
  const pairs = events.map((ev) => {
    const summary = unescapeICS(ev.SUMMARY || "").replace(/^Match\s+/, "").trim();
    const parts = summary.split(" - ");
    const home = (parts[0] || "").trim();
    const away = (parts.slice(1).join(" - ") || "").trim();
    return { home, away, ev };
  });

  const teamName = deriveTeamName(pairs);

  const matches = pairs.map(({ home, away, ev }) => {
    let teamlabel = "";
    let opponent = "";
    let homeway = "";
    let flag = "";

    if (teamName && home.startsWith(teamName) && !away.startsWith(teamName)) {
      teamlabel = home.slice(teamName.length).trim();
      opponent = away;
      homeway = "home";
    } else if (teamName && away.startsWith(teamName) && !home.startsWith(teamName)) {
      teamlabel = away.slice(teamName.length).trim();
      opponent = home;
      homeway = "away";
    } else {
      // Could not unambiguously identify our team in this match.
      opponent = away || home;
      homeway = "home";
      flag = "Kunde inte identifiera laget — kontrollera";
    }

    const { date, time } = icsDateTime(ev.DTSTART);
    const linkMatch = (ev.DESCRIPTION || "").match(GAME_LINK_RE);
    const serieId = linkMatch ? linkMatch[1] : "";
    const fogisId = linkMatch ? linkMatch[2] : "";

    return {
      date,
      time,
      opponent: opponent.trim(),
      location: unescapeICS(ev.LOCATION || "").trim(),
      homeway,
      teamlabel,
      difficulty: "green", // filled in later from serie scrape
      serie: "",
      serieId,
      fogisId,
      flag,
    };
  }).filter((m) => m.date);

  matches.sort((a, b) =>
    `${a.date}T${a.time || "00:00"}`.localeCompare(`${b.date}T${b.time || "00:00"}`)
  );

  return { teamName, matches };
}

// ─── Serie scraping ────────────────────────────────────────────────────────

/** Extract the serie name from a fetched match-page HTML. */
function serieNameFromHTML(html) {
  if (!html) return "";
  // Primary: the calendar info row "Serie: </span>Pojk 7 mot 7 Röd, ...".
  let m = html.match(/Serie:\s*<\/span>\s*([^<]+)</i);
  if (m) return decodeEntities(m[1]).trim();
  // Secondary: the serie box heading.
  m = html.match(/box__title--truncate">\s*([^<]+?)\s*<\/h6>/i);
  if (m) return decodeEntities(m[1]).trim();
  return "";
}

/**
 * For each unique serieId, fetch one match page and read the serie name.
 * Returns a map serieId → { serie, difficulty }.
 */
async function fetchSerieInfo(urlName, matches) {
  const bySerieId = new Map();
  for (const m of matches) {
    if (m.serieId && m.fogisId && !bySerieId.has(m.serieId)) {
      bySerieId.set(m.serieId, m.fogisId);
    }
  }

  const result = {};
  for (const [serieId, fogisId] of bySerieId.entries()) {
    const pageUrl =
      `https://www.laget.se/${urlName}/Division/Game/${serieId}/${fogisId}`;
    try {
      const res = await fetch(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Laguttagning import)" },
      });
      if (!res.ok) {
        logger.warn(`Serie page ${serieId} returned ${res.status}`);
        result[serieId] = { serie: "", difficulty: "green" };
        continue;
      }
      const html = await res.text();
      const serie = serieNameFromHTML(html);
      result[serieId] = { serie, difficulty: difficultyFromSerie(serie) };
    } catch (err) {
      logger.warn(`Failed to fetch serie page ${serieId}: ${err.message}`);
      result[serieId] = { serie: "", difficulty: "green" };
    }
  }
  return result;
}

// ─── Main callable ───────────────────────────────────────────────────────

exports.importLaget = onCall(
  { region: "europe-west1", memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    // Require an authenticated user.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Du måste vara inloggad.");
    }

    const rawUrl = (request.data && request.data.url ? request.data.url : "").trim();
    if (!rawUrl) {
      throw new HttpsError("invalid-argument", "Ingen laget.se-URL angiven.");
    }

    // Extract the URL name (first path segment) from the team start-page URL.
    // Accepts forms like https://www.laget.se/IKOden-P14 or .../IKOden-P14/
    let urlName = "";
    try {
      const u = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
      const seg = u.pathname.split("/").filter(Boolean);
      urlName = seg[0] || "";
    } catch (_) {
      urlName = "";
    }
    if (!urlName) {
      throw new HttpsError("invalid-argument", "Kunde inte tolka laget.se-URL:en.");
    }

    // 1. Fetch the public ICS feed.
    const icsUrl = `https://cal.laget.se/${urlName}.ics`;
    let rawICS = "";
    try {
      const res = await fetch(icsUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Laguttagning import)" },
      });
      if (!res.ok) {
        throw new HttpsError(
          "not-found",
          `Kunde inte hämta kalendern (HTTP ${res.status}). Kontrollera URL:en.`
        );
      }
      rawICS = await res.text();
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("unavailable", `Kunde inte nå laget.se: ${err.message}`);
    }

    // 2. Parse matches and derive team name.
    const { teamName, matches } = parseMatches(rawICS);
    if (!matches.length) {
      throw new HttpsError(
        "not-found",
        "Inga matcher hittades i kalendern."
      );
    }

    // 3. Scrape serie name + difficulty per unique serie, apply to matches.
    const serieInfo = await fetchSerieInfo(urlName, matches);
    for (const m of matches) {
      const info = serieInfo[m.serieId];
      if (info) {
        m.serie = info.serie;
        m.difficulty = info.difficulty;
      }
    }

    logger.info(
      `importLaget: ${urlName} → team "${teamName}", ${matches.length} matches, ` +
      `${Object.keys(serieInfo).length} series`
    );

    // 4. Return data; the app handles preview + Firestore write.
    return { teamName, matches };
  }
);
