// The referee. Holds the live world in memory (who's online, monsters, loot on
// the ground), advances it on a fixed tick, and is the only place an outcome
// is decided. Clients only ever submit intents; every intent waits in one
// queue and is applied, in arrival order, at the start of the next tick, so
// no two intents interleave halfway. Anything involving items or zeny is
// written to SQLite inside the intent, in one transaction.

import { createHash, randomUUID } from "node:crypto";
import {
  CAPS, EMOTES, ITEMS, JOBS, MAPS, MONSTERS, SHOP_STOCK, SKILLS, dist, portalAt, walkable,
  type BuffId, type ItemId, type JobId, type MapId, type MonsterId, type SkillId, type Spawn, type Stats,
} from "../game/data.ts";
import { findPath, type Step } from "../game/path.ts";
import {
  MAX_REFINE, MAX_STAT, SAFE_REFINE, deathPenalty, derive, gainXp, healAmount, isStat, magicDamage,
  physicalDamage, refineChance, refineCost, splitXp, statCost, type Derived, type EquipView,
} from "../game/rules.ts";
import * as store from "./db.ts";
import { GameError, tx } from "./db.ts";
import { log, shortHash, who } from "./log.ts";
import { roll } from "./rng.ts";

export const TICK_MS = 200;
export const OWN_MS = 6000;
export const GROUND_MS = 60_000;
const OFFLINE_GRACE_MS = 20_000;
const SAVE_EVERY_MS = 10_000;
const REGEN_EVERY_MS = 3000;
const INVITE_MS = 60_000;
const NPC_REACH = 3;
const TRADE_REACH = 3;
const VIEW_RANGE = 10;
const LEASH = 12;
const MVP_LEASH = 6;
const RATE_PER_SEC = 12;
const BURST = 30;
const CMD_MEMORY = 200;

type Send = (chunk: string) => void;
export interface Result {
  status: number;
  body: Record<string, unknown>;
}

export interface Player {
  id: string;
  pid: string;
  name: string;
  job: JobId;
  level: number;
  xp: number;
  jobLevel: number;
  jobXp: number;
  stats: Stats;
  statPoints: number;
  skillPoints: number;
  skills: SkillId[];
  map: MapId;
  x: number;
  y: number;
  hp: number;
  sp: number;
  partyId: number | null;
  guildId: number | null;
  path: Step[];
  attackTarget: number | null;
  casting: { skill: SkillId; target: string | number | null; endsAt: number } | null;
  nextAttackAt: number;
  cooldowns: Partial<Record<SkillId, number>>;
  buffs: Partial<Record<BuffId, number>>;
  dead: boolean;
  sends: Set<Send>;
  lastActive: number;
  lastSaved: number;
  regenAt: number;
  dirtyMe: boolean;
  cmds: Map<string, Promise<Result>>;
  tokens: number;
  tokenAt: number;
  lastRateLog: number;
  derived: Derived;
  weight: number;
  partyInvites: Map<number, number>;
  guildInvites: Map<number, number>;
  tradeInvite: { from: string; until: number } | null;
  trade: Trade | null;
  walkStart: [number, number] | null;
  lastMoveLog: number;
}

interface Monster {
  id: number;
  type: MonsterId;
  map: MapId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  respawnAt: number;
  spawn: Spawn | null;
  target: string | null;
  nextMoveAt: number;
  nextAttackAt: number;
  damage: Map<string, number>;
  still: boolean;
  homeX: number;
  homeY: number;
}

interface Ground {
  id: number;
  map: MapId;
  x: number;
  y: number;
  item: ItemId;
  qty: number;
  owner: string | null;
  ownerTag: string | null;
  ownUntil: number;
  expires: number;
}

interface Offer {
  items: { id: number; qty: number }[];
  zeny: number;
}
interface Trade {
  a: string;
  b: string;
  offers: Record<string, Offer>;
  confirmed: Set<string>;
  version: number;
}

interface StallView {
  charId: string;
  pid: string;
  name: string;
  title: string;
  map: MapId;
  x: number;
  y: number;
}

interface MapState {
  id: MapId;
  seq: number;
  players: Set<Player>;
  monsters: Map<number, Monster>;
  ground: Map<number, Ground>;
  dirty: Set<string>;
  gone: Set<string>;
  fx: Record<string, unknown>[];
  noRespawn: boolean;
}

// ---------- state ----------

const players = new Map<string, Player>(); // by character id
const byPid = new Map<string, string>(); // public id -> character id
const stalls = new Map<string, StallView>(); // by pid
const maps = new Map<MapId, MapState>();
const queue: { p: Player; body: Record<string, unknown>; resolve: (r: Result) => void }[] = [];
let nextMonsterId = 1;
let nextGroundId = 1;
export const counters = { mvpKills: 0, mvpRewards: 0, kills: 0 };

export const publicId = (charId: string): string => createHash("sha256").update("pid:" + charId).digest("hex").slice(0, 10);

const tag = (p: { name: string; id: string }): string => who(p);
const mtag = (m: Monster): string => `${MONSTERS[m.type].name}#${m.id}`;

class Refusal extends Error {
  constructor(public status: number, public reason: string) {
    super(reason);
  }
}
// A function declaration, not an arrow, so TypeScript narrows after a call.
function refuse(status: number, reason: string): never {
  throw new Refusal(status, reason);
}

function mapState(id: MapId): MapState {
  return maps.get(id)!;
}

function resetMaps(): void {
  maps.clear();
  for (const id of Object.keys(MAPS) as MapId[]) {
    maps.set(id, { id, seq: 0, players: new Set(), monsters: new Map(), ground: new Map(), dirty: new Set(), gone: new Set(), fx: [], noRespawn: false });
  }
  for (const id of Object.keys(MAPS) as MapId[]) {
    for (const s of MAPS[id].spawns) for (let i = 0; i < s.count; i++) spawnMonster(id, s.monster, s, null, null);
  }
  stalls.clear();
  for (const s of store.allStalls()) {
    const pid = publicId(s.charId);
    byPid.set(pid, s.charId);
    stalls.set(pid, { ...s, pid });
  }
}

function randomTileIn(map: MapId, zone: [number, number, number, number]): [number, number] {
  const m = MAPS[map];
  for (let i = 0; i < 200; i++) {
    const x = zone[0] + Math.floor(Math.random() * (zone[2] - zone[0] + 1));
    const y = zone[1] + Math.floor(Math.random() * (zone[3] - zone[1] + 1));
    if (walkable(m, x, y) && !portalAt(m, x, y)) return [x, y];
  }
  return m.start;
}

function spawnMonster(map: MapId, type: MonsterId, spawn: Spawn | null, at: [number, number] | null, opts: { hp?: number; still?: boolean } | null): Monster {
  const ms = mapState(map);
  if (ms.monsters.size >= CAPS.monstersPerMap) {
    // the cap holds: evict the oldest dead monster slot, or refuse
    const dead = [...ms.monsters.values()].find((m) => m.dead);
    if (!dead) throw new GameError(503, "this map is full of monsters");
    ms.monsters.delete(dead.id);
  }
  const def = MONSTERS[type];
  const [x, y] = at ?? randomTileIn(map, spawn!.zone);
  const m: Monster = {
    id: nextMonsterId++, type, map, x, y, hp: opts?.hp ?? def.hp, maxHp: def.hp, dead: false, respawnAt: 0, spawn,
    target: null, nextMoveAt: 0, nextAttackAt: 0, damage: new Map(), still: opts?.still ?? false, homeX: x, homeY: y,
  };
  ms.monsters.set(m.id, m);
  ms.dirty.add("m:" + m.id);
  if (def.ai === "mvp") {
    log("mvp", `${mtag(m)} has appeared in ${MAPS[map].name}`);
    announce(`${def.name} has appeared in ${MAPS[map].name}!`, "mvp");
  }
  return m;
}

// ---------- views ----------

function playerView(p: Player): Record<string, unknown> {
  return {
    k: "p", id: p.pid, name: p.name, job: p.job, lv: p.level, x: p.x, y: p.y, hp: p.hp, mhp: p.derived.maxHp,
    dead: p.dead, party: p.partyId ? store.partyById(p.partyId)?.name ?? null : null,
    guild: p.guildId ? store.guildById(p.guildId)?.name ?? null : null,
    casting: p.casting ? SKILLS[p.casting.skill].name : null,
  };
}
const monsterView = (m: Monster): Record<string, unknown> => ({ k: "m", id: m.id, type: m.type, x: m.x, y: m.y, hp: m.hp, mhp: m.maxHp });
const groundView = (g: Ground): Record<string, unknown> => ({
  k: "i", id: g.id, item: g.item, qty: g.qty, x: g.x, y: g.y, owner: g.owner ? publicId(g.owner) : null,
  ownMs: Math.max(0, g.ownUntil - Date.now()),
});
const stallView = (s: StallView): Record<string, unknown> => ({ k: "s", id: s.pid, name: s.name, title: s.title, x: s.x, y: s.y });

function entityView(ms: MapState, key: string): Record<string, unknown> | null {
  const [k, id] = [key.slice(0, 1), key.slice(2)];
  if (k === "p") {
    const p = players.get(byPid.get(id) ?? "");
    return p && p.map === ms.id ? playerView(p) : null;
  }
  if (k === "m") {
    const m = ms.monsters.get(Number(id));
    return m && !m.dead ? monsterView(m) : null;
  }
  if (k === "i") {
    const g = ms.ground.get(Number(id));
    return g ? groundView(g) : null;
  }
  if (k === "s") {
    const s = stalls.get(id);
    return s && s.map === ms.id ? stallView(s) : null;
  }
  return null;
}

export function snapshot(p: Player): Record<string, unknown> {
  const ms = mapState(p.map);
  const ents: Record<string, unknown>[] = [];
  for (const q of ms.players) ents.push(playerView(q));
  for (const m of ms.monsters.values()) if (!m.dead) ents.push(monsterView(m));
  for (const g of ms.ground.values()) ents.push(groundView(g));
  for (const s of stalls.values()) if (s.map === ms.id) ents.push(stallView(s));
  return { map: ms.id, seq: ms.seq, you: p.pid, ents };
}

const itemOut = (r: store.ItemRow): Record<string, unknown> => ({
  id: r.id, item: r.item, qty: r.qty, refine: r.refine, cards: r.cards, equipped: r.equipped, price: r.price,
});

