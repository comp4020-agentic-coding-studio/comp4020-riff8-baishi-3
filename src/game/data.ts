// Everything the server and the client both need to agree on: jobs, skills,
// monsters, items and the maps. Pure data plus deterministic map builders, so
// both sides import the same file and draw/validate the same world.

export type Sheet = "town" | "dungeon";
export interface Sprite {
  sheet: Sheet;
  i: number;
}
const T = (i: number): Sprite => ({ sheet: "town", i });
const D = (i: number): Sprite => ({ sheet: "dungeon", i });

export const TILE = 16;
export const SHEET_COLS = 12;

export type Element = "neutral" | "fire" | "water" | "earth";
// attacker element -> defender element -> multiplier (missing = 1)
export const ELEMENT_TABLE: Record<Element, Partial<Record<Element, number>>> = {
  neutral: {},
  fire: { earth: 1.5, water: 0.5, fire: 0.5 },
  water: { fire: 1.5, earth: 0.5, water: 0.5 },
  earth: { water: 1.5, fire: 0.5, earth: 0.5 },
};

export const STATS = ["str", "agi", "vit", "int", "dex", "luk"] as const;
export type Stat = (typeof STATS)[number];
export type Stats = Record<Stat, number>;

export type JobId = "warden" | "ember" | "mender";
export interface JobDef {
  name: string;
  role: string;
  blurb: string;
  sprite: Sprite;
  hpMod: number;
  spMod: number;
  base: Stats;
  starter: ItemId;
  skills: SkillId[];
}

export const JOBS: Record<JobId, JobDef> = {
  warden: {
    name: "Warden",
    role: "fighter",
    blurb: "Holds the line: taunts monsters off friends and takes the hits.",
    sprite: D(97),
    hpMod: 1.5,
    spMod: 0.6,
    base: { str: 8, agi: 5, vit: 8, int: 1, dex: 5, luk: 3 },
    starter: "training_blade",
    skills: ["bash", "provoke", "endure", "sweep"],
  },
  ember: {
    name: "Ember",
    role: "caster",
    blurb: "Burns or chills from behind. Fragile; needs someone in front.",
    sprite: D(84),
    hpMod: 0.8,
    spMod: 1.5,
    base: { str: 2, agi: 4, vit: 4, int: 10, dex: 8, luk: 2 },
    starter: "oak_staff",
    skills: ["firebolt", "frost_lance", "flame_ring", "meditate"],
  },
  mender: {
    name: "Mender",
    role: "healer",
    blurb: "Keeps friends standing: heals, blessings and haste.",
    sprite: D(99),
    hpMod: 1.0,
    spMod: 1.3,
    base: { str: 3, agi: 5, vit: 6, int: 8, dex: 5, luk: 3 },
    starter: "willow_wand",
    skills: ["heal", "blessing", "sanctuary", "quicken"],
  },
};

export type SkillId =
  | "bash"
  | "provoke"
  | "endure"
  | "sweep"
  | "firebolt"
  | "frost_lance"
  | "flame_ring"
  | "meditate"
  | "heal"
  | "blessing"
  | "sanctuary"
  | "quicken";

export type SkillTarget = "monster" | "ally" | "self";
export interface SkillDef {
  name: string;
  job: JobId;
  key: string;
  target: SkillTarget;
  range: number;
  sp: number;
  castMs: number;
  cdMs: number;
  prereq: SkillId[];
  desc: string;
  // damage skills
  kind?: "phys" | "magic";
  mult?: number;
  element?: Element;
  radius?: number; // area around the target (or self, for self-target)
  // support
  heal?: boolean;
  buff?: { id: BuffId; ms: number };
  taunt?: boolean;
  restoreSpPct?: number;
}

export type BuffId = "endure" | "blessing" | "quicken";

