import type * as Party from "partykit/server";

type Player = {
  id: string;
  name: string;
  ready: boolean;
  mcap: number;
  x: number;
  y: number;
  finished: boolean;
};

type RoomState = {
  seed: number;
  targetMcap: number;
  players: Map<string, Player>;
  started: boolean;
  startsAt: number;     // server-clock ms when GO fires
  winnerId: string | null;
  createdAt: number;
};

const TARGET_MCAP_DEFAULT = 1_000_000;
const TARGET_MCAP_MIN = 50_000;
const TARGET_MCAP_MAX = 1_000_000_000;
const COUNTDOWN_MS = 3500; // ~3-2-1-GO
const ROOM_TTL_MS = 30 * 60 * 1000;

export default class RaceRoom implements Party.Server {
  state: RoomState;

  constructor(readonly room: Party.Room) {
    this.state = {
      seed: Math.floor(Math.random() * 0x7fffffff) | 0,
      targetMcap: TARGET_MCAP_DEFAULT,
      players: new Map(),
      started: false,
      startsAt: 0,
      winnerId: null,
      createdAt: Date.now(),
    };
  }

  static onBeforeConnect(req: Party.Request) {
    // public game — allow any origin to embed/connect
    return req;
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // First connect of an empty room may carry ?targetMcap to seed the lobby.
    if (this.state.players.size === 0 && this.state.winnerId === null) {
      try {
        const url = new URL(ctx.request.url);
        const tm = parseInt(url.searchParams.get("targetMcap") || "0", 10);
        if (Number.isFinite(tm) && tm >= TARGET_MCAP_MIN && tm <= TARGET_MCAP_MAX) {
          this.state.targetMcap = tm;
        }
      } catch {}
    }

    // Race already concluded or full → reject gracefully.
    if (this.state.winnerId) {
      conn.send(JSON.stringify({ type: "closed", reason: "race already finished" }));
      conn.close();
      return;
    }
    if (this.state.players.size >= 2 && !this.state.players.has(conn.id)) {
      conn.send(JSON.stringify({ type: "full" }));
      conn.close();
      return;
    }

    conn.send(JSON.stringify({
      type: "hello",
      youId: conn.id,
      seed: this.state.seed,
      targetMcap: this.state.targetMcap,
      roomId: this.room.id,
    }));
    this.broadcastState();
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }

    let p = this.state.players.get(sender.id);

    if (msg.type === "join") {
      if (this.state.players.size >= 2 && !p) return;
      const name = String(msg.name || "ANON").slice(0, 14).trim() || "ANON";
      if (!p) {
        p = { id: sender.id, name, ready: false, mcap: 0, x: 0, y: 0, finished: false };
        this.state.players.set(sender.id, p);
      } else {
        p.name = name;
      }
      this.broadcastState();
      return;
    }

    if (!p) return;

    if (msg.type === "ready") {
      p.ready = !!msg.ready;
      const all = [...this.state.players.values()];
      if (this.state.players.size === 2 && all.every(x => x.ready) && !this.state.started) {
        this.state.started = true;
        this.state.startsAt = Date.now() + COUNTDOWN_MS;
        this.broadcast({
          type: "start",
          seed: this.state.seed,
          targetMcap: this.state.targetMcap,
          startsAt: this.state.startsAt,
          serverNow: Date.now(),
        });
      }
      this.broadcastState();
      return;
    }

    if (msg.type === "tick") {
      // light validation — keep numbers numeric, clamp obvious garbage
      const x = Number.isFinite(msg.x) ? +msg.x : p.x;
      const y = Number.isFinite(msg.y) ? +msg.y : p.y;
      const mcap = Number.isFinite(msg.mcap) ? Math.max(0, +msg.mcap) : p.mcap;
      p.x = x; p.y = y; p.mcap = mcap;
      // relay to the other player only
      const payload = JSON.stringify({
        type: "tick", id: sender.id, x, y, mcap,
        vx: Number.isFinite(msg.vx) ? +msg.vx : 0,
        vy: Number.isFinite(msg.vy) ? +msg.vy : 0,
        camera: Number.isFinite(msg.camera) ? +msg.camera : 0,
        facing: msg.facing === -1 ? -1 : 1,
      });
      for (const c of this.room.getConnections()) {
        if (c.id !== sender.id) c.send(payload);
      }
      return;
    }

    if (msg.type === "finish") {
      if (this.state.winnerId) return;
      if (!this.state.started) return;
      if (p.mcap >= this.state.targetMcap) {
        this.state.winnerId = sender.id;
        p.finished = true;
        this.broadcast({
          type: "winner",
          id: sender.id,
          name: p.name,
          mcap: p.mcap,
          finishMs: Date.now() - this.state.startsAt,
        });
      }
      return;
    }

    if (msg.type === "ping") {
      sender.send(JSON.stringify({ type: "pong", t: msg.t, serverNow: Date.now() }));
      return;
    }
  }

  onClose(conn: Party.Connection) {
    if (!this.state.players.has(conn.id)) return;
    this.state.players.delete(conn.id);
    // If the race had started and the other player is now alone — declare them
    // the winner so the room doesn't hang.
    if (this.state.started && !this.state.winnerId) {
      const remaining = [...this.state.players.values()];
      if (remaining.length === 1) {
        const w = remaining[0];
        this.state.winnerId = w.id;
        w.finished = true;
        this.broadcast({
          type: "winner",
          id: w.id,
          name: w.name,
          mcap: w.mcap,
          reason: "opponent left",
          finishMs: Date.now() - this.state.startsAt,
        });
      }
    } else {
      this.broadcastState();
    }
  }

  broadcast(payload: object) {
    this.room.broadcast(JSON.stringify(payload));
  }

  broadcastState() {
    this.broadcast({
      type: "state",
      players: [...this.state.players.values()].map(p => ({
        id: p.id, name: p.name, ready: p.ready, mcap: p.mcap, finished: p.finished,
      })),
      seed: this.state.seed,
      targetMcap: this.state.targetMcap,
      started: this.state.started,
      startsAt: this.state.startsAt,
      winnerId: this.state.winnerId,
    });
  }
}