export function meView(p: Player): Record<string, unknown> {
  const party = p.partyId ? store.partyById(p.partyId) : undefined;
  const guild = p.guildId ? store.guildById(p.guildId) : undefined;
  const stall = store.stallOf(p.id);
  const t = p.trade;
  const other = t ? players.get(t.a === p.id ? t.b : t.a) : undefined;
  return {
    pid: p.pid, name: p.name, job: p.job, level: p.level, xp: p.xp, jobLevel: p.jobLevel, jobXp: p.jobXp,
    stats: p.stats, statPoints: p.statPoints, skillPoints: p.skillPoints, skills: p.skills,
    map: p.map, x: p.x, y: p.y, hp: p.hp, sp: p.sp, dead: p.dead, derived: p.derived, weight: p.weight,
    zeny: store.getZeny(p.id), inventory: store.itemsOf("char", p.id).map(itemOut),
    cooldowns: Object.fromEntries(Object.entries(p.cooldowns).map(([k, v]) => [k, Math.max(0, (v ?? 0) - Date.now())])),
    buffs: Object.fromEntries(Object.entries(p.buffs).map(([k, v]) => [k, Math.max(0, (v ?? 0) - Date.now())])),
    casting: p.casting ? { skill: p.casting.skill, ms: Math.max(0, p.casting.endsAt - Date.now()) } : null,
    party: party ? { id: party.id, name: party.name, leader: publicId(party.leaderId), members: store.membersOf("party_id", party.id).map(memberOut) } : null,
    guild: guild ? {
      id: guild.id, name: guild.name, leader: publicId(guild.leaderId), members: store.membersOf("guild_id", guild.id).map(memberOut),
      storage: store.itemsOf("guild", String(guild.id)).map(itemOut),
    } : null,
    partyInvites: [...p.partyInvites.entries()].filter(([, u]) => u > Date.now()).map(([id]) => ({ id, name: store.partyById(id)?.name })),
    guildInvites: [...p.guildInvites.entries()].filter(([, u]) => u > Date.now()).map(([id]) => ({ id, name: store.guildById(id)?.name })),
    tradeInvite: p.tradeInvite && p.tradeInvite.until > Date.now() ? { from: publicId(p.tradeInvite.from), name: players.get(p.tradeInvite.from)?.name } : null,
    trade: t && other ? {
      with: other.pid, withName: other.name, version: t.version,
      mine: offerOut(t.offers[p.id]), theirs: offerOut(t.offers[other.id]),
      iConfirmed: t.confirmed.has(p.id), theyConfirmed: t.confirmed.has(other.id),
    } : null,
    stall: stall ? { title: stall.title, items: store.itemsOf("stall", p.id).map(itemOut) } : null,
  };
}
function memberOut(m: { id: string; name: string; job: JobId; level: number }): Record<string, unknown> {
  const online = players.get(m.id);
  return { pid: publicId(m.id), name: m.name, job: m.job, level: m.level, online: !!online, map: online?.map ?? null, hp: online?.hp ?? null, mhp: online?.derived.maxHp ?? null };
}
function offerOut(o: Offer | undefined): Record<string, unknown> {
  if (!o) return { items: [], zeny: 0 };
  return { zeny: o.zeny, items: o.items.map((i) => ({ ...i, item: store.itemById(i.id)?.item ?? null, refine: store.itemById(i.id)?.refine ?? 0 })) };
}

// ---------- streaming ----------

const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function sendTo(p: Player, chunk: string): void {
  for (const s of p.sends) {
    try {
      s(chunk);
    } catch {
      p.sends.delete(s);
    }
  }
}

function announce(text: string, sound: string | null): void {
  const chunk = event("announce", { text, sound });
  for (const p of players.values()) sendTo(p, chunk);
}

function chatTo(recipients: Iterable<Player>, msg: Record<string, unknown>): void {
  const chunk = event("chat", msg);
  for (const p of recipients) sendTo(p, chunk);
}

function fx(map: MapId, f: Record<string, unknown>): void {
  mapState(map).fx.push(f);
}
const touch = (p: Player): void => {
  mapState(p.map).dirty.add("p:" + p.pid);
};

// `close` ends the HTTP response; the simulated restart uses it so a tab
// reconnects to the new world, as it would after a real restart.
const closers = new Map<Send, () => void>();

export function attachStream(p: Player, send: Send, close: () => void = () => {}): () => void {
  p.sends.add(send);
  closers.set(send, close);
  p.lastActive = Date.now();
  send("retry: 2000\n\n");
  send(event("snapshot", snapshot(p)));
  send(event("me", meView(p)));
  return () => {
    p.sends.delete(send);
    closers.delete(send);
    p.lastActive = Date.now();
  };
}

// ---------- players coming and going ----------

function loadPlayer(row: store.CharRow): Player {
  const pid = publicId(row.id);
  const p: Player = {
    ...row, pid, path: [], attackTarget: null, casting: null, nextAttackAt: 0, cooldowns: {}, buffs: {}, dead: false,
    sends: new Set(), lastActive: Date.now(), lastSaved: Date.now(), regenAt: Date.now() + REGEN_EVERY_MS, dirtyMe: true,
    cmds: new Map(), tokens: BURST, tokenAt: Date.now(), lastRateLog: 0,
    derived: derive(row.job, row.level, row.stats, []), weight: 0, partyInvites: new Map(), guildInvites: new Map(),
    tradeInvite: null, trade: null, walkStart: null, lastMoveLog: 0,
  };
  if (!MAPS[p.map] || !walkable(MAPS[p.map], p.x, p.y)) [p.map, p.x, p.y] = ["town", ...MAPS.town.start];
  [p.x, p.y] = landing(p.map, p.x, p.y, p);
  refreshGear(p);
  if (p.hp <= 0) p.hp = Math.ceil(p.derived.maxHp / 2);
  p.hp = Math.min(p.hp, p.derived.maxHp);
  p.sp = Math.min(p.sp, p.derived.maxSp);
  return p;
}

// Brings a character into the world if they aren't already in it.
export function ensureOnline(row: store.CharRow): Player {
  const existing = players.get(row.id);
  if (existing) {
    existing.lastActive = Date.now();
    return existing;
  }
  if (players.size >= CAPS.onlinePlayers) throw new GameError(503, "the world is full right now; try again soon");
  const p = loadPlayer(row);
  players.set(p.id, p);
  byPid.set(p.pid, p.id);
  mapState(p.map).players.add(p);
  touch(p);
  log("join", `${tag(p)} (${JOBS[p.job].name} Lv${p.level}) entered ${MAPS[p.map].name}`);
  return p;
}

function goOffline(p: Player): void {
  cancelTrade(p, "went offline");
  save(p);
  const ms = mapState(p.map);
  ms.players.delete(p);
  ms.gone.add("p:" + p.pid);
  for (const m of ms.monsters.values()) if (m.target === p.id) m.target = null;
  players.delete(p.id);
  log("leave", `${tag(p)} left the world from ${MAPS[p.map].name}`);
}

function save(p: Player): void {
  store.saveProgress({
    id: p.id, level: p.level, xp: p.xp, jobLevel: p.jobLevel, jobXp: p.jobXp, stats: p.stats, statPoints: p.statPoints,
    skillPoints: p.skillPoints, skills: p.skills, map: p.map, x: p.x, y: p.y, hp: p.dead ? 0 : p.hp, sp: p.sp,
  });
  p.lastSaved = Date.now();
}

function refreshGear(p: Player): void {
  const inv = store.itemsOf("char", p.id);
  const equips: EquipView[] = inv.filter((r) => r.equipped).map((r) => ({ item: r.item, refine: r.refine, cards: r.cards }));
  const buffs = { endure: buffOn(p, "endure"), blessing: buffOn(p, "blessing"), quicken: buffOn(p, "quicken") };
  p.derived = derive(p.job, p.level, p.stats, equips, buffs);
  p.weight = inv.reduce((sum, r) => sum + ITEMS[r.item].weight * r.qty, 0);
  p.hp = Math.min(p.hp, p.derived.maxHp);
  p.sp = Math.min(p.sp, p.derived.maxSp);
  p.dirtyMe = true;
  touch(p);
}

const buffOn = (p: Player, b: BuffId): boolean => (p.buffs[b] ?? 0) > Date.now();
const weightPct = (p: Player): number => p.weight / p.derived.maxWeight;

// Arrivals land on the nearest free tile, so two people walking through the
// same portal or waking in town don't stand on each other.
function landing(map: MapId, x: number, y: number, self: Player): [number, number] {
  const m = MAPS[map];
  const taken = (tx: number, ty: number): boolean => [...mapState(map).players].some((q) => q !== self && q.x === tx && q.y === ty);
  for (let r = 0; r <= 2; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const [tx, ty] = [x + dx, y + dy];
        if (walkable(m, tx, ty) && !portalAt(m, tx, ty) && !taken(tx, ty)) return [tx, ty];
      }
    }
  }
  return [x, y];
}

function changeMap(p: Player, to: MapId, x: number, y: number): void {
  const from = p.map;
  [x, y] = landing(to, x, y, p);
  const old = mapState(from);
  old.players.delete(p);
  old.gone.add("p:" + p.pid);
  for (const m of old.monsters.values()) if (m.target === p.id) m.target = null;
  cancelTrade(p, "walked away");
  p.map = to;
  p.x = x;
  p.y = y;
  p.path = [];
  p.attackTarget = null;
  p.casting = null;
  mapState(to).players.add(p);
  touch(p);
  if (from !== to) log("map", `${tag(p)} went from ${MAPS[from].name} to ${MAPS[to].name}`);
  sendTo(p, event("snapshot", snapshot(p)));
  p.dirtyMe = true;
  save(p);
}

// ---------- intents ----------

const CMD = /^[A-Za-z0-9_-]{6,64}$/;

// Rate limit and dedupe happen as the request arrives; everything else waits
// for the tick.
export function submit(p: Player, body: Record<string, unknown>): Promise<Result> {
  const now = Date.now();
  p.lastActive = now;
  if (typeof body.cmd !== "string" || !CMD.test(body.cmd)) {
    log("reject", `${tag(p)} sent an intent with no valid command id`);
    return Promise.resolve({ status: 400, body: { ok: false, error: "every intent needs a cmd id (6-64 letters, digits, - or _)" } });
  }
  const prior = p.cmds.get(body.cmd);
  if (prior) {
    log("retry", `${tag(p)} resent command ${body.cmd.slice(0, 8)} (${String(body.type)}); it applies once`);
    return prior.then((r) => ({ status: r.status, body: { ...r.body, replay: true } }));
  }
  p.tokens = Math.min(BURST, p.tokens + ((now - p.tokenAt) / 1000) * RATE_PER_SEC);
  p.tokenAt = now;
  if (p.tokens < 1) {
    if (now - p.lastRateLog > 2000) {
      log("reject", `${tag(p)} is sending intents too fast; throttled`);
      p.lastRateLog = now;
    }
    return Promise.resolve({ status: 429, body: { ok: false, error: "too many actions; slow down" } });
  }
  p.tokens -= 1;
  const promise = new Promise<Result>((resolve) => queue.push({ p, body, resolve }));
  p.cmds.set(body.cmd, promise);
  if (p.cmds.size > CMD_MEMORY) p.cmds.delete(p.cmds.keys().next().value!);
  return promise;
}

