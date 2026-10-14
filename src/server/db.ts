// Everything durable lives here: characters, items (wherever they sit), parties,
// guilds, stalls and a ledger of every zeny or item created or destroyed.
// Anything that moves items or zeny runs inside `tx()`, one SQLite
// transaction, so it either fully happens or changes nothing.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ITEMS, type ItemId, type JobId, type MapId, type SkillId, type Stats } from "../game/data.ts";

const DB_PATH = process.env.DB_PATH ?? "./.data/hollowfield.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    job TEXT NOT NULL,
    level INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    job_level INTEGER NOT NULL,
    job_xp INTEGER NOT NULL,
    stats TEXT NOT NULL,
    stat_points INTEGER NOT NULL,
    skill_points INTEGER NOT NULL,
    skills TEXT NOT NULL,
    zeny INTEGER NOT NULL CHECK (zeny >= 0),
    map TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    hp INTEGER NOT NULL,
    sp INTEGER NOT NULL,
    party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
    guild_id INTEGER REFERENCES guilds(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    leader_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guilds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    leader_id TEXT NOT NULL
  );
  -- owner_kind: 'char' (inventory), 'stall' (a character's vending stall),
  -- 'guild' (guild storage). An item row has exactly one owner.
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('char', 'stall', 'guild')),
    owner_id TEXT NOT NULL,
    item TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    refine INTEGER NOT NULL DEFAULT 0,
    cards TEXT NOT NULL DEFAULT '[]',
    equipped TEXT,
    price INTEGER
  );
  CREATE INDEX IF NOT EXISTS items_owner ON items (owner_kind, owner_id);
  CREATE TABLE IF NOT EXISTS stalls (
    char_id TEXT PRIMARY KEY REFERENCES characters(id),
    title TEXT NOT NULL,
    map TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    opened_at INTEGER NOT NULL
  );
  -- Every zeny or item that enters or leaves the world, so conservation can
  -- be audited: trades and stalls never appear here, they only move things.
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    char_id TEXT NOT NULL,
    zeny INTEGER NOT NULL,
    items INTEGER NOT NULL,
    note TEXT NOT NULL
  );
