# Futures Book

A personal sports futures ticket ledger. Drop a screenshot of a bet slip and AI reads it into a ticket. Track open positions as split legs, run live edge checks against current market odds, settle markets with one tap (one winner auto-resolves the rest), and keep season-by-season money history.

## Features

- **Slip intake**: drop, paste, or browse a screenshot of any sportsbook slip or bet-history list. Claude vision extracts book, market, selection, odds, stake, and status for every bet on screen. Manual entry and JSON paste-import also supported.
- **Split-leg tracking**: multiple tickets on the same pick stay individual legs so you can cash one out early and ride the rest. Leg numbering, per-leg cash out, and market cards that show realized money alongside open risk.
- **Edge check / Market check**: live web search for current odds on your picks, compared against your entry price, with a rough fair cash-out and a HOLD / TRIM / SELL lean. Market check values every leg in a market and says which to cash vs ride.
- **Win cascade**: mark a ticket Won and every other open ticket in that market resolves automatically (same pick wins, the rest go to lost). One MVP per season. Parlays excluded. Undo available.
- **Money tracking**: Markets tab shows per-market performance, settled and open. History tab groups by season with W-L-CO record, staked, net, and ROI. League and bet-type filter chips are generated from your data, so new leagues and award types become filterable instantly.
- **Slip archive**: every screenshot you drop is compressed and archived with its ticket.
- **Backup and restore**: export the entire book as a JSON code; restore merges by ticket so nothing duplicates.

## Run it

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Output lands in `dist/`.

## Deploy (Netlify)

Either drag the `dist/` folder into Netlify, or connect this repo with:

- Build command: `npm run build`
- Publish directory: `dist`

## AI features and the API key

Standalone, the app calls the Anthropic API directly from the browser. Open the **+ New ticket** tab, scroll to **AI settings**, and paste an Anthropic API key (create one at console.anthropic.com). The key is stored in your browser's localStorage only and is sent nowhere except api.anthropic.com. API usage is billed to your key; slip parses and edge checks each cost fractions of a cent to a few cents.

Without a key, everything except AI parsing and edge checks still works: manual entry, paste-import, settling, markets, history, backup.

## Data

All data lives in your browser's localStorage (`futures-ledger-v1` plus `slip:*` keys for archived screenshots). It persists across sessions on the same device and browser. Use Backup and restore to move between devices.

The same component also runs as a Claude artifact, where it uses Claude's artifact storage and keyless API access automatically.