const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1e9) refuse(400, `${what} must be a whole number`);
  return v as number;
};
const str = (v: unknown, what: string, min: number, max: number): string => {
  if (typeof v !== "string") refuse(400, `${what} must be text`);
  const s = (v as string).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (s.length < min || s.length > max) refuse(400, `${what} must be ${min}-${max} characters`);
  return s;
};

// What an intent was trying to do, in words, for a [reject] line. Ids that
// name something on the map are turned back into names.
function describe(p: Player, b: Record<string, unknown>): string {
  const t = String(b.type ?? "?");
  const ms = mapState(p.map);
  const id = (k: string): string => {
    const v = b[k];
    if (v === undefined) return "";
    if (k === "target" && typeof v === "number" && ms.monsters.has(v)) return ` ${mtag(ms.monsters.get(v)!)}`;
    if (typeof v === "string" && byPid.has(v)) {
      const q = players.get(byPid.get(v)!);
      if (q) return ` ${tag(q)}`;
    }
    return ` ${String(v).slice(0, 20)}`;
  };
  switch (t) {
    case "move": return `move to ${String(b.x)},${String(b.y)}`;
    case "attack": return `attack${id("target")}`;
    case "skill": return `use ${typeof b.skill === "string" && b.skill in SKILLS ? SKILLS[b.skill as SkillId].name : "an unknown skill"}${b.target !== undefined ? " on" + id("target") : ""}`;
    case "pickup": return `pick up item${id("item")}`;
    case "use": return `use item${id("item")}`;
    case "equip": return `equip item${id("item")}`;
    case "party_join": return `join party ${store.partyById(Number(b.party))?.name ?? String(b.party)}`;
    case "party_invite": return `invite${id("target")} to a party`;
    case "trade_request": return `trade with${id("target")}`;
    case "guild_join": return `join guild${id("guild")}`;
    case "storage_put": return `put item${id("item")} in guild storage`;
    case "storage_take": return `take item${id("item")} from guild storage`;
    case "stall_buy": return `buy item${id("item")} from a stall`;
    case "trade_confirm": return `confirm trade version${id("version")}`;
    case "shop_buy": return `buy${id("item")} from the shop`;
    case "refine": return `refine item${id("item")}`;
    default: return t.replace(/_/g, " ");
  }
}

function processQueue(): void {
  const batch = queue.splice(0, queue.length);
  for (const { p, body, resolve } of batch) {
    let r: Result;
    try {
      if (!players.has(p.id)) refuse(409, "you are not in the world");
      r = { status: 200, body: { ok: true, ...(handle(p, body) ?? {}) } };
    } catch (e) {
      if (e instanceof Refusal || e instanceof GameError) {
        const reason = e instanceof Refusal ? e.reason : e.message;
        const status = e instanceof Refusal ? e.status : e.status;
        log("reject", `${tag(p)} tried to ${describe(p, body)}: ${reason}`);
        r = { status, body: { ok: false, error: reason } };
      } else {
        console.error(e);
        log("error", `${tag(p)}'s ${describe(p, body)} failed inside the server`);
        r = { status: 500, body: { ok: false, error: "the server tripped over that; nothing changed" } };
      }
    }
    resolve(r);
  }
}

function online(pid: unknown): Player {
  if (typeof pid !== "string") refuse(400, "target must be a player id");
  const p = players.get(byPid.get(pid as string) ?? "");
  if (!p) refuse(404, "that player isn't online");
  return p!;
}
function alive(p: Player): void {
  if (p.dead) refuse(409, "you are dead; respawn first");
}
function nearNpc(p: Player, npc: "shop" | "smith" | "steward"): void {
  const n = MAPS.town.npcs.find((x) => x.id === npc)!;
  if (p.map !== "town" || dist(p.x, p.y, n.x, n.y) > NPC_REACH) refuse(422, `walk over to ${n.name} first`);
}
function ownedItem(p: Player, id: unknown): store.ItemRow {
  const n = int(id, "item");
  const row = store.itemById(n);
  if (!row || row.ownerKind !== "char" || row.ownerId !== p.id) refuse(403, `item ${n} isn't yours`);
  return row!;
}
function qtyOf(v: unknown, max: number): number {
  const q = v === undefined ? 1 : int(v, "qty");
  if (q < 1 || q > max) refuse(400, `qty must be 1-${max}`);
  return q;
}

type Handler = (p: Player, b: Record<string, unknown>) => Record<string, unknown> | void;

