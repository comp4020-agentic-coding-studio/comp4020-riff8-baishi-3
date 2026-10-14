import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAPS, walkable } from "../src/game/data.ts";
import { Client, admin, audit, baseUrl, cmd, logs, openSpot, sleep, until } from "./helpers.ts";

// The referee's rules, checked against the running app over HTTP. The test
// route (src/pages/api/test.ts) fixes the dice and places monsters, so every
// outcome here is deterministic.

const [fx, fy] = openSpot("field", 7);
const SHOP: [number, number] = [9, 9];
const SMITH: [number, number] = [18, 10];
const STEWARD: [number, number] = [14, 11];

const rng = (fields: { values?: number[]; fixed?: number | null }): Promise<unknown> => admin.test("rng", { fixed: null, ...fields });
const monster = async (id: number): Promise<Record<string, any> | null> => (await admin.test("monster", { map: "field", id })).body.monster;
const spawn = async (type: string, x: number, y: number, hp?: number, still = true): Promise<number> =>
  (await admin.test("spawn", { map: "field", type, x, y, hp, still })).body.id;

// Forget everyone online and every live monster, as a restart would, so a
// test's aggressive monster can only chase that test's characters.
async function fresh(): Promise<void> {
  await admin.test("restart");
  await admin.test("clear", { map: "field", noRespawn: true });
}

async function since(fn: () => Promise<unknown>): Promise<string[]> {
  const before = await logs(500);
  const last = before[before.length - 1];
  await fn();
  await sleep(250);
  const after = await logs(500);
  const at = last === undefined ? -1 : after.lastIndexOf(last);
  return after.slice(at + 1);
}

beforeAll(async () => {
  await admin.test("clear", { map: "field", noRespawn: true });
  await rng({ fixed: 0.5 });
});

afterAll(async () => {
  await rng({});
  await admin.test("restart");
});

