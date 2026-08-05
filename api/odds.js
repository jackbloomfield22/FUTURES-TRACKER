import { kv, kvConfigured } from "./_lib/kv.js";

/* Proxies The Odds API so the key stays server-side, and caches each
   sport's board in Redis for 6 hours. Futures move slowly; this keeps
   the free 500 credits/month plan comfortable. Add ?fresh=1 to bypass. */

const TTL = 6 * 60 * 60;

export default async function handler(req, res) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "No ODDS_API_KEY set on Vercel yet." });

  const sport = String((req.query && req.query.sport) || "");
  if (!/^[a-z0-9_]+$/.test(sport)) return res.status(400).json({ error: "Bad sport key" });

  const cacheKey = "odds:" + sport;
  const fresh = req.query && req.query.fresh === "1";

  try {
    if (kvConfigured() && !fresh) {
      const hit = await kv.get(cacheKey);
      if (hit) return res.status(200).json({ cached: true, events: JSON.parse(hit) });
    }

    const url = "https://api.the-odds-api.com/v4/sports/" + sport +
      "/odds?apiKey=" + encodeURIComponent(apiKey) + "&regions=us&markets=outrights&oddsFormat=american";
    const upstream = await fetch(url);
    const events = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: (events && events.message) || "Odds provider error " + upstream.status });
    }

    if (kvConfigured()) {
      try { await kv.setex(cacheKey, TTL, JSON.stringify(events)); } catch (e) { /* cache is optional */ }
    }
    return res.status(200).json({
      cached: false,
      events,
      remaining: upstream.headers.get("x-requests-remaining"),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