export const SKILLS: Record<SkillId, SkillDef> = {
  bash: {
    name: "Bash", job: "warden", key: "1", target: "monster", range: 1, sp: 8, castMs: 0, cdMs: 1500,
    prereq: [], kind: "phys", mult: 1.8, element: "neutral", desc: "A heavy blow: 180% damage.",
  },
  provoke: {
    name: "Provoke", job: "warden", key: "2", target: "monster", range: 5, sp: 5, castMs: 0, cdMs: 5000,
    prereq: [], taunt: true, desc: "The monster turns on you, whoever it was chasing.",
  },
  endure: {
    name: "Endure", job: "warden", key: "3", target: "self", range: 0, sp: 10, castMs: 0, cdMs: 20000,
    prereq: ["provoke"], buff: { id: "endure", ms: 15000 }, desc: "+12 defence for 15s, and casts can't be broken.",
  },
  sweep: {
    name: "Ember Sweep", job: "warden", key: "4", target: "self", range: 0, sp: 15, castMs: 0, cdMs: 4000,
    prereq: ["bash", "endure"], kind: "phys", mult: 1.3, element: "fire", radius: 1, desc: "Fire-edged swing hitting everything next to you.",
  },
  firebolt: {
    name: "Firebolt", job: "ember", key: "1", target: "monster", range: 6, sp: 10, castMs: 900, cdMs: 1200,
    prereq: [], kind: "magic", mult: 1.6, element: "fire", desc: "Fire from range. Mossy things burn (x1.5).",
  },
  frost_lance: {
    name: "Frost Lance", job: "ember", key: "2", target: "monster", range: 6, sp: 10, castMs: 900, cdMs: 1200,
    prereq: [], kind: "magic", mult: 1.6, element: "water", desc: "Water from range. Douses fire (x1.5).",
  },
  flame_ring: {
    name: "Flame Ring", job: "ember", key: "3", target: "monster", range: 5, sp: 25, castMs: 1800, cdMs: 5000,
    prereq: ["firebolt"], kind: "magic", mult: 1.2, element: "fire", radius: 2, desc: "Fire on everything within 2 tiles of the target.",
  },
  meditate: {
    name: "Meditate", job: "ember", key: "4", target: "self", range: 0, sp: 0, castMs: 2000, cdMs: 30000,
    prereq: ["flame_ring"], restoreSpPct: 0.35, desc: "Recover 35% SP after a 2s focus.",
  },
  heal: {
    name: "Heal", job: "mender", key: "1", target: "ally", range: 6, sp: 12, castMs: 600, cdMs: 800,
    prereq: [], heal: true, desc: "Restore HP to yourself or a friend.",
  },
  blessing: {
    name: "Blessing", job: "mender", key: "2", target: "ally", range: 6, sp: 15, castMs: 0, cdMs: 10000,
    prereq: [], buff: { id: "blessing", ms: 30000 }, desc: "+20% damage and +10 hit for 30s.",
  },
  sanctuary: {
    name: "Sanctuary", job: "mender", key: "3", target: "self", range: 0, sp: 30, castMs: 1500, cdMs: 8000,
    prereq: ["heal"], heal: true, radius: 2, desc: "Heal every player within 2 tiles of you.",
  },
  quicken: {
    name: "Quicken", job: "mender", key: "4", target: "ally", range: 6, sp: 18, castMs: 0, cdMs: 12000,
    prereq: ["blessing", "sanctuary"], buff: { id: "quicken", ms: 30000 }, desc: "Attacks 30% faster for 30s.",
  },
};

export type ItemId =
  | "red_potion"
  | "blue_potion"
  | "jelly_gel"
  | "gnawed_key"
  | "spinner_fang"
  | "ember_shell"
  | "grave_dust"
  | "training_blade"
  | "iron_sword"
  | "oak_staff"
  | "ember_rod"
  | "willow_wand"
  | "wooden_buckler"
  | "iron_buckler"
  | "mossling_card"
  | "rat_card"
  | "spinner_card"
  | "crab_card"
  | "bat_card"
  | "wight_card";