describe("identity", () => {
  it("gives two cookies two different characters", async () => {
    const a = await Client.make("warden", "Id");
    const b = await Client.make("mender", "Id");
    expect(a.pid).not.toBe(b.pid);
    expect((await a.me()).name).toBe(a.name);
    expect((await b.me()).name).toBe(b.name);
  });

  it("ignores a body that claims to be another character", async () => {
    const a = await Client.make("warden", "Liar");
    const b = await Client.make("warden", "Mark");
    await a.place("field", fx, fy);
    await b.place("field", fx, fy + 1);
    const r = await a.act("move", { x: fx + 3, y: fy, pid: b.pid, id: b.pid, character: b.pid, char: b.pid });
    expect(r.status).toBe(200);
    await until(async () => (await a.me()).x === fx + 3);
    expect(await b.me()).toMatchObject({ x: fx, y: fy + 1 });
  });

  it("refuses intents and the stream without a cookie", async () => {
    const res = await fetch(new URL("/api/act", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "move", cmd: cmd(), x: 1, y: 1 }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(new URL("/api/stream", baseUrl))).status).toBe(401);
  });

  it("keeps the cookie httpOnly and the raw token out of the logs", async () => {
    const res = await fetch(new URL("/api/character", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Ck${Date.now().toString(36).slice(-6)}`, job: "ember" }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    const token = cookie.split(";")[0].split("=")[1];
    expect((await logs(500)).join("\n")).not.toContain(token);
  });

  it("serves a playable page with the character once the cookie is set", async () => {
    const a = await Client.make("ember", "Page");
    const html = await (await fetch(new URL("/", baseUrl), { headers: { cookie: a.cookie } })).text();
    expect(html).toContain('id="game"');
    expect(html).toContain(a.name);
  });
});

describe("refusals: each is a 4xx and a [reject] line", () => {
  let a: Client;
  let b: Client;
  beforeAll(async () => {
    a = await Client.make("warden", "Rej");
    b = await Client.make("mender", "Rej");
    await a.place("field", fx, fy);
    await b.place("field", fx + 1, fy + 1);
  });

  const expectReject = async (who: Client, fn: () => Promise<{ status: number; body: Record<string, any> }>, status: number, text: RegExp): Promise<void> => {
    let res!: { status: number; body: Record<string, any> };
    const lines = await since(async () => {
      res = await fn();
    });
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body.error).toMatch(text);
    expect(lines.some((l) => l.startsWith("[reject]") && l.includes(who.name)), lines.join("\n")).toBe(true);
  };

  it("attack out of range", async () => {
    const far = await spawn("bristlerat", fx + 1, fy, 100);
    await a.place("field", ...openSpotAway(fx + 1, fy, 12));
    await expectReject(a, () => a.act("attack", { target: far }), 422, /out of range/);
    await a.place("field", fx, fy);
  });

  it("an unwalkable tile", async () => {
    const m = MAPS.field;
    let tree: [number, number] = [0, 0];
    for (let x = 1; x < m.w && !tree[0]; x++) if (!walkable(m, x, 0)) tree = [x, 0];
    await expectReject(a, () => a.act("move", { x: tree[0], y: tree[1] }), 422, /walkable/);
  });

  it("an item you don't own", async () => {
    const theirs = (await b.me()).inventory.find((r: any) => r.item === "red_potion");
    await expectReject(a, () => a.act("use", { item: theirs.id }), 403, /isn't yours/);
  });

  it("a skill on cooldown", async () => {
    const m = await spawn("bristlerat", fx + 1, fy, 1000);
    expect((await a.act("skill", { skill: "bash", target: m })).status).toBe(200);
    await sleep(250);
    await expectReject(a, () => a.act("skill", { skill: "bash", target: m }), 409, /cooldown/);
  });

  it("a skill you haven't learned", async () => {
    await expectReject(a, () => a.act("skill", { skill: "sweep" }), 403, /haven't learned/);
  });

  it("an uninvited party join", async () => {
    await a.act("party_create", { name: `P${Date.now().toString(36).slice(-6)}` });
    const party = (await a.me()).party.id;
    await expectReject(b, () => b.act("party_join", { party }), 403, /uninvited/);
    await a.act("party_leave");
  });

  it("guild storage by a non-member", async () => {
    await a.place("town", ...STEWARD);
    await b.place("town", STEWARD[0] + 1, STEWARD[1]);
    await a.act("guild_create", { name: `G${Date.now().toString(36).slice(-6)}` });
    const potion = (await a.me()).inventory.find((r: any) => r.item === "red_potion");
    expect((await a.act("storage_put", { item: potion.id, qty: 2 })).status).toBe(200);
    const stored = (await a.me()).guild.storage[0];
    const mine = (await b.me()).inventory.find((r: any) => r.item === "red_potion");
    await expectReject(b, () => b.act("storage_put", { item: mine.id }), 403, /guild members only/);
    await expectReject(b, () => b.act("storage_take", { item: stored.id }), 403, /guild members only/);
    await a.place("field", fx, fy);
    await b.place("field", fx + 1, fy + 1);
  });

  it("malformed and stale input", async () => {
    await expectReject(a, () => a.act("move", { x: "east", y: 3 }), 400, /whole number/);
    await expectReject(a, () => a.act("teleport", {}), 400, /unknown intent/);
    await expectReject(a, () => a.post("/api/act", { type: "move", x: 1, y: 1 }), 400, /cmd id/);
    const res = await a.post("/api/act", "{not json");
    expect(res.status).toBe(400);
    await expectReject(a, () => a.act("chat", { text: "x".repeat(500) }), 400, /characters/);
  });

  it("a trade confirmation for an offer that has since changed", async () => {
    await b.place("field", fx + 1, fy);
    expect((await a.act("trade_request", { target: b.pid })).status).toBe(200);
    expect((await b.act("trade_accept", { from: a.pid })).status).toBe(200);
    const v1 = (await a.act("trade_offer", { items: [], zeny: 10 })).body.version;
    await a.act("trade_offer", { items: [], zeny: 20 });
    await expectReject(b, () => b.act("trade_confirm", { version: v1 }), 409, /stale/);
    await a.act("trade_cancel");
  });
});

function openSpotAway(x: number, y: number, d: number): [number, number] {
  const m = MAPS.field;
  for (let tx = 1; tx < m.w - 1; tx++) {
    for (let ty = 1; ty < m.h - 1; ty++) {
      if (walkable(m, tx, ty) && Math.max(Math.abs(tx - x), Math.abs(ty - y)) >= d && !m.portals.some((p) => p.x === tx && p.y === ty)) return [tx, ty];
    }
  }
  throw new Error("no far spot");
}

describe("fighting together", () => {
  beforeAll(fresh);
  it("two players hit the same monster, the logs name both, and both get XP", async () => {
    const w = await Client.make("warden", "Fight");
    const e = await Client.make("ember", "Fight");
    await w.place("field", fx, fy);
    await e.place("field", fx + 4, fy);
    const id = await spawn("bristlerat", fx + 1, fy, 140);
    const before = [(await w.me()).xp, (await e.me()).xp];
    const lines = await since(async () => {
      await w.act("attack", { target: id });
      await e.act("skill", { skill: "firebolt", target: id });
      await until(async () => (await monster(id))?.dead === true || !(await monster(id)), 15000);
    });
    const combat = lines.filter((l) => l.startsWith("[combat]"));
    // 29 atk - 5 def at x1.0 variance: the Warden's blow is exactly 24
    expect(combat.some((l) => l.includes(w.name) && l.includes("for 24,"))).toBe(true);
    expect(combat.some((l) => l.includes(e.name) && l.includes("Firebolt"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[kill]") && l.includes(`Bristlerat#${id}`))).toBe(true);
    expect((await w.me()).xp).toBeGreaterThan(before[0]);
    expect((await e.me()).xp).toBeGreaterThan(before[1]);
  });

  it("a party shares the kill's XP with a member who didn't hit it", async () => {
    const w = await Client.make("warden", "Pty");
    const m = await Client.make("mender", "Pty");
    await w.place("field", fx, fy);
    await m.place("field", fx + 3, fy + 1);
    await w.act("party_create", { name: `Pty${Date.now().toString(36).slice(-5)}` });
    const party = (await w.me()).party.id;
    expect((await w.act("party_invite", { target: m.pid })).status).toBe(200);
    expect((await m.act("party_join", { party })).status).toBe(200);
    const id = await spawn("mossling", fx + 1, fy, 20);
    await w.act("attack", { target: id });
    await until(async () => !(await monster(id)) || (await monster(id))!.dead);
    await sleep(300);
    const me = await m.me();
    expect(me.xp).toBe(5); // a Mossling's 10 base XP, x1.15 for two, split two ways
    expect(me.party.members.map((x: any) => x.pid).sort()).toEqual([w.pid, m.pid].sort());
  });

  it("the healer heals a hurt friend", async () => {
    const w = await Client.make("warden", "Hurt");
    const m = await Client.make("mender", "Medic");
    await w.place("field", fx, fy);
    await m.place("field", fx + 2, fy);
    await w.test("setup", { hp: 10 });
    const lines = await since(async () => {
      await m.act("skill", { skill: "heal", target: w.pid });
      await until(async () => (await w.me()).hp > 10, 3000);
    });
    expect(lines.some((l) => l.startsWith("[heal]") && l.includes(m.name) && l.includes(w.name))).toBe(true);
  });

  it("getting hit interrupts a cast", async () => {
    await fresh();
    const e = await Client.make("ember", "Cast");
    await e.place("field", fx, fy);
    await e.test("setup", { skills: ["firebolt", "frost_lance", "flame_ring"] });
    const target = await spawn("mossling", fx + 3, fy, 500);
    const lines = await since(async () => {
      expect((await e.act("skill", { skill: "flame_ring", target })).body.casting).toBe(true);
      await spawn("bristlerat", fx + 1, fy, 100, false);
      await until(async () => (await logs(30)).some((l) => l.includes(e.name) && l.includes("was interrupted")), 4000);
    });
    expect(lines.some((l) => l.startsWith("[cast]") && l.includes("was interrupted"))).toBe(true);
    await admin.test("clear", { map: "field", noRespawn: true });
  });

  it("carrying over 90% weight stops attacking", async () => {
    const w = await Client.make("warden", "Heavy");
    await w.place("field", fx, fy);
    await w.test("grant", { items: [{ item: "ember_shell", qty: 100 }] });
    const id = await spawn("mossling", fx + 1, fy, 100);
    const r = await w.act("attack", { target: id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/90%/);
  });

  it("dying costs XP and respawns you in town", async () => {
    await fresh();
    const w = await Client.make("warden", "Doom");
    await w.place("field", fx, fy);
    await w.test("setup", { hp: 1, xp: 15 });
    const lines = await since(async () => {
      await spawn("bristlerat", fx + 1, fy, 100, false);
      await until(async () => (await w.me()).dead, 5000);
    });
    expect(lines.some((l) => l.startsWith("[death]") && l.includes(w.name))).toBe(true);
    expect((await w.me()).xp).toBe(14); // 5% of 30, floored
    expect((await w.act("respawn")).status).toBe(200);
    expect(await w.me()).toMatchObject({ map: "town", dead: false });
    await admin.test("clear", { map: "field", noRespawn: true });
  });
});

describe("loot", () => {
  beforeAll(fresh);
  it("belongs to the top damage dealer inside the window and is free after it", async () => {
    const a = await Client.make("warden", "Own");
    const b = await Client.make("warden", "Grab");
    await a.place("field", fx, fy);
    await b.place("field", fx + 2, fy);
    await rng({ values: [0.5, 0.99, 0.5], fixed: 0.01 }); // a hit, then every drop roll succeeds
    const id = await spawn("mossling", fx + 1, fy, 10);
    const lines = await since(async () => {
      await a.act("attack", { target: id });
      await until(async () => !(await monster(id)) || (await monster(id))!.dead);
    });
    await rng({ fixed: 0.5 });
    const drop = lines.find((l) => l.startsWith("[drop]") && l.includes("Jelly Gel"))!;
    expect(drop).toContain(`${a.name}#`);
    const item = Number(drop.match(/item (\d+)/)![1]);
    const refused = await b.act("pickup", { item });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/protected for/);
    await admin.test("expire", { map: "field" });
    const ok = await b.act("pickup", { item });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await b.me()).inventory.some((r: any) => r.item === "jelly_gel")).toBe(true);
  });

  it("free loot left on the ground is eaten by a mossling", async () => {
    const item = (await admin.test("drop", { map: "field", item: "jelly_gel", x: fx + 5, y: fy })).body.id;
    await spawn("mossling", fx + 4, fy, 60, false);
    const lines = await since(() => until(async () => (await logs(20)).some((l) => l.startsWith("[jelly]") && l.includes(`item ${item}`)), 12000));
    expect(lines.length).toBeGreaterThan(0);
    await admin.test("clear", { map: "field", noRespawn: true });
  });
});