const handlers: Record<string, Handler> = {
  move(p, b) {
    alive(p);
    const x = int(b.x, "x");
    const y = int(b.y, "y");
    if (store.stallOf(p.id)) refuse(409, "close your stall before walking");
    const map = MAPS[p.map];
    if (!walkable(map, x, y)) refuse(422, "that tile isn't walkable");
    const path = findPath(map, p.x, p.y, x, y, 4000);
    if (!path) refuse(422, "there's no way there");
    if (path!.length > 60) refuse(422, "too far in one go");
    p.path = path!;
    p.attackTarget = null;
    if (p.casting) {
      log("cast", `${tag(p)} stopped casting ${SKILLS[p.casting.skill].name} to move`);
      p.casting = null;
      touch(p);
    }
    if (p.path.length >= 6 && !p.walkStart) p.walkStart = [p.x, p.y];
    return { steps: p.path.length };
  },

  stop(p) {
    p.path = [];
    p.attackTarget = null;
  },

  attack(p, b) {
    alive(p);
    const m = mapState(p.map).monsters.get(int(b.target, "target"));
    if (!m) refuse(404, "no such monster here");
    if (m!.dead) refuse(409, "it's already dead");
    if (weightPct(p) > 0.9) refuse(409, "carrying too much to fight (over 90% weight)");
    const d = dist(p.x, p.y, m!.x, m!.y);
    if (d > VIEW_RANGE) refuse(422, `out of range (${d} tiles away; you can engage within ${VIEW_RANGE})`);
    p.attackTarget = m!.id;
    p.path = [];
    return { target: m!.id };
  },

  skill(p, b) {
    alive(p);
    if (typeof b.skill !== "string" || !(b.skill in SKILLS)) refuse(400, "unknown skill");
    const id = b.skill as SkillId;
    const s = SKILLS[id];
    if (!p.skills.includes(id)) refuse(403, `you haven't learned ${s.name}`);
    if (p.casting) refuse(409, `already casting ${SKILLS[p.casting.skill].name}`);
    const cd = (p.cooldowns[id] ?? 0) - Date.now();
    if (cd > 0) refuse(409, `${s.name} is on cooldown for ${(cd / 1000).toFixed(1)}s`);
    if (p.sp < s.sp) refuse(409, `not enough SP (${p.sp}/${s.sp})`);
    if (s.kind && weightPct(p) > 0.9) refuse(409, "carrying too much to fight (over 90% weight)");
    const target = resolveTarget(p, id, b.target);
    if (s.castMs > 0) {
      p.casting = { skill: id, target, endsAt: Date.now() + s.castMs };
      p.path = [];
      touch(p);
      p.dirtyMe = true;
      fx(p.map, { t: "cast", id: p.pid, skill: id, ms: s.castMs });
      log("cast", `${tag(p)} began casting ${s.name}${targetTag(p, target)}`);
      return { casting: true, ms: s.castMs };
    }
    return applySkill(p, id, target);
  },

  respawn(p) {
    if (!p.dead) refuse(409, "you're not dead");
    p.dead = false;
    p.hp = Math.ceil(p.derived.maxHp / 2);
    p.sp = Math.ceil(p.derived.maxSp / 2);
    log("respawn", `${tag(p)} woke up in Hollowfield`);
    changeMap(p, "town", ...MAPS.town.start);
  },

  pickup(p, b) {
    alive(p);
    const id = int(b.item, "item");
    const g = mapState(p.map).ground.get(id);
    if (!g) refuse(404, `item ${id} is gone (someone got there first, or it was never here)`);
    if (dist(p.x, p.y, g!.x, g!.y) > 1) refuse(422, "walk next to it first");
    const left = g!.ownUntil - Date.now();
    if (g!.owner && g!.owner !== p.id && left > 0) refuse(403, `protected for ${g!.ownerTag} for ${(left / 1000).toFixed(1)}s more`);
    const w = ITEMS[g!.item].weight * g!.qty;
    if (p.weight + w > p.derived.maxWeight) refuse(409, "too heavy to carry");
    tx(() => {
      store.addItem("char", p.id, g!.item, g!.qty);
      store.ledger("loot", p.id, 0, g!.qty, `${g!.item} from the ground`);
    });
    removeGround(g!);
    refreshGear(p);
    const rare = ITEMS[g!.item].rare;
    log("loot", `${tag(p)} picked up ${qtyName(g!.item, g!.qty)} (item ${g!.id})${rare ? " — RARE" : ""}`);
    if (rare) announce(`${p.name} picked up a ${ITEMS[g!.item].name}!`, "rare");
    return { item: g!.item, qty: g!.qty };
  },

  use(p, b) {
    alive(p);
    const row = ownedItem(p, b.item);
    const def = ITEMS[row.item];
    if (def.kind !== "consumable") refuse(422, `${def.name} can't be used`);
    tx(() => {
      store.takeItem(row.id, 1);
      store.ledger("use", p.id, 0, -1, row.item);
    });
    if (def.heal) p.hp = Math.min(p.derived.maxHp, p.hp + def.heal);
    if (def.sp) p.sp = Math.min(p.derived.maxSp, p.sp + def.sp);
    refreshGear(p);
    log("item", `${tag(p)} used a ${def.name} (hp ${p.hp}/${p.derived.maxHp})`);
  },

  equip(p, b) {
    const row = ownedItem(p, b.item);
    const def = ITEMS[row.item];
    if (def.kind !== "equip" || !def.slot) refuse(422, `${def.name} isn't equipment`);
    if (def.jobs && !def.jobs.includes(p.job)) refuse(403, `a ${JOBS[p.job].name} can't use ${def.name}`);
    if (store.stallOf(p.id)) refuse(409, "close your stall first");
    tx(() => {
      for (const r of store.itemsOf("char", p.id)) if (r.equipped === def.slot) store.setEquipped(r.id, null);
      store.setEquipped(row.id, def.slot!);
    });
    refreshGear(p);
    log("item", `${tag(p)} equipped ${itemName(row)}`);
  },

  unequip(p, b) {
    const row = ownedItem(p, b.item);
    if (!row.equipped) refuse(409, "it isn't equipped");
    store.setEquipped(row.id, null);
    refreshGear(p);
  },

  card(p, b) {
    const card = ownedItem(p, b.card);
    const gear = ownedItem(p, b.equip);
    if (ITEMS[card.item].kind !== "card") refuse(422, "that isn't a card");
    const def = ITEMS[gear.item];
    if (def.kind !== "equip") refuse(422, "cards go into equipment");
    if (gear.cards.length >= (def.slots ?? 0)) refuse(409, `${def.name} has no free card slot`);
    tx(() => {
      store.takeItem(card.id, 1);
      // the card still exists, inside the gear: audit() counts slotted cards
      store.setCards(gear.id, [...gear.cards, card.item]);
    });
    refreshGear(p);
    log("card", `${tag(p)} slotted a ${ITEMS[card.item].name} into ${itemName(gear)}`);
  },

  stat(p, b) {
    if (!isStat(b.stat)) refuse(400, "stat must be str, agi, vit, int, dex or luk");
    const s = b.stat as keyof Stats;
    const cost = statCost(p.stats[s]);
    if (p.stats[s] >= MAX_STAT) refuse(409, `${s.toUpperCase()} is at its limit`);
    if (p.statPoints < cost) refuse(409, `raising ${s.toUpperCase()} costs ${cost} points; you have ${p.statPoints}`);
    p.statPoints -= cost;
    p.stats = { ...p.stats, [s]: p.stats[s] + 1 };
    refreshGear(p);
    save(p);
    log("stat", `${tag(p)} raised ${s.toUpperCase()} to ${p.stats[s]}`);
  },

  learn(p, b) {
    if (typeof b.skill !== "string" || !(b.skill in SKILLS)) refuse(400, "unknown skill");
    const id = b.skill as SkillId;
    const s = SKILLS[id];
    if (s.job !== p.job) refuse(403, `${s.name} isn't a ${JOBS[p.job].name} skill`);
    if (p.skills.includes(id)) refuse(409, `you already know ${s.name}`);
    const missing = s.prereq.filter((q) => !p.skills.includes(q));
    if (missing.length) refuse(409, `learn ${missing.map((q) => SKILLS[q].name).join(", ")} first`);
    if (p.skillPoints < 1) refuse(409, "no skill points (earn them from job levels)");
    p.skillPoints--;
    p.skills = [...p.skills, id];
    p.dirtyMe = true;
    save(p);
    log("skill", `${tag(p)} learned ${s.name}`);
  },

  chat(p, b) {
    const text = str(b.text, "message", 1, CAPS.chatLength);
    const scope = b.scope === "party" || b.scope === "guild" ? b.scope : "say";
    const msg = { from: p.name, pid: p.pid, scope, text };
    if (scope === "say") {
      fx(p.map, { t: "say", id: p.pid, text });
      chatTo(mapState(p.map).players, msg);
    } else {
      const gid = scope === "party" ? p.partyId : p.guildId;
      if (!gid) refuse(409, `you're not in a ${scope}`);
      const col = scope === "party" ? "partyId" : "guildId";
      chatTo([...players.values()].filter((q) => q[col] === gid), msg);
    }
    log("chat", `${tag(p)} (${scope}): ${text}`);
  },

  emote(p, b) {
    const e = int(b.emote, "emote");
    if (e < 0 || e >= EMOTES.length) refuse(400, "no such emote");
    fx(p.map, { t: "emote", id: p.pid, e });
    log("emote", `${tag(p)} shows ${EMOTES[e]}`);
  },

  // ----- party -----
  party_create(p, b) {
    const name = str(b.name, "party name", 2, 20);
    if (p.partyId) refuse(409, "leave your party first");
    tx(() => {
      p.partyId = store.createGroup("parties", name, p.id);
      store.setGroup("party_id", p.id, p.partyId);
    });
    touch(p);
    p.dirtyMe = true;
    log("party", `${tag(p)} founded the party "${name}"`);
  },
  party_invite(p, b) {
    if (!p.partyId) refuse(409, "make a party first");
    const t = online(b.target);
    if (t.id === p.id) refuse(400, "you can't invite yourself");
    if (t.partyId) refuse(409, `${t.name} is already in a party`);
    if (store.membersOf("party_id", p.partyId).length >= CAPS.partySize) refuse(409, "the party is full");
    t.partyInvites.set(p.partyId, Date.now() + INVITE_MS);
    t.dirtyMe = true;
    chatTo([t], { from: "", scope: "system", text: `${p.name} invited you to their party.` });
    log("party", `${tag(p)} invited ${tag(t)} to "${store.partyById(p.partyId)!.name}"`);
  },
  party_join(p, b) {
    const id = int(b.party, "party");
    if (p.partyId) refuse(409, "leave your party first");
    if ((p.partyInvites.get(id) ?? 0) < Date.now()) refuse(403, "uninvited: nobody in that party invited you");
    const party = store.partyById(id);
    if (!party) refuse(404, "that party has disbanded");
    if (store.membersOf("party_id", id).length >= CAPS.partySize) refuse(409, "the party is full");
    store.setGroup("party_id", p.id, id);
    p.partyId = id;
    p.partyInvites.delete(id);
    touch(p);
    for (const q of players.values()) if (q.partyId === id) q.dirtyMe = true;
    log("party", `${tag(p)} joined "${party!.name}"`);
  },
  party_leave(p) {
    if (!p.partyId) refuse(409, "you're not in a party");
    const id = p.partyId;
    const name = store.partyById(id)?.name;
    tx(() => {
      store.setGroup("party_id", p.id, null);
      store.tidyGroup("parties", "party_id", id, p.id);
    });
    p.partyId = null;
    touch(p);
    for (const q of players.values()) if (q.partyId === id || q === p) q.dirtyMe = true;
    log("party", `${tag(p)} left "${name}"`);
  },

  // ----- guild -----
  guild_create(p, b) {
    const name = str(b.name, "guild name", 2, 24);
    if (p.guildId) refuse(409, "leave your guild first");
    tx(() => {
      p.guildId = store.createGroup("guilds", name, p.id);
      store.setGroup("guild_id", p.id, p.guildId);
    });
    touch(p);
    p.dirtyMe = true;
    log("guild", `${tag(p)} founded the guild "${name}"`);
  },
  guild_invite(p, b) {
    if (!p.guildId) refuse(409, "found a guild first");
    const t = online(b.target);
    if (t.id === p.id) refuse(400, "you can't invite yourself");
    if (t.guildId) refuse(409, `${t.name} is already in a guild`);
    if (store.membersOf("guild_id", p.guildId).length >= CAPS.guildSize) refuse(409, "the guild is full");
    t.guildInvites.set(p.guildId, Date.now() + INVITE_MS);
    t.dirtyMe = true;
    chatTo([t], { from: "", scope: "system", text: `${p.name} invited you to their guild.` });
    log("guild", `${tag(p)} invited ${tag(t)} to "${store.guildById(p.guildId)!.name}"`);
  },
  guild_join(p, b) {
    const id = int(b.guild, "guild");
    if (p.guildId) refuse(409, "leave your guild first");
    if ((p.guildInvites.get(id) ?? 0) < Date.now()) refuse(403, "uninvited: nobody in that guild invited you");
    const g = store.guildById(id);
    if (!g) refuse(404, "that guild is gone");
    store.setGroup("guild_id", p.id, id);
    p.guildId = id;
    p.guildInvites.delete(id);
    touch(p);
    for (const q of players.values()) if (q.guildId === id) q.dirtyMe = true;
    log("guild", `${tag(p)} joined "${g!.name}"`);
  },
  guild_leave(p) {
    if (!p.guildId) refuse(409, "you're not in a guild");
    const id = p.guildId;
    const name = store.guildById(id)?.name;
    tx(() => {
      store.setGroup("guild_id", p.id, null);
      store.tidyGroup("guilds", "guild_id", id, p.id);
    });
    p.guildId = null;
    touch(p);
    for (const q of players.values()) if (q.guildId === id || q === p) q.dirtyMe = true;
    log("guild", `${tag(p)} left "${name}"`);
  },
  storage_put(p, b) {
    if (!p.guildId) refuse(403, "guild storage is for guild members only");
    nearNpc(p, "steward");
    const row = ownedItem(p, b.item);
    if (row.equipped) refuse(409, "unequip it first");
    const qty = qtyOf(b.qty, row.qty);
    tx(() => store.moveItem(row.id, qty, "guild", String(p.guildId)));
    refreshGear(p);
    for (const q of players.values()) if (q.guildId === p.guildId) q.dirtyMe = true;
    log("storage", `${tag(p)} put ${qtyName(row.item, qty)} into "${store.guildById(p.guildId)!.name}" storage`);
  },
  storage_take(p, b) {
    if (!p.guildId) refuse(403, "guild storage is for guild members only");
    nearNpc(p, "steward");
    const id = int(b.item, "item");
    const row = store.itemById(id);
    if (!row || row.ownerKind !== "guild" || row.ownerId !== String(p.guildId)) refuse(403, `item ${id} isn't in your guild's storage`);
    const qty = qtyOf(b.qty, row!.qty);
    if (p.weight + ITEMS[row!.item].weight * qty > p.derived.maxWeight) refuse(409, "too heavy to carry");
    tx(() => store.moveItem(row!.id, qty, "char", p.id));
    refreshGear(p);
    for (const q of players.values()) if (q.guildId === p.guildId) q.dirtyMe = true;
    log("storage", `${tag(p)} took ${qtyName(row!.item, qty)} from "${store.guildById(p.guildId)!.name}" storage`);
  },

  // ----- economy -----
  shop_buy(p, b) {
    nearNpc(p, "shop");
    if (typeof b.item !== "string" || !SHOP_STOCK.includes(b.item as ItemId)) refuse(404, "the shop doesn't sell that");
    const item = b.item as ItemId;
    const qty = qtyOf(b.qty, 99);
    const cost = ITEMS[item].price * qty;
    if (p.weight + ITEMS[item].weight * qty > p.derived.maxWeight) refuse(409, "too heavy to carry");
    tx(() => {
      store.addZeny(p.id, -cost);
      store.addItem("char", p.id, item, qty);
      store.ledger("shop-buy", p.id, -cost, qty, item);
    });
    refreshGear(p);
    log("shop", `${tag(p)} bought ${qtyName(item, qty)} for ${cost}z`);
    return { zeny: store.getZeny(p.id) };
  },
  shop_sell(p, b) {
    nearNpc(p, "shop");
    const row = ownedItem(p, b.item);
    if (row.equipped) refuse(409, "unequip it first");
    const qty = qtyOf(b.qty, row.qty);
    const gain = Math.floor(ITEMS[row.item].price / 2) * qty;
    tx(() => {
      store.takeItem(row.id, qty);
      store.addZeny(p.id, gain);
      store.ledger("shop-sell", p.id, gain, -qty, row.item);
    });
    refreshGear(p);
    log("shop", `${tag(p)} sold ${qtyName(row.item, qty)} for ${gain}z`);
    return { zeny: store.getZeny(p.id) };
  },
  refine(p, b) {
    nearNpc(p, "smith");
    const row = ownedItem(p, b.item);
    const def = ITEMS[row.item];
    if (def.kind !== "equip") refuse(422, "only equipment can be refined");
    if (row.refine >= MAX_REFINE) refuse(409, `already +${MAX_REFINE}`);
    const cost = refineCost(row.refine);
    const chance = refineChance(row.refine);
    const ok = roll() < chance;
    const next = row.refine + 1;
    tx(() => {
      store.addZeny(p.id, -cost);
      if (ok) store.setRefine(row.id, next);
      else store.takeItem(row.id, 1);
      // a break destroys the gear and any cards slotted in it
      store.ledger("refine", p.id, -cost, ok ? 0 : -(1 + row.cards.length), `${row.item} +${row.refine} -> ${ok ? "+" + next : "broke"}`);
    });
    refreshGear(p);
    fx(p.map, { t: "refine", id: p.pid, ok, level: next });
    if (ok) {
      log("refine", `${tag(p)} refined ${def.name} to +${next} (${Math.round(chance * 100)}% chance) for ${cost}z`);
      if (next >= 7) announce(`${p.name}'s +${next} ${def.name} held!`, "rare");
    } else {
      log("refine", `${tag(p)} +${next} ${def.name} failed: broke (${Math.round(chance * 100)}% chance)`);
    }
    return { success: ok, refine: ok ? next : null, broke: !ok };
  },

  // ----- trade -----
  trade_request(p, b) {
    alive(p);
    const t = online(b.target);
    if (t.id === p.id) refuse(400, "you can't trade with yourself");
    if (t.map !== p.map || dist(p.x, p.y, t.x, t.y) > TRADE_REACH) refuse(422, `stand within ${TRADE_REACH} tiles of ${t.name} to trade`);
    if (p.trade || t.trade) refuse(409, "one of you is already trading");
    t.tradeInvite = { from: p.id, until: Date.now() + INVITE_MS };
    t.dirtyMe = true;
    chatTo([t], { from: "", scope: "system", text: `${p.name} wants to trade.` });
    log("trade", `${tag(p)} asked ${tag(t)} to trade`);
  },
  trade_accept(p, b) {
    const from = online(b.from);
    if (!p.tradeInvite || p.tradeInvite.from !== from.id || p.tradeInvite.until < Date.now()) refuse(403, `${from.name} hasn't asked you to trade`);
    if (p.trade || from.trade) refuse(409, "one of you is already trading");
    if (from.map !== p.map || dist(p.x, p.y, from.x, from.y) > TRADE_REACH) refuse(422, "you've drifted too far apart");
    const t: Trade = { a: from.id, b: p.id, offers: { [from.id]: { items: [], zeny: 0 }, [p.id]: { items: [], zeny: 0 } }, confirmed: new Set(), version: 1 };
    p.trade = t;
    from.trade = t;
    p.tradeInvite = null;
    p.dirtyMe = from.dirtyMe = true;
    log("trade", `${tag(from)} and ${tag(p)} opened a trade window`);
  },
  trade_offer(p, b) {
    const t = p.trade;
    if (!t) refuse(409, "you're not trading");
    const zeny = b.zeny === undefined ? 0 : int(b.zeny, "zeny");
    if (zeny < 0 || zeny > store.getZeny(p.id)) refuse(409, "you don't have that much zeny");
    if (!Array.isArray(b.items) || b.items.length > 10) refuse(400, "items must be a list of up to 10 { id, qty }");
    const items: { id: number; qty: number }[] = [];
    for (const raw of b.items as unknown[]) {
      const o = raw as Record<string, unknown>;
      const row = ownedItem(p, o?.id);
      if (row.equipped) refuse(409, `unequip ${ITEMS[row.item].name} first`);
      if (items.some((i) => i.id === row.id)) refuse(400, "each item once");
      items.push({ id: row.id, qty: qtyOf(o.qty, row.qty) });
    }
    t!.offers[p.id] = { items, zeny };
    t!.version++;
    t!.confirmed.clear();
    for (const id of [t!.a, t!.b]) players.get(id)!.dirtyMe = true;
    log("trade", `${tag(p)} put ${offerText(t!.offers[p.id])} on the table (both confirmations reset)`);
    return { version: t!.version };
  },
  trade_confirm(p, b) {
    const t = p.trade;
    if (!t) refuse(409, "you're not trading");
    const v = int(b.version, "version");
    if (v !== t!.version) refuse(409, `stale: the offer changed (now version ${t!.version}); look again`);
    t!.confirmed.add(p.id);
    for (const id of [t!.a, t!.b]) players.get(id)!.dirtyMe = true;
    if (t!.confirmed.size < 2) {
      log("trade", `${tag(p)} confirmed the trade (version ${v})`);
      return { done: false };
    }
    const A = players.get(t!.a)!;
    const B = players.get(t!.b)!;
    tx(() => {
      for (const [from, to] of [[A, B], [B, A]] as const) {
        const o = t!.offers[from.id];
        for (const i of o.items) {
          const row = store.itemById(i.id);
          if (!row || row.ownerKind !== "char" || row.ownerId !== from.id || row.equipped || row.qty < i.qty) {
            throw new GameError(409, `${from.name}'s offer no longer matches their bag`);
          }
          store.moveItem(i.id, i.qty, "char", to.id);
        }
        if (o.zeny) {
          store.addZeny(from.id, -o.zeny);
          store.addZeny(to.id, o.zeny);
        }
      }
    });
    log("trade", `${tag(A)} gave ${tag(B)} ${offerText(t!.offers[A.id])} for ${offerText(t!.offers[B.id])}`);
    A.trade = B.trade = null;
    refreshGear(A);
    refreshGear(B);
    return { done: true };
  },
  trade_cancel(p) {
    if (!p.trade) refuse(409, "you're not trading");
    cancelTrade(p, "cancelled");
  },

  // ----- vending -----
  stall_open(p, b) {
    alive(p);
    if (p.map !== "town") refuse(422, "stalls go up in Hollowfield");
    if (store.stallOf(p.id)) refuse(409, "your stall is already open");
    if (p.trade) refuse(409, "finish your trade first");
    const title = str(b.title, "stall title", 2, 30);
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > CAPS.stallItems) refuse(400, `list 1-${CAPS.stallItems} items`);
    for (const s of stalls.values()) if (s.map === p.map && dist(s.x, s.y, p.x, p.y) < 1) refuse(409, "someone's stall is already here");
    const lines = (b.items as unknown[]).map((raw) => {
      const o = raw as Record<string, unknown>;
      const row = ownedItem(p, o?.id);
      if (row.equipped) refuse(409, `unequip ${ITEMS[row.item].name} first`);
      const price = int(o.price, "price");
      if (price < 1 || price > 1_000_000) refuse(400, "price must be 1-1000000z");
      return { row, qty: qtyOf(o.qty, row.qty), price };
    });
    if (new Set(lines.map((l) => l.row.id)).size !== lines.length) refuse(400, "each item once");
    tx(() => {
      for (const l of lines) store.moveItem(l.row.id, l.qty, "stall", p.id, l.price);
      store.openStallRow({ charId: p.id, title, map: p.map, x: p.x, y: p.y });
    });
    p.path = [];
    stalls.set(p.pid, { charId: p.id, pid: p.pid, name: p.name, title, map: p.map, x: p.x, y: p.y });
    mapState(p.map).dirty.add("s:" + p.pid);
    refreshGear(p);
    log("vend", `${tag(p)} opened a stall "${title}" with ${lines.map((l) => `${qtyName(l.row.item, l.qty)} at ${l.price}z`).join(", ")}`);
  },
  stall_close(p) {
    if (!store.stallOf(p.id)) refuse(409, "you have no stall open");
    closeStall(p.id, p.pid, p.name, "closed it");
    refreshGear(p);
  },
  stall_buy(p, b) {
    alive(p);
    if (typeof b.seller !== "string") refuse(400, "seller must be a player id");
    const s = stalls.get(b.seller as string);
    if (!s) refuse(404, "that stall is closed");
    if (s!.charId === p.id) refuse(400, "that's your own stall");
    if (p.map !== s!.map || dist(p.x, p.y, s!.x, s!.y) > NPC_REACH) refuse(422, "walk up to the stall first");
    const id = int(b.item, "item");
    const row = store.itemById(id);
    if (!row || row.ownerKind !== "stall" || row.ownerId !== s!.charId) refuse(409, "sold out");
    const qty = qtyOf(b.qty, 99);
    if (qty > row!.qty) refuse(409, `only ${row!.qty} left`);
    const cost = row!.price! * qty;
    if (p.weight + ITEMS[row!.item].weight * qty > p.derived.maxWeight) refuse(409, "too heavy to carry");
    tx(() => {
      store.addZeny(p.id, -cost);
      store.addZeny(s!.charId, cost);
      store.moveItem(row!.id, qty, "char", p.id);
    });
    const seller = players.get(s!.charId);
    if (seller) seller.dirtyMe = true;
    refreshGear(p);
    log("vend", `${tag(p)} bought ${qtyName(row!.item, qty)} from ${s!.name}#${shortHash(s!.charId)}'s stall for ${cost}z`);
    if (store.itemsOf("stall", s!.charId).length === 0) closeStall(s!.charId, s!.pid, s!.name, "sold out");
    return { zeny: store.getZeny(p.id) };
  },
};

