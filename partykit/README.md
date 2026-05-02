# chungus-jumper-race · partykit room

PartyKit (Cloudflare Durable Objects) backend for 1v1 race rooms.

## Deploy

```sh
cd partykit
npm install
npx partykit login        # one-time
npx partykit deploy
```

The CLI prints a host like `chungus-jumper-race.<your-name>.partykit.dev`.
Either:
- update `PARTYKIT_HOST` in `index.html`, OR
- add `<meta name="partykit-host" content="chungus-jumper-race.<your-name>.partykit.dev">` to `index.html` `<head>`

## Local dev

```sh
npx partykit dev
# serves on ws://localhost:1999
```

`index.html` auto-uses `localhost:1999` when served on `localhost` / `127.0.0.1`.

## Protocol (informational)

- Client → server: `{type:"join", name}` · `{type:"ready", ready:bool}` · `{type:"tick", x,y,vx,vy,camera,facing,mcap}` · `{type:"finish"}`
- Server → client: `{type:"hello", youId, seed, targetMcap, roomId}` · `{type:"state", players[], started, startsAt, winnerId, ...}` · `{type:"start", seed, targetMcap, startsAt, serverNow}` · `{type:"tick", id, x,y,vx,vy,camera,facing,mcap}` (relayed) · `{type:"winner", id, name, mcap, finishMs}` · `{type:"full"}` · `{type:"closed", reason}`

Server picks `seed` on room creation; both clients call `setRng(seed)` before `reset()` so platforms / coins / fillers spawn identically. Ticks are relayed at ~30Hz between the two players. Finish is server-validated (server checks `mcap >= targetMcap` before accepting).