`);

export const tx = <T>(fn: () => T): T => db.transaction(fn)();

export interface CharRow {
  id: string;
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
  zeny: number;
  map: MapId;
  x: number;
  y: number;
  hp: number;
  sp: number;
  partyId: number | null;
  guildId: number | null;
}

const charCols = `id, name, job, level, xp, job_level AS jobLevel, job_xp AS jobXp, stats, stat_points AS statPoints,
  skill_points AS skillPoints, skills, zeny, map, x, y, hp, sp, party_id AS partyId, guild_id AS guildId`;

const parseChar = (r: Record<string, unknown> | undefined): CharRow | undefined =>
  r ? ({ ...r, stats: JSON.parse(r.stats as string), skills: JSON.parse(r.skills as string) } as CharRow) : undefined;

const byToken = db.prepare(`SELECT ${charCols} FROM characters WHERE token_hash = ?`);
const byId = db.prepare(`SELECT ${charCols} FROM characters WHERE id = ?`);
const nameTaken = db.prepare("SELECT 1 FROM characters WHERE name = ?");

export const charByToken = (hash: string): CharRow | undefined => parseChar(byToken.get(hash) as Record<string, unknown>);
export const charById = (id: string): CharRow | undefined => parseChar(byId.get(id) as Record<string, unknown>);
export const isNameTaken = (name: string): boolean => nameTaken.get(name) !== undefined;

const insertChar = db.prepare(`INSERT INTO characters
  (id, token_hash, name, job, level, xp, job_level, job_xp, stats, stat_points, skill_points, skills, zeny, map, x, y, hp, sp, created_at, last_seen)
  VALUES (@id, @tokenHash, @name, @job, 1, 0, 1, 0, @stats, 0, 0, @skills, @zeny, @map, @x, @y, @hp, @sp, @now, @now)`);

export function createChar(c: {
  id: string; tokenHash: string; name: string; job: JobId; stats: Stats; skills: SkillId[]; zeny: number;
  map: MapId; x: number; y: number; hp: number; sp: number; starter: ItemId;
}): void {
  tx(() => {
    insertChar.run({ ...c, stats: JSON.stringify(c.stats), skills: JSON.stringify(c.skills), now: Date.now() });
    const id = addItem("char", c.id, c.starter, 1);
    db.prepare("UPDATE items SET equipped = 'weapon' WHERE id = ?").run(id);
    addItem("char", c.id, "red_potion", 5);
    ledger("start", c.id, c.zeny, 6, "starting kit");
  });
}

const saveStmt = db.prepare(`UPDATE characters SET level=@level, xp=@xp, job_level=@jobLevel, job_xp=@jobXp, stats=@stats,
  stat_points=@statPoints, skill_points=@skillPoints, skills=@skills, map=@map, x=@x, y=@y, hp=@hp, sp=@sp, last_seen=@now WHERE id=@id`);

// Progress and position. Zeny, party and guild are never written from here:
// they only change inside their own transactions.
export function saveProgress(c: Omit<CharRow, "zeny" | "partyId" | "guildId" | "name" | "job">): void {
  saveStmt.run({ ...c, stats: JSON.stringify(c.stats), skills: JSON.stringify(c.skills), now: Date.now() });
}

export const getZeny = (id: string): number =>
  (db.prepare("SELECT zeny FROM characters WHERE id = ?").get(id) as { zeny: number }).zeny;

// Throws (rolling back the surrounding transaction) rather than go negative.
export function addZeny(id: string, delta: number): number {
  const z = getZeny(id) + delta;
  if (z < 0) throw new GameError(409, "not enough zeny");
  db.prepare("UPDATE characters SET zeny = ? WHERE id = ?").run(z, id);
  return z;
}

export function ledger(kind: string, charId: string, zeny: number, items: number, note: string): void {
  db.prepare("INSERT INTO ledger (at, kind, char_id, zeny, items, note) VALUES (?, ?, ?, ?, ?, ?)").run(
    Date.now(), kind, charId, zeny, items, note,
  );
}

export class GameError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- items ----------

export type OwnerKind = "char" | "stall" | "guild";
export interface ItemRow {
  id: number;
  item: ItemId;
  qty: number;
  refine: number;
  cards: ItemId[];
  equipped: string | null;
  price: number | null;
}

const parseItem = (r: Record<string, unknown>): ItemRow => ({ ...(r as unknown as ItemRow), cards: JSON.parse(r.cards as string) });

export const stackable = (item: ItemId): boolean => ITEMS[item].kind !== "equip";

export function itemsOf(kind: OwnerKind, owner: string): ItemRow[] {
  return (db.prepare("SELECT id, item, qty, refine, cards, equipped, price FROM items WHERE owner_kind = ? AND owner_id = ? ORDER BY id")
    .all(kind, owner) as Record<string, unknown>[]).map(parseItem);
}

export function itemById(id: number): (ItemRow & { ownerKind: OwnerKind; ownerId: string }) | undefined {
  const r = db.prepare("SELECT id, item, qty, refine, cards, equipped, price, owner_kind AS ownerKind, owner_id AS ownerId FROM items WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return r ? (parseItem(r) as ItemRow & { ownerKind: OwnerKind; ownerId: string }) : undefined;
}

// Adds to an existing plain stack where possible. Returns the row id.
export function addItem(kind: OwnerKind, owner: string, item: ItemId, qty: number, refine = 0, cards: ItemId[] = [], price: number | null = null): number {
  if (qty <= 0) throw new GameError(400, "quantity must be positive");
  if (stackable(item) && refine === 0 && cards.length === 0) {
    const row = db.prepare(
      "SELECT id FROM items WHERE owner_kind = ? AND owner_id = ? AND item = ? AND refine = 0 AND cards = '[]' AND equipped IS NULL AND price IS ?",
    ).get(kind, owner, item, price) as { id: number } | undefined;
    if (row) {
      db.prepare("UPDATE items SET qty = qty + ? WHERE id = ?").run(qty, row.id);
      return row.id;
    }
    return Number(db.prepare("INSERT INTO items (owner_kind, owner_id, item, qty, price) VALUES (?, ?, ?, ?, ?)")
      .run(kind, owner, item, qty, price).lastInsertRowid);
  }
  let last = 0;
  for (let i = 0; i < qty; i++) {
    last = Number(db.prepare("INSERT INTO items (owner_kind, owner_id, item, qty, refine, cards, price) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .run(kind, owner, item, refine, JSON.stringify(cards), price).lastInsertRowid);
  }
  return last;
}

// Removes qty from a row, deleting it at zero. Throws rather than go negative.
export function takeItem(id: number, qty: number): ItemRow {
  const row = itemById(id);
  if (!row) throw new GameError(404, "no such item");
  if (!Number.isInteger(qty) || qty <= 0 || qty > row.qty) throw new GameError(409, "not that many");
  if (qty === row.qty) db.prepare("DELETE FROM items WHERE id = ?").run(id);
  else db.prepare("UPDATE items SET qty = qty - ? WHERE id = ?").run(qty, id);
  return row;
}

// Moves qty of a row to a new owner, merging stacks where possible.
export function moveItem(id: number, qty: number, kind: OwnerKind, owner: string, price: number | null = null): number {
  const row = takeItem(id, qty);
  return addItem(kind, owner, row.item, qty, row.refine, row.cards, price);
}

export const setEquipped = (id: number, slot: string | null): void => {
  db.prepare("UPDATE items SET equipped = ? WHERE id = ?").run(slot, id);
};
export const setRefine = (id: number, refine: number): void => {
  db.prepare("UPDATE items SET refine = ? WHERE id = ?").run(refine, id);
};
export const setCards = (id: number, cards: ItemId[]): void => {
  db.prepare("UPDATE items SET cards = ? WHERE id = ?").run(JSON.stringify(cards), id);
};

// ---------- parties and guilds ----------

export const partyById = (id: number): { id: number; name: string; leaderId: string } | undefined =>
  db.prepare("SELECT id, name, leader_id AS leaderId FROM parties WHERE id = ?").get(id) as never;
export const guildById = (id: number): { id: number; name: string; leaderId: string } | undefined =>
  db.prepare("SELECT id, name, leader_id AS leaderId FROM guilds WHERE id = ?").get(id) as never;

export function membersOf(col: "party_id" | "guild_id", id: number): { id: string; name: string; job: JobId; level: number }[] {
  return db.prepare(`SELECT id, name, job, level FROM characters WHERE ${col} = ? ORDER BY name`).all(id) as never;
}

export function createGroup(table: "parties" | "guilds", name: string, leaderId: string): number {
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name);
  if (exists) throw new GameError(409, "that name is taken");
  return Number(db.prepare(`INSERT INTO ${table} (name, leader_id) VALUES (?, ?)`).run(name, leaderId).lastInsertRowid);
}

export function setGroup(col: "party_id" | "guild_id", charId: string, groupId: number | null): void {
  db.prepare(`UPDATE characters SET ${col} = ? WHERE id = ?`).run(groupId, charId);
}

// When the last member leaves, the group goes; when the leader leaves, the
// longest-standing remaining member (lowest name, for determinism) leads.
export function tidyGroup(table: "parties" | "guilds", col: "party_id" | "guild_id", id: number, leaving: string): void {
  const rest = membersOf(col, id);
  if (rest.length === 0) {
    if (table === "guilds") {
      const stored = db.prepare("SELECT COUNT(*) AS n FROM items WHERE owner_kind = 'guild' AND owner_id = ?").get(String(id)) as { n: number };
      if (stored.n > 0) return; // a guild with things in storage outlives its members
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  } else {
    const g = db.prepare(`SELECT leader_id AS leaderId FROM ${table} WHERE id = ?`).get(id) as { leaderId: string };
    if (g.leaderId === leaving) db.prepare(`UPDATE ${table} SET leader_id = ? WHERE id = ?`).run(rest[0].id, id);
  }
}

// ---------- stalls ----------

export interface StallRow {
  charId: string;
  title: string;
  map: MapId;
  x: number;
  y: number;
}
export const stallOf = (charId: string): StallRow | undefined =>
  db.prepare("SELECT char_id AS charId, title, map, x, y FROM stalls WHERE char_id = ?").get(charId) as never;
export const allStalls = (): (StallRow & { name: string })[] =>
  db.prepare("SELECT s.char_id AS charId, s.title, s.map, s.x, s.y, c.name FROM stalls s JOIN characters c ON c.id = s.char_id").all() as never;
export function openStallRow(s: StallRow): void {
  db.prepare("INSERT INTO stalls (char_id, title, map, x, y, opened_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.charId, s.title, s.map, s.x, s.y, Date.now());
}
export const closeStallRow = (charId: string): void => {
  db.prepare("DELETE FROM stalls WHERE char_id = ?").run(charId);
};

// ---------- the no-JavaScript front page ----------

export const topCharacters = (n: number): { name: string; job: JobId; level: number }[] =>
  db.prepare("SELECT name, job, level FROM characters ORDER BY level DESC, xp DESC, created_at ASC LIMIT ?").all(n) as never;
export const characterCount = (): number => (db.prepare("SELECT COUNT(*) AS n FROM characters").get() as { n: number }).n;