function handle(p: Player, b: Record<string, unknown>): Record<string, unknown> | void {
  const h = typeof b.type === "string" && Object.hasOwn(handlers, b.type) ? handlers[b.type] : null;
  if (!h) refuse(400, "unknown intent type");
  return h!(p, b);
}

function closeStall(charId: string, pid: string, name: string, why: string): void {
  tx(() => {
    for (const r of store.itemsOf("stall", charId)) {
      store.takeItem(r.id, r.qty);
      store.addItem("char", charId, r.item, r.qty, r.refine, r.cards);
    }
    store.closeStallRow(charId);
  });
  const s = stalls.get(pid);
  stalls.delete(pid);
  if (s) mapState(s.map).gone.add("s:" + pid);
  const p = players.get(charId);
  if (p) refreshGear(p);
  log("vend", `${name}#${shortHash(charId)}'s stall ${why}`);
}

function cancelTrade(p: Player, why: string): void {
  const t = p.trade;
  if (!t) return;
  for (const id of [t.a, t.b]) {
    const q = players.get(id);
    if (q) {
      q.trade = null;
      q.dirtyMe = true;
    }
  }
  log("trade", `${tag(p)}'s trade ended: ${why}`);
}

export function stallItems(pid: string): Record<string, unknown> | null {
  const s = stalls.get(pid);
  if (!s) return null;
  return { seller: s.pid, name: s.name, title: s.title, items: store.itemsOf("stall", s.charId).map(itemOut) };
}

