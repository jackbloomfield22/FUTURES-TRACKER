import React, { useState, useEffect, useRef, useCallback } from "react";
import { store, IS_ARTIFACT } from "./lib/store.js";
import { fetchLiveOdds, sportKeyFor, implied, BOOKS, getOddsPrefs, saveOddsPrefs } from "./lib/odds.js";
import { getSession } from "./lib/cloud.js";

/* FUTURES BOOK — personal futures ticket ledger
   - Screenshot a slip, Claude parses it into a ticket
   - Edge Check: live web search for current odds + value % vs entry (a read, not advice)
   - Season history with W/L/CO records, net P/L, ROI
   - Persists via store
*/

const STORAGE_KEY = "futures-ledger-v1"; // must match LEDGER_KEY in lib/store.js

/* Environment: inside a Claude artifact, store and keyless API access exist.
   Standalone (Vercel/local), AuthGate picks the backend: a signed-in account
   syncs through /api/data, otherwise localStorage on this device. */

function getApiKey() {
  try { return localStorage.getItem("fb-api-key") || ""; } catch (e) { return ""; }
}
const SPORTS = ["MLB", "NBA", "NFL", "NHL", "Soccer", "Golf", "Tennis", "Other"];
const sportRank = (s) => { const i = SPORTS.indexOf(s); return i === -1 ? SPORTS.length : i; };

/* ---------- helpers ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function parseOdds(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v).replace(/[+\s,]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function fmtOdds(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n > 0 ? "+" + n : String(n);
}
function profitFor(odds, stake) {
  if (!Number.isFinite(odds) || !Number.isFinite(stake)) return 0;
  return odds > 0 ? (stake * odds) / 100 : (stake * 100) / Math.abs(odds);
}
/* Free plays pay profit only: the stake is house money and never comes back. */
function collectFor(p) {
  const win = profitFor(p.odds, p.stake);
  return p.freePlay ? win : (p.stake || 0) + win;
}
/* Cash actually risked; free-play stakes aren't your money. */
const cashStaked = (rows) => rows.reduce((s, p) => s + (p.freePlay ? 0 : p.stake || 0), 0);
function fmtMoney(n, signed = false) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : signed && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs.toLocaleString("en-US", { minimumFractionDigits: abs % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return sign + "$" + s;
}
function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function guessSeason(sport, dateStr) {
  const y = (dateStr || todayISO()).slice(0, 4);
  return `${y} ${sport || "MLB"}`;
}

/* Group markets into bet types for filtering. Known award/market patterns normalize
   variants under one label; anything unrecognized becomes its own category
   automatically (year fragments stripped), so new bet types are instantly filterable. */
const TYPE_PATTERNS = [
  ["Parlay", /parlay/i],
  ["Cy Young", /cy young/i],
  ["MVP", /\bmvp\b|most valuable/i],
  ["OPOY", /\bopoy\b|offensive player of the year/i],
  ["DPOY", /\bdpoy\b|defensive player of the year/i],
  ["OROY", /\boroy\b|offensive rookie/i],
  ["DROY", /\bdroy\b|defensive rookie/i],
  ["ROY", /\broy\b|rookie of the year/i],
  ["MIP", /\bmip\b|most improved/i],
  ["6th Man", /sixth man|6th man/i],
  ["Comeback of the Year", /comeback/i],
  ["Heisman", /heisman/i],
  ["Coach of the Year", /\bcoy\b|coach of the year|manager of the year/i],
  ["Win Total", /win total|regular season wins|season wins/i],
  ["College Football Playoff", /college football playoff|\bcfp\b/i],
  ["Playoffs", /to make the playoffs|playoff berth/i],
  ["Division", /division (winner|champion)|to win the \w+ (east|west|north|south|central)/i],
  ["Conference", /conference (winner|champion)|pennant|\b(afc|nfc|al|nl) champion/i],
  ["Championship", /championship|super bowl|world series|stanley cup|finals winner|outright winner|to win the (league|cup|title)/i],
  ["Stat Leader", /\bleader\b|most (home runs|touchdowns|points|assists|rebounds|strikeouts|sacks|goals)/i],
];
function marketType(market) {
  const raw = market || "";
  for (const [label, re] of TYPE_PATTERNS) if (re.test(raw)) return label;
  /* Unrecognized market: normalize hard so every spelling of the same market
     lands on one label. Strip parentheticals, years, league tags, and
     "reg. season" qualifiers, then re-try the patterns on the cleaned form. */
  let m = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(19|20)\d{2}(\s*[\/\-\u2013]\s*(19|20)?\d{2})?\b/g, " ")
    .replace(/['\u2019]\d{2}\b/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\b(reg\.?|regular)\s+season\b/gi, " ")
    .replace(/\b(nfl|nba|mlb|nhl|ncaaf?b?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [label, re] of TYPE_PATTERNS) if (re.test(m)) return label;
  /* Any "<X> Player/Rookie/... of the Year" award is the same market as
     "<X> of the Year" -- books word these interchangeably. */
  const award = m.match(/^(.+?)\s+(?:player|pitcher|rookie|back|lineman|man)\s+of the year\b/i);
  if (award) m = award[1] + " of the Year";
  m = m
    .replace(/^\s*the\s+/i, "")
    .replace(/\b(winner|award|trophy)\s*$/i, "")
    .replace(/[.,]/g, "")
    .replace(/^[\s\-\u00b7:]+|[\s\-\u00b7:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!m) return "Other";
  /* Case-fold to one canonical label; short all-caps words stay as acronyms. */
  return m
    .split(" ")
    .map((w, i) =>
      i > 0 && /^(of|the|to|a|an|in|for|at|on)$/i.test(w) ? w.toLowerCase()
      : /^[A-Z0-9+\/]{2,4}$/.test(w) ? w
      : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/* Tickets in the same market are mutually exclusive (one MVP per season),
   so they group by sport + normalized bet type + season. */
const marketKey = (p) => p.sport + "|" + marketType(p.market) + "|" + (p.season || "");
const sameSel = (a, b) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
const fp = (p) => [p.book, p.selection, p.market, p.odds, p.stake, p.datePlaced].join("|").toLowerCase();

/* Duplicate detection, with Bet IDs as the truth when present: the same ID is the
   same bet; different IDs are different bets even when every other field matches
   (two identical $10 MVP slips). Value fingerprints decide only when a side has
   no ID, so legacy tickets and ID-less slips still dedupe as before. */
function makeDupeCheck(existingList) {
  const normId = (v) => String(v).trim().toLowerCase();
  const ids = new Set();
  const printsNoId = new Set();
  const printsAll = new Set();
  const add = (c) => {
    if (c.betId) ids.add(normId(c.betId));
    else printsNoId.add(fp(c));
    printsAll.add(fp(c));
  };
  (existingList || []).forEach(add);
  const isDupe = (c) => (c.betId ? ids.has(normId(c.betId)) || printsNoId.has(fp(c)) : printsAll.has(fp(c)));
  return { isDupe, add };
}

/* SEED: the book baked into the app itself, so a storage wipe can't lose it.
   To update: Export from the Backup section, paste the code to Claude in chat,
   and Claude rebuilds the app with the new state embedded here. */
const SEED_POSITIONS = [
  { id: "seed-gibbs-0750", book: "BetRivers", sport: "NFL", market: "Regular Season MVP 2026/2027", selection: "Jahmyr Gibbs", odds: 15000, stake: 7.5, datePlaced: "2026-07-07", season: "2026 NFL", notes: "Pot. payout $1,132.50", status: "open", returned: null, dateSettled: null },
  { id: "seed-gibbs-1500", book: "BetRivers", sport: "NFL", market: "Regular Season MVP 2026/2027", selection: "Jahmyr Gibbs", odds: 15000, stake: 15, datePlaced: "2026-07-07", season: "2026 NFL", notes: "Pot. payout $2,265.00", status: "open", returned: null, dateSettled: null },
];
function netOf(p) {
  if (p.status === "open") return 0;
  /* a lost free play costs nothing: no cash was staked */
  return (p.returned || 0) - (p.freePlay ? 0 : p.stake || 0);
}

/* ---------- Claude API ---------- */

async function callClaude(body) {
  const payload = { model: "claude-sonnet-4-6", max_tokens: 1000, ...body };

  if (IS_ARTIFACT) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : "API error " + res.status;
      throw new Error(msg);
    }
    return data;
  }

  /* Standalone: server key first (one Vercel env var covers every device
     and account), the device key from AI settings as fallback. */
  let proxyErr = null;
  try {
    const headers = { "Content-Type": "application/json" };
    const session = getSession();
    if (session) headers["x-fb-session"] = session;
    const res = await fetch("/api/ai", { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.content) return data;
    if (data) proxyErr = (data.error && data.error.message) || data.error || null;
  } catch (e) { /* no proxy on this deploy; fall through */ }

  const key = getApiKey();
  if (!key) {
    throw new Error(proxyErr || "no AI source. Sign in if this site has a server key, or add your own under AI settings in the + New ticket tab");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : "API error " + res.status;
    throw new Error(msg);
  }
  return data;
}

const textOf = (data) =>
  (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/* Checks must read like a quote board. Strip any narration the model
   sneaks in: keep only board lines and honest misses. */
function boardOnly(raw) {
  const lines = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter(
    (l) =>
      /:.*[+-]\d{3}/.test(l) ||            // "Name: FanDuel +12000 · ..."
      /no board found/i.test(l)
  );
  return kept.length ? kept.join("\n") : String(raw || "").trim();
}

/* Prep any screenshot for the API without trusting the browser's decoder or the file's
   MIME label (iOS pickers often hand over files with a blank or wrong type).
   1) Read raw bytes, sniff the real format from magic numbers.
   2) PNG/JPG/WEBP/GIF at a safe size → send bytes untouched. No decoding, nothing to fail.
   3) Oversized or HEIC → decode via createImageBitmap or data-URL Image, re-encode to JPEG.
   Errors carry a diagnostic tag naming the file, size, sniffed type, and failing stage. */
const API_SAFE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function sniffType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return "image/heic";
  return null;
}

async function normalizeImage(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sniffed = sniffType(bytes) || (API_SAFE_TYPES.includes(file.type) ? file.type : null);
  const diag =
    (file.name || "?") + " · " + (file.type || "no-type") + " · " +
    Math.round(bytes.length / 1024) + "KB · sniffed " + (sniffed || "unknown");

  const rawB64 = bufToBase64(buf);
  const rawOk = sniffed && API_SAFE_TYPES.includes(sniffed);

  // Fast path: real PNG/JPG/WEBP/GIF under ~3.8MB → raw bytes, no decoding at all
  if (rawOk && bytes.length < 3.8 * 1024 * 1024) {
    return { base64: rawB64, mediaType: sniffed, preview: "data:" + sniffed + ";base64," + rawB64 };
  }

  // Decode + downscale + re-encode to JPEG
  try {
    const mime = sniffed || file.type || "image/png";
    let src = null;
    if (typeof createImageBitmap === "function") {
      try {
        src = await createImageBitmap(new Blob([buf], { type: mime }));
      } catch (e) {
        /* fall through */
      }
    }
    if (!src) {
      src = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("browser can't decode this format"));
        i.src = "data:" + mime + ";base64," + rawB64;
      });
    }
    const W = src.width || src.naturalWidth;
    const H = src.height || src.naturalHeight;
    if (!W || !H) throw new Error("decoded empty");
    const MAX = 1568;
    const scale = Math.min(1, MAX / Math.max(W, H));
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const out = c.toDataURL("image/jpeg", 0.9);
    if (!out || !out.startsWith("data:image/jpeg")) throw new Error("canvas export failed");
    return { base64: out.split(",")[1], mediaType: "image/jpeg", preview: out };
  } catch (e) {
    // Final fallback: API-safe format under the hard limit ships raw anyway
    if (rawOk && bytes.length < 4.8 * 1024 * 1024) {
      return { base64: rawB64, mediaType: sniffed, preview: "data:" + sniffed + ";base64," + rawB64 };
    }
    throw new Error((e.message || "image processing failed") + " [" + diag + "]");
  }
}

/* Shrink a captured slip for the archive (~900px JPEG). Falls back to the original
   if canvas is unavailable, or skips archiving if the raw image is too large to store. */
async function shrinkDataUrl(dataUrl) {
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("decode"));
      i.src = dataUrl;
    });
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) throw new Error("empty");
    const MAX = 900;
    const sc = Math.min(1, MAX / Math.max(W, H));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(W * sc));
    c.height = Math.max(1, Math.round(H * sc));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/jpeg", 0.72);
    if (out && out.startsWith("data:image/jpeg") && out.length < dataUrl.length) return out;
    throw new Error("no gain");
  } catch (e) {
    return dataUrl.length < 3.5 * 1024 * 1024 ? dataUrl : null;
  }
}

