/* Live prices for futures markets via The Odds API (the-odds-api.com).
   Preferred path: the /api/odds proxy on Vercel, so the key stays server-side
   and responses cache in Redis. Fallback: a direct browser call with a key
   saved on this device (Settings > Live odds).

   One source of truth: the user picks a bookmaker (FanDuel by default);
   we quote that book's price and only fall back to another book when the
   preferred one isn't listing the market. */

export const BOOKS = [
  { key: "fanduel", label: "FanDuel" },
  { key: "draftkings", label: "DraftKings" },
  { key: "betmgm", label: "BetMGM" },
  { key: "caesars", label: "Caesars" },
  { key: "betrivers", label: "BetRivers" },
];

const BOOK_KEY = "fb-odds-book";
const ODDS_KEY = "fb-odds-key";

export function getOddsPrefs() {
  try {
    return {
      book: localStorage.getItem(BOOK_KEY) || "fanduel",
      key: localStorage.getItem(ODDS_KEY) || "",
    };
  } catch (e) {
    return { book: "fanduel", key: "" };
  }
}
export function saveOddsPrefs(prefs) {
  try {
    if (prefs.book) localStorage.setItem(BOOK_KEY, prefs.book);
    if (typeof prefs.key === "string") localStorage.setItem(ODDS_KEY, prefs.key);
  } catch (e) { /* private mode */ }
}

/* Market -> Odds API sport key. Award futures (MVP, Cy Young, ROY) have no
   public feed there, so those tickets honestly report "no feed" instead of
   guessing. Extend this table as The Odds API adds outright markets. */
const RULES = [
  { sport: "NFL", re: /super bowl|championship/i, key: "americanfootball_nfl_super_bowl_winner" },
  { sport: "NFL", re: /\b(afc|nfc)\b.*(champion|winner)/i, key: "americanfootball_nfl_super_bowl_winner" },
  { sport: "NBA", re: /championship|finals|title/i, key: "basketball_nba_championship_winner" },
  { sport: "MLB", re: /world series/i, key: "baseball_mlb_world_series_winner" },
  { sport: "NHL", re: /stanley cup|championship/i, key: "icehockey_nhl_championship_winner" },
  { sport: "NFL", re: /ncaa|college.*(champ|playoff)/i, key: "americanfootball_ncaaf_championship_winner" },
  { sport: "NBA", re: /ncaa|college.*(champ|tournament)/i, key: "basketball_ncaab_championship_winner" },
  { sport: "Golf", re: /masters/i, key: "golf_masters_tournament_winner" },
  { sport: "Golf", re: /pga championship/i, key: "golf_pga_championship_winner" },
  { sport: "Golf", re: /u\.?s\.? open/i, key: "golf_us_open_winner" },
  { sport: "Golf", re: /open championship|british open/i, key: "golf_the_open_championship_winner" },
];

export function sportKeyFor(p) {
  for (const r of RULES) {
    if (r.sport === p.sport && r.re.test(p.market || "")) return r.key;
  }
  return null;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/* 3 = exact, 2 = containment, 1 = strong token overlap, 0 = no match */
function nameScore(selection, outcome) {
  const a = norm(selection), b = norm(outcome);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const at = a.split(" "), bt = new Set(b.split(" "));
  const overlap = at.filter((t) => t.length > 2 && bt.has(t)).length;
  return overlap >= 2 || (overlap === 1 && at.length === 1) ? 1 : 0;
}

async function fetchSport(sportKey) {
  // Proxy first: key stays on the server, responses cache in Redis.
  try {
    const res = await fetch("/api/odds?sport=" + sportKey);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.events)) return data.events;
    }
  } catch (e) { /* fall through to direct */ }

  const { key } = getOddsPrefs();
  if (!key) {
    throw new Error("No odds source yet. Set ODDS_API_KEY on Vercel, or paste a key under Live odds in the + New ticket tab.");
  }
  const url = "https://api.the-odds-api.com/v4/sports/" + sportKey +
    "/odds?apiKey=" + encodeURIComponent(key) + "&regions=us&markets=outrights&oddsFormat=american";
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || "Odds API error " + res.status);
  return Array.isArray(data) ? data : [];
}

function findPrice(events, selection, prefBook) {
  let best = null;
  for (const ev of events || []) {
    for (const bm of ev.bookmakers || []) {
      for (const mk of bm.markets || []) {
        for (const o of mk.outcomes || []) {
          const score = nameScore(selection, o.name);
          if (!score) continue;
          const pref = bm.key === prefBook ? 1 : 0;
          const rank = score * 10 + pref;
          if (!best || rank > best.rank) {
            best = { rank, price: o.price, book: bm.title || bm.key, outcome: o.name, preferred: !!pref };
          }
        }
      }
    }
  }
  if (!best) return null;
  return { price: best.price, book: best.book, outcome: best.outcome, preferred: best.preferred };
}

/* Fetch current prices for every open position that maps to a feed.
   Returns { prices: {posId: {price, book, outcome, preferred}}, misses, errors, ts } */
export async function fetchLiveOdds(positions, prefBook) {
  const result = { prices: {}, misses: [], errors: [], ts: Date.now() };
  const bySport = new Map();

  for (const p of positions) {
    if (p.status !== "open") continue;
    const k = sportKeyFor(p);
    if (!k) {
      result.misses.push({ id: p.id, reason: "no feed for this market" });
      continue;
    }
    if (!bySport.has(k)) bySport.set(k, []);
    bySport.get(k).push(p);
  }

  for (const [sportKey, ps] of bySport) {
    let events;
    try {
      events = await fetchSport(sportKey);
    } catch (e) {
      if (!result.errors.includes(e.message)) result.errors.push(e.message);
      for (const p of ps) result.misses.push({ id: p.id, reason: "fetch failed" });
      continue;
    }
    for (const p of ps) {
      const found = findPrice(events, p.selection, prefBook);
      if (found) result.prices[p.id] = found;
      else result.misses.push({ id: p.id, reason: "selection not listed right now" });
    }
  }
  return result;
}

/* Implied win probability from american odds, for judging line movement. */
export function implied(odds) {
  const o = Number(odds);
  if (!o) return 0;
  return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
}
