import { describe, expect, it } from "vitest";
import { JOBS, ITEMS, MAPS, walkable } from "../src/game/data.ts";
import { findPath } from "../src/game/path.ts";
import {
  baseXpToNext, deathPenalty, derive, elementMultiplier, gainXp, hitChance, magicDamage, physicalDamage,
  refineChance, splitXp, statCost,
} from "../src/game/rules.ts";

// The arithmetic the referee uses, for a known stat setup. Pure functions,
// so these run without the app.

const sure = { hit: 0, crit: 0.99, variance: 0.5 }; // hits, no crit, no variance

describe("damage", () => {
  const warden = derive("warden", 1, JOBS.warden.base, [{ item: "training_blade", refine: 0, cards: [] }]);

  it("derives a level-1 Warden's attack from STR, DEX and the weapon", () => {
    // 8 STR x2 + floor(5 DEX / 5) + 12 from the blade
    expect(warden.atk).toBe(29);
  });

  it("takes defence off a physical blow", () => {
    const b = physicalDamage(warden, { def: 2, flee: 2, element: "earth" }, 1, "neutral", sure);
    expect(b).toEqual({ amount: 27, miss: false, crit: false, mult: 1 });
  });

  it("multiplies by the element table before defence", () => {
    expect(elementMultiplier("fire", "earth")).toBe(1.5);
    expect(elementMultiplier("water", "fire")).toBe(1.5);
    expect(elementMultiplier("fire", "water")).toBe(0.5);
    expect(elementMultiplier("neutral", "water")).toBe(1);
    // Ember firebolt: (10 INT x2 + 16 staff) x1.6 skill x1.5 fire-vs-earth - 2/2 def
    const ember = derive("ember", 1, JOBS.ember.base, [{ item: "oak_staff", refine: 0, cards: [] }]);
    expect(ember.matk).toBe(36);
    expect(magicDamage(ember, { def: 2, element: "earth" }, 1.6, "fire", sure).amount).toBe(85);
  });

  it("misses when the hit roll beats the chance, and a crit ignores defence and flee", () => {
    expect(hitChance(6, 2)).toBe(0.84);
    expect(physicalDamage(warden, { def: 2, flee: 2, element: "earth" }, 1, "neutral", { hit: 0.9, crit: 0.99, variance: 0.5 }).miss).toBe(true);
    const crit = physicalDamage(warden, { def: 50, flee: 500, element: "earth" }, 1, "neutral", { hit: 0.99, crit: 0, variance: 0.5 });
    expect(crit).toMatchObject({ crit: true, miss: false, amount: Math.round(29 * 1.4) });
  });

  it("clamps hit chance between 5% and 95%", () => {
    expect(hitChance(0, 1000)).toBe(0.05);
    expect(hitChance(1000, 0)).toBe(0.95);
  });
});

describe("experience", () => {
  it("levels up and grants stat points when XP crosses the curve", () => {
    const start = { level: 1, xp: 0, jobLevel: 1, jobXp: 0, statPoints: 0, skillPoints: 0 };
    expect(baseXpToNext(1)).toBe(20);
    const r = gainXp(start, 25, 15);
    expect(r.levels).toBe(1);
    expect(r.state).toMatchObject({ level: 2, xp: 5, jobLevel: 2, jobXp: 0, statPoints: 5, skillPoints: 1 });
  });

  it("splits party XP evenly with a bonus per extra member", () => {
    expect(splitXp(100, 1)).toBe(100);
    expect(splitXp(100, 2)).toBe(57); // 100 x1.15 / 2
    expect(splitXp(100, 3)).toBe(43); // 100 x1.30 / 3
  });

  it("costs 5% of the level's XP to die, never below zero", () => {
    expect(deathPenalty(10, 1000)).toBe(Math.floor(baseXpToNext(10) * 0.05));
    expect(deathPenalty(10, 3)).toBe(3);
  });

  it("raises stat costs every ten points", () => {
    expect(statCost(1)).toBe(2);
    expect(statCost(10)).toBe(2);
    expect(statCost(11)).toBe(3);
    expect(statCost(21)).toBe(4);
  });
});

describe("refining", () => {
  it("is certain up to the safe level and risky after it", () => {
    expect(refineChance(0)).toBe(1);
    expect(refineChance(3)).toBe(1);
    expect(refineChance(4)).toBe(0.6);
    expect(refineChance(9)).toBe(0.1);
  });
});

describe("the world", () => {
  it("joins town and field both ways, and the field to the barrow", () => {
    for (const map of Object.values(MAPS)) {
      for (const p of map.portals) {
        expect(walkable(MAPS[p.to], p.tx, p.ty), `${map.id} -> ${p.to}`).toBe(true);
      }
    }
    const town = MAPS.town;
    expect(findPath(town, ...town.start, town.portals[0].x, town.portals[0].y)).not.toBeNull();
    const field = MAPS.field;
    const barrowGate = field.portals.find((p) => p.to === "barrow")!;
    expect(findPath(field, ...field.start, barrowGate.x, barrowGate.y, 5000)).not.toBeNull();
  });

  it("has a sprite and a price for every item", () => {
    for (const [id, it] of Object.entries(ITEMS)) {
      expect(it.price, id).toBeGreaterThan(0);
      expect(it.sprite.i, id).toBeLessThan(132);
    }
  });
});
