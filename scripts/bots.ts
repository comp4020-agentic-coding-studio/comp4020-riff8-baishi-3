#!/usr/bin/env node
// Headless playtest: N bots make characters, walk to the fields, fight, form
// a party, loot and trade, for a few minutes, against a running server. It
// plays through the same HTTP API and SSE stream a browser does, then prints
// pacing numbers for docs/TESTING.md.
//
//   node scripts/bots.ts [--url http://localhost:8080] [--bots 3] [--minutes 4] [--solo] [--mvp-level 6]
//
// --solo keeps every bot out of parties, for comparing solo against party
// pacing. Bots never use the test hooks: what they see is what a player sees.

import { MAPS, MONSTERS, dist, type JobId, type MonsterId } from "../src/game/data.ts";
import { findPath } from "../src/game/path.ts";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("url", "http://localhost:8080");
const COUNT = Number(arg("bots", "3"));
const MINUTES = Number(arg("minutes", "4"));
const SOLO = process.argv.includes("--solo");
// a party whose every member has reached this level goes after the MVP too
const MVP_LEVEL = Number(arg("mvp-level", "6"));
const JOBS: JobId[] = ["warden", "ember", "mender", "warden"];

interface Ent {
  k: string;
  id: string | number;
  x: number;
  y: number;
  [k: string]: unknown;
}