function extractJSON(raw) {
  const t = raw.replace(/```json|```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("no JSON in response");
  return JSON.parse(t.slice(s, e + 1));
}

const PARSE_PROMPT = `Read this sportsbook screenshot carefully. It may show a single bet slip, a bet confirmation, or a scrolling list of multiple bets (open bets or settled history). Extract EVERY distinct bet visible.

For each bet, find:
- book: the sportsbook. Identify it from any logo, header text, or the app's UI style and colors (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET, Hard Rock, Fanatics, bet365, PrizePicks, etc).
- sport: exactly one of MLB, NBA, NFL, NHL, Soccer, Golf, Tennis, Other.
- market: the market name (e.g. "AL Cy Young", "NBA Championship", "Regular Season Wins").
- selection: the player or team picked.
- odds: american odds as a string like "+2000" or "-110". If odds were boosted, use the boosted odds and mention the original in notes.
- stake: the wager / cost / risk amount in dollars, as a number.
- to_win: the "to win" or profit amount shown, as a number (not including stake, if that's how the app shows it).
- date_placed: "YYYY-MM-DD" if visible, else null.
- status: "open", "won", "lost", or "cashout" if determinable from the UI (settled lists usually mark these), else null.
- returned: for settled bets, total dollars paid back (0 if lost, cash-out amount if cashed out), else null.
- bet_id: the Bet ID / Ticket # / Receipt number printed on the slip, as a string exactly as shown; null if not visible.
- free_play: true if the wager used a free bet / bonus bet / free play credit (slips label it "Free Bet", "Bonus Bet", "FP", or show a $0 cash risk with a bonus applied); else false.
- notes: boosts, promos, free bet, odds movement, or anything notable; else null.

Respond with ONLY raw JSON. No markdown fences, no commentary. Exactly this shape:
{"tickets":[{"book":"DraftKings","sport":"MLB","market":"AL Cy Young","selection":"George Kirby","odds":"+2000","stake":25,"to_win":500,"date_placed":null,"status":"open","returned":null,"bet_id":"ABC123456","free_play":false,"notes":null}]}

Rules:
- One entry per bet. A parlay is ONE ticket: market "Parlay", selection summarizes the legs.
- Almost every book prints a Bet ID on each slip; read each one carefully. Slips that look identical (same selection, odds, stake) but carry different bet IDs are SEPARATE bets: output one entry for each. Never merge duplicate-looking slips into one entry.
- Numbers as numbers, odds as a string.
- Use null for anything not visible. Never invent values; read exactly what's on screen.`;

async function parseSlip(base64, mediaType) {
  const data = await callClaude({
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: PARSE_PROMPT },
        ],
      },
    ],
  });
  const raw = textOf(data);
  let parsed;
  try {
    parsed = extractJSON(raw);
  } catch (e) {
    // one repair pass: have the model fix its own output
    const fix = await callClaude({
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content:
            'Convert the following into valid JSON of exactly this shape: {"tickets":[{"book":"","sport":"","market":"","selection":"","odds":"","stake":0,"to_win":0,"date_placed":null,"status":null,"returned":null,"bet_id":null,"free_play":false,"notes":null}]}. Reply with ONLY the JSON, nothing else:\n\n' +
            raw,
        },
      ],
    });
    parsed = extractJSON(textOf(fix));
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tickets) ? parsed.tickets : [parsed];
  return arr.filter((t) => t && (t.selection || t.market));
}

/* Map a parsed ticket to a confirm-form draft. Derives odds from stake/to_win when missing. */
function ticketToDraft(j, preview) {
  const sport = SPORTS.includes(j.sport) ? j.sport : "Other";
  let odds = parseOdds(j.odds);
  const stake = j.stake !== null && j.stake !== undefined ? parseFloat(j.stake) : NaN;
  const toWin = j.to_win !== null && j.to_win !== undefined ? parseFloat(j.to_win) : NaN;
  if (odds === null && Number.isFinite(stake) && Number.isFinite(toWin) && stake > 0 && toWin > 0) {
    const ratio = toWin / stake;
    odds = ratio >= 1 ? Math.round(ratio * 100) : -Math.round(100 / ratio);
  }
  const dateP = j.date_placed || todayISO();
  const st = ["won", "lost", "cashout"].includes(j.status) ? j.status : null;
  return {
    ...blankDraft(),
    book: j.book || "",
    sport,
    market: j.market || "",
    selection: j.selection || "",
    odds: odds !== null ? fmtOdds(odds) : "",
    stake: Number.isFinite(stake) ? String(stake) : "",
    datePlaced: dateP,
    season: j.season || guessSeason(sport, dateP),
    notes: j.notes || "",
    betId: j.bet_id !== null && j.bet_id !== undefined ? String(j.bet_id).trim() : "",
    freePlay: !!j.free_play,
    logSettled: !!st,
    result: st || "won",
    returned: st && st !== "lost" && j.returned !== null && j.returned !== undefined ? String(j.returned) : "",
    dateSettled: j.date_settled || todayISO(),
    preview,
  };
}

async function marketCheck(openRows, settledRows) {
  const p0 = openRows[0];
  const lines = openRows
    .map((p, i) => `- Leg ${i + 1}: ${p.selection} at ${fmtOdds(p.odds)}, stake ${fmtMoney(p.stake)}, collects ${fmtMoney(collectFor(p))}`)
    .join("\n");
  const realized = (settledRows || []).reduce((s, p) => s + netOf(p), 0);
  const realizedLine =
    settledRows && settledRows.length
      ? `\nAlready settled from this market: ${settledRows.length} leg(s), realized ${fmtMoney(realized, true)}.`
      : "";
  const prompt = `Today is ${todayISO()}. I hold open futures tickets in this market: ${p0.market} (${p0.season}, ${p0.sport}). My entries:
${lines}${realizedLine}

Search the web for the CURRENT odds on each selection. Reply as a quote board, nothing else:
- One line per selection, exactly this shape:
  {Selection}: FanDuel {odds} · DraftKings {odds} (entry {my odds} · value {+/-N%})
- Quote FanDuel and DraftKings. If either doesn't list it, substitute one other major US book and name it. If nobody lists it, write "no board found".
- "value" is the change in implied win probability vs my entry, as a percent: positive means my position gained value.
No sentences, no advice, no buy/sell/hold verdicts, no explanations, no markdown.`;
  const data = await callClaude({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system: "You print sportsbook quote boards. Output ONLY the board lines. Never advise, never recommend holding or selling, never narrate what you are doing, never describe your search, never explain, never apologize.",
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
  });
  return boardOnly(textOf(data));
}

async function edgeCheck(p, splitLegs) {
  const prompt = `Today is ${todayISO()}. I hold this open futures bet:
Sport: ${p.sport} | Market: ${p.market} | Selection: ${p.selection}
My odds: ${fmtOdds(p.odds)} | Stake: ${fmtMoney(p.stake)} | To collect if it wins: ${fmtMoney(collectFor(p))}${splitLegs > 0 ? `
Note: this is one of ${splitLegs + 1} split tickets I hold on this same selection in this market, deliberately staggered so I can cash legs out separately. Judge this leg on its own but factor that in.` : ""}

Search the web for the CURRENT odds on this exact market and selection. Reply as a quote line, nothing else:
{Selection}: FanDuel {odds} · DraftKings {odds} (entry ${fmtOdds(p.odds)} · value {+/-N%})
If either book doesn't list it, substitute one other major US book and name it; if nobody lists it, write "no board found". "value" is the change in implied win probability vs my entry, positive meaning my position gained value.
No sentences, no advice, no buy/sell/hold verdicts, no markdown.`;
  const data = await callClaude({
    model: "claude-haiku-4-5",
    max_tokens: 250,
    system: "You print sportsbook quote boards. Output ONLY the board line. Never advise, never recommend holding or selling, never narrate what you are doing, never describe your search, never explain, never apologize.",
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  });
  return boardOnly(textOf(data));
}

/* ---------- blank draft ---------- */

const blankDraft = () => ({
  book: "",
  sport: "MLB",
  market: "",
  selection: "",
  odds: "",
  stake: "",
  datePlaced: todayISO(),
  season: guessSeason("MLB"),
  notes: "",
  betId: "",
  freePlay: false,
  logSettled: false,
  result: "won",
  returned: "",
  dateSettled: todayISO(),
  preview: null,
  editingId: null,
});

/* ---------- component ---------- */