const itemName = (r: { item: ItemId; refine: number; cards: ItemId[] }): string =>
  `${r.refine ? "+" + r.refine + " " : ""}${ITEMS[r.item].name}${r.cards.length ? ` [${r.cards.map((c) => ITEMS[c].name).join(", ")}]` : ""}`;
const qtyName = (item: ItemId, qty: number): string => (qty === 1 ? ITEMS[item].name : `${qty} ${ITEMS[item].name}`);
function offerText(o: Offer): string {
  const parts = o.items.map((i) => {
    const row = store.itemById(i.id);
    return row ? qtyName(row.item, i.qty) : `item ${i.id}`;
  });
  if (o.zeny) parts.push(`${o.zeny}z`);
  return parts.length ? parts.join(", ") : "nothing";
}

// ---------- skills and combat ----------

function resolveTarget(p: Player, id: SkillId, raw: unknown): string | number | null {
  const s = SKILLS[id];
  if (s.target === "self") return null;
  if (s.target === "monster") {
    const m = mapState(p.map).monsters.get(int(raw, "target"));
    if (!m) refuse(404, "no such monster here");
    if (m!.dead) refuse(409, "it's already dead");
    const d = dist(p.x, p.y, m!.x, m!.y);
    if (d > s.range) refuse(422, `out of range (${d} tiles; ${s.name} reaches ${s.range})`);
    return m!.id;
  }
  if (raw === undefined || raw === null || raw === p.pid) return p.pid;
  const t = online(raw);
  if (t.map !== p.map) refuse(422, `${t.name} isn't on this map`);
  if (t.dead) refuse(409, `${t.name} is dead`);
  const d = dist(p.x, p.y, t.x, t.y);
  if (d > s.range) refuse(422, `out of range (${d} tiles; ${s.name} reaches ${s.range})`);
  return t.pid;
}

function targetTag(p: Player, target: string | number | null): string {
  if (target === null) return "";
  if (typeof target === "number") {
    const m = mapState(p.map).monsters.get(target);
    return m ? ` on ${mtag(m)}` : "";
  }
  const t = players.get(byPid.get(target) ?? "");
  return t ? (t === p ? " on themself" : ` on ${tag(t)}`) : "";
}

const rolls = (): { hit: number; crit: number; variance: number } => ({ hit: roll(), crit: roll(), variance: roll() });

function applySkill(p: Player, id: SkillId, target: string | number | null): Record<string, unknown> {
  const s = SKILLS[id];
  const ms = mapState(p.map);
  p.sp -= s.sp;
  p.cooldowns[id] = Date.now() + s.cdMs;
  p.dirtyMe = true;
  fx(p.map, { t: "skill", id: p.pid, skill: id, to: typeof target === "number" ? "m:" + target : target ? "p:" + target : null });
  const blessing = buffOn(p, "blessing");
  if (s.kind) {
    const centre = typeof target === "number" ? ms.monsters.get(target)! : { x: p.x, y: p.y };
    const victims = s.radius !== undefined
      ? [...ms.monsters.values()].filter((m) => !m.dead && dist(m.x, m.y, centre.x, centre.y) <= s.radius!)
      : [ms.monsters.get(target as number)!];
    if (typeof target === "number" && victims[0]?.dead) refuse(409, "it's already dead");
    log("skill", `${tag(p)} used ${s.name}${targetTag(p, target)}${s.radius !== undefined ? ` (${victims.length} caught)` : ""}`);
    for (const m of victims) {
      const def = MONSTERS[m.type];
      const blow = s.kind === "magic"
        ? magicDamage({ matk: p.derived.matk, blessing }, { def: def.def, element: def.element }, s.mult!, s.element!, rolls())
        : physicalDamage({ atk: p.derived.atk, hit: p.derived.hit, crit: p.derived.crit, blessing }, { def: def.def, flee: def.flee, element: def.element }, s.mult!, s.element!, rolls());
      hitMonster(p, m, blow, s.element!, s.name);
    }
    return { hit: victims.length };
  }
  if (s.taunt) {
    const m = ms.monsters.get(target as number)!;
    m.target = p.id;
    log("skill", `${tag(p)} provoked ${mtag(m)}; it turns on them`);
    return {};
  }
  if (s.restoreSpPct) {
    p.sp = Math.min(p.derived.maxSp, p.sp + Math.round(p.derived.maxSp * s.restoreSpPct));
    log("skill", `${tag(p)} meditated (sp ${p.sp}/${p.derived.maxSp})`);
    return {};
  }
  const allies = s.radius !== undefined
    ? [...ms.players].filter((q) => !q.dead && dist(q.x, q.y, p.x, p.y) <= s.radius!)
    : [players.get(byPid.get(target as string)!)!];
  if (s.heal) {
    for (const q of allies) {
      const n = Math.min(q.derived.maxHp - q.hp, healAmount(p.derived.matk, p.level, roll()));
      q.hp += n;
      q.dirtyMe = true;
      touch(q);
      fx(p.map, { t: "dmg", to: "p:" + q.pid, n, heal: true });
      log("heal", `${tag(p)} ${s.name === "Heal" ? "healed" : "sanctified"} ${q === p ? "themself" : tag(q)} for ${n} (hp ${q.hp}/${q.derived.maxHp})`);
    }
    return { healed: allies.length };
  }
  if (s.buff) {
    for (const q of allies) {
      q.buffs[s.buff.id] = Date.now() + s.buff.ms;
      refreshGear(q);
      log("buff", `${tag(p)} cast ${s.name} on ${q === p ? "themself" : tag(q)} (${s.buff.ms / 1000}s)`);
    }
  }
  return {};
}

function hitMonster(p: Player, m: Monster, blow: { amount: number; miss: boolean; crit: boolean; mult: number }, element: string, how: string | null): void {
  const def = MONSTERS[m.type];
  fx(m.map, { t: "dmg", to: "m:" + m.id, n: blow.amount, miss: blow.miss, crit: blow.crit, mult: blow.mult, by: p.pid });
  if (!m.target) m.target = p.id;
  if (def.ai === "caller" && !blow.miss) callFriends(m, p);
  if (blow.miss) {
    log("combat", `${tag(p)} ${how ? how + " " : ""}missed ${mtag(m)}`);
    return;
  }
  const el = blow.mult !== 1 ? ` (${element} vs ${def.element} x${blow.mult})` : "";
  const amount = Math.min(blow.amount, m.hp);
  m.hp -= amount;
  m.damage.set(p.id, (m.damage.get(p.id) ?? 0) + amount);
  mapState(m.map).dirty.add("m:" + m.id);
  log("combat", `${tag(p)} ${how ? "used " + how + " on" : "hit"} ${mtag(m)} for ${blow.amount}${blow.crit ? " CRITICAL" : ""}${el}, hp ${m.hp}/${m.maxHp}`);
  if (m.hp <= 0) killMonster(m, p);
}

function callFriends(m: Monster, p: Player): void {
  const called = [...mapState(m.map).monsters.values()].filter((o) => o !== m && !o.dead && o.type === m.type && !o.target && dist(o.x, o.y, m.x, m.y) <= 6);
  for (const o of called) o.target = p.id;
  if (called.length) log("call", `${mtag(m)} screeched; ${called.map(mtag).join(", ")} came for ${tag(p)}`);
}

function killMonster(m: Monster, killer: Player): void {
  if (m.dead) return;
  const def = MONSTERS[m.type];
  const ms = mapState(m.map);
  m.dead = true;
  m.respawnAt = Date.now() + def.respawnMs;
  ms.gone.add("m:" + m.id);
  fx(m.map, { t: "die", key: "m:" + m.id, x: m.x, y: m.y });
  counters.kills++;
  for (const q of players.values()) if (q.attackTarget === m.id) q.attackTarget = null;
  const total = [...m.damage.values()].reduce((a, b) => a + b, 0) || 1;
  const contributors = [...m.damage.entries()].sort((a, b) => b[1] - a[1]);
  const share = contributors.map(([id, d]) => `${players.get(id)?.name ?? "?"} ${Math.round((d / total) * 100)}%`).join(", ");
  log("kill", `${tag(killer)} landed the killing blow on ${mtag(m)} (damage: ${share})`);

  // XP: each contributor's share; a party pools its members' shares and
  // splits them among everyone in the party standing on this map.
  const groups = new Map<string, { share: number; members: Player[]; party: string | null }>();
  for (const [id, d] of contributors) {
    const q = players.get(id);
    if (!q) continue;
    const key = q.partyId ? "party:" + q.partyId : "solo:" + q.id;
    const g = groups.get(key) ?? {
      share: 0,
      members: q.partyId ? [...ms.players].filter((o) => o.partyId === q.partyId && !o.dead) : [q],
      party: q.partyId ? store.partyById(q.partyId)?.name ?? null : null,
    };
    g.share += d / total;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (!g.members.length) continue;
    const base = splitXp(Math.round(def.baseXp * g.share), g.members.length);
    const job = splitXp(Math.round(def.jobXp * g.share), g.members.length);
    log("xp", `${g.party ? `party "${g.party}": ` : ""}${g.members.map(tag).join(", ")} ${g.members.length > 1 ? "each " : ""}+${base} base / +${job} job xp`);
    for (const q of g.members) giveXp(q, base, job);
  }

  // Drops: the top damage dealer owns them for a few seconds.
  const [topId, topDmg] = contributors[0] ?? [killer.id, 0];
  const top = players.get(topId) ?? killer;
  const spots = dropSpots(m);
  let n = 0;
  for (const d of def.drops) {
    if (roll() < d.chance) dropItem(m, d.item, 1, top, spots[n++ % spots.length]);
  }
  if (def.ai === "mvp" && def.mvpReward) {
    counters.mvpKills++;
    tx(() => {
      store.addItem("char", top.id, def.mvpReward!, 1);
      store.ledger("mvp", top.id, 0, 1, `${def.mvpReward} for ${def.name}`);
    });
    counters.mvpRewards++;
    refreshGear(top);
    log("mvp", `${tag(top)} dealt the most damage to ${mtag(m)} (${topDmg} of ${m.maxHp}) and wins the ${ITEMS[def.mvpReward].name}`);
    announce(`MVP! ${top.name} toppled the ${def.name} and claims the ${ITEMS[def.mvpReward].name}!`, "mvp");
  }
}

