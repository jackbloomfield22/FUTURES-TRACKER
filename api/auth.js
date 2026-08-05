import { kv, kvConfigured } from "./_lib/kv.js";
import {
  normEmail, hashPassword, verifyPassword,
  createSession, sessionEmail, destroySession, readBody,
} from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!kvConfigured()) {
    return res.status(503).json({ error: "Accounts aren't set up yet: connect a Redis database to this project in Vercel, then redeploy." });
  }

  const body = readBody(req);
  const action = body.action;
  const email = normEmail(body.email);
  const password = body.password;

  try {
    if (action === "signup") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
      if (!password || String(password).length < 8) return res.status(400).json({ error: "Password needs at least 8 characters." });
      if (await kv.get("user:" + email)) return res.status(409).json({ error: "That email already has a book. Sign in instead." });
      const { salt, hash } = hashPassword(password);
      await kv.set("user:" + email, JSON.stringify({ salt, hash, createdAt: Date.now() }));
      const token = await createSession(email);
      return res.status(200).json({ token, email });
    }

    if (action === "login") {
      const raw = await kv.get("user:" + email);
      if (!raw) return res.status(401).json({ error: "No account with that email. Open one instead." });
      const user = JSON.parse(raw);
      if (!verifyPassword(password, user.salt, user.hash)) return res.status(401).json({ error: "Wrong password." });
      const token = await createSession(email);
      return res.status(200).json({ token, email });
    }

    if (action === "logout") {
      await destroySession(req);
      return res.status(200).json({ ok: true });
    }

    if (action === "session") {
      const current = await sessionEmail(req);
      return res.status(200).json({ email: current || null });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
