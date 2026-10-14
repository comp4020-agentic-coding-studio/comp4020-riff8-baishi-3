import type { APIRoute } from "astro";
import { currentChar } from "../../server/auth.ts";
import { GameError } from "../../server/db.ts";
import { json, readJson } from "../../server/http.ts";
import { log, who } from "../../server/log.ts";
import { ensureOnline, submit } from "../../server/world.ts";

// Every action in the game is one intent posted here. Who's acting comes from
// the cookie only; the world validates and applies it on the next tick.
export const POST: APIRoute = async ({ request, cookies }) => {
  const row = currentChar(cookies);
  if (!row) {
    log("reject", "an intent arrived with no valid character cookie");
    return json(401, { ok: false, error: "no character in this browser" });
  }
  const body = await readJson(request);
  if (body instanceof Response) {
    log("reject", `${who(row)} sent a malformed intent`);
    return body;
  }
  try {
    const r = await submit(ensureOnline(row), body);
    return json(r.status, r.body);
  } catch (e) {
    if (e instanceof GameError) return json(e.status, { ok: false, error: e.message });
    throw e;
  }
};