function dropSpots(m: Monster): [number, number][] {
  const map = MAPS[m.map];
  const out: [number, number][] = [[m.x, m.y]];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    if (walkable(map, m.x + dx, m.y + dy) && !portalAt(map, m.x + dx, m.y + dy)) out.push([m.x + dx, m.y + dy]);
  }
  return out;
}

function dropItem(m: Monster | null, item: ItemId, qty: number, owner: Player | null, at: [number, number], map?: MapId): Ground {
  const mid = m?.map ?? map!;
  const ms = mapState(mid);
  if (ms.ground.size >= CAPS.groundItemsPerMap) {
    const oldest = [...ms.ground.values()].sort((a, b) => a.expires - b.expires)[0];
    removeGround(oldest);
    log("ground", `item ${oldest.id} (${ITEMS[oldest.item].name}) crumbled to make room`);
  }
  const now = Date.now();
  const g: Ground = {
    id: nextGroundId++, map: mid, x: at[0], y: at[1], item, qty, owner: owner?.id ?? null, ownerTag: owner ? tag(owner) : null,
    ownUntil: owner ? now + OWN_MS : 0, expires: now + GROUND_MS,
  };
  ms.ground.set(g.id, g);
  ms.dirty.add("i:" + g.id);
  const rare = ITEMS[item].rare;
  log("drop", `${m ? mtag(m) : "the ground"} dropped ${qtyName(item, qty)} (item ${g.id}${owner ? `, ${tag(owner)}'s for ${OWN_MS / 1000}s` : ""})${rare ? " — RARE" : ""}`);
  if (rare) announce(`A ${ITEMS[item].name} dropped for ${owner?.name ?? "anyone"} in ${MAPS[mid].name}!`, "rare");
  return g;
}

function removeGround(g: Ground): void {
  const ms = mapState(g.map);
  ms.ground.delete(g.id);
  ms.gone.add("i:" + g.id);
}

function giveXp(p: Player, base: number, job: number): void {
  const before = p.level;
  const r = gainXp(p, base, job);
  Object.assign(p, r.state);
  p.dirtyMe = true;
  if (r.levels || r.jobLevels) {
    refreshGear(p);
    if (r.levels) {
      p.hp = p.derived.maxHp;
      p.sp = p.derived.maxSp;
      fx(p.map, { t: "lvl", id: p.pid, kind: "base", level: p.level });
      log("level", `${tag(p)} reached base level ${p.level} (from ${before})`);
    }
    if (r.jobLevels) {
      fx(p.map, { t: "lvl", id: p.pid, kind: "job", level: p.jobLevel });
      log("level", `${tag(p)} reached job level ${p.jobLevel}`);
    }
    save(p);
  }
}

function hurtPlayer(m: Monster, p: Player): void {
  const def = MONSTERS[m.type];
  const blow = physicalDamage({ atk: def.atk, hit: def.hit, crit: 0 }, { def: p.derived.def, flee: p.derived.flee, element: "neutral" }, 1, def.element, rolls());
  fx(p.map, { t: "dmg", to: "p:" + p.pid, n: blow.amount, miss: blow.miss, by: "m:" + m.id });
  if (blow.miss) {
    log("combat", `${mtag(m)} missed ${tag(p)}`);
    return;
  }
  p.hp = Math.max(0, p.hp - blow.amount);
  p.dirtyMe = true;
  touch(p);
  log("combat", `${mtag(m)} hit ${tag(p)} for ${blow.amount}, hp ${p.hp}/${p.derived.maxHp}`);
  if (p.casting && !buffOn(p, "endure")) {
    log("cast", `${tag(p)}'s ${SKILLS[p.casting.skill].name} was interrupted by ${mtag(m)}`);
    fx(p.map, { t: "interrupt", id: p.pid });
    p.casting = null;
  }
  if (p.hp <= 0) {
    p.dead = true;
    p.path = [];
    p.attackTarget = null;
    p.casting = null;
    const lost = deathPenalty(p.level, p.xp);
    p.xp -= lost;
    for (const o of mapState(p.map).monsters.values()) if (o.target === p.id) o.target = null;
    fx(p.map, { t: "die", key: "p:" + p.pid, x: p.x, y: p.y });
    log("death", `${tag(p)} was killed by ${mtag(m)} in ${MAPS[p.map].name} (lost ${lost} base xp)`);
    save(p);
  }
}

// ---------- the tick ----------

function stepPlayer(p: Player, now: number): void {
  if (p.dead) return;
  const ms = mapState(p.map);
  // casting
  if (p.casting && now >= p.casting.endsAt) {
    const c = p.casting;
    p.casting = null;
    touch(p);
    try {
      const s = SKILLS[c.skill];
      if (p.sp < s.sp) refuse(409, "not enough SP");
      if (typeof c.target === "number") {
        const m = ms.monsters.get(c.target);
        if (!m || m.dead) refuse(409, "the target is gone");
        if (dist(p.x, p.y, m!.x, m!.y) > s.range + 2) refuse(422, "the target moved out of range");
      } else if (typeof c.target === "string") {
        const t = players.get(byPid.get(c.target) ?? "");
        if (!t || t.dead || t.map !== p.map) refuse(409, "the target is gone");
      }
      applySkill(p, c.skill, c.target);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      log("cast", `${tag(p)}'s ${SKILLS[c.skill].name} fizzled: ${e.reason}`);
      fx(p.map, { t: "interrupt", id: p.pid });
    }
  }
  // auto-attack
  if (p.attackTarget !== null && !p.casting) {
    const m = ms.monsters.get(p.attackTarget);
    if (!m || m.dead) p.attackTarget = null;
    else if (dist(p.x, p.y, m.x, m.y) <= 1) {
      p.path = [];
      if (now >= p.nextAttackAt && weightPct(p) <= 0.9) {
        p.nextAttackAt = now + p.derived.attackMs;
        const def = MONSTERS[m.type];
        const blow = physicalDamage(
          { atk: p.derived.atk, hit: p.derived.hit, crit: p.derived.crit, blessing: buffOn(p, "blessing") },
          { def: def.def, flee: def.flee, element: def.element }, 1, "neutral", rolls(),
        );
        hitMonster(p, m, blow, "neutral", null);
      }
    } else if (p.path.length === 0 || now % 1000 < TICK_MS) {
      const path = findPath(MAPS[p.map], p.x, p.y, m.x, m.y, 800);
      if (path && path.length) p.path = path.slice(0, -1);
      else p.attackTarget = null;
    }
  }
  // walking
  if (p.path.length && !p.casting) {
    const [x, y] = p.path.shift()!;
    p.x = x;
    p.y = y;
    touch(p);
    const portal = portalAt(MAPS[p.map], x, y);
    if (portal) {
      p.walkStart = null;
      changeMap(p, portal.to, portal.tx, portal.ty);
    } else if (!p.path.length && p.walkStart) {
      // movement is summarised, one line per long walk, never per step
      const [sx, sy] = p.walkStart;
      p.walkStart = null;
      if (now - p.lastMoveLog > 5000) {
        p.lastMoveLog = now;
        log("move", `${tag(p)} walked ${dist(sx, sy, p.x, p.y)} tiles across ${MAPS[p.map].name} to ${p.x},${p.y}${nearby(p)}`);
      }
    }
  }
  // regen
  if (now >= p.regenAt) {
    p.regenAt = now + REGEN_EVERY_MS;
    if (weightPct(p) <= 0.5 && (p.hp < p.derived.maxHp || p.sp < p.derived.maxSp)) {
      const mult = p.map === "town" ? 4 : 1;
      p.hp = Math.min(p.derived.maxHp, p.hp + Math.max(1, Math.round(p.derived.maxHp * 0.02 * mult)));
      p.sp = Math.min(p.derived.maxSp, p.sp + Math.max(1, Math.round(p.derived.maxSp * 0.03 * mult)));
      touch(p);
      p.dirtyMe = true;
    }
  }
  // buffs wearing off
  for (const [b, until] of Object.entries(p.buffs)) {
    if ((until ?? 0) <= now) {
      delete p.buffs[b as BuffId];
      refreshGear(p);
    }
  }
}

function stepMonster(m: Monster, ms: MapState, now: number): void {
  const def = MONSTERS[m.type];
  const map = MAPS[m.map];
  if (m.dead) {
    if (m.spawn && !ms.noRespawn && now >= m.respawnAt) {
      ms.monsters.delete(m.id);
      spawnMonster(m.map, m.type, m.spawn, null, null);
    } else if (!m.spawn) ms.monsters.delete(m.id);
    return;
  }
  if (m.still) return;
  let target = m.target ? players.get(m.target) : undefined;
  // an MVP keeps to its lair: lead it out and it gives up and heals
  const leash = def.ai === "mvp" ? MVP_LEASH : LEASH;
  if (target && (target.dead || target.map !== m.map || dist(m.x, m.y, m.homeX, m.homeY) > leash)) {
    m.target = null;
    target = undefined;
    m.damage.clear();
    m.hp = m.maxHp;
    ms.dirty.add("m:" + m.id);
  }
  if (!target && def.aggroRange > 0) {
    let best: Player | undefined;
    for (const p of ms.players) {
      if (p.dead) continue;
      const d = dist(p.x, p.y, m.x, m.y);
      if (d <= def.aggroRange && (!best || d < dist(best.x, best.y, m.x, m.y))) best = p;
    }
    if (best) {
      m.target = best.id;
      target = best;
      log("aggro", `${mtag(m)} spotted ${tag(best)} and charges`);
    }
  }
  if (target) {
    if (dist(m.x, m.y, target.x, target.y) <= 1) {
      if (now >= m.nextAttackAt) {
        m.nextAttackAt = now + def.atkMs;
        hurtPlayer(m, target);
      }
    } else if (now >= m.nextMoveAt) {
      m.nextMoveAt = now + def.moveTicks * TICK_MS * (def.ai === "aggressive" || def.ai === "mvp" ? 1 : 0.6);
      stepToward(m, ms, target.x, target.y);
    }
    return;
  }
  if (now < m.nextMoveAt) return;
  m.nextMoveAt = now + def.moveTicks * TICK_MS * (1 + Math.random() * 2);
  // the jelly's appetite: free loot nearby draws it in, and it eats it
  if (def.ai === "looter") {
    const free = [...ms.ground.values()].filter((g) => g.ownUntil <= now && dist(g.x, g.y, m.x, m.y) <= 6)
      .sort((a, b) => dist(a.x, a.y, m.x, m.y) - dist(b.x, b.y, m.x, m.y))[0];
    if (free) {
      if (free.x === m.x && free.y === m.y) {
        removeGround(free);
        fx(m.map, { t: "eat", m: m.id, item: free.item });
        log("jelly", `${mtag(m)} swallowed ${qtyName(free.item, free.qty)} (item ${free.id}) nobody picked up`);
      } else stepToward(m, ms, free.x, free.y);
      return;
    }
  }
  if (Math.random() < 0.5) {
    const [dx, dy] = [Math.floor(Math.random() * 3) - 1, Math.floor(Math.random() * 3) - 1];
    const [nx, ny] = [m.x + dx, m.y + dy];
    if (walkable(map, nx, ny) && !portalAt(map, nx, ny) && dist(nx, ny, m.homeX, m.homeY) <= 5 && !occupied(ms, nx, ny, m)) {
      m.x = nx;
      m.y = ny;
      ms.dirty.add("m:" + m.id);
    }
  }
}

// "near Marta the Grocer" / "near a Bristlerat": something a narrator can say
function nearby(p: Player): string {
  const npc = MAPS[p.map].npcs.find((n) => dist(n.x, n.y, p.x, p.y) <= 3);
  if (npc) return `, near ${npc.name}`;
  const m = [...mapState(p.map).monsters.values()].filter((o) => !o.dead && dist(o.x, o.y, p.x, p.y) <= 3)
    .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
  return m ? `, near ${mtag(m)}` : "";
}

const occupied = (ms: MapState, x: number, y: number, self: Monster): boolean =>
  [...ms.monsters.values()].some((o) => o !== self && !o.dead && o.x === x && o.y === y);

function stepToward(m: Monster, ms: MapState, tx: number, ty: number): void {
  const map = MAPS[m.map];
  let best: [number, number] | null = null;
  let bestD = dist(m.x, m.y, tx, ty);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const [nx, ny] = [m.x + dx, m.y + dy];
      if ((!dx && !dy) || !walkable(map, nx, ny) || portalAt(map, nx, ny) || occupied(ms, nx, ny, m)) continue;
      if (dx && dy && (!walkable(map, m.x + dx, m.y) || !walkable(map, m.x, m.y + dy))) continue;
      const d = dist(nx, ny, tx, ty) + (dx && dy ? 0.1 : 0);
      if (d < bestD) [best, bestD] = [[nx, ny], d];
    }
  }
  if (!best) {
    const path = findPath(map, m.x, m.y, tx, ty, 300, (x, y) => occupied(ms, x, y, m));
    if (path && path.length) best = path[0];
  }
  if (best) {
    [m.x, m.y] = best;
    ms.dirty.add("m:" + m.id);
  }
}