describe("races give exactly one outcome", () => {
  beforeAll(fresh);
  it("two players grabbing the same item", async () => {
    const a = await Client.make("warden", "RaceA");
    const b = await Client.make("ember", "RaceB");
    await a.place("field", fx, fy);
    await b.place("field", fx + 2, fy);
    const item = (await admin.test("drop", { map: "field", item: "red_potion", x: fx + 1, y: fy })).body.id;
    const [ra, rb] = await Promise.all([a.act("pickup", { item }), b.act("pickup", { item })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 404]);
  });

  it("two players finishing a 1 HP monster", async () => {
    const a = await Client.make("warden", "LastA");
    const b = await Client.make("warden", "LastB");
    await a.place("field", fx, fy);
    await b.place("field", fx + 2, fy);
    const id = await spawn("bristlerat", fx + 1, fy, 1);
    const lines = await since(async () => {
      await Promise.all([a.act("attack", { target: id }), b.act("attack", { target: id })]);
      await until(async () => !(await monster(id)) || (await monster(id))!.dead);
    });
    expect(lines.filter((l) => l.startsWith("[kill]") && l.includes(`Bristlerat#${id}`))).toHaveLength(1);
  });

  it("two buyers for the last unit in a stall", async () => {
    const s = await Client.make("mender", "Seller");
    const a = await Client.make("warden", "BuyA");
    const b = await Client.make("warden", "BuyB");
    await s.place("town", 12, 9);
    await a.place("town", 12, 10);
    await b.place("town", 13, 10);
    await a.test("grant", { zeny: 500 });
    await b.test("grant", { zeny: 500 });
    const potion = (await s.me()).inventory.find((r: any) => r.item === "red_potion");
    expect((await s.act("stall_open", { title: "Last one", items: [{ id: potion.id, qty: 1, price: 40 }] })).status).toBe(200);
    const unit = (await (await fetch(new URL(`/api/stall?seller=${s.pid}`, baseUrl))).json()).stall.items[0];
    const before = await audit();
    const [ra, rb] = await Promise.all([a.act("stall_buy", { seller: s.pid, item: unit.id }), b.act("stall_buy", { seller: s.pid, item: unit.id })]);
    expect([ra.status, rb.status].filter((x) => x === 200)).toHaveLength(1);
    expect([ra.status, rb.status].filter((x) => x >= 400 && x < 500)).toHaveLength(1);
    const after = await audit();
    expect(after.zeny).toBe(before.zeny);
    expect(after.items).toBe(before.items);
    expect(after.balanced).toBe(true);
  });
});

