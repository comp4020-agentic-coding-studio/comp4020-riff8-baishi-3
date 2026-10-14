// Identity is a cookie and nothing else: a random 32-byte token, httpOnly,
// set when a character is made. The database holds only its SHA-256, so even
// a copy of the database can't be replayed as someone's cookie. Nothing in a
// request body ever says who you are.

import { createHash, randomBytes } from "node:crypto";
import type { AstroCookies } from "astro";
import { charByToken, type CharRow } from "./db.ts";

export const COOKIE = "hf_token";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");

export function currentChar(cookies: AstroCookies): CharRow | undefined {
  const t = cookies.get(COOKIE)?.value;
  if (!t || !TOKEN.test(t)) return undefined;
  return charByToken(hashToken(t));
}

export function setToken(cookies: AstroCookies, token: string, secure: boolean): void {
  cookies.set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 60 * 60 * 24 * 365 });
}
