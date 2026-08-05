# Futures Book

Personal sports futures ledger. Screenshot a slip and AI parses it into a ticket; the book tracks open positions, live prices, edge reads, settlements, win cascades across mutually exclusive markets, and season history with net P/L and ROI.

Live at: your Vercel deployment. Repo is the source of truth; pushes to `main` auto-deploy.

## Architecture

```
src/
  FuturesBook.jsx   the app
  AuthGate.jsx      sign in / open an account / device-only gate
  lib/store.js      storage seam: artifact | cloud | device backends
  lib/cloud.js      client for the /api functions
  lib/odds.js       live odds fetch, market mapping, name matching
api/                Vercel serverless functions (zero dependencies)
  auth.js           signup / login / logout / session
  data.js           per-account key-value storage (namespaced in Redis)
  odds.js           The Odds API proxy with 6h Redis cache
  health.js         reports which server features are configured
```

The app degrades gracefully: with no backend configured it runs exactly as before on device localStorage, no login shown. Each server feature turns on when its config exists.

## One-time Vercel setup

1. **Accounts + sync:** Vercel project > Storage tab > Create Database > **Redis** (Upstash, via Marketplace). Connect it to this project. That injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically. Redeploy. The members window appears and accounts work.
2. **Live odds:** grab a free key at [the-odds-api.com](https://the-odds-api.com) (500 credits/month). Vercel > Settings > Environment Variables > add `ODDS_API_KEY`. Redeploy. Responses cache in Redis for 6 hours, so the free tier is plenty.

No other configuration. The serverless functions have zero npm dependencies.

## Accounts and data

- Passwords are scrypt-hashed with per-user salts; sessions are random tokens with a 30-day TTL in Redis.
- All account data lives under `u:{email}:*` keys.
- First sign-in on a device that already has a book imports those tickets to the account (cloud data wins if both exist).
- "Skip: keep my book on this device only" runs the app on localStorage, same as before accounts existed.

## Live odds coverage

Prices come from The Odds API `outrights` markets, quoted at one book of record (FanDuel by default, switchable in Live odds settings). Mapped today: NFL Super Bowl, NBA/NHL championship, MLB World Series, NCAA titles, golf majors. **Award futures (MVP, Cy Young, ROY) have no public feed there**; those tickets say so honestly, and the AI Edge check covers them instead. To extend coverage, add a rule to `RULES` in `src/lib/odds.js`.

## Local dev

```
npm install
npm run dev        # UI only; /api functions need `vercel dev` + .env (see .env.example)
```

## Working on this repo

Built and updated with Claude. Preferred loop: open the folder in Claude Code (or point a cloud session at this repo), describe the change, let it commit and push. Vercel deploys `main` automatically and gives every branch its own preview URL.
