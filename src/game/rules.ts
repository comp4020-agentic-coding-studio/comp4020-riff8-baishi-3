// The game's arithmetic, as pure functions: derived stats, hit chance, damage,
// XP curves, stat costs, refine odds. The server is the only caller that
// decides outcomes; the client imports these just to display numbers.

import { ELEMENT_TABLE, ITEMS, JOBS, type CardBonus, type Element, type ItemId, type JobId, type Stat, type Stats } from "./data.ts";

export interface EquipView {
  item: ItemId;
  refine: number;
  cards: ItemId[];
}

export interface Derived {
  maxHp: number;
  maxSp: number;
  atk: number;
  matk: number;
  def: number;
  hit: number;
  flee: number;
  crit: number;
  attackMs: number;
  maxWeight: number;
}

export interface Buffs {
  endure?: boolean;
  blessing?: boolean;
  quicken?: boolean;
}

export const SAFE_REFINE = 4;
export const MAX_REFINE = 10;
export const MAX_LEVEL = 50;
export const MAX_JOB_LEVEL = 20;
export const MAX_STAT = 60;

export function cardBonus(equips: EquipView[]): Required<CardBonus> {
  const b = { atk: 0, matk: 0, def: 0, flee: 0, hpPct: 0, crit: 0 };
  for (const e of equips) {
    for (const c of e.cards) {
      const card = ITEMS[c].card ?? {};
      for (const k of Object.keys(b) as (keyof typeof b)[]) b[k] += card[k] ?? 0;
    }
  }
  return b;
}

export function derive(job: JobId, level: number, stats: Stats, equips: EquipView[], buffs: Buffs = {}): Derived {
  const j = JOBS[job];
  const cards = cardBonus(equips);
  let atk = stats.str * 2 + Math.floor(stats.dex / 5) + cards.atk;
  let matk = stats.int * 2 + cards.matk;
  let def = Math.floor(stats.vit / 2) + cards.def;
  for (const e of equips) {
    const it = ITEMS[e.item];
    if (it.slot === "weapon") {
      atk += (it.atk ?? 0) + e.refine * 3;
      matk += (it.matk ?? 0) + (it.matk ? e.refine * 3 : 0);
    } else if (it.slot === "armor") {
      def += (it.def ?? 0) + e.refine;
    }
  }
  if (buffs.endure) def += 12;
  const attackMs = Math.round(Math.max(500, 2000 - stats.agi * 20 - stats.dex * 5) * (buffs.quicken ? 0.7 : 1));
  return {
    maxHp: Math.round((35 + level * 12 + stats.vit * 8) * j.hpMod * (1 + cards.hpPct)),
    maxSp: Math.round((10 + level * 3 + stats.int * 4) * j.spMod),
    atk,
    matk,
    def,
    hit: level + stats.dex + (buffs.blessing ? 10 : 0),
    flee: level + stats.agi + cards.flee,
    crit: 1 + Math.floor(stats.luk / 3) + cards.crit,
    attackMs,
    maxWeight: 800 + stats.str * 30,
  };
}

export const elementMultiplier = (attack: Element, defend: Element): number => ELEMENT_TABLE[attack][defend] ?? 1;

export const hitChance = (hit: number, flee: number): number => Math.min(95, Math.max(5, 80 + hit - flee)) / 100;

// Random draws arrive as arguments in [0, 1), so a test can pin every outcome.
export interface Rolls {
  hit: number;
  crit: number;
  variance: number;
}

export interface Blow {
  amount: number;
  miss: boolean;
  crit: boolean;
  mult: number;
}