export type EquipSlot = "weapon" | "armor";
export interface CardBonus {
  atk?: number;
  matk?: number;
  def?: number;
  flee?: number;
  hpPct?: number;
  crit?: number;
}
export interface ItemDef {
  name: string;
  sprite: Sprite;
  weight: number;
  price: number; // shop buy price; sell is half
  kind: "consumable" | "loot" | "equip" | "card";
  heal?: number;
  sp?: number;
  slot?: EquipSlot;
  jobs?: JobId[];
  atk?: number;
  matk?: number;
  def?: number;
  slots?: number;
  card?: CardBonus;
  rare?: boolean;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  red_potion: { name: "Red Potion", sprite: D(115), weight: 7, price: 50, kind: "consumable", heal: 50 },
  blue_potion: { name: "Blue Potion", sprite: D(116), weight: 7, price: 200, kind: "consumable", sp: 40 },
  jelly_gel: { name: "Jelly Gel", sprite: D(125), weight: 1, price: 14, kind: "loot" },
  gnawed_key: { name: "Gnawed Key", sprite: T(117), weight: 2, price: 24, kind: "loot" },
  spinner_fang: { name: "Spinner Fang", sprite: D(131), weight: 2, price: 36, kind: "loot" },
  ember_shell: { name: "Ember Shell", sprite: T(93), weight: 10, price: 240, kind: "loot" },
  grave_dust: { name: "Grave Dust", sprite: D(126), weight: 1, price: 60, kind: "loot" },
  training_blade: { name: "Training Blade", sprite: D(103), weight: 40, price: 150, kind: "equip", slot: "weapon", jobs: ["warden"], atk: 12, slots: 1 },
  iron_sword: { name: "Iron Sword", sprite: D(104), weight: 70, price: 1200, kind: "equip", slot: "weapon", jobs: ["warden"], atk: 30, slots: 1 },
  oak_staff: { name: "Oak Staff", sprite: D(129), weight: 30, price: 150, kind: "equip", slot: "weapon", jobs: ["ember"], atk: 5, matk: 16, slots: 1 },
  ember_rod: { name: "Ember Rod", sprite: D(131), weight: 40, price: 1200, kind: "equip", slot: "weapon", jobs: ["ember"], atk: 8, matk: 34, slots: 1 },
  willow_wand: { name: "Willow Wand", sprite: D(130), weight: 25, price: 150, kind: "equip", slot: "weapon", jobs: ["mender"], atk: 6, matk: 12, slots: 1 },
  wooden_buckler: { name: "Wooden Buckler", sprite: D(66), weight: 30, price: 120, kind: "equip", slot: "armor", def: 4, slots: 1 },
  iron_buckler: { name: "Iron Buckler", sprite: D(102), weight: 60, price: 900, kind: "equip", slot: "armor", def: 9, slots: 1 },
  mossling_card: { name: "Mossling Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { hpPct: 0.15 }, rare: true },
  rat_card: { name: "Bristlerat Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { atk: 8 }, rare: true },
  spinner_card: { name: "Webspinner Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { flee: 10 }, rare: true },
  crab_card: { name: "Ember Crab Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { atk: 15, matk: 15 }, rare: true },
  bat_card: { name: "Dusk Bat Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { crit: 6 }, rare: true },
  wight_card: { name: "Barrow Wight Card", sprite: D(101), weight: 1, price: 40, kind: "card", card: { def: 10, hpPct: 0.2 }, rare: true },
};

// What the town shop sells. Everything sells back for half its price.
export const SHOP_STOCK: ItemId[] = [
  "red_potion", "blue_potion", "training_blade", "oak_staff", "willow_wand", "wooden_buckler",
  "iron_sword", "ember_rod", "iron_buckler",
];

export type MonsterId =
  | "mossling"
  | "bristlerat"
  | "webspinner"
  | "ember_crab"
  | "dusk_bat"
  | "cairn_beetle"
  | "grave_jelly"
  | "barrow_wight";
export type AiKind = "looter" | "aggressive" | "caller" | "mvp";
export interface MonsterDef {
  name: string;
  sprite: Sprite;
  scale: number;
  level: number;
  hp: number;
  atk: number;
  def: number;
  hit: number;
  flee: number;
  element: Element;
  baseXp: number;
  jobXp: number;
  ai: AiKind;
  hue?: number; // canvas hue-rotate, to recolour a shared sprite
  aggroRange: number;
  moveTicks: number;
  atkMs: number;
  drops: { item: ItemId; chance: number }[];
  mvpReward?: ItemId;
  respawnMs: number;
  temperament: string;
}

export const MONSTERS: Record<MonsterId, MonsterDef> = {
  mossling: {
    name: "Mossling", sprite: D(108), scale: 1, level: 2, hp: 60, atk: 7, def: 2, hit: 2, flee: 2,
    element: "earth", baseXp: 12, jobXp: 8, ai: "looter", aggroRange: 0, moveTicks: 6, atkMs: 2000,
    drops: [{ item: "jelly_gel", chance: 0.6 }, { item: "red_potion", chance: 0.08 }, { item: "mossling_card", chance: 0.02 }],
    respawnMs: 8000, temperament: "Passive. Wanders, and eats any loot left lying free on the ground.",
  },
  bristlerat: {
    name: "Bristlerat", sprite: D(123), scale: 1, level: 4, hp: 110, atk: 14, def: 4, hit: 6, flee: 8,
    element: "neutral", baseXp: 28, jobXp: 18, ai: "aggressive", aggroRange: 4, moveTicks: 3, atkMs: 1700,
    drops: [{ item: "gnawed_key", chance: 0.45 }, { item: "red_potion", chance: 0.1 }, { item: "rat_card", chance: 0.02 }],
    respawnMs: 10000, temperament: "Aggressive. Chases anyone who strays close.",
  },
  webspinner: {
    name: "Webspinner", sprite: D(122), scale: 1, level: 6, hp: 170, atk: 18, def: 6, hit: 8, flee: 10,
    element: "earth", baseXp: 45, jobXp: 30, ai: "caller", aggroRange: 0, moveTicks: 4, atkMs: 1800,
    drops: [{ item: "spinner_fang", chance: 0.4 }, { item: "blue_potion", chance: 0.05 }, { item: "spinner_card", chance: 0.02 }],
    respawnMs: 12000, temperament: "Passive until hit; then every spinner nearby comes running.",
  },
  ember_crab: {
    name: "Ember Crab", sprite: D(110), scale: 2, level: 15, hp: 2400, atk: 42, def: 12, hit: 25, flee: 10,
    element: "fire", baseXp: 900, jobXp: 600, ai: "mvp", aggroRange: 5, moveTicks: 4, atkMs: 1500,
    drops: [{ item: "ember_shell", chance: 1 }, { item: "iron_buckler", chance: 0.3 }],
    mvpReward: "crab_card", respawnMs: 180000,
    temperament: "MVP. Hits hard and hates water. Respawns every three minutes.",
  },
  dusk_bat: {
    name: "Dusk Bat", sprite: D(120), scale: 1, level: 10, hp: 260, atk: 28, def: 6, hit: 18, flee: 30,
    element: "neutral", baseXp: 90, jobXp: 60, ai: "aggressive", aggroRange: 5, moveTicks: 2, atkMs: 1400,
    drops: [{ item: "grave_dust", chance: 0.3 }, { item: "blue_potion", chance: 0.06 }, { item: "bat_card", chance: 0.02 }],
    respawnMs: 12000, temperament: "Aggressive and quick; hard to hit.",
  },
  cairn_beetle: {
    name: "Cairn Beetle", sprite: D(124), scale: 1, level: 12, hp: 420, atk: 30, def: 18, hit: 16, flee: 4,
    element: "earth", baseXp: 130, jobXp: 90, ai: "caller", aggroRange: 0, moveTicks: 5, atkMs: 2000,
    drops: [{ item: "grave_dust", chance: 0.5 }, { item: "red_potion", chance: 0.2 }],
    respawnMs: 14000, temperament: "Armoured. Calls its kin when struck. Burns.",
  },
  grave_jelly: {
    name: "Grave Jelly", sprite: D(108), hue: 200, scale: 1, level: 11, hp: 300, atk: 22, def: 8, hit: 14, flee: 6,
    element: "water", baseXp: 100, jobXp: 70, ai: "looter", aggroRange: 0, moveTicks: 6, atkMs: 2000,
    drops: [{ item: "jelly_gel", chance: 0.8 }, { item: "blue_potion", chance: 0.08 }],
    respawnMs: 12000, temperament: "Passive. Drifts toward loot nobody claimed and swallows it.",
  },
  barrow_wight: {
    name: "Barrow Wight", sprite: D(121), scale: 2, level: 25, hp: 6000, atk: 70, def: 20, hit: 40, flee: 20,
    element: "water", baseXp: 3000, jobXp: 2000, ai: "mvp", aggroRange: 6, moveTicks: 4, atkMs: 1400,
    drops: [{ item: "grave_dust", chance: 1 }, { item: "iron_sword", chance: 0.25 }, { item: "ember_rod", chance: 0.25 }],
    mvpReward: "wight_card", respawnMs: 300000,
    temperament: "MVP of the Barrow. Earth breaks it. Respawns every five minutes.",
  },
};

export const EMOTES = ["!", "?", "♥", "♪", "…", "zZ", "★", "💢"] as const;

// ---------- maps ----------

export type MapId = "town" | "field" | "barrow";
export interface TileDef {
  sprite: Sprite;
  walk: boolean;
  under?: Sprite;
}
export const TERRAIN: Record<string, TileDef> = {
  ".": { sprite: T(0), walk: true },
  "'": { sprite: T(1), walk: true },
  "*": { sprite: T(2), walk: true },
  ",": { sprite: T(25), walk: true },
  ":": { sprite: T(25), walk: true },
  m: { sprite: T(29), walk: true, under: T(0) },
  T: { sprite: T(16), walk: false, under: T(0) },
  Y: { sprite: T(15), walk: false, under: T(0) },
  b: { sprite: T(5), walk: false, under: T(0) },
  P: { sprite: D(56), walk: true, under: T(25) },
  Q: { sprite: D(56), walk: true, under: D(0) },
  d: { sprite: D(0), walk: true },
  r: { sprite: D(12), walk: true },
  s: { sprite: D(48), walk: true },
  "#": { sprite: D(40), walk: false },
};

export interface Prop {
  x: number;
  y: number;
  sprite: Sprite;
  under?: Sprite;
}
export interface Npc {
  id: "shop" | "smith" | "steward";
  name: string;
  x: number;
  y: number;
  sprite: Sprite;
  line: string;
}
export interface Portal {
  x: number;
  y: number;
  to: MapId;
  tx: number;
  ty: number;
}
export interface Spawn {
  monster: MonsterId;
  count: number;
  zone: [number, number, number, number]; // x0 y0 x1 y1 inclusive
}
export interface GameMap {
  id: MapId;
  name: string;
  w: number;
  h: number;
  tiles: string[]; // terrain chars, one string per row
  props: Prop[];
  npcs: Npc[];
  portals: Portal[];
  spawns: Spawn[];
  start: [number, number];
  blocked: boolean[]; // derived: terrain + props + npcs
}

// Deterministic per-tile noise, so server and client build identical maps.
function noise(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function house(x: number, y: number, roof: "red" | "grey"): Prop[] {
  const r = roof === "red" ? [52, 53, 54, 64, 65, 66] : [48, 49, 50, 60, 61, 62];
  const out: Prop[] = [];
  for (let i = 0; i < 3; i++) {
    out.push({ x: x + i, y, sprite: T(r[i]), under: T(0) });
    out.push({ x: x + i, y: y + 1, sprite: T(r[3 + i]), under: T(0) });
  }
  const [win, door] = roof === "red" ? [84, 85] : [88, 89];
  out.push({ x, y: y + 2, sprite: T(win), under: T(0) });
  out.push({ x: x + 1, y: y + 2, sprite: T(door), under: T(0) });
  out.push({ x: x + 2, y: y + 2, sprite: T(win), under: T(0) });
  return out;
}

function finish(m: Omit<GameMap, "blocked">): GameMap {
  if (m.tiles.length !== m.h || m.tiles.some((row) => row.length !== m.w)) {
    throw new Error(`map ${m.id}: rows must be ${m.w} wide and ${m.h} tall`);
  }
  const blocked = new Array<boolean>(m.w * m.h).fill(false);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const def = TERRAIN[m.tiles[y][x]];
      if (!def) throw new Error(`map ${m.id}: unknown terrain ${m.tiles[y][x]}`);
      blocked[y * m.w + x] = !def.walk;
    }
  }
  for (const p of m.props) blocked[p.y * m.w + p.x] = true;
  for (const n of m.npcs) blocked[n.y * m.w + n.x] = true;
  return { ...m, blocked };
}

function buildTown(): GameMap {
  const inner = [
    ".'.......*.....,.........'",
    "..............,,......*...",
    "..'...........,,..........",
    "..............,,.......'..",
    ".....'........,,..........",
    ",,,,,,,,,,,,,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,,,,,,,,,,,,,",
    "......::::::::::::::......",
    ".'....::::::::::::::...'..",
    "......::::::::::::::......",
    "......::::::::::::::......",
    "..*...::::::::::::::......",
    "..............,,.......*..",
    "...m..........,,..........",
    ".....'........,,......'...",
    ".........*....,,..........",
  ];
  const tiles = ["Y".repeat(28)];
  inner.forEach((row, i) => {
    const y = i + 1;
    const right = y === 6 || y === 7 ? "P" : "Y";
    tiles.push("Y" + row.padEnd(26, ".") + right);
  });
  tiles.push("Y".repeat(28));
  return finish({
    id: "town",
    name: "Hollowfield",
    w: 28,
    h: 18,
    tiles,
    props: [
      ...house(3, 1, "red"),
      ...house(20, 1, "grey"),
      ...house(3, 13, "grey"),
      ...house(20, 13, "red"),
      { x: 14, y: 10, sprite: T(104), under: T(25) },
      { x: 20, y: 9, sprite: D(74), under: T(25) },
      { x: 25, y: 5, sprite: T(83), under: T(0) },
    ],
    npcs: [
      { id: "shop", name: "Marta the Grocer", x: 8, y: 9, sprite: D(88), line: "Potions, blades and bucklers. I buy loot too." },
      { id: "smith", name: "Old Tobin", x: 19, y: 9, sprite: D(86), line: "Refining's safe to +4. After that, the anvil decides." },
      { id: "steward", name: "Ilse the Steward", x: 14, y: 12, sprite: D(87), line: "Guild chests, for guild members only." },
    ],
    portals: [
      { x: 27, y: 6, to: "field", tx: 1, ty: 10 },
      { x: 27, y: 7, to: "field", tx: 1, ty: 11 },
    ],
    spawns: [],
    start: [14, 8],
  });
}

// Fields are generated, not drawn: border trees, a road from the portal,
// scattered trees and flowers, then any walkable pocket the road can't reach
// is filled in so every open tile is reachable.
function buildWild(opts: {
  id: MapId;
  name: string;
  w: number;
  h: number;
  salt: number;
  floor: (n: number) => string;
  wall: (n: number) => string;
  obstacle: number;
  road: { y: number; to: number; ch: string };
  portals: Portal[];
  portalCh: string;
  spawns: Spawn[];
  start: [number, number];
  clear?: [number, number][];
}): GameMap {
  const { w, h, salt } = opts;
  const grid: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const n = noise(x, y, salt);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) row.push(opts.wall(n));
      else if (n < opts.obstacle && !(y >= opts.road.y - 1 && y <= opts.road.y + 2 && x <= opts.road.to + 1)) {
        row.push(opts.wall(noise(y, x, salt)));
      } else row.push(opts.floor(noise(y, x, salt + 1)));
    }
    grid.push(row);
  }
  for (let x = 0; x <= opts.road.to; x++) {
    grid[opts.road.y][x] = opts.road.ch;
    grid[opts.road.y + 1][x] = opts.road.ch;
  }
  for (const [x, y] of opts.clear ?? []) grid[y][x] = opts.road.ch;
  for (const p of opts.portals) grid[p.y][p.x] = opts.portalCh;
  // flood fill from start; unreachable walkables become walls
  const seen = new Set<number>();
  const stack: [number, number][] = [opts.start];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (seen.has(k) || !TERRAIN[grid[y][x]].walk) continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (TERRAIN[grid[y][x]].walk && !seen.has(y * w + x)) grid[y][x] = opts.wall(noise(x, y, salt + 2));
    }
  }
  return finish({
    id: opts.id,
    name: opts.name,
    w,
    h,
    tiles: grid.map((r) => r.join("")),
    props: [],
    npcs: [],
    portals: opts.portals,
    spawns: opts.spawns,
    start: opts.start,
  });
}

