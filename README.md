# 🐰 chungus jumper

Climb the bonding curve. Eat the buys. Dodge the dumps. Don't get sat on.

Single-file HTML5 canvas game. No build step.

## Run locally

```sh
open index.html
# or any static server
python3 -m http.server 8080
```

## Deploy

Static site — works on Vercel, Netlify, GitHub Pages, anywhere. Vercel auto-detects and deploys with zero config.

## Files

- `index.html` — the game (HTML + CSS + JS, single file)
- `chungus.png` — the man himself
- `wincard.jpg` — game-over win card background
- `bg-zone-{1,2,3,4}.png` — themed zone backgrounds
- `api/score.js` + `api/leaderboard.js` — global leaderboard endpoints
- `package.json` — declares `@vercel/kv` for the API

## Global leaderboard (Vercel KV setup)

Once the project is deployed on Vercel, enable persistent global scores:

1. Vercel project → **Storage** tab → **Create Database** → pick **Upstash for Redis** (free tier)
2. Connect it to this project — Vercel auto-injects `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` env vars
3. Redeploy (or push any commit) — `@vercel/kv` picks up the env vars automatically
4. Test: play a run, refresh title screen — your name should appear on the leaderboard from any other browser/device

The leaderboard panel hits `/api/leaderboard` on title screen + after every game over. Top 10 globally, ranked by mcap. The leaderboard polls every 30s while you're on the title screen so new scores appear in near real-time.

If KV isn't set up yet (or the API errors), the game gracefully falls back to a localStorage cache so it still works locally.