const stats = {
  firstLevelUpMs: [] as number[],
  firstRareMs: null as number | null,
  deaths: 0,
  kills: 0,
  rejects: new Map<string, number>(),
  errors: 0,
  intents: 0,
  trades: 0,
  levels: [] as number[],
};
const started = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Bot {
  cookie = "";
  pid = "";
  me: Record<string, any> = {};
  map = "town";
  ents = new Map<string, Ent>();
  name: string;
  firstLevel = false;
  abort = new AbortController();

  job: JobId;

  constructor(job: JobId, i: number) {
    this.job = job;
    this.name = `Bot${i}${Math.random().toString(36).slice(2, 6)}`;
  }

  async start(): Promise<void> {
    const res = await fetch(`${BASE}/api/character`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: this.name, job: this.job }),
    });
    if (res.status !== 201) throw new Error(`create ${this.name}: ${res.status} ${await res.text()}`);
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    this.pid = (await res.json()).me.pid;
    void this.stream();
  }

  async stream(): Promise<void> {
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/stream`, { headers: { cookie: this.cookie }, signal: this.abort.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            this.handle(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        if (this.abort.signal.aborted) return;
      }
      await sleep(1000);
    }
  }

  handle(chunk: string): void {
    const ev = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!ev || !data) return;
    const d = JSON.parse(data);
    if (ev === "snapshot") {
      this.ents.clear();
      this.map = d.map;
      for (const e of d.ents) this.ents.set(`${e.k}:${e.id}`, e);
    } else if (ev === "delta") {
      for (const e of d.ents) this.ents.set(`${e.k}:${e.id}`, e);
      for (const k of d.gone) this.ents.delete(k);
    } else if (ev === "me") {
      if (this.me.level && d.level > this.me.level && !this.firstLevel) {
        this.firstLevel = true;
        stats.firstLevelUpMs.push(Date.now() - started);
      }
      if (this.me.dead === false && d.dead) stats.deaths++;
      this.me = d;
    } else if (ev === "announce" && stats.firstRareMs === null && /Card/.test(d.text)) {
      stats.firstRareMs = Date.now() - started;
    }
  }

  async act(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, any>> {
    stats.intents++;
    const res = await fetch(`${BASE}/api/act`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify({ type, cmd: crypto.randomUUID(), ...fields }),
    });
    const body = await res.json();
    if (res.status >= 500) stats.errors++;
    else if (!body.ok) {
      const key = `${type}: ${String(body.error).replace(/\d+(\.\d+)?/g, "N")}`;
      stats.rejects.set(key, (stats.rejects.get(key) ?? 0) + 1);
    }
    return body;
  }

  get you(): Ent | undefined {
    return this.ents.get(`p:${this.pid}`);
  }

  async walkTo(x: number, y: number): Promise<void> {
    const you = this.you;
    if (!you) return;
    const path = findPath(MAPS[this.map as keyof typeof MAPS], you.x, you.y, x, y, 4000);
    if (!path?.length) return;
    // long routes go in hops; the server caps one move at 60 steps
    const hop = path[Math.min(path.length - 1, 40)];
    await this.act("move", { x: hop[0], y: hop[1] });
  }

  async tick(friends: Bot[]): Promise<void> {
    const you = this.you;
    if (!you || !this.me.derived) return;
    if (this.me.dead) {
      await this.act("respawn");
      return;
    }
    if (this.me.tradeInvite) {
      await this.act("trade_accept", { from: this.me.tradeInvite.from });
      return;
    }
    if (this.me.trade) {
      const t = this.me.trade;
      const potion = this.me.inventory.find((r: any) => r.item === "red_potion" && !r.equipped);
      if (t.mine.items.length === 0 && t.mine.zeny === 0 && potion && this.job === "warden") {
        await this.act("trade_offer", { items: [{ id: potion.id, qty: 1 }], zeny: 0 });
      } else if (t.mine.zeny === 0 && t.mine.items.length === 0 && this.job !== "warden") {
        await this.act("trade_offer", { items: [], zeny: 10 });
      } else if (!t.iConfirmed) {
        const r = await this.act("trade_confirm", { version: t.version });
        if (r.done) stats.trades++;
      }
      return;
    }
    if (this.me.partyInvites?.length) {
      await this.act("party_join", { party: this.me.partyInvites[0].id });
      return;
    }
    if (this.map === "town") {
      const gate = MAPS.town.portals[0];
      await this.walkTo(gate.x, gate.y);
      return;
    }
    if (this.map !== "field") return;

    const leader = friends[0];
    if (!SOLO && this === leader && !this.me.party) {
      await this.act("party_create", { name: `Bots ${this.name}` });
      return;
    }
    if (!SOLO && this === leader && this.me.party) {
      for (const f of friends) {
        if (f !== this && !f.me.party && f.map === this.map && !f.me.partyInvites?.length) await this.act("party_invite", { target: f.pid });
      }
    }
    // a trade every couple of minutes between the leader and the next bot
    if (!SOLO && this === leader && friends[1] && friends[1].map === this.map && Math.random() < 0.01) {
      const f = friends[1].you;
      if (f && dist(f.x, f.y, you.x, you.y) <= 3) await this.act("trade_request", { target: friends[1].pid });
    }
    // potions when low
    if (this.me.hp < this.me.derived.maxHp * 0.35) {
      const potion = this.me.inventory.find((r: any) => r.item === "red_potion");
      if (potion) await this.act("use", { item: potion.id });
    }
    // menders heal the hurtest friend in reach
    if (this.job === "mender") {
      const hurt = friends.filter((f) => f.map === this.map && f.me.derived && !f.me.dead && f.me.hp < f.me.derived.maxHp * 0.7)
        .sort((a, b) => a.me.hp / a.me.derived.maxHp - b.me.hp / b.me.derived.maxHp)[0];
      if (hurt && !this.me.cooldowns?.heal && !this.me.casting && this.me.sp >= 12) {
        const h = hurt.you;
        if (h && dist(h.x, h.y, you.x, you.y) <= 6) {
          await this.act("skill", { skill: "heal", target: hurt.pid });
          return;
        }
        if (h) await this.walkTo(h.x, h.y);
        return;
      }
    }
    // loot I own, or free loot, close by
    for (const e of this.ents.values()) {
      if (e.k === "i" && (e.owner === this.pid || !e.owner || (e.ownMs as number) <= 0) && dist(e.x, e.y, you.x, you.y) <= 4) {
        if (dist(e.x, e.y, you.x, you.y) <= 1) await this.act("pickup", { item: e.id });
        else await this.walkTo(e.x, e.y);
        return;
      }
    }
    // hurt with no potion: back off toward the gate and let regen work
    const potions = this.me.inventory.some((r: any) => r.item === "red_potion");
    if (!potions && this.me.hp < this.me.derived.maxHp * 0.4 && this.job !== "mender") {
      const [sx, sy] = MAPS.field.start;
      if (dist(you.x, you.y, sx + 2, sy) > 1) await this.walkTo(sx + 2, sy);
      else await this.act("stop");
      return;
    }
    // fight: the party's target, or the nearest weak monster; until the
    // party is strong enough, keep well away from an MVP's lair
    const bold = !SOLO && friends.every((f) => (f.me.level ?? 1) >= MVP_LEVEL);
    const mvps = [...this.ents.values()].filter((e) => e.k === "m" && MONSTERS[e.type as MonsterId].ai === "mvp");
    const monsters = [...this.ents.values()].filter((e) => e.k === "m" && (bold || (MONSTERS[e.type as MonsterId].ai !== "mvp" && !mvps.some((v) => dist(v.x, v.y, e.x, e.y) <= 6))));
    const shared = SOLO ? undefined : monsters.find((m) => friends.some((f) => f !== this && f.lastTarget === m.id));
    const target = shared ?? monsters.sort((a, b) => dist(a.x, a.y, you.x, you.y) - dist(b.x, b.y, you.x, you.y))[0];
    if (!target) return;
    this.lastTarget = target.id as number;
    const d = dist(target.x, target.y, you.x, you.y);
    if (this.job === "ember") {
      if (d <= 6 && !this.me.casting && this.me.sp >= 10) {
        const t = MONSTERS[target.type as MonsterId];
        const skill = t.element === "fire" ? "frost_lance" : "firebolt";
        if (!this.me.cooldowns?.[skill]) await this.act("skill", { skill, target: target.id });
      } else if (d > 6) await this.walkTo(target.x, target.y);
      else if (this.me.sp < 10) await this.act("attack", { target: target.id });
      return;
    }
    if (this.job === "warden" && d <= 1 && !this.me.cooldowns?.bash && this.me.sp >= 8) {
      await this.act("skill", { skill: "bash", target: target.id });
      return;
    }
    if (d <= 10) await this.act("attack", { target: target.id });
    else await this.walkTo(target.x, target.y);
  }
  lastTarget: number | null = null;
}

async function main(): Promise<void> {
  const bots = Array.from({ length: COUNT }, (_, i) => new Bot(JOBS[i % JOBS.length], i));
  for (const b of bots) await b.start();
  console.log(`${COUNT} bots (${bots.map((b) => b.job).join(", ")}) for ${MINUTES} min against ${BASE}${SOLO ? ", solo" : ""}`);
  const end = Date.now() + MINUTES * 60_000;
  while (Date.now() < end) {
    await Promise.all(bots.map((b) => b.tick(bots).catch(() => stats.errors++)));
    await sleep(450);
  }
  for (const b of bots) {
    stats.levels.push(b.me.level);
    b.abort.abort();
  }
  const kills = await fetch(`${BASE}/api/test`, { method: "POST", body: JSON.stringify({ op: "audit" }), headers: { "content-type": "application/json" } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  console.log(JSON.stringify({
    minutes: MINUTES,
    firstLevelUpSec: stats.firstLevelUpMs.map((m) => Math.round(m / 1000)),
    firstCardSec: stats.firstRareMs === null ? null : Math.round(stats.firstRareMs / 1000),
    deaths: stats.deaths,
    levels: stats.levels,
    trades: stats.trades,
    intents: stats.intents,
    serverErrors: stats.errors,
    topRejects: [...stats.rejects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    audit: kills?.audit ?? "test hooks off",
  }, null, 2));
  process.exit(0);
}

void main();
