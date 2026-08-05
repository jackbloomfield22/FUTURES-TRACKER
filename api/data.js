import { kv, kvConfigured } from "./_lib/kv.js";
import { sessionEmail, readBody } from "./_lib/auth.js";

/* Per-account key-value storage. Mirrors the client store interface
   (get / set / delete / list) so the app code doesn't change shape.
   Keys are namespaced per account: u:{email}:{key} */

const MAX_KEY = 200;
const MAX_VALUE = 900 * 1024; // stay under Upstash's 1MB request ceiling

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!kvConfigured()) return res.status(503).json({ error: "Storage isn't set up: connect a Redis database in Vercel." });

  const email = await sessionEmail(req);
  if (!email) return res.status(401).json({ error: "Signed out. Sign in again to reach your book." });

  const { op, key, value, prefix } = readBody(req);
  const ns = "u:" + email + ":";

  try {
    if (op === "get") {
      if (!key || key.length > MAX_KEY) return res.status(400).json({ error: "Bad key" });
      const v = await kv.get(ns + key);
      return res.status(200).json({ result: v === null ? null : { key, value: v } });
    }
    if (op === "set") {
      if (!key || key.length > MAX_KEY) return res.status(400).json({ error: "Bad key" });
      if (typeof value !== "string" || value.length > MAX_VALUE) {
        return res.status(413).json({ error: "That record is too large to sync (slips over ~900KB stay on-device)." });
      }
      await kv.set(ns + key, value);
      return res.status(200).json({ result: { key, value } });
    }
    if (op === "delete") {
      if (!key || key.length > MAX_KEY) return res.status(400).json({ error: "Bad key" });
      await kv.del(ns + key);
      return res.status(200).json({ result: { key, deleted: true } });
    }
    if (op === "list") {
      const keys = await kv.keys(ns + (prefix || "") + "*");
      return res.status(200).json({ result: { keys: (keys || []).map((k) => k.slice(ns.length)) } });
    }
    return res.status(400).json({ error: "Unknown op" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
