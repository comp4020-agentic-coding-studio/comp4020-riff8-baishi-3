import type { APIRoute } from "astro";
import { json } from "../../server/http.ts";
import { stallItems } from "../../server/world.ts";

// What a stall has for sale. Stalls are public by design: anyone can look.
export const GET: APIRoute = ({ url }) => {
  const s = stallItems(url.searchParams.get("seller") ?? "");
  return s ? json(200, { ok: true, stall: s }) : json(404, { ok: false, error: "that stall is closed" });
};