function flush(): void {
  for (const ms of maps.values()) {
    if (!ms.dirty.size && !ms.gone.size && !ms.fx.length) continue;
    ms.seq++;
    const ents = [...ms.dirty].map((k) => entityView(ms, k)).filter(Boolean);
    const gone = [...ms.gone].filter((k) => !ms.dirty.has(k) || !entityView(ms, k));
    const chunk = event("delta", { seq: ms.seq, ents, gone, fx: ms.fx });
    ms.dirty.clear();
    ms.gone.clear();
    ms.fx = [];
    for (const p of ms.players) sendTo(p, chunk);
  }
  for (const p of players.values()) {
    if (p.dirtyMe && p.sends.size) {
      p.dirtyMe = false;
      sendTo(p, event("me", meView(p)));
    }
  }
}

function tick(): void {
  const now = Date.now();
  processQueue();
  for (const p of [...players.values()]) stepPlayer(p, now);
  for (const ms of maps.values()) {
    for (const m of [...ms.monsters.values()]) stepMonster(m, ms, now);
    for (const g of [...ms.ground.values()]) {
      if (g.expires <= now) {
        removeGround(g);
        log("ground", `${qtyName(g.item, g.qty)} (item ${g.id}) faded away in ${MAPS[g.map].name}`);
      } else if (g.owner && g.ownUntil <= now && g.ownUntil > now - TICK_MS) {
        ms.dirty.add("i:" + g.id);
      }
    }
  }
  for (const p of [...players.values()]) {
    if (!p.sends.size && now - p.lastActive > OFFLINE_GRACE_MS) goOffline(p);
    else if (now - p.lastSaved > SAVE_EVERY_MS) save(p);
    for (const [id, until] of p.partyInvites) if (until < now) p.partyInvites.delete(id);
    for (const [id, until] of p.guildInvites) if (until < now) p.guildInvites.delete(id);
  }
  flush();
}

// ---------- public reads ----------

export function onlineSummary(): { name: string; job: JobId; level: number; map: string }[] {
  return [...players.values()].map((p) => ({ name: p.name, job: p.job, level: p.level, map: MAPS[p.map].name }));
}

export function audit(): Record<string, unknown> {
  const items = store.db.prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM items").get() as { n: number };
  const zeny = store.db.prepare("SELECT COALESCE(SUM(zeny), 0) AS n FROM characters").get() as { n: number };
  const led = store.db.prepare("SELECT COALESCE(SUM(zeny), 0) AS z, COALESCE(SUM(items), 0) AS i FROM ledger").get() as { z: number; i: number };
  // a card slotted into gear still exists, just inside the gear
  const slotted = (store.db.prepare("SELECT cards FROM items WHERE cards != '[]'").all() as { cards: string }[])
    .reduce((n, r) => n + (JSON.parse(r.cards) as unknown[]).length, 0);
  const mvp = store.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'mvp'").get() as { n: number };
  const mins = store.db.prepare("SELECT (SELECT MIN(qty) FROM items) AS minQty, (SELECT MIN(zeny) FROM characters) AS minZeny").get() as { minQty: number | null; minZeny: number | null };
  return {
    zeny: zeny.n, zenyCreated: led.z, items: items.n, itemsCreated: led.i, slottedCards: slotted,
    balanced: zeny.n === led.z && items.n + slotted === led.i, mvpRewardsLedgered: mvp.n, ...mins, ...counters,
    online: players.size,
  };
}

// ---------- character creation ----------

export function newCharacter(tokenHash: string, name: string, job: JobId): store.CharRow {
  const j = JOBS[job];
  const id = randomUUID();
  const d = derive(job, 1, j.base, []);
  store.createChar({
    id, tokenHash, name, job, stats: { ...j.base }, skills: j.skills.slice(0, 2), zeny: 300,
    map: "town", x: MAPS.town.start[0], y: MAPS.town.start[1], hp: d.maxHp, sp: d.maxSp, starter: j.starter,
  });
  const row = store.charById(id)!;
  log("create", `${who(row)} was born a ${j.name} in Hollowfield`);
  return row;
}

// ---------- test hooks (TEST_HOOKS=1 only; see src/pages/api/test.ts) ----------

export const testing = {
  player: (row: store.CharRow): Player => ensureOnline(row),
  place(p: Player, map: MapId, x: number, y: number): void {
    if (!walkable(MAPS[map], x, y)) throw new GameError(400, "not walkable");
    if (p.map !== map) changeMap(p, map, x, y);
    else {
      p.x = x;
      p.y = y;
      p.path = [];
      touch(p);
    }
    p.dead = false;
  },
  grant(p: Player, zeny: number, items: { item: ItemId; qty: number; refine?: number }[]): void {
    tx(() => {
      if (zeny) store.addZeny(p.id, zeny);
      let n = 0;
      for (const i of items) {
        store.addItem("char", p.id, i.item, i.qty, i.refine ?? 0);
        n += i.qty;
      }
      store.ledger("test-grant", p.id, zeny, n, "test hook");
    });
    refreshGear(p);
  },
  setup(p: Player, o: { level?: number; stats?: Partial<Stats>; hp?: number; sp?: number; skills?: SkillId[]; skillPoints?: number; statPoints?: number; xp?: number }): void {
    if (o.level) p.level = o.level;
    if (o.stats) p.stats = { ...p.stats, ...o.stats };
    if (o.skills) p.skills = o.skills;
    if (o.skillPoints !== undefined) p.skillPoints = o.skillPoints;
    if (o.statPoints !== undefined) p.statPoints = o.statPoints;
    if (o.xp !== undefined) p.xp = o.xp;
    p.cooldowns = {};
    p.buffs = {};
    refreshGear(p);
    p.hp = o.hp ?? p.derived.maxHp;
    p.sp = o.sp ?? p.derived.maxSp;
    p.dead = false;
    save(p);
  },
  clearMap(map: MapId, noRespawn: boolean): void {
    const ms = mapState(map);
    for (const m of ms.monsters.values()) ms.gone.add("m:" + m.id);
    for (const g of ms.ground.values()) ms.gone.add("i:" + g.id);
    ms.monsters.clear();
    ms.ground.clear();
    ms.noRespawn = noRespawn;
  },
  spawn(map: MapId, type: MonsterId, x: number, y: number, hp: number | undefined, still: boolean): number {
    return spawnMonster(map, type, null, [x, y], { hp, still }).id;
  },
  monster(map: MapId, id: number): Record<string, unknown> | null {
    const m = mapState(map).monsters.get(id);
    return m ? { ...monsterView(m), dead: m.dead, target: m.target ? publicId(m.target) : null } : null;
  },
  drop(map: MapId, item: ItemId, x: number, y: number, owner: Player | null): number {
    return dropItem(null, item, 1, owner, [x, y], map).id;
  },
  expireOwnership(map: MapId): void {
    for (const g of mapState(map).ground.values()) g.ownUntil = 0;
  },
  // What a process restart does to memory: everyone and everything live is
  // forgotten, and only SQLite remains.
  wipe(): void {
    for (const p of players.values()) {
      for (const s of p.sends) {
        p.sends.delete(s);
        closers.get(s)?.();
        closers.delete(s);
      }
    }
    players.clear();
    byPid.clear();
    queue.length = 0;
    resetMaps();
  },
};

resetMaps();
// One timer; started once even if the module is evaluated by several routes.
const g = globalThis as unknown as { __hollowfieldTick?: NodeJS.Timeout };
if (!g.__hollowfieldTick) {
  g.__hollowfieldTick = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error(e);
      log("error", "a tick failed; the world carries on");
    }
  }, TICK_MS);
}
setInterval(() => {
  for (const p of players.values()) sendTo(p, ": still here\n\n");
}, 15_000).unref();