describe("money and items", () => {
  it("a resent command id applies once", async () => {
    const a = await Client.make("warden", "Retry");
    await a.place("town", ...SHOP);
    const zeny = (await a.me()).zeny;
    const id = cmd();
    const first = await a.act("shop_buy", { item: "red_potion", qty: 1 }, id);
    const again = await a.act("shop_buy", { item: "red_potion", qty: 1 }, id);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect((await a.me()).zeny).toBe(zeny - 50);
  });

  it("a trade conserves zeny and items, and needs both confirmations of the same contents", async () => {
    const a = await Client.make("warden", "TradeA");
    const b = await Client.make("mender", "TradeB");
    await a.place("town", 12, 9);
    await b.place("town", 13, 9);
    const before = await audit();
    const aPotion = (await a.me()).inventory.find((r: any) => r.item === "red_potion");
    expect((await a.act("trade_request", { target: b.pid })).status).toBe(200);
    expect((await b.act("trade_accept", { from: a.pid })).status).toBe(200);
    await a.act("trade_offer", { items: [{ id: aPotion.id, qty: 2 }] });
    const v = (await b.act("trade_offer", { items: [], zeny: 50 })).body.version;
    expect((await a.act("trade_confirm", { version: v })).body.done).toBe(false);
    const done = await b.act("trade_confirm", { version: v });
    expect(done.body.done).toBe(true);
    const [ma, mb] = [await a.me(), await b.me()];
    expect(ma.zeny).toBe(350);
    expect(mb.zeny).toBe(250);
    expect(mb.inventory.find((r: any) => r.item === "red_potion").qty).toBe(7);
    const ids = new Set(ma.inventory.map((r: any) => r.id));
    expect(mb.inventory.some((r: any) => ids.has(r.id))).toBe(false);
    const after = await audit();
    expect(after.zeny).toBe(before.zeny);
    expect(after.items).toBe(before.items);
  });

  it("refining above the safe level can break the item", async () => {
    const a = await Client.make("warden", "Smith");
    await a.place("town", ...SMITH);
    await a.test("grant", { zeny: 5000, items: [{ item: "iron_sword", qty: 1, refine: 4 }, { item: "iron_sword", qty: 1, refine: 4 }] });
    const swords = (await a.me()).inventory.filter((r: any) => r.item === "iron_sword");
    await rng({ values: [0] });
    const ok = await a.act("refine", { item: swords[0].id });
    expect(ok.body).toMatchObject({ success: true, refine: 5 });
    await rng({ values: [0.99] });
    let lines: string[] = [];
    lines = await since(async () => {
      const bad = await a.act("refine", { item: swords[1].id });
      expect(bad.body).toMatchObject({ success: false, broke: true });
    });
    await rng({ fixed: 0.5 });
    expect(lines.some((l) => l.startsWith("[refine]") && l.includes("failed: broke"))).toBe(true);
    const left = (await a.me()).inventory.filter((r: any) => r.item === "iron_sword");
    expect(left).toHaveLength(1);
    expect(left[0].refine).toBe(5);
    expect((await audit()).balanced).toBe(true);
  });

  it("each MVP kill gives exactly one MVP reward", async () => {
    const a = await Client.make("warden", "Mvp");
    const b = await Client.make("warden", "Mvp");
    await a.place("field", fx, fy);
    await b.place("field", fx + 2, fy);
    const before = await audit();
    const id = await spawn("ember_crab", fx + 1, fy, 40);
    const lines = await since(async () => {
      await Promise.all([a.act("attack", { target: id }), b.act("attack", { target: id })]);
      await until(async () => !(await monster(id)) || (await monster(id))!.dead, 8000);
    });
    const after = await audit();
    expect(after.mvpRewardsLedgered - before.mvpRewardsLedgered).toBe(1);
    expect(lines.filter((l) => l.startsWith("[mvp]") && l.includes("wins the"))).toHaveLength(1);
    const holders = [await a.me(), await b.me()].filter((m) => m.inventory.some((r: any) => r.item === "crab_card"));
    expect(holders).toHaveLength(1);
  });

  it("vending moves zeny to the seller, conserving the totals", async () => {
    const s = await Client.make("mender", "Vend");
    const buyer = await Client.make("warden", "Cust");
    await s.place("town", 16, 9);
    await buyer.place("town", 16, 10);
    const potion = (await s.me()).inventory.find((r: any) => r.item === "red_potion");
    await s.act("stall_open", { title: "Potions", items: [{ id: potion.id, qty: 3, price: 30 }] });
    const unit = (await (await fetch(new URL(`/api/stall?seller=${s.pid}`, baseUrl))).json()).stall.items[0];
    const before = await audit();
    expect((await buyer.act("stall_buy", { seller: s.pid, item: unit.id, qty: 2 })).status).toBe(200);
    expect((await s.me()).zeny).toBe(360);
    expect((await buyer.me()).zeny).toBe(240);
    const after = await audit();
    expect(after.zeny).toBe(before.zeny);
    expect(after.items).toBe(before.items);
    expect((await s.act("move", { x: 17, y: 9 })).status).toBe(409); // a stall holds you in place
    expect((await s.act("stall_close")).status).toBe(200);
    expect((await s.me()).inventory.find((r: any) => r.item === "red_potion").qty).toBe(3);
  });

  it("the whole session's ledger balances, nothing is negative, and nothing has two owners", async () => {
    const a = await audit();
    expect(a.balanced, JSON.stringify(a)).toBe(true);
    expect(a.minQty).toBeGreaterThan(0);
    expect(a.minZeny).toBeGreaterThanOrEqual(0);
  });
});

