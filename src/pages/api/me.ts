import type { APIRoute } from "astro";
import { currentChar } from "../../server/auth.ts";
import { GameError } from "../../server/db.ts";
import { json } from "../../server/http.ts";
import { ensureOnline, meView } from "../../server/world.ts";

export const GET: APIRoute = ({ cookies }) => {
  const row = currentChar(cookies);
  if (!row) return json(401, { ok: false, error: "no character in this browser yet" });
  try {
    return json(200, { ok: true, me: meView(ensureOnline(row)) });
  } catch (e) {
    if (e instanceof GameError) return json(e.status, { ok: false, error: e.message });
    throw e;
  }
};
