import { kvConfigured } from "./_lib/kv.js";
import { sessionEmail, readBody } from "./_lib/auth.js";

/* Proxies the Anthropic API so one server-side key powers screenshot
   parsing, edge checks, and market checks on every device.
   When accounts are enabled, a signed-in session is required, so
   strangers visiting the site can't spend the owner's credits. */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "No ANTHROPIC_API_KEY set on Vercel." });

  if (kvConfigured()) {
    const email = await sessionEmail(req);
    if (!email) return res.status(401).json({ error: "Sign in to run AI checks on this site." });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(readBody(req)),
    });
    const data = await upstream.json().catch(() => null);
    return res.status(upstream.status).json(data || { error: "Upstream error " + upstream.status });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