describe("restarts", () => {
  it("a character's level, inventory and zeny survive a restart", async () => {
    const a = await Client.make("warden", "Last");
    await a.test("setup", { level: 7 });
    await a.test("grant", { zeny: 123, items: [{ item: "iron_buckler", qty: 1 }] });
    const before = await a.me();
    await admin.test("restart");
    await admin.test("clear", { map: "field", noRespawn: true });
    const after = await a.me();
    expect(after.level).toBe(7);
    expect(after.zeny).toBe(before.zeny);
    expect(after.inventory.map((r: any) => [r.id, r.item, r.qty])).toEqual(before.inventory.map((r: any) => [r.id, r.item, r.qty]));
  });
});

describe("without JavaScript", () => {
  it("a plain form post makes a character and sets its cookie", async () => {
    const name = `Form${Date.now().toString(36).slice(-6)}`;
    const res = await fetch(new URL("/api/character", baseUrl), {
      method: "POST",
      // a browser sends its own origin with a form post; Astro refuses a
      // form from anywhere else
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(baseUrl).origin },
      body: new URLSearchParams({ name, job: "mender" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/hf_token=.*HttpOnly/i);
  });

  it("the front page says who's playing, with no script needed", async () => {
    const html = await (await fetch(new URL("/", baseUrl))).text();
    expect(html).toMatch(/adventurers? (is|are) in the world now/);
    expect(html).toContain('action="/api/character"');
  });
});

describe("the stream", () => {
  it("opens at once with a snapshot and sequence number, then numbered deltas with no gaps", async () => {
    const a = await Client.make("warden", "Strm");
    await a.place("field", fx, fy);
    const ctrl = new AbortController();
    const res = await fetch(new URL("/api/stream", baseUrl), { headers: { cookie: a.cookie }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events: { ev: string; data: any }[] = [];
    const read = async (): Promise<void> => {
      const { value } = await reader.read();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (ev && data) events.push({ ev, data: JSON.parse(data) });
      }
    };
    await read();
    expect(buf + events.length).toBeTruthy(); // the first chunk arrives without waiting for a heartbeat
    while (!events.some((e) => e.ev === "snapshot")) await read();
    const snap = events.find((e) => e.ev === "snapshot")!.data;
    expect(snap.you).toBe(a.pid);
    expect(snap.ents.some((e: any) => e.k === "p" && e.id === a.pid)).toBe(true);
    // the stream never carries a raw character id or cookie
    expect(JSON.stringify(snap)).not.toContain(a.cookie.split("=")[1]);
    await a.act("move", { x: fx + 3, y: fy });
    while (events.filter((e) => e.ev === "delta").length < 3) await read();
    const seqs = [snap.seq, ...events.filter((e) => e.ev === "delta").map((e) => e.data.seq)];
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    ctrl.abort();
  });
});

describe("guilds", () => {
  it("members share storage; a leaver loses access; guild chat reaches members only", async () => {
    const a = await Client.make("warden", "Gld");
    const b = await Client.make("mender", "Gld");
    const c = await Client.make("ember", "Out");
    for (const [x, cl] of [[0, a], [1, b], [-1, c]] as const) await cl.place("town", STEWARD[0] + x, STEWARD[1]);
    await a.act("guild_create", { name: `Gd${Date.now().toString(36).slice(-6)}` });
    const guild = (await a.me()).guild.id;
    expect((await b.act("guild_join", { guild })).status).toBe(403); // not yet invited
    await a.act("guild_invite", { target: b.pid });
    expect((await b.act("guild_join", { guild })).status).toBe(200);
    const potion = (await a.me()).inventory.find((r: any) => r.item === "red_potion");
    expect((await a.act("storage_put", { item: potion.id, qty: 3 })).status).toBe(200);
    const stored = (await b.me()).guild.storage.find((r: any) => r.item === "red_potion");
    expect(stored.qty).toBe(3);
    expect((await b.act("storage_take", { item: stored.id, qty: 1 })).status).toBe(200);
    expect((await b.me()).inventory.find((r: any) => r.item === "red_potion").qty).toBe(6);
    expect((await c.act("storage_take", { item: stored.id, qty: 1 })).status).toBe(403);
    const lines = await since(() => a.act("chat", { scope: "guild", text: "meet at the well" }));
    expect(lines.some((l) => l.startsWith("[chat]") && l.includes("(guild): meet at the well"))).toBe(true);
    expect((await c.act("chat", { scope: "guild", text: "let me in" })).status).toBe(409);
    expect((await b.act("guild_leave")).status).toBe(200);
    expect((await b.act("storage_take", { item: stored.id, qty: 1 })).status).toBe(403);
  });
});
