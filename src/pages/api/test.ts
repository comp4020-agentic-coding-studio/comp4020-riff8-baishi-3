import type { APIRoute } from "astro";
import { ITEMS, MAPS, MONSTERS, type ItemId, type MapId, type MonsterId } from "../../game/data.ts";
import { currentChar } from "../../server/auth.ts";
import { charById } from "../../server/db.ts";
import { json, readJson } from "../../server/http.ts";
import { recent } from "../../server/log.ts";
import { setRolls, testHooks } from "../../server/rng.ts";
import { audit, publicId, testing } from "../../server/world.ts";

// Hooks the spec uses to set up exact situations: fixed dice, a monster at a
// known spot, a character at a known level. On Fly this route is a 404, so it
// can't be used to cheat (see testHooks in src/server/rng.ts).
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!testHooks()) return new Response("not found", { status: 404 });
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const map = (b.map ?? "field") as MapId;
  if (!Object.hasOwn(MAPS, map)) return json(400, { error: "bad map" });
  const me = (): ReturnType<typeof testing.player> => {
    const row = currentChar(cookies);
    if (!row) throw new Error("no character cookie");
    return testing.player(charById(row.id)!);
  };
  switch (b.op) {
    case "rng":
      setRolls(Array.isArray(b.values) ? (b.values as number[]) : [], typeof b.fixed === "number" ? b.fixed : null);
      return json(200, { ok: true });
    case "clear":
      testing.clearMap(map, b.noRespawn !== false);
      return json(200, { ok: true });
    case "spawn": {
      if (typeof b.type !== "string" || !Object.hasOwn(MONSTERS, b.type)) return json(400, { error: "bad monster" });
      const id = testing.spawn(map, b.type as MonsterId, Number(b.x), Number(b.y), typeof b.hp === "number" ? b.hp : undefined, b.still !== false);
      return json(200, { ok: true, id });
    }
    case "monster":
      return json(200, { ok: true, monster: testing.monster(map, Number(b.id)) });
    case "place":
      testing.place(me(), map, Number(b.x), Number(b.y));
      return json(200, { ok: true });
    case "setup":
      testing.setup(me(), b as never);
      return json(200, { ok: true });
    case "grant": {
      const items = Array.isArray(b.items) ? (b.items as { item: ItemId; qty: number; refine?: number }[]) : [];
      if (items.some((i) => !Object.hasOwn(ITEMS, i.item))) return json(400, { error: "bad item" });
      testing.grant(me(), Number(b.zeny ?? 0), items);
      return json(200, { ok: true });
    }
    case "drop": {
      const owner = b.owner === true ? me() : null;
      const id = testing.drop(map, b.item as ItemId, Number(b.x), Number(b.y), owner);
      return json(200, { ok: true, id });
    }
    case "expire":
      testing.expireOwnership(map);
      return json(200, { ok: true });
    case "restart":
      testing.wipe();
      return json(200, { ok: true });
    case "audit":
      return json(200, { ok: true, audit: audit() });
    case "logs":
      return json(200, { ok: true, lines: recent.slice(-Number(b.n ?? 100)) });
    case "whoami": {
      const row = currentChar(cookies);
      return json(200, { ok: true, pid: row ? publicId(row.id) : null });
    }
    default:
      return json(400, { error: "unknown op" });
  }
};