function buildField(): GameMap {
  return buildWild({
    id: "field",
    name: "Amber Fields",
    w: 36,
    h: 22,
    salt: 7,
    floor: (n) => (n < 0.14 ? "'" : n < 0.18 ? "*" : n < 0.19 ? "m" : "."),
    wall: (n) => (n < 0.5 ? "T" : n < 0.85 ? "Y" : "b"),
    obstacle: 0.06,
    road: { y: 10, to: 7, ch: "," },
    portals: [
      { x: 0, y: 10, to: "town", tx: 26, ty: 6 },
      { x: 0, y: 11, to: "town", tx: 26, ty: 7 },
      { x: 35, y: 18, to: "barrow", tx: 1, ty: 9 },
    ],
    portalCh: "P",
    clear: [[34, 18], [33, 18], [32, 18], [34, 17], [33, 17]],
    spawns: [
      { monster: "mossling", count: 6, zone: [5, 2, 20, 19] },
      { monster: "bristlerat", count: 5, zone: [14, 2, 30, 19] },
      { monster: "webspinner", count: 4, zone: [22, 2, 33, 11] },
      { monster: "ember_crab", count: 1, zone: [26, 14, 32, 19] },
    ],
    start: [1, 10],
  });
}

function buildBarrow(): GameMap {
  return buildWild({
    id: "barrow",
    name: "The Old Barrow",
    w: 30,
    h: 20,
    salt: 31,
    floor: (n) => (n < 0.12 ? "r" : n < 0.18 ? "s" : "d"),
    wall: () => "#",
    obstacle: 0.08,
    road: { y: 9, to: 5, ch: "d" },
    portals: [{ x: 0, y: 9, to: "field", tx: 34, ty: 18 }],
    portalCh: "Q",
    spawns: [
      { monster: "dusk_bat", count: 5, zone: [8, 1, 28, 18] },
      { monster: "cairn_beetle", count: 4, zone: [10, 1, 28, 18] },
      { monster: "grave_jelly", count: 3, zone: [6, 1, 20, 18] },
      { monster: "barrow_wight", count: 1, zone: [22, 12, 28, 18] },
    ],
    start: [1, 9],
  });
}

export const MAPS: Record<MapId, GameMap> = {
  town: buildTown(),
  field: buildField(),
  barrow: buildBarrow(),
};

export function walkable(map: GameMap, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.w && y < map.h && !map.blocked[y * map.w + x];
}

export function portalAt(map: GameMap, x: number, y: number): Portal | undefined {
  return map.portals.find((p) => p.x === x && p.y === y);
}

export const dist = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// Caps that keep everything inside a 256 MB machine (see docs/DECISIONS.md).
export const CAPS = {
  monstersPerMap: 20,
  groundItemsPerMap: 60,
  onlinePlayers: 60,
  partySize: 6,
  guildSize: 20,
  inventoryRows: 60,
  chatLength: 120,
  stallItems: 8,
};
