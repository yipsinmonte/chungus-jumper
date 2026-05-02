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
- `partykit/` — 1v1 race backend (PartyKit / Cloudflare Durable Objects)

## 1v1 race

Title screen → **1V1 RACE** → pick target mcap → share the room link. Both clients seed from the same RNG; the canvas is locked to a 480×800 virtual world during a race so spawn fns produce byte-identical platforms across screens. Ghost is rendered translucent in the same chungus sprite size as the local player, with linear extrapolation between 50Hz ticks for smooth motion.

To enable, deploy the `partykit/` backend (see `partykit/README.md`) and either edit `PARTYKIT_HOST` in `index.html` or drop a `<meta name="partykit-host" content="…">` in the `<head>`.

### Embedding on your own site

```html
<iframe id="chungus-game"
        src="https://chungus-jumper.vercel.app/"
        width="100%" height="700"
        allow="autoplay; fullscreen; clipboard-write"
        style="border:0;"></iframe>
<script>
  // Forward ?room=ABC from the parent URL into the iframe so share links
  // like https://chungus.site/game/?room=ABC auto-join the lobby.
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    const iframe = document.getElementById('chungus-game');
    function send() { iframe.contentWindow.postMessage({ type: 'chungus-room', code: room }, '*'); }
    iframe.addEventListener('load', send);
    window.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'chungus-ready') send();
    });
  }
</script>
```

The iframe also exposes a `share-base` override so links it generates point at your own URL:

```html
<meta name="share-base" content="https://chungus.site/game/">
```
…but the default is already `https://chungus.site/game/`, so no action needed if that's the canonical embed location.

## Global leaderboard (Vercel KV setup)

Once the project is deployed on Vercel, enable persistent global scores:

1. Vercel project → **Storage** tab → **Create Database** → pick **Upstash for Redis** (free tier)
2. Connect it to this project — Vercel auto-injects `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` env vars
3. Redeploy (or push any commit) — `@vercel/kv` picks up the env vars automatically
4. Test: play a run, refresh title screen — your name should appear on the leaderboard from any other browser/device

The leaderboard panel hits `/api/leaderboard` on title screen + after every game over. Top 10 globally, ranked by mcap. The leaderboard polls every 30s while you're on the title screen so new scores appear in near real-time.

If KV isn't set up yet (or the API errors), the game gracefully falls back to a localStorage cache so it still works locally.