// Physical blow: can miss (hit vs flee), can crit (ignores flee and defence,
// x1.4), element multiplies before defence comes off.
export function physicalDamage(
  a: { atk: number; hit: number; crit: number; blessing?: boolean },
  d: { def: number; flee: number; element: Element },
  skillMult: number,
  element: Element,
  r: Rolls,
): Blow {
  const mult = elementMultiplier(element, d.element);
  const crit = r.crit < a.crit / 100;
  if (!crit && r.hit >= hitChance(a.hit, d.flee)) return { amount: 0, miss: true, crit: false, mult };
  const variance = 0.9 + r.variance * 0.2;
  const raw = a.atk * skillMult * variance * mult * (a.blessing ? 1.2 : 1) * (crit ? 1.4 : 1);
  const amount = Math.max(1, Math.round(raw - (crit ? 0 : d.def)));
  return { amount, miss: false, crit, mult };
}

// Magic never misses and never crits; defence counts half.
export function magicDamage(
  a: { matk: number; blessing?: boolean },
  d: { def: number; element: Element },
  skillMult: number,
  element: Element,
  r: Rolls,
): Blow {
  const mult = elementMultiplier(element, d.element);
  const variance = 0.9 + r.variance * 0.2;
  const raw = a.matk * skillMult * variance * mult * (a.blessing ? 1.2 : 1);
  return { amount: Math.max(1, Math.round(raw - d.def / 2)), miss: false, crit: false, mult };
}

export const healAmount = (matk: number, level: number, variance: number): number =>
  Math.round((matk * 1.5 + level * 4 + 20) * (0.9 + variance * 0.2));

export const baseXpToNext = (level: number): number => Math.round(30 * Math.pow(level, 2));
export const jobXpToNext = (jobLevel: number): number => Math.round(25 * Math.pow(jobLevel, 2));

// Raising a stat from `current` to current+1.
export const statCost = (current: number): number => Math.floor((current - 1) / 10) + 2;
export const statPointsForLevel = (newLevel: number): number => 5 + Math.floor(newLevel / 5);

// Death costs 5% of what this level needs, never dropping below zero.
export const deathPenalty = (level: number, xp: number): number => Math.min(xp, Math.floor(baseXpToNext(level) * 0.05));

// Chance that refining from `current` to current+1 holds.
export function refineChance(current: number): number {
  if (current < SAFE_REFINE) return 1;
  return [0.6, 0.5, 0.4, 0.3, 0.2, 0.1][current - SAFE_REFINE] ?? 0;
}
export const refineCost = (current: number): number => 100 * (current + 1);

// A party shares XP evenly among members on the same map, with a bonus for
// every extra member: together beats alone.
export const partyBonus = (members: number): number => 1 + 0.15 * (members - 1);

export function splitXp(total: number, members: number): number {
  return Math.floor((total * partyBonus(members)) / members);
}

export interface XpState {
  level: number;
  xp: number;
  jobLevel: number;
  jobXp: number;
  statPoints: number;
  skillPoints: number;
}

// Applies XP gains; returns the new state and how many levels were gained.
export function gainXp(s: XpState, base: number, job: number): { state: XpState; levels: number; jobLevels: number } {
  const n = { ...s };
  let levels = 0;
  let jobLevels = 0;
  n.xp += base;
  while (n.level < MAX_LEVEL && n.xp >= baseXpToNext(n.level)) {
    n.xp -= baseXpToNext(n.level);
    n.level++;
    levels++;
    n.statPoints += statPointsForLevel(n.level);
  }
  if (n.level >= MAX_LEVEL) n.xp = 0;
  n.jobXp += job;
  while (n.jobLevel < MAX_JOB_LEVEL && n.jobXp >= jobXpToNext(n.jobLevel)) {
    n.jobXp -= jobXpToNext(n.jobLevel);
    n.jobLevel++;
    jobLevels++;
    n.skillPoints++;
  }
  if (n.jobLevel >= MAX_JOB_LEVEL) n.jobXp = 0;
  return { state: n, levels, jobLevels };
}

export function isStat(s: unknown): s is Stat {
  return s === "str" || s === "agi" || s === "vit" || s === "int" || s === "dex" || s === "luk";
}
