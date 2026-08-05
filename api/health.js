import { kvConfigured } from "./_lib/kv.js";

/* Tells the client which server features are wired up, so the UI can
   show the members window only when accounts actually work. */

export default function handler(req, res) {
  res.status(200).json({
    api: true,
    kv: kvConfigured(),
    odds: !!process.env.ODDS_API_KEY,
  });
}