export default function FuturesBook() {
  const [positions, setPositions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [storageStatus, setStorageStatus] = useState("checking"); // ok | unavailable
  const [backupText, setBackupText] = useState("");
  const [backupMsg, setBackupMsg] = useState(null);
  const [dirty, setDirty] = useState(0); // changes since last export
  const [undoSnap, setUndoSnap] = useState(null);
  const [pasteInfo, setPasteInfo] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState(() => getApiKey());
  const [view, setView] = useState("open"); // open | history | add
  const [draft, setDraft] = useState(null);
  const [queue, setQueue] = useState([]);
  const [batch, setBatch] = useState(null); // bulk intake progress: {done, total, found, failed}
  const [pasteText, setPasteText] = useState("");
  const [pasteErr, setPasteErr] = useState("");
  const [aiStatus, setAiStatus] = useState("unknown");
  const [aiErr, setAiErr] = useState("");
  const [serverInfo, setServerInfo] = useState(null); // /api/health: {kv, odds, ai}
  const [pendingSlip, setPendingSlip] = useState(null); // captured slip awaiting a ticket
  const [slips, setSlips] = useState(null); // null = archive not loaded yet
  const [expandedSlip, setExpandedSlip] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState("");
  const [edges, setEdges] = useState({}); // id -> {loading, text, err}
  const [settling, setSettling] = useState(null); // {id, mode, amount}
  const [cascadeNote, setCascadeNote] = useState(null);
  const [marketChecks, setMarketChecks] = useState({}); // marketKey -> {loading, text, err}
  const [seasonFilter, setSeasonFilter] = useState("all");
  const [sportFilter, setSportFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [live, setLive] = useState(null); // { prices, misses, errors, ts }
  const [liveBusy, setLiveBusy] = useState(false);
  const [oddsPrefs, setOddsPrefs] = useState(() => getOddsPrefs());
  const [oddsKeyDraft, setOddsKeyDraft] = useState(() => getOddsPrefs().key);
  const fileRef = useRef(null);

  /* load: verify storage works, then merge stored data with the baked-in seed */
  useEffect(() => {
    (async () => {
      const finish = (stored, status) => {
        const seedToAdd = SEED_POSITIONS.filter(
          (s) => !stored.some((p) => p.id === s.id || fp(p) === fp(s))
        );
        const merged = [...stored, ...seedToAdd].sort((a, b) => (b.datePlaced || "").localeCompare(a.datePlaced || ""));
        setPositions(merged);
        setStorageStatus(status);
        if (status === "ok" && seedToAdd.length) {
          try {
            const r = store.set(STORAGE_KEY, JSON.stringify({ positions: merged }));
            if (r && r.catch) r.catch(() => {});
          } catch (e) {
            /* best effort */
          }
        }
        setLoaded(true);
      };
      if (!(typeof window !== "undefined" && store && store.get && store.set)) {
        finish([], "unavailable");
        return;
      }
      try {
        const r = await store.get(STORAGE_KEY);
        const stored = r && r.value ? JSON.parse(r.value).positions || [] : [];
        finish(stored, "ok");
      } catch (e) {
        /* A failed read is NOT an empty book. Never write here: writing an
           empty ledger over a real one on a transient error is how books die.
           Run read-only until a reload gets a clean read. */
        finish([], "unavailable");
      }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setPositions(next);
    setDirty((d) => d + 1);
    try {
      if (storageStatus !== "ok") throw new Error("storage unverified, not writing");
      if (!(store && store.set)) throw new Error("no storage");
      const res = await store.set(STORAGE_KEY, JSON.stringify({ positions: next }));
      if (!res) throw new Error("save failed");
    } catch (e) {
      setStorageStatus("unavailable");
    }
  }, [storageStatus]);

  /* image intake */
  /* skip drafts that exactly match a ticket already in the book */
  const dedupeDrafts = (drafts) => {
    const seen = makeDupeCheck(positions);
    const fresh = [];
    let skipped = 0;
    drafts.forEach((d) => {
      const cand = { book: d.book, selection: d.selection, market: d.market, odds: parseOdds(d.odds), stake: parseFloat(d.stake), datePlaced: d.datePlaced, betId: d.betId };
      if (seen.isDupe(cand)) skipped++;
      else { seen.add(cand); fresh.push(d); }
    });
    return { fresh, skipped };
  };

  /* Bulk-capable intake: one screenshot or a whole camera-roll drop.
     Slips parse one at a time (progress shown), every ticket lands in one
     verify queue, dupes collapse across the batch and against the book. */
  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f && (!f.type || f.type.startsWith("image/")));
    if (!files.length) {
      if (fileList && fileList.length) setParseErr("Those files aren't images. Screenshot the slips and try again.");
      return;
    }
    setParsing(true);
    setParseErr("");
    setView("add");
    setBatch({ done: 0, total: files.length, found: 0, failed: [] });

    const allFresh = [];
    const failed = [];
    let skippedTotal = 0;
    let lastPreview = null;
    const seen = makeDupeCheck(positions);

    for (let i = 0; i < files.length; i++) {
      let preview = null;
      try {
        const norm = await normalizeImage(files[i]);
        preview = norm.preview;
        lastPreview = preview;
        const tickets = await parseSlip(norm.base64, norm.mediaType);
        if (!tickets.length) throw new Error("no bets found");
        for (const t of tickets) {
          const d = ticketToDraft(t, preview);
          const cand = { book: d.book, selection: d.selection, market: d.market, odds: parseOdds(d.odds), stake: parseFloat(d.stake), datePlaced: d.datePlaced, betId: d.betId };
          if (seen.isDupe(cand)) { skippedTotal++; continue; }
          seen.add(cand);
          allFresh.push(d);
        }
      } catch (e) {
        failed.push((files[i].name || "slip " + (i + 1)) + ": " + (e.message || "error"));
      }
      setBatch({ done: i + 1, total: files.length, found: allFresh.length, failed: failed.slice() });
    }

    setBatch(null);
    const notes = [];
    if (skippedTotal) notes.push(skippedTotal + " duplicate" + (skippedTotal > 1 ? "s" : "") + " already in the book, skipped");
    if (failed.length) notes.push("couldn't read " + failed.length + " slip" + (failed.length > 1 ? "s" : "") + " (" + failed.join(" · ") + ")");
    if (!allFresh.length) {
      if (lastPreview && failed.length) setPendingSlip(lastPreview);
      setParseErr(notes.length ? notes.join(". ") + "." : "No new bets found in those screenshots.");
    } else {
      setDraft(allFresh[0]);
      setQueue(allFresh.slice(1));
      setPendingSlip(null);
      setParseErr(notes.length ? notes.join(". ") + "." : "");
    }
    setParsing(false);
  }, [positions]);

  const handleFile = useCallback((file) => handleFiles(file ? [file] : []), [handleFiles]);

  /* load tickets from an import code generated by Claude in chat */
  const loadPasted = () => {
    try {
      const t = pasteText.trim();
      if (!t) throw new Error("nothing pasted");
      let parsed;
      try {
        parsed = JSON.parse(t.replace(/```json|```/g, "").trim());
      } catch (e) {
        parsed = extractJSON(t);
      }
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tickets) ? parsed.tickets : [parsed];
      const drafts = arr.filter((x) => x && (x.selection || x.market)).map((x) => ticketToDraft(x, pendingSlip));
      if (!drafts.length) throw new Error("no tickets in that code");
      const { fresh, skipped } = dedupeDrafts(drafts);
      if (!fresh.length) {
        setPasteInfo("Everything in that code is already in the book.");
        setPasteErr("");
        return;
      }
      setDraft(fresh[0]);
      setQueue(fresh.slice(1));
      setPendingSlip(null);
      setPasteText("");
      setPasteErr("");
      setPasteInfo(skipped ? skipped + " duplicate" + (skipped > 1 ? "s" : "") + " skipped." : "");
      setParseErr("");
    } catch (e) {
      setPasteErr("Couldn't load that (" + (e.message || "bad format") + "). Paste the full code block from chat.");
    }
  };

  /* slip archive: lazy-load stored screenshots when the Slips tab opens */
  const loadSlips = useCallback(async () => {
    try {
      const r = await store.list("slip:");
      const keys = (r && r.keys) || [];
      const items = [];
      for (const key of keys) {
        try {
          const g = await store.get(key);
          if (g && g.value) items.push({ key, ...JSON.parse(g.value) });
        } catch (e) {
          /* skip unreadable entries */
        }
      }
      items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      setSlips(items);
    } catch (e) {
      setSlips([]);
    }
  }, []);

  useEffect(() => {
    if (view === "slips" && slips === null) loadSlips();
  }, [view, slips, loadSlips]);

  /* recovery: re-parse every archived slip back into the verify queue.
     The archive survives ledger loss, so the book can always be rebuilt
     from its own receipts. One AI parse per slip. */
  const rebuildFromSlips = useCallback(async () => {
    setParsing(true);
    setParseErr("");
    setView("add");
    let items = slips;
    if (!items) {
      try {
        const r = await store.list("slip:");
        const keys = (r && r.keys) || [];
        items = [];
        for (const key of keys) {
          try {
            const g = await store.get(key);
            if (g && g.value) {
              const rec = JSON.parse(g.value);
              if (rec && rec.img) items.push({ key, img: rec.img, ts: rec.ts, caption: rec.caption });
            }
          } catch (e) { /* skip broken record */ }
        }
      } catch (e) {
        setParsing(false);
        setParseErr("Couldn't read the slip archive (" + (e.message || "error") + "). Reload and try again.");
        return;
      }
    }
    if (!items.length) {
      setParsing(false);
      setParseErr("No slips in the archive to rebuild from.");
      return;
    }
    setBatch({ done: 0, total: items.length, found: 0, failed: [] });
    const allFresh = [];
    const failed = [];
    let skippedTotal = 0;
    const seen = makeDupeCheck(positions);
    for (let i = 0; i < items.length; i++) {
      try {
        const img = items[i].img || "";
        const m = img.match(/^data:([^;]+);base64,(.*)$/s);
        if (!m) throw new Error("stored image unreadable");
        const tickets = await parseSlip(m[2], m[1]);
        if (!tickets.length) throw new Error("no bets found");
        for (const t of tickets) {
          const d = ticketToDraft(t, img);
          const cand = { book: d.book, selection: d.selection, market: d.market, odds: parseOdds(d.odds), stake: parseFloat(d.stake), datePlaced: d.datePlaced, betId: d.betId };
          if (seen.isDupe(cand)) { skippedTotal++; continue; }
          seen.add(cand);
          allFresh.push(d);
        }
      } catch (e) {
        failed.push((items[i].caption || "slip " + (i + 1)) + ": " + (e.message || "error"));
      }
      setBatch({ done: i + 1, total: items.length, found: allFresh.length, failed: failed.slice() });
    }
    setBatch(null);
    const notes = [];
    if (skippedTotal) notes.push(skippedTotal + " already in the book, skipped");
    if (failed.length) notes.push("couldn't re-read " + failed.length + " (" + failed.join(" · ") + ")");
    if (!allFresh.length) {
      setParseErr(notes.length ? notes.join(". ") + "." : "Nothing new came out of the archive.");
    } else {
      setDraft(allFresh[0]);
      setQueue(allFresh.slice(1));
      setParseErr(notes.length ? notes.join(". ") + "." : "");
    }
    setParsing(false);
  }, [slips, positions]);

  /* backup: export the whole book as a code; restore merges by ticket id */
  const exportBook = () => {
    const code = JSON.stringify({ futuresBookBackup: 1, exported: todayISO(), positions });
    setBackupText(code);
    setDirty(0);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(
        () => setBackupMsg({ text: "Backup code copied to clipboard and shown below. Save it in Notes or paste it to Claude.", err: false }),
        () => setBackupMsg({ text: "Backup code is below. Copy and save it in Notes or paste it to Claude.", err: false })
      );
    } else {
      setBackupMsg({ text: "Backup code is below. Copy and save it in Notes or paste it to Claude.", err: false });
    }
  };

  const importBook = () => {
    try {
      const t = backupText.trim();
      if (!t) throw new Error("nothing pasted");
      const parsed = JSON.parse(t.replace(/```json|```/g, "").trim());
      const arr = Array.isArray(parsed) ? parsed : parsed.positions;
      if (!Array.isArray(arr) || !arr.length) throw new Error("no tickets in that code");
      const cleaned = arr
        .map((p) => ({
          id: p.id || uid(),
          book: p.book || "",
          sport: SPORTS.includes(p.sport) ? p.sport : "Other",
          market: p.market || "",
          selection: p.selection || "",
          odds: typeof p.odds === "number" ? p.odds : parseOdds(p.odds) || 0,
          stake: Number(p.stake) || 0,
          datePlaced: p.datePlaced || todayISO(),
          season: p.season || guessSeason(p.sport, p.datePlaced),
          notes: p.notes || "",
          betId: p.betId ? String(p.betId) : "",
          freePlay: !!p.freePlay,
          status: ["open", "won", "lost", "cashout"].includes(p.status) ? p.status : "open",
          returned: p.returned === null || p.returned === undefined ? null : Number(p.returned),
          dateSettled: p.dateSettled || null,
        }))
        .filter((p) => p.selection || p.market);
      if (!cleaned.length) throw new Error("no valid tickets in that code");
      const byId = {};
      positions.forEach((p) => { byId[p.id] = p; });
      cleaned.forEach((p) => { byId[p.id] = p; });
      const merged = Object.values(byId).sort((a, b) => (b.datePlaced || "").localeCompare(a.datePlaced || ""));
      persist(merged);
      setBackupMsg({ text: "Restored " + cleaned.length + " ticket" + (cleaned.length > 1 ? "s" : "") + ". Book now holds " + merged.length + ".", err: false });
    } catch (e) {
      setBackupMsg({ text: "Couldn't restore (" + (e.message || "bad code") + "). Paste the full backup code.", err: true });
    }
  };

  /* paste screenshots anywhere on Add view */
  useEffect(() => {
    const onPaste = (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (item) handleFile(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  /* one-time API reachability check so we know if AI features work in this view */
  useEffect(() => {
    if (IS_ARTIFACT) return;
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.kv !== "undefined") setServerInfo(d); })
      .catch(() => { /* no server on this deploy */ });
  }, []);

  useEffect(() => {
    if (aiStatus !== "unknown") return;
    setAiStatus("checking");
    callClaude({ max_tokens: 8, messages: [{ role: "user", content: "Reply with OK" }] })
      .then(() => { setAiStatus("ok"); setAiErr(""); })
      .catch((e) => { setAiStatus("down"); setAiErr(e.message || ""); });
  }, [aiStatus]);

  /* save draft as position */
  const saveDraft = () => {
    const odds = parseOdds(draft.odds);
    const stake = parseFloat(draft.stake);
    if (!draft.selection.trim() || odds === null || !Number.isFinite(stake)) return;
    if (draft.editingId) {
      persist(
        positions.map((p) =>
          p.id === draft.editingId
            ? { ...p, book: draft.book.trim(), sport: draft.sport, market: draft.market.trim(), selection: draft.selection.trim(), odds, stake, datePlaced: draft.datePlaced, season: draft.season.trim() || guessSeason(draft.sport, draft.datePlaced), notes: draft.notes.trim(), betId: (draft.betId || "").trim(), freePlay: !!draft.freePlay }
            : p
        )
      );
      setDraft(null);
      setView("open");
      return;
    }
    const base = {
      id: uid(),
      book: draft.book.trim(),
      sport: draft.sport,
      market: draft.market.trim(),
      selection: draft.selection.trim(),
      odds,
      stake,
      datePlaced: draft.datePlaced,
      season: draft.season.trim() || guessSeason(draft.sport, draft.datePlaced),
      notes: draft.notes.trim(),
      betId: (draft.betId || "").trim(),
      freePlay: !!draft.freePlay,
      status: "open",
      returned: null,
      dateSettled: null,
    };
    if (draft.logSettled) {
      base.status = draft.result;
      base.dateSettled = draft.dateSettled;
      base.returned =
        draft.result === "lost"
          ? 0
          : draft.result === "won"
          ? draft.returned !== "" ? parseFloat(draft.returned) : (draft.freePlay ? 0 : stake) + profitFor(odds, stake)
          : parseFloat(draft.returned || 0);
    }
    persist([base, ...positions]);
    setUndoSnap(positions);
    setCascadeNote("Added to the book: " + base.selection + " · " + (base.market || base.sport) + ".");
    if (draft.preview) {
      const caption = base.selection + " · " + base.market + (base.book ? " · " + base.book : "");
      shrinkDataUrl(draft.preview)
        .then((img) => {
          if (!img) return null;
          return store.set("slip:" + base.id, JSON.stringify({ img, ts: Date.now(), caption }));
        })
        .then(() => setSlips(null))
        .catch(() => {});
    }
    if (queue.length) {
      setDraft(queue[0]);
      setQueue(queue.slice(1));
    } else {
      setDraft(null);
      setView(base.status === "open" ? "open" : "history");
    }
  };

  const settle = (id, status, returned) => {
    const t = positions.find((p) => p.id === id);
    if (!t) return;
    let next;
    let note = null;
    if (status === "won" && marketType(t.market) !== "Parlay") {
      // one winner per market: matching picks also win, everything else in the group loses
      const key = marketKey(t);
      let alsoWon = 0;
      let alsoLost = 0;
      next = positions.map((p) => {
        if (p.id === id) return { ...p, status: "won", returned, dateSettled: todayISO() };
        if (p.status === "open" && marketKey(p) === key) {
          if (sameSel(p.selection, t.selection)) {
            alsoWon++;
            return { ...p, status: "won", returned: collectFor(p), dateSettled: todayISO() };
          }
          alsoLost++;
          return { ...p, status: "lost", returned: 0, dateSettled: todayISO() };
        }
        return p;
      });
      if (alsoWon || alsoLost) {
        const bits = [];
        if (alsoWon) bits.push(alsoWon + " more " + t.selection + " ticket" + (alsoWon > 1 ? "s" : "") + " won");
        if (alsoLost) bits.push(alsoLost + " other" + (alsoLost > 1 ? "s" : "") + " marked lost");
        note = "Market settled: " + bits.join(", ") + ".";
      }
    } else {
      next = positions.map((p) =>
        p.id === id ? { ...p, status, returned, dateSettled: todayISO() } : p
      );
    }
    persist(next);
    setSettling(null);
    const word = status === "won" ? "won" : status === "lost" ? "lost" : "cashed out";
    setCascadeNote(note || "Settled: " + t.selection + " " + word + ".");
    setUndoSnap(positions);
  };

  const removeTicket = (id) => {
    const t = positions.find((p) => p.id === id);
    persist(positions.filter((p) => p.id !== id));
    setUndoSnap(positions);
    setCascadeNote("Removed " + (t ? t.selection + " · " + (t.market || t.sport) : "ticket") + " from the book.");
    try {
      const r = store.delete("slip:" + id);
      if (r && r.catch) r.catch(() => {});
    } catch (e) {
      /* best effort */
    }
    setSlips(null);
  };

  const editTicket = (p) => {
    setQueue([]);
    setPendingSlip(null);
    setDraft({
      ...blankDraft(),
      editingId: p.id,
      book: p.book || "",
      sport: p.sport,
      market: p.market || "",
      selection: p.selection || "",
      odds: fmtOdds(p.odds),
      stake: String(p.stake),
      datePlaced: p.datePlaced || todayISO(),
      season: p.season || "",
      notes: p.notes || "",
      betId: p.betId || "",
      freePlay: !!p.freePlay,
    });
    setView("add");
  };

  const saveApiKey = () => {
    try { localStorage.setItem("fb-api-key", apiKeyDraft.trim()); } catch (e) { /* private mode */ }
    setAiStatus("unknown");
  };

  const refreshLive = async (openList) => {
    setLiveBusy(true);
    try {
      const r = await fetchLiveOdds(openList, oddsPrefs.book);
      setLive(r);
    } catch (e) {
      setLive({ prices: {}, misses: [], errors: [e.message], ts: Date.now() });
    } finally {
      setLiveBusy(false);
    }
  };

  const saveOddsSettings = (book, key) => {
    const next = { book: book || oddsPrefs.book, key: key !== undefined ? key.trim() : oddsPrefs.key };
    saveOddsPrefs(next);
    setOddsPrefs(next);
    setLive(null); // prices from the old book no longer apply
  };

  /* A held futures ticket gains when the market shortens on the pick:
     implied probability now above your entry means the money agrees with you. */
  const liveDrift = (p, lp) => {
    const entry = implied(p.odds);
    const now = implied(lp.price);
    if (!entry || !now) return "flat";
    const delta = now - entry;
    if (delta > 0.004) return "steam";
    if (delta < -0.004) return "drift";
    return "flat";
  };

  const AI_DOWN_MSG = IS_ARTIFACT
    ? "AI can't connect in this view. Open this artifact on claude.ai in a browser to run checks."
    : "AI unavailable: " + (aiErr || "sign in if this site has a server key, or add your own under AI settings in the + New ticket tab.");

  const runEdge = async (p) => {
    if (aiStatus === "down") {
      setEdges((e) => ({ ...e, [p.id]: { loading: false, err: AI_DOWN_MSG } }));
      return;
    }
    const splitLegs = open.filter((x) => x.id !== p.id && marketKey(x) === marketKey(p) && sameSel(x.selection, p.selection)).length;
    setEdges((e) => ({ ...e, [p.id]: { loading: true } }));
    try {
      const text = await edgeCheck(p, splitLegs);
      setEdges((e) => ({ ...e, [p.id]: { loading: false, text } }));
    } catch (err) {
      setEdges((e) => ({ ...e, [p.id]: { loading: false, err: "Check failed. Try again." } }));
    }
  };

  const runMarketCheck = async (k, openRows, settledRows) => {
    if (aiStatus === "down") {
      setMarketChecks((m) => ({ ...m, [k]: { loading: false, err: AI_DOWN_MSG } }));
      return;
    }
    setMarketChecks((m) => ({ ...m, [k]: { loading: true } }));
    try {
      const text = await marketCheck(openRows, settledRows);
      setMarketChecks((m) => ({ ...m, [k]: { loading: false, text } }));
    } catch (err) {
      setMarketChecks((m) => ({ ...m, [k]: { loading: false, err: "Check failed. Try again." } }));
    }
  };

  /* derived */
  const open = positions.filter((p) => p.status === "open");
  const settled = positions.filter((p) => p.status !== "open");
  const atRisk = cashStaked(open);
  const toWin = open.reduce((s, p) => s + collectFor(p), 0);
  const allTimeNet = settled.reduce((s, p) => s + netOf(p), 0);

  /* free-text search: every word must land somewhere on the ticket */
  const q = query.trim().toLowerCase();
  const matchesQuery = (p) => {
    if (!q) return true;
    const hay = [p.selection, p.market, marketType(p.market), p.book, p.notes, p.betId, p.season].filter(Boolean).join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  };
  const matchesFilters = (p) =>
    matchesQuery(p) &&
    (sportFilter === "all" || p.sport === sportFilter) &&
    (typeFilter === "all" || marketType(p.market) === typeFilter);
  const openShown = open.filter(matchesFilters);
  const settledShown = settled.filter(matchesFilters);
  const clearFilters = () => { setSportFilter("all"); setTypeFilter("all"); setQuery(""); };

  const seasons = {};
  settledShown.forEach((p) => {
    const k = p.season || "Unlabeled";
    if (!seasons[k]) seasons[k] = [];
    seasons[k].push(p);
  });
  const seasonKeys = Object.keys(seasons).sort().reverse();
  const effSeason = seasonKeys.includes(seasonFilter) ? seasonFilter : "all";
  const shownSeasons = effSeason === "all" ? seasonKeys : seasonKeys.filter((k) => k === effSeason);

  /* market groups for the Markets tab */
  const buildGroups = (list) => {
    const g = {};
    list.forEach((p) => {
      const k = marketKey(p);
      if (!g[k]) g[k] = [];
      g[k].push(p);
    });
    return g;
  };
  const allGroups = buildGroups(positions);
  const openGroupList = Object.entries(allGroups)
    .filter(([, rows]) => rows.some((p) => p.status === "open"))
    .map(([k, rows]) => [k, rows.filter((p) => p.status === "open"), rows.filter((p) => p.status !== "open")])
    .sort((a, b) =>
      sportRank(a[1][0].sport) - sportRank(b[1][0].sport) ||
      marketType(a[1][0].market).localeCompare(marketType(b[1][0].market)) ||
      b[1].reduce((s, p) => s + p.stake, 0) - a[1].reduce((s, p) => s + p.stake, 0));
  const settledGroupList = Object.entries(allGroups)
    .filter(([, rows]) => rows.every((p) => p.status !== "open"))
    .sort((a, b) => {
      const bySport = sportRank(a[1][0].sport) - sportRank(b[1][0].sport);
      if (bySport) return bySport;
      const last = (rows) => rows.map((p) => p.dateSettled || "").sort().pop() || "";
      return last(b[1]).localeCompare(last(a[1]));
    });

  /* ---------- render ---------- */

  return (
    <div className="fb-root">
      <style>{css}</style>

      {/* header */}
      <header className="fb-head">
        <div className="fb-brand">
          <span className="fb-brand-main">FUTURES</span>
          <span className="fb-brand-sub">BOOK</span>
        </div>
        <div className="fb-board">
          <div className="fb-board-cell">
            <label>Open</label>
            <span>{open.length}</span>
          </div>
          <div className="fb-board-cell">
            <label>Risk</label>
            <span>{fmtMoney(atRisk)}</span>
          </div>
          <div className="fb-board-cell">
            <label>To collect</label>
            <span className="gold">{fmtMoney(toWin)}</span>
          </div>
          <div className="fb-board-cell">
            <label>All-time</label>
            <span className={allTimeNet >= 0 ? "win" : "loss"}>{fmtMoney(allTimeNet, true)}</span>
          </div>
        </div>
      </header>

      {/* nav */}
      <nav className="fb-nav">
        {[
          ["open", `Open tickets${open.length ? " · " + open.length : ""}`],
          ["markets", "Markets"],
          ["history", "History"],
          ["slips", "Slips"],
          ["add", "+ New ticket"],
        ].map(([k, label]) => (
          <button
            key={k}
            className={"fb-tab" + (view === k ? " active" : "")}
            onClick={() => {
              setView(k);
              if (k === "add" && !draft && !parsing) setParseErr("");
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {cascadeNote && (
        <div className="fb-note">
          <span>{cascadeNote}</span>
          {undoSnap && (
            <button
              className="fb-btn small"
              onClick={() => { persist(undoSnap); setUndoSnap(null); setCascadeNote(null); }}
            >
              Undo
            </button>
          )}
          <button onClick={() => setCascadeNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {loaded && storageStatus === "unavailable" && (
        <div className="fb-note warn">
          <span>
            Saving isn't working in this view, so the book resets when closed.
            {dirty > 0 ? ` ${dirty} change${dirty > 1 ? "s" : ""} since last backup.` : ""}
            {" "}Export before you leave, and paste the code to Claude to bake it into the app permanently.
          </span>
          <button className="fb-btn small" onClick={() => { setView("add"); exportBook(); }}>Export</button>
        </div>
      )}

      {!loaded && <div className="fb-empty">Loading your book…</div>}

      {/* ============ ADD ============ */}
      {loaded && view === "add" && (
        <section>
          {!draft && !parsing && (
            <>
            <div
              className={"fb-drop" + (dragOver ? " over" : "")}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => fileRef.current && fileRef.current.click()}
            >
              <div className="fb-drop-stamp">SLIP INTAKE</div>
              <p className="fb-drop-big">Drop slip screenshots, one or a whole batch</p>
              <p className="fb-drop-small">or paste (Ctrl/Cmd+V), or tap to browse and multi-select. Every bet from every screenshot lands in one queue for you to verify ticket by ticket.</p>
              {parseErr && <p className="fb-err">{parseErr}</p>}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
              />
              <button
                className="fb-btn ghost"
                onClick={(e) => { e.stopPropagation(); setDraft({ ...blankDraft(), preview: pendingSlip }); setPendingSlip(null); }}
              >
                Enter manually instead
              </button>
              {aiStatus === "checking" && <p className="fb-status">Checking AI intake…</p>}
              {aiStatus === "ok" && <p className="fb-status ok">AI intake connected</p>}
              {aiStatus === "down" && (
                <p className="fb-status bad">{IS_ARTIFACT ? "AI intake can't reach the API in this view. Use Paste from chat below, or open this artifact on claude.ai in a desktop browser." : "AI intake: " + (aiErr || "needs a key. Sign in if this site has a server key, or add one under AI settings below.")}</p>
              )}
            </div>

            {pendingSlip && (
              <div className="fb-pending">
                <img src={pendingSlip} alt="captured slip" />
                <span>Slip captured. It will attach and archive with the next ticket(s) you add here.</span>
                <button onClick={() => setPendingSlip(null)} aria-label="Discard captured slip">×</button>
              </div>
            )}

            <div className="fb-import">
              <h4>Paste from chat</h4>
              <p>Screenshot won't go through? Send the slip to Claude in the chat and ask for a Futures Book import code, then paste it here. Works for one slip or a whole bet history.</p>
              <textarea
                rows={3}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='{"tickets":[{"book":"DraftKings","sport":"MLB","market":"AL Cy Young","selection":"George Kirby","odds":"+2000","stake":25}]}'
              />
              <div className="fb-row">
                <button className="fb-btn small" onClick={loadPasted}>Load tickets</button>
              </div>
              {pasteErr && <p className="fb-err">{pasteErr}</p>}
              {pasteInfo && <p className="fb-ok">{pasteInfo}</p>}
            </div>

            <div className="fb-import">
              <h4>Backup &amp; restore</h4>
              <p>Export your whole book (open + settled) as a code. Save it in Notes or paste it to Claude in chat, then restore it here anytime. Restoring merges by ticket, so nothing gets wiped.</p>
              <div className="fb-row" style={{ marginBottom: 10 }}>
                <button className="fb-btn small" onClick={exportBook}>Export book</button>
                <button className="fb-btn ghost small" onClick={importBook}>Restore from code</button>
              </div>
              <textarea
                rows={3}
                value={backupText}
                onChange={(e) => setBackupText(e.target.value)}
                placeholder="Backup code appears here when you export. Paste a saved code here to restore."
              />
              {backupMsg && <p className={backupMsg.err ? "fb-err" : "fb-ok"}>{backupMsg.text}</p>}
            </div>

            {!IS_ARTIFACT && (
              <div className="fb-import">
                <h4>Live odds</h4>
                <p>Pick your book of record; the Open tab quotes its current price next to every ticket it can find a feed for. Prices come from The Odds API. If this deploy has a server key, it just works; otherwise paste your own free key from the-odds-api.com and it stays on this device.</p>
                <div className="fb-row">
                  <select
                    className="fb-key-input"
                    style={{ maxWidth: 180 }}
                    value={oddsPrefs.book}
                    onChange={(e) => saveOddsSettings(e.target.value, undefined)}
                  >
                    {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                  <input
                    className="fb-key-input"
                    type="password"
                    value={oddsKeyDraft}
                    onChange={(e) => setOddsKeyDraft(e.target.value)}
                    placeholder="Odds API key (optional)"
                  />
                  <button className="fb-btn small" onClick={() => saveOddsSettings(undefined, oddsKeyDraft)}>Save</button>
                </div>
              </div>
            )}

            {!IS_ARTIFACT && (
              <div className="fb-import">
                <h4>AI settings</h4>
                <p>Screenshot parsing, edge checks, and market checks run on Claude. If this site has a server key (ANTHROPIC_API_KEY on Vercel), every signed-in member gets AI on every device with nothing to paste. Otherwise, add your own key here; it stays on this device only.</p>
                {serverInfo && (
                  <p className="fb-status">
                    Server config: AI key {serverInfo.ai ? "✓" : "not set"} · Odds key {serverInfo.odds ? "✓" : "not set"} · Accounts {serverInfo.kv ? "✓" : "not set"}
                  </p>
                )}
                {!serverInfo && <p className="fb-status">Server config: /api not reachable on this deploy (device keys only).</p>}
                <div className="fb-row">
                  <input
                    className="fb-key-input"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder="sk-ant-..."
                  />
                  <button className="fb-btn small" onClick={saveApiKey}>Save key</button>
                </div>
              </div>
            )}
            </>
          )}

          {parsing && (
            <div className="fb-drop">
              <div className="fb-spinner" />
              <p className="fb-drop-big">{batch && batch.total > 1 ? "Reading slip " + Math.min(batch.done + 1, batch.total) + " of " + batch.total + "…" : "Reading the slip…"}</p>
              <p className="fb-drop-small">{batch && batch.total > 1
                ? batch.found + " ticket" + (batch.found === 1 ? "" : "s") + " pulled so far" + (batch.failed.length ? " · " + batch.failed.length + " slip" + (batch.failed.length > 1 ? "s" : "") + " unreadable" : "")
                : "Pulling book, market, odds and stake off the screenshot."}</p>
            </div>
          )}

          {draft && !parsing && (
            <div className="fb-form">
              <div className="fb-form-head">
                <h3>{draft.editingId ? "Edit ticket" : queue.length ? `Verify ticket · ${queue.length} more in queue` : "Confirm the ticket"}</h3>
                {draft.preview && <img className="fb-slip-preview" src={draft.preview} alt="slip screenshot" />}
              </div>
              <div className="fb-grid">
                <Field label="Sportsbook">
                  <input value={draft.book} onChange={(e) => setDraft({ ...draft, book: e.target.value })} placeholder="DraftKings" />
                </Field>
                <Field label="Sport">
                  <select
                    value={draft.sport}
                    onChange={(e) => setDraft({ ...draft, sport: e.target.value, season: guessSeason(e.target.value, draft.datePlaced) })}
                  >
                    {SPORTS.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="Market">
                  <input value={draft.market} onChange={(e) => setDraft({ ...draft, market: e.target.value })} placeholder="AL Cy Young" />
                </Field>
                <Field label="Selection">
                  <input value={draft.selection} onChange={(e) => setDraft({ ...draft, selection: e.target.value })} placeholder="George Kirby" />
                </Field>
                <Field label="Odds">
                  <input value={draft.odds} onChange={(e) => setDraft({ ...draft, odds: e.target.value })} placeholder="+2000" />
                </Field>
                <Field label="Stake ($)">
                  <input value={draft.stake} onChange={(e) => setDraft({ ...draft, stake: e.target.value })} placeholder="25" inputMode="decimal" />
                </Field>
                <Field label="Date placed">
                  <input type="date" value={draft.datePlaced} onChange={(e) => setDraft({ ...draft, datePlaced: e.target.value, season: guessSeason(draft.sport, e.target.value) })} />
                </Field>
                <Field label="Season">
                  <input value={draft.season} onChange={(e) => setDraft({ ...draft, season: e.target.value })} placeholder="2026 MLB" />
                </Field>
                <Field label="Bet ID">
                  <input value={draft.betId || ""} onChange={(e) => setDraft({ ...draft, betId: e.target.value })} placeholder="from the slip, if shown" />
                </Field>
                <Field label="Notes" wide>
                  <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Boost, promo, reasoning…" />
                </Field>
              </div>

              {(() => {
                const o = parseOdds(draft.odds);
                const st = parseFloat(draft.stake);
                const ok = o !== null && Number.isFinite(st);
                return (
                  <div className="fb-collect">
                    To collect if it hits: <strong className="gold">{ok ? fmtMoney((draft.freePlay ? 0 : st) + profitFor(o, st)) : "—"}</strong>
                  </div>
                );
              })()}

              <label className="fb-check">
                <input
                  type="checkbox"
                  checked={!!draft.freePlay}
                  onChange={(e) => setDraft({ ...draft, freePlay: e.target.checked })}
                />
                Free play / bonus bet (stake is house money — a loss costs $0)
              </label>

              {!draft.editingId && (
                <label className="fb-check">
                  <input
                    type="checkbox"
                    checked={draft.logSettled}
                    onChange={(e) => setDraft({ ...draft, logSettled: e.target.checked })}
                  />
                  This one's already settled (logging past seasons)
                </label>
              )}

              {!draft.editingId && draft.logSettled && (
                <div className="fb-grid">
                  <Field label="Result">
                    <select value={draft.result} onChange={(e) => setDraft({ ...draft, result: e.target.value })}>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                      <option value="cashout">Cashed out</option>
                    </select>
                  </Field>
                  {draft.result !== "lost" && (
                    <Field label="Amount returned ($)">
                      <input value={draft.returned} onChange={(e) => setDraft({ ...draft, returned: e.target.value })} placeholder="auto from odds if won" inputMode="decimal" />
                    </Field>
                  )}
                  <Field label="Date settled">
                    <input type="date" value={draft.dateSettled} onChange={(e) => setDraft({ ...draft, dateSettled: e.target.value })} />
                  </Field>
                </div>
              )}

              <div className="fb-row">
                {(() => {
                  const ok = !!draft.selection.trim() && parseOdds(draft.odds) !== null && Number.isFinite(parseFloat(draft.stake));
                  return (
                    <button className="fb-btn" onClick={saveDraft} disabled={!ok} title={ok ? undefined : "Needs a selection, odds, and a stake before it can go in the book."}>
                      {draft.editingId ? "Save changes" : "Add to the book"}
                    </button>
                  );
                })()}
                <button
                  className="fb-btn ghost"
                  onClick={() => {
                    if (queue.length) { setDraft(queue[0]); setQueue(queue.slice(1)); }
                    else { setDraft(null); setParseErr(""); }
                  }}
                >
                  {queue.length ? "Skip this one" : "Discard"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ============ OPEN ============ */}
      {loaded && view === "open" && (
        <section>
          {open.length === 0 && (
            <div className="fb-empty">
              No open tickets. <button className="fb-link" onClick={() => setView("add")}>Drop a slip screenshot</button> to start the book.
            </div>
          )}
          <FilterBar tickets={open} sportFilter={sportFilter} typeFilter={typeFilter} onSport={setSportFilter} onType={setTypeFilter} query={query} onQuery={setQuery} shown={openShown.length} />
          {open.length > 0 && (
            <div className="fb-liveband">
              <button className="fb-btn small" onClick={() => refreshLive(open)} disabled={liveBusy}
                title="Pulls current futures prices from your book of record and stamps each open ticket.">
                {liveBusy ? "Pulling board…" : live ? "Refresh live odds" : "Pull live odds"}
              </button>
              <span className="fb-dim">
                {(BOOKS.find((b) => b.key === oddsPrefs.book) || BOOKS[0]).label} is the book of record
                {live ? " · updated " + new Date(live.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
              </span>
              {live && live.errors.length > 0 && <span className="fb-err">{live.errors[0]}</span>}
              {live && live.errors.length === 0 && live.misses.some((m) => m.reason === "no feed for this market") && (
                <span className="fb-dim">Award markets (MVP, Cy Young) have no public feed; use Edge check on those.</span>
              )}
            </div>
          )}
          {open.length > 0 && openShown.length === 0 && (
            <div className="fb-empty">
              Nothing matches those filters. <button className="fb-link" onClick={clearFilters}>Clear filters</button>
            </div>
          )}
          <div className="fb-tickets">
          {(() => {
            const rows = openShown
              .slice()
              .sort((a, b) =>
                sportRank(a.sport) - sportRank(b.sport) ||
                marketType(a.market).localeCompare(marketType(b.market)) ||
                (b.datePlaced || "").localeCompare(a.datePlaced || ""));
            return rows.map((p, rowIdx) => {
              const sportHead = rowIdx === 0 || rows[rowIdx - 1].sport !== p.sport ? p.sport : null;
              const edge = edges[p.id];
              const isSettling = settling && settling.id === p.id;
              const legMates = open
                .filter((x) => marketKey(x) === marketKey(p) && sameSel(x.selection, p.selection))
                .sort((a, b) => (a.datePlaced || "").localeCompare(b.datePlaced || "") || a.id.localeCompare(b.id));
              const legStr = legMates.length > 1 ? ` · leg ${legMates.findIndex((x) => x.id === p.id) + 1} of ${legMates.length}` : "";
              return (
                <React.Fragment key={p.id}>
                {sportHead && <div className="fb-sport-head">{sportHead}</div>}
                <article className="ticket">
                  <div className="ticket-body">
                    <div className="ticket-top">
                      <span className="ticket-market">{p.market || p.sport}</span>
                      <span className="ticket-meta">{p.book || "—"} · {p.season}{legStr}{p.betId ? " · #" + p.betId : ""}{p.freePlay ? " · FREE PLAY" : ""}</span>
                    </div>
                    <div className="ticket-selection">{p.selection}</div>
                    {p.notes && <div className="ticket-notes">{p.notes}</div>}

                    {edge && (
                      <div className="ticket-edge">
                        {edge.loading && <span className="fb-dim">Checking current market…</span>}
                        {edge.err && <span className="fb-err">{edge.err}</span>}
                        {edge.text && <p>{edge.text}</p>}
                      </div>
                    )}

                    {isSettling ? (
                      <div className="ticket-settle">
                        {settling.mode === "cashout" ? (
                          <>
                            <input
                              autoFocus
                              placeholder="Cash out amount $"
                              inputMode="decimal"
                              value={settling.amount || ""}
                              onChange={(e) => setSettling({ ...settling, amount: e.target.value })}
                            />
                            <button className="fb-btn small" onClick={() => settle(p.id, "cashout", parseFloat(settling.amount || 0))}>Confirm</button>
                            <button className="fb-btn ghost small" onClick={() => setSettling(null)}>Back</button>
                          </>
                        ) : (
                          <>
                            <span className="fb-dim">Grade it:</span>
                            <button className="fb-btn small win-btn" onClick={() => settle(p.id, "won", collectFor(p))}>Won {fmtMoney(collectFor(p))}</button>
                            <button className="fb-btn small loss-btn" onClick={() => settle(p.id, "lost", 0)}>Lost</button>
                            <button className="fb-btn small" onClick={() => setSettling({ id: p.id, mode: "cashout", amount: "" })}>Cash out…</button>
                            <button className="fb-btn ghost small" onClick={() => setSettling(null)}>Cancel</button>
                            {marketType(p.market) !== "Parlay" &&
                              open.some((x) => x.id !== p.id && marketKey(x) === marketKey(p)) && (
                                <span className="fb-cascade-hint">Won settles this whole market: matching picks win, the rest go to lost.</span>
                              )}
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="ticket-actions">
                        <button className="fb-btn small" onClick={() => runEdge(p)} disabled={edge && edge.loading} title="Quotes current FanDuel and DraftKings odds on this pick, with the % change in implied win probability vs your entry. Just the board, no advice.">
                          {edge && edge.loading ? "Checking…" : "Edge check"}
                        </button>
                        <button className="fb-btn ghost small" onClick={() => setSettling({ id: p.id, mode: "grade" })}>Settle</button>
                        <button className="fb-btn ghost small" onClick={() => editTicket(p)}>Edit</button>
                        <button className="fb-btn ghost small danger" onClick={() => removeTicket(p.id)}>Void</button>
                      </div>
                    )}
                  </div>

                  <div className="ticket-stub">
                    <div className="stub-odds">{fmtOdds(p.odds)}</div>
                    <div className="stub-line"><label>{p.freePlay ? "Free play" : "Risk"}</label><span>{fmtMoney(p.stake)}</span></div>
                    <div className="stub-line"><label>Collect</label><span>{fmtMoney(collectFor(p))}</span></div>
                    {live && live.prices[p.id] && (() => {
                      const lp = live.prices[p.id];
                      const drift = liveDrift(p, lp);
                      return (
                        <div
                          className={"stub-line stub-live " + drift}
                          title={"Now " + fmtOdds(lp.price) + " at " + lp.book +
                            (lp.preferred ? "" : " (your book isn't listing this; nearest price shown)") +
                            " · matched \"" + lp.outcome + "\""}
                        >
                          <label>Now</label>
                          <span>{fmtOdds(lp.price)}{drift === "steam" ? " ▲" : drift === "drift" ? " ▼" : ""}</span>
                        </div>
                      );
                    })()}
                    {live && !live.prices[p.id] && sportKeyFor(p) && (
                      <div className="stub-line stub-live flat"><label>Now</label><span>—</span></div>
                    )}
                    <div className="stub-date">{p.datePlaced}</div>
                  </div>
                </article>
                </React.Fragment>
              );
            });
          })()}
          </div>
        </section>
      )}

      {/* ============ MARKETS ============ */}
      {loaded && view === "markets" && (
        <section>
          {positions.length === 0 && (
            <div className="fb-empty">
              Nothing to track yet. <button className="fb-link" onClick={() => setView("add")}>Add a ticket</button> first.
            </div>
          )}

          {openGroupList.length > 0 && (
            <>
              <h3 className="fb-section-title">Open markets</h3>
              {openGroupList.map(([k, openRows, settledRows], gi) => {
                const p0 = openRows[0];
                const sportHead = gi === 0 || openGroupList[gi - 1][1][0].sport !== p0.sport ? p0.sport : null;
                const staked = cashStaked(openRows);
                const bySel = {};
                openRows.forEach((p) => {
                  bySel[p.selection] = (bySel[p.selection] || 0) + collectFor(p);
                });
                const best = Object.entries(bySel).sort((a, b) => b[1] - a[1])[0];
                const realized = settledRows.reduce((s, p) => s + netOf(p), 0);
                const coCount = settledRows.filter((p) => p.status === "cashout").length;
                const mc = marketChecks[k];
                const sorted = openRows.slice().sort(
                  (a, b) => a.selection.localeCompare(b.selection) || (a.datePlaced || "").localeCompare(b.datePlaced || "") || a.id.localeCompare(b.id)
                );
                return (
                  <React.Fragment key={k}>
                  {sportHead && <div className="fb-sport-head">{sportHead}</div>}
                  <div className="mkt-card">
                    <div className="mkt-head">
                      <div>
                        <div className="mkt-title">{marketType(p0.market)} · {p0.season}</div>
                        <div className="mkt-sub">{p0.market} · {openRows.length} open leg{openRows.length > 1 ? "s" : ""}</div>
                      </div>
                      <button className="fb-btn small" onClick={() => runMarketCheck(k, openRows, settledRows)} disabled={mc && mc.loading} title="Quotes current FanDuel and DraftKings odds on every selection you hold here, with the % change in implied win probability vs your entry. Just the board, no advice.">
                        {mc && mc.loading ? "Checking…" : "Market check"}
                      </button>
                    </div>
                    {sorted.map((p) => {
                      const mates = sorted.filter((x) => sameSel(x.selection, p.selection));
                      const legIdx = mates.findIndex((x) => x.id === p.id);
                      const isActive = settling && settling.id === p.id;
                      return (
                        <React.Fragment key={p.id}>
                          <div className="mkt-sel">
                            <span>
                              {p.selection}
                              {mates.length > 1 && <em className="mkt-leg-tag">leg {legIdx + 1}/{mates.length}</em>}
                              <em className="mkt-odds">{fmtOdds(p.odds)}</em>
                              {p.freePlay && <em className="mkt-leg-tag">free play</em>}
                            </span>
                            <span className="mkt-leg-right">
                              {fmtMoney(p.stake)} → {fmtMoney(collectFor(p))}
                              <button
                                className="fb-link"
                                onClick={() => setSettling(isActive ? null : { id: p.id, mode: "grade" })}
                              >
                                {isActive ? "close" : "settle"}
                              </button>
                            </span>
                          </div>
                          {isActive && (
                            <div className="mkt-settle">
                              {settling.mode === "cashout" ? (
                                <>
                                  <input
                                    autoFocus
                                    placeholder="Cash out $"
                                    inputMode="decimal"
                                    value={settling.amount || ""}
                                    onChange={(e) => setSettling({ ...settling, amount: e.target.value })}
                                  />
                                  <button className="fb-btn small" onClick={() => settle(p.id, "cashout", parseFloat(settling.amount || 0))}>Confirm</button>
                                  <button className="fb-btn ghost small" onClick={() => setSettling({ id: p.id, mode: "grade" })}>Back</button>
                                </>
                              ) : (
                                <>
                                  <button className="fb-btn small win-btn" onClick={() => settle(p.id, "won", collectFor(p))}>Won {fmtMoney(collectFor(p))}</button>
                                  <button className="fb-btn small loss-btn" onClick={() => settle(p.id, "lost", 0)}>Lost</button>
                                  <button className="fb-btn small" onClick={() => setSettling({ id: p.id, mode: "cashout", amount: "" })}>Cash out…</button>
                                  <button className="fb-btn ghost small" onClick={() => setSettling(null)}>Cancel</button>
                                  {marketType(p.market) !== "Parlay" && sorted.length > 1 && (
                                    <span className="mkt-hint">Won settles this whole market: matching picks win, the rest go to lost.</span>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {settledRows.length > 0 && (
                      <div className="mkt-realized">
                        Already realized: <strong className={realized >= 0 ? "win" : "loss"}>{fmtMoney(realized, true)}</strong>
                        {" "}from {settledRows.length} settled leg{settledRows.length > 1 ? "s" : ""}{coCount ? ` (${coCount} cashed out)` : ""}
                      </div>
                    )}
                    <div className="mkt-foot">
                      <span>Open risk <strong className="mono">{fmtMoney(staked)}</strong></span>
                      <span>Best hit: {best[0]} collects <strong className="gold mono">{fmtMoney(best[1])}</strong> ({fmtMoney(best[1] - staked + realized, true)} market net)</span>
                    </div>
                    {mc && (
                      <div className="mkt-edge">
                        {mc.loading && <span className="fb-dim-dark">Searching current odds for every selection…</span>}
                        {mc.err && <span className="fb-err">{mc.err}</span>}
                        {mc.text && <p>{mc.text}</p>}
                      </div>
                    )}
                  </div>
                  </React.Fragment>
                );
              })}
            </>
          )}

          {settledGroupList.length > 0 && (
            <>
              <h3 className="fb-section-title">Settled markets</h3>
              {settledGroupList.map(([k, rows], gi) => {
                const p0 = rows[0];
                const sportHead = gi === 0 || settledGroupList[gi - 1][1][0].sport !== p0.sport ? p0.sport : null;
                const w = rows.filter((p) => p.status === "won").length;
                const l = rows.filter((p) => p.status === "lost").length;
                const c = rows.filter((p) => p.status === "cashout").length;
                const staked = cashStaked(rows);
                const net = rows.reduce((s, p) => s + netOf(p), 0);
                const roi = staked ? (net / staked) * 100 : 0;
                return (
                  <React.Fragment key={k}>
                  {sportHead && <div className="fb-sport-head">{sportHead}</div>}
                  <div className="mkt-row">
                    <span className="mkt-row-name">
                      {marketType(p0.market)} · {p0.season}
                      <em>{p0.market}</em>
                    </span>
                    <span className="mono dim">{w}W – {l}L{c ? ` – ${c}CO` : ""}</span>
                    <span className="mono dim">{fmtMoney(staked)}</span>
                    <span className={"mono " + (net >= 0 ? "win" : "loss")}>{fmtMoney(net, true)}</span>
                    <span className={"mono " + (net >= 0 ? "win" : "loss")}>{roi.toFixed(0)}%</span>
                  </div>
                  </React.Fragment>
                );
              })}
            </>
          )}
        </section>
      )}

      {/* ============ SLIPS ============ */}
      {loaded && view === "slips" && (
        <section>
          {slips && slips.length > 0 && (
            <div className="fb-liveband">
              <button className="fb-btn small" onClick={rebuildFromSlips} disabled={parsing}
                title="Re-reads every archived screenshot and queues any bet that isn't in the book, for you to verify one by one. One AI parse per slip.">
                Rebuild book from these slips
              </button>
              <span className="fb-dim">Lost tickets? The archive is the receipt: this re-parses every slip and queues what's missing.</span>
            </div>
          )}
          {slips === null && <div className="fb-empty">Loading your slip archive…</div>}
          {slips && slips.length === 0 && (
            <div className="fb-empty">
              No slips archived yet. Every screenshot you drop, paste, or attach gets saved here with its ticket.
            </div>
          )}
          {slips && slips.length > 0 && (
            <div className="slips-grid">
              {slips.map((s) => (
                <figure
                  className={"slip-item" + (expandedSlip === s.key ? " expanded" : "")}
                  key={s.key}
                  onClick={() => setExpandedSlip(expandedSlip === s.key ? null : s.key)}
                >
                  <img src={s.img} alt={s.caption || "bet slip"} />
                  <figcaption>
                    {s.caption || "Slip"}
                    <em>{s.ts ? new Date(s.ts).toLocaleDateString() : ""}</em>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ============ HISTORY ============ */}
      {loaded && view === "history" && (
        <section>
          {settled.length === 0 && (
            <div className="fb-empty">
              Nothing settled yet. You can backfill past seasons from <button className="fb-link" onClick={() => setView("add")}>+ New ticket</button> with "already settled" checked.
            </div>
          )}

          {settled.length > 0 && (
            <>
              <FilterBar tickets={settled} sportFilter={sportFilter} typeFilter={typeFilter} onSport={setSportFilter} onType={setTypeFilter} query={query} onQuery={setQuery} shown={settledShown.length} />
              <div className="fb-filter">
                <select value={effSeason} onChange={(e) => setSeasonFilter(e.target.value)}>
                  <option value="all">All seasons</option>
                  {seasonKeys.map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              {settledShown.length === 0 && (
                <div className="fb-empty">
                  Nothing settled matches those filters. <button className="fb-link" onClick={clearFilters}>Clear filters</button>
                </div>
              )}

              {shownSeasons.map((k) => {
                const rows = seasons[k];
                const w = rows.filter((p) => p.status === "won").length;
                const l = rows.filter((p) => p.status === "lost").length;
                const c = rows.filter((p) => p.status === "cashout").length;
                const staked = cashStaked(rows);
                const net = rows.reduce((s, p) => s + netOf(p), 0);
                const roi = staked ? (net / staked) * 100 : 0;
                return (
                  <div className="season" key={k}>
                    <div className="season-head">
                      <h3>{k}</h3>
                      <div className="season-stats">
                        <span>{w}W – {l}L{c ? ` – ${c}CO` : ""}</span>
                        <span>Staked {fmtMoney(staked)}</span>
                        <span className={net >= 0 ? "win" : "loss"}>{fmtMoney(net, true)}</span>
                        <span className={net >= 0 ? "win" : "loss"}>{roi.toFixed(0)}% ROI</span>
                      </div>
                    </div>
                    {rows
                      .slice()
                      .sort((a, b) => (b.dateSettled || "").localeCompare(a.dateSettled || ""))
                      .map((p) => (
                        <div className="hist-row" key={p.id}>
                          <span className={"hist-badge " + p.status}>
                            {p.status === "won" ? "W" : p.status === "lost" ? "L" : "CO"}
                          </span>
                          <span className="hist-sel">
                            {p.selection}
                            <em>{p.market}{p.book ? " · " + p.book : ""}{p.freePlay ? " · Free play" : ""}</em>
                          </span>
                          <span className="hist-odds">{fmtOdds(p.odds)}</span>
                          <span className="hist-stake">{fmtMoney(p.stake)}</span>
                          <span className={"hist-net " + (netOf(p) >= 0 ? "win" : "loss")}>{fmtMoney(netOf(p), true)}</span>
                          <button className="fb-link danger" onClick={() => removeTicket(p.id)}>×</button>
                        </div>
                      ))}
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}

      <footer className="fb-foot">Paste a slip screenshot anywhere to log a new future.</footer>
    </div>
  );
}

function Field({ label, children, wide }) {
  return (
    <label className={"fb-field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Chip({ label, active, onClick, title }) {
  return (
    <button className={"fb-chip" + (active ? " active" : "")} onClick={onClick} title={title}>{label}</button>
  );
}

/* League + bet-type chips derived live from the tickets in view.
   Two-step filter: pick a league first, then the market row appears showing
   only that league's markets (with counts scoped to it). Switching leagues
   resets the market pick so a hidden stale filter can never blank the list.
   Tapping an active chip clears it. New leagues/types show up automatically. */
function FilterBar({ tickets, sportFilter, typeFilter, onSport, onType, query, onQuery, shown }) {
  if (!tickets.length) return null;
  const sportOrder = ["MLB", "NBA", "NFL", "NHL", "Soccer", "Golf", "Tennis", "Other"];
  const idx = (s) => { const i = sportOrder.indexOf(s); return i === -1 ? 99 : i; };
  const sportCounts = {};
  tickets.forEach((t) => { sportCounts[t.sport] = (sportCounts[t.sport] || 0) + 1; });
  const sports = Object.keys(sportCounts).sort((a, b) => idx(a) - idx(b));
  /* a one-league book skips the league step entirely */
  const effSport = sports.length === 1 ? sports[0] : sportFilter;
  const typeCounts = {};
  tickets.forEach((t) => {
    if (effSport !== "all" && t.sport !== effSport) return;
    const k = marketType(t.market);
    typeCounts[k] = (typeCounts[k] || 0) + 1;
  });
  const types = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a] || a.localeCompare(b));
  const pickSport = (s) => { onSport(s); onType("all"); };
  const search = (
    <div className="fb-chip-row">
      <span className="fb-chip-label">Find</span>
      <div className="fb-search">
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search by name, market, book, bet ID…"
          aria-label="Search tickets"
        />
        {query && <button onClick={() => onQuery("")} aria-label="Clear search">×</button>}
      </div>
      {query.trim() && <span className="fb-filter-hint">{shown} match{shown === 1 ? "" : "es"}</span>}
    </div>
  );
  if (sports.length < 2 && types.length < 2) return <div className="fb-filters">{search}</div>;
  return (
    <div className="fb-filters">
      {search}
      {sports.length > 1 && (
        <div className="fb-chip-row">
          <span className="fb-chip-label">League</span>
          <Chip label={`All · ${tickets.length}`} active={sportFilter === "all"} onClick={() => pickSport("all")} />
          {sports.map((s) => (
            <Chip key={s} label={`${s} · ${sportCounts[s]}`} active={sportFilter === s} onClick={() => pickSport(sportFilter === s ? "all" : s)} />
          ))}
          {effSport === "all" && <span className="fb-filter-hint">pick a league to filter its markets</span>}
        </div>
      )}
      {effSport !== "all" && types.length > 1 && (
        <div className="fb-chip-row">
          <span className="fb-chip-label">Market</span>
          <Chip label={`All · ${Object.values(typeCounts).reduce((a, b) => a + b, 0)}`} active={typeFilter === "all"} onClick={() => onType("all")} />
          {types.map((t) => (
            <Chip key={t} label={`${t} · ${typeCounts[t]}`} title={t} active={typeFilter === t} onClick={() => onType(typeFilter === t ? "all" : t)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- styles ---------- */

const css = `
/* sport section headers */
.fb-sport-head { font-family: 'Barlow Condensed'; font-weight: 700; font-size: 15px; letter-spacing: 5px; text-transform: uppercase; color: var(--brass); margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid rgba(217,164,65,0.3); }
.fb-tickets .fb-sport-head:first-child, section .fb-sport-head:first-of-type { margin-top: 6px; }

/* live odds */
.fb-liveband { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; }
.fb-liveband .fb-dim { color: rgba(245,241,228,0.6); }
.stub-live span { font-size: 13px; }
.stub-live.steam span { color: var(--win-ink); }
.stub-live.drift span { color: var(--loss-ink); }
.stub-live.flat span { opacity: 0.75; }

@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');

.fb-root {
  --felt: #0c231c;
  --felt-deep: #081812;
  --paper: #f5f1e4;
  --paper-dim: #e9e3d0;
  --ink: #1d1f1b;
  --ink-soft: #5a5c52;
  --brass: #e0b04a;
  --win: #2e9e64;
  --win-ink: #0f7b45;
  --loss: #c65340;
  --loss-ink: #b3402f;
  min-height: 100vh;
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(217,164,65,0.07), transparent 60%),
    var(--felt);
  color: var(--paper);
  font-family: 'Barlow', system-ui, sans-serif;
  padding: 20px 16px 60px;
  max-width: 860px;
  margin: 0 auto;
}
.fb-root * { box-sizing: border-box; }
.fb-root button { font-family: inherit; cursor: pointer; }
.fb-root :focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
.fb-btn, .fb-tab, .fb-chip, .fb-link { transition: filter 0.15s, border-color 0.15s, background 0.15s, color 0.15s, transform 0.05s; }
.fb-btn:hover:not(:disabled) { filter: brightness(1.08); }
.fb-btn:active:not(:disabled) { transform: translateY(1px); }
.fb-btn.ghost:hover:not(:disabled) { opacity: 1; border-color: var(--brass); color: var(--brass); }
.fb-tab:hover:not(.active) { border-color: rgba(245,241,228,0.6); }
.fb-chip:hover:not(.active) { border-color: rgba(245,241,228,0.7); color: var(--paper); }
.fb-link:hover { filter: brightness(1.2); }
@media (prefers-reduced-motion: reduce) { .fb-btn, .fb-tab, .fb-chip, .fb-link { transition: none; } }

/* header */
.fb-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.fb-brand { line-height: 0.9; }
.fb-brand-main { display: block; font-family: 'Barlow Condensed'; font-weight: 700; font-size: 44px; letter-spacing: 2px; color: var(--paper); }
.fb-brand-sub { display: block; font-family: 'Barlow Condensed'; font-weight: 600; font-size: 20px; letter-spacing: 10px; color: var(--brass); }
.fb-board { display: flex; gap: 0; border: 1px solid rgba(245,241,228,0.18); border-radius: 6px; overflow: hidden; }
.fb-board-cell { padding: 8px 14px; border-left: 1px solid rgba(245,241,228,0.12); text-align: right; }
.fb-board-cell:first-child { border-left: none; }
.fb-board-cell label { display: block; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(245,241,228,0.5); }
.fb-board-cell span { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 16px; }
.gold { color: var(--brass); }
.win { color: var(--win); }
.loss { color: var(--loss); }

/* nav */
.fb-nav { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.fb-tab { background: transparent; border: 1px solid rgba(245,241,228,0.25); color: var(--paper); padding: 8px 16px; border-radius: 999px; font-size: 14px; font-weight: 500; }
.fb-tab.active { background: var(--paper); color: var(--ink); border-color: var(--paper); }

/* buttons */
.fb-btn { background: var(--brass); border: none; color: var(--ink); font-weight: 600; padding: 10px 18px; border-radius: 6px; font-size: 14px; }
.fb-btn.ghost { background: transparent; border: 1px solid currentColor; color: inherit; opacity: 0.85; }
.fb-btn.small { padding: 6px 12px; font-size: 13px; }
.fb-btn:disabled { opacity: 0.5; cursor: default; }
.fb-btn.win-btn { background: var(--win-ink); color: #fff; }
.fb-btn.loss-btn { background: var(--loss-ink); color: #fff; }
.fb-btn.danger, .fb-link.danger { color: var(--loss); }
.fb-link { background: none; border: none; color: var(--brass); text-decoration: underline; font-size: inherit; padding: 0; }

/* drop zone */
.fb-drop { border: 2px dashed rgba(245,241,228,0.3); border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; }
.fb-drop.over { border-color: var(--brass); background: rgba(217,164,65,0.06); }
.fb-drop-stamp { display: inline-block; font-family: 'IBM Plex Mono'; font-size: 11px; letter-spacing: 3px; color: var(--brass); border: 1px solid var(--brass); padding: 3px 10px; border-radius: 3px; transform: rotate(-2deg); margin-bottom: 16px; }
.fb-drop-big { font-family: 'Barlow Condensed'; font-weight: 600; font-size: 26px; margin: 0 0 6px; }
.fb-drop-small { color: rgba(245,241,228,0.6); font-size: 14px; margin: 0 0 18px; }
.fb-spinner { width: 28px; height: 28px; border: 3px solid rgba(245,241,228,0.2); border-top-color: var(--brass); border-radius: 50%; margin: 0 auto 16px; animation: fbspin 0.8s linear infinite; }
@keyframes fbspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fb-spinner { animation: none; } }
.fb-err { color: var(--loss); font-size: 14px; }
.fb-status { font-size: 12px; margin: 14px 0 0; font-family: 'IBM Plex Mono'; }
.fb-status.ok { color: var(--win); }
.fb-status.bad { color: var(--loss); font-family: 'Barlow'; font-size: 13px; }
.fb-import { margin-top: 16px; border: 1px solid rgba(245,241,228,0.18); border-radius: 10px; padding: 16px; }
.fb-import h4 { font-family: 'Barlow Condensed'; font-size: 18px; letter-spacing: 1.5px; margin: 0 0 4px; text-transform: uppercase; color: var(--brass); }
.fb-import p { font-size: 13px; color: rgba(245,241,228,0.6); margin: 0 0 10px; }
.fb-key-input { flex: 1; border: 1px solid rgba(245,241,228,0.25); background: rgba(0,0,0,0.25); color: var(--paper); border-radius: 6px; padding: 10px; font-family: 'IBM Plex Mono'; font-size: 12px; }
.fb-import textarea { width: 100%; border: 1px solid rgba(245,241,228,0.25); background: rgba(0,0,0,0.25); color: var(--paper); border-radius: 6px; padding: 10px; font-family: 'IBM Plex Mono'; font-size: 12px; margin-bottom: 10px; resize: vertical; }
.fb-dim { color: rgba(29,31,27,0.55); font-size: 13px; }

/* form */
.fb-form { background: var(--paper); color: var(--ink); border-radius: 10px; padding: 20px; }
.fb-form h3 { font-family: 'Barlow Condensed'; font-size: 24px; margin: 0 0 14px; letter-spacing: 0.5px; }
.fb-form-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.fb-slip-preview { width: 64px; height: 64px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid #c9c2ac; flex-shrink: 0; }
.fb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
.fb-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.fb-field.wide { grid-column: 1 / -1; }
.fb-field span { text-transform: uppercase; letter-spacing: 1px; color: var(--ink-soft); font-size: 10px; }
.fb-field input, .fb-field select, .ticket-settle input, .fb-filter select {
  border: 1px solid #c9c2ac; background: #fffdf6; color: var(--ink); border-radius: 5px; padding: 8px 10px; font-size: 14px; font-family: 'Barlow';
}
.fb-collect { font-size: 15px; margin: 4px 0 12px; }
.fb-collect .gold { color: #a87b1e; font-family: 'IBM Plex Mono'; }
.fb-check { display: flex; gap: 8px; align-items: center; font-size: 14px; margin-bottom: 12px; }
.fb-row { display: flex; gap: 10px; }

/* slips archive */
.slips-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.slip-item { margin: 0; background: var(--paper); border-radius: 8px; overflow: hidden; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,0.3); }
.slip-item img { width: 100%; height: 190px; object-fit: cover; object-position: top; display: block; }
.slip-item.expanded { grid-column: 1 / -1; }
.slip-item.expanded img { height: auto; object-fit: contain; max-height: 80vh; background: #000; }
.slip-item figcaption { color: var(--ink); font-size: 12px; padding: 8px 10px; }
.slip-item figcaption em { display: block; font-style: normal; color: var(--ink-soft); font-size: 11px; }
.fb-pending { display: flex; align-items: center; gap: 10px; margin-top: 14px; background: rgba(217,164,65,0.1); border: 1px dashed rgba(217,164,65,0.5); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.fb-pending img { width: 40px; height: 40px; object-fit: cover; object-position: top; border-radius: 4px; }
.fb-pending button { margin-left: auto; background: none; border: none; color: var(--brass); font-size: 18px; line-height: 1; }

/* markets tab */
.fb-section-title { font-family: 'Barlow Condensed'; font-size: 20px; letter-spacing: 2px; text-transform: uppercase; color: var(--brass); margin: 18px 0 10px; border-bottom: 1px solid rgba(245,241,228,0.2); padding-bottom: 6px; }
.mkt-card { background: rgba(245,241,228,0.05); border: 1px solid rgba(245,241,228,0.15); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.mkt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.mkt-title { font-family: 'Barlow Condensed'; font-weight: 700; font-size: 21px; letter-spacing: 0.5px; }
.mkt-sub { font-size: 12px; color: rgba(245,241,228,0.55); }
.mkt-sel { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 5px 0; border-bottom: 1px dashed rgba(245,241,228,0.12); }
.mkt-sel span:last-child { font-family: 'IBM Plex Mono'; font-size: 12px; white-space: nowrap; }
.mkt-odds { font-style: normal; font-family: 'IBM Plex Mono'; font-size: 11px; color: var(--brass); margin-left: 4px; }
.mkt-leg-tag { font-style: normal; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: rgba(245,241,228,0.55); margin-left: 6px; border: 1px solid rgba(245,241,228,0.25); padding: 1px 5px; border-radius: 3px; }
.mkt-leg-right { display: inline-flex; align-items: center; gap: 8px; }
.mkt-leg-right .fb-link { font-size: 12px; }
.mkt-cashout { display: inline-flex; gap: 6px; align-items: center; }
.mkt-cashout input { width: 70px; border: 1px solid rgba(245,241,228,0.3); background: rgba(0,0,0,0.3); color: var(--paper); border-radius: 4px; padding: 3px 6px; font-family: 'IBM Plex Mono'; font-size: 12px; }
.mkt-realized { margin-top: 8px; font-size: 13px; color: rgba(245,241,228,0.75); }
.mkt-settle { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px 0 10px; border-bottom: 1px dashed rgba(245,241,228,0.12); }
.mkt-settle input { width: 110px; border: 1px solid rgba(245,241,228,0.3); background: rgba(0,0,0,0.3); color: var(--paper); border-radius: 4px; padding: 6px 8px; font-family: 'IBM Plex Mono'; font-size: 13px; }
.mkt-hint { width: 100%; font-size: 12px; color: rgba(245,241,228,0.6); }
.fb-note.warn { background: rgba(198,83,64,0.12); border-color: rgba(198,83,64,0.5); }
.fb-ok { color: var(--win); font-size: 13px; }
.mkt-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; font-size: 13px; }
.mkt-edge { margin-top: 10px; background: rgba(0,0,0,0.25); border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.45; }
.mkt-edge p { margin: 6px 0 0; white-space: pre-wrap; }
.mkt-row { display: flex; align-items: center; gap: 14px; padding: 10px 4px; border-bottom: 1px solid rgba(245,241,228,0.08); font-size: 14px; }
.mkt-row-name { flex: 1; min-width: 0; }
.mkt-row-name em { display: block; font-style: normal; font-size: 12px; color: rgba(245,241,228,0.5); }
.mono { font-family: 'IBM Plex Mono'; font-size: 13px; }
.dim { color: rgba(245,241,228,0.7); }
.fb-dim-dark { color: rgba(245,241,228,0.55); font-size: 13px; }
.fb-note { background: rgba(217,164,65,0.12); border: 1px solid rgba(217,164,65,0.4); color: var(--paper); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.fb-note button { background: none; border: none; color: var(--brass); font-size: 18px; line-height: 1; }
.fb-cascade-hint { width: 100%; font-size: 12px; color: var(--ink-soft); }

/* filter chips */
.fb-filters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.fb-chip-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.fb-chip { background: transparent; border: 1px solid rgba(245,241,228,0.25); color: rgba(245,241,228,0.85); padding: 4px 12px; border-radius: 999px; font-size: 12px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-chip-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: rgba(245,241,228,0.45); align-self: center; min-width: 48px; }
.fb-filter-hint { font-size: 12px; color: rgba(245,241,228,0.45); align-self: center; font-style: italic; }
.fb-search { position: relative; flex: 1; min-width: 200px; max-width: 340px; }
.fb-search input { width: 100%; border: 1px solid rgba(245,241,228,0.25); background: rgba(0,0,0,0.25); color: var(--paper); border-radius: 999px; padding: 6px 30px 6px 14px; font-size: 13px; font-family: 'Barlow'; }
.fb-search input::placeholder { color: rgba(245,241,228,0.4); }
.fb-search input:focus { border-color: var(--brass); outline: none; }
.fb-search button { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--brass); font-size: 16px; line-height: 1; padding: 2px 6px; }
.fb-chip.active { background: var(--brass); border-color: var(--brass); color: var(--ink); font-weight: 600; }

/* tickets */
.fb-tickets { display: flex; flex-direction: column; gap: 16px; }
.ticket { display: flex; background: var(--paper); color: var(--ink); border-radius: 10px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
.ticket-body { flex: 1; padding: 16px 18px; min-width: 0; }
.ticket-top { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.ticket-market { font-family: 'IBM Plex Mono'; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #a87b1e; }
.ticket-meta { font-size: 12px; color: var(--ink-soft); }
.ticket-selection { font-family: 'Barlow Condensed'; font-weight: 700; font-size: 28px; line-height: 1.05; letter-spacing: 0.3px; }
.ticket-notes { font-size: 13px; color: var(--ink-soft); margin-top: 4px; }
.ticket-actions, .ticket-settle { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
.ticket-settle input { width: 160px; }
.ticket-edge { margin-top: 10px; background: #ece6d3; border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.45; }
.ticket-edge p { margin: 6px 0 0; white-space: pre-wrap; }

.ticket-stub {
  width: 132px; flex-shrink: 0; padding: 14px 12px; text-align: right;
  border-left: 2px dashed #b9b19a; position: relative;
  background: var(--paper-dim);
  display: flex; flex-direction: column; justify-content: center; gap: 6px;
}
.ticket-stub::before, .ticket-stub::after {
  content: ''; position: absolute; left: -8px; width: 14px; height: 14px; border-radius: 50%; background: var(--felt);
}
.ticket-stub::before { top: -7px; }
.ticket-stub::after { bottom: -7px; }
.stub-odds { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 24px; color: var(--ink); }
.stub-line { display: flex; justify-content: space-between; font-size: 12px; }
.stub-line label { color: var(--ink-soft); text-transform: uppercase; letter-spacing: 1px; font-size: 9px; align-self: center; }
.stub-line span { font-family: 'IBM Plex Mono'; font-weight: 500; }
.stub-date { font-size: 10px; color: var(--ink-soft); margin-top: 2px; }

/* history */
.fb-filter { margin-bottom: 14px; }
.fb-filter select { max-width: 220px; background: var(--paper); }
.season { margin-bottom: 22px; }
.season-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid rgba(245,241,228,0.2); padding-bottom: 6px; margin-bottom: 8px; }
.season-head h3 { font-family: 'Barlow Condensed'; font-size: 24px; letter-spacing: 1px; margin: 0; }
.season-stats { display: flex; gap: 16px; font-family: 'IBM Plex Mono'; font-size: 13px; }
.hist-row { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-bottom: 1px solid rgba(245,241,228,0.08); font-size: 14px; }
.hist-badge { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 11px; width: 26px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 3px; flex-shrink: 0; }
.hist-badge.won { background: var(--win-ink); color: #fff; }
.hist-badge.lost { background: var(--loss-ink); color: #fff; }
.hist-badge.cashout { background: #a87b1e; color: #fff; }
.hist-sel { flex: 1; min-width: 0; }
.hist-sel em { display: block; font-style: normal; font-size: 12px; color: rgba(245,241,228,0.5); }
.hist-odds, .hist-stake, .hist-net { font-family: 'IBM Plex Mono'; font-size: 13px; width: 76px; text-align: right; flex-shrink: 0; }

.fb-empty { text-align: center; color: rgba(245,241,228,0.65); padding: 60px 20px; font-size: 15px; }
.fb-foot { text-align: center; font-size: 12px; color: rgba(245,241,228,0.35); margin-top: 40px; }

@media (max-width: 560px) {
  .fb-brand-main { font-size: 34px; }
  .fb-board { width: 100%; }
  .fb-board-cell { flex: 1; padding: 8px 8px; }
  .ticket { flex-direction: column; }
  .ticket-stub { width: 100%; border-left: none; border-top: 2px dashed #b9b19a; flex-direction: row; justify-content: space-between; align-items: center; text-align: left; }
  .ticket-stub::before { top: -7px; left: -7px; }
  .ticket-stub::after { top: -7px; bottom: auto; left: auto; right: -7px; }
  .hist-odds { display: none; }
}
`;
