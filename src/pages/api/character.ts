import type { APIRoute } from "astro";
import { JOBS, type JobId } from "../../game/data.ts";
import { COOKIE, currentChar, hashToken, newToken, setToken } from "../../server/auth.ts";
import { isNameTaken } from "../../server/db.ts";
import { json, readJson } from "../../server/http.ts";
import { log } from "../../server/log.ts";
import { meView, newCharacter, ensureOnline } from "../../server/world.ts";

const NAME = /^[A-Za-z][A-Za-z0-9 _'-]{1,14}[A-Za-z0-9]$/;

// Makes a character and binds it to a fresh cookie. Works as a JSON POST
// (the game) or a plain form POST (no JavaScript).
export const POST: APIRoute = async ({ request, cookies, url, redirect }) => {
  const form = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  let body: Record<string, unknown>;
  if (form) body = Object.fromEntries(await request.formData());
  else {
    const parsed = await readJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  }
  const fail = (status: number, error: string): Response => {
    log("reject", `a new visitor's character was refused: ${error}`);
    return form ? redirect(`/?error=${encodeURIComponent(error)}`, 303) : json(status, { ok: false, error });
  };
  if (currentChar(cookies)) return fail(409, "this browser already has a character");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME.test(name)) return fail(400, "names are 3-16 letters, digits, spaces, _ ' or -, starting with a letter");
  if (typeof body.job !== "string" || !Object.hasOwn(JOBS, body.job)) return fail(400, "pick Warden, Ember or Mender");
  if (isNameTaken(name)) return fail(409, `${name} is taken`);
  const token = newToken();
  const row = newCharacter(hashToken(token), name, body.job as JobId);
  setToken(cookies, token, url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https");
  const p = ensureOnline(row);
  // Astro's own redirect, not Response.redirect: its headers are immutable,
  // so the cookie would fail to attach.
  return form ? redirect("/", 303) : json(201, { ok: true, me: meView(p) });
};

// Forgets this browser's character (the character itself stays in the world's
// records, unreachable). Lets a tester start over in the same profile.
export const DELETE: APIRoute = ({ cookies }) => {
  cookies.delete(COOKIE, { path: "/" });
  return json(200, { ok: true });
};
