import type * as Party from "partykit/server";

// Public-lobby party — tracks rooms whose creator opted in to a public
// listing. Race rooms themselves are unaware of public/private; the
// creator's client decides and registers here.

type Entry = {
  id: string;
  host: string;
  targetMcap: number;
  mobile: boolean;
  createdAt: number;
  lastSeen: number;
};

const TTL_MS = 75_000;       // entry expires if no heartbeat within this window
const MAX_LIST = 25;         // most-recent-N visible

export default class LobbyRoom implements Party.Server {
  entries = new Map<string, Entry>();
  // conn.id → entry id (so we can clean up when a creator disconnects)
  registrations = new Map<string, string>();

  constructor(readonly room: Party.Room) {}

  static onBeforeConnect(req: Party.Request) {
    return req;
  }

  prune(): boolean {
    const now = Date.now();
    let pruned = false;
    for (const [id, e] of this.entries) {
      if (now - e.lastSeen > TTL_MS) {
        this.entries.delete(id);
        pruned = true;
      }
    }
    return pruned;
  }

  list(): Entry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_LIST);
  }

  broadcastList() {
    this.room.broadcast(JSON.stringify({ type: "list", entries: this.list() }));
  }

  onConnect(conn: Party.Connection) {
    if (this.prune()) {/* changed list will be sent below */}
    conn.send(JSON.stringify({ type: "list", entries: this.list() }));
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: any;
    try { msg = JSON.parse(message); } catch { return; }
    const changed = this.prune();

    if (msg.type === "register") {
      const id = String(msg.id || "").slice(0, 16).toUpperCase();
      if (!/^[A-Z0-9]{4,16}$/.test(id)) return;
      const host = String(msg.host || "ANON").slice(0, 14) || "ANON";
      const tm = Number(msg.targetMcap);
      if (!Number.isFinite(tm) || tm < 50_000 || tm > 1_000_000_000) return;
      const mobile = !!msg.mobile;
      const now = Date.now();
      // If another connection already registered the same id, replace it.
      // Drop the previous owner's reservation.
      for (const [cid, eid] of this.registrations) {
        if (eid === id && cid !== sender.id) this.registrations.delete(cid);
      }
      this.entries.set(id, { id, host, targetMcap: tm, mobile, createdAt: now, lastSeen: now });
      this.registrations.set(sender.id, id);
      this.broadcastList();
      return;
    }

    if (msg.type === "heartbeat") {
      const id = this.registrations.get(sender.id);
      if (id && this.entries.has(id)) {
        this.entries.get(id)!.lastSeen = Date.now();
      }
      if (changed) this.broadcastList();
      return;
    }

    if (msg.type === "unregister") {
      const id = this.registrations.get(sender.id);
      if (id) {
        this.entries.delete(id);
        this.registrations.delete(sender.id);
        this.broadcastList();
      }
      return;
    }

    if (msg.type === "refresh") {
      sender.send(JSON.stringify({ type: "list", entries: this.list() }));
      return;
    }

    if (changed) this.broadcastList();
  }

  onClose(conn: Party.Connection) {
    const id = this.registrations.get(conn.id);
    if (id) {
      this.entries.delete(id);
      this.registrations.delete(conn.id);
      this.broadcastList();
    }
  }
}
