// A tiny client for the spec: one cookie jar per player, intents with fresh
// command ids, and the test-only setup route (src/pages/api/test.ts).

import { inject } from "vitest";
import { MAPS, walkable, type MapId } from "../src/game/data.ts";

export const baseUrl = inject("baseUrl");
const url = (p: string): string => new URL(p, baseUrl).toString();

let n = 0;
export const cmd = (): string => `t${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const uniqueName = (prefix: string): string => `${prefix}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16);

export interface Res {
  status: number;
  body: Record<string, any>;
}

export class Client {
  cookie = "";
  pid = "";
  name = "";

  static async make(job: "warden" | "ember" | "mender", prefix = "T"): Promise<Client> {
    const c = new Client();
    c.name = uniqueName(prefix);
    const res = await fetch(url("/api/character"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: c.name, job }),
    });
    if (res.status !== 201) throw new Error(`couldn't make ${c.name}: ${res.status} ${await res.text()}`);
    c.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    c.pid = (await res.json()).me.pid;
    return c;
  }

  async post(path: string, body: unknown): Promise<Res> {
    const res = await fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { status: res.status, body: parsed };
  }

  act(type: string, fields: Record<string, unknown> = {}, id = cmd()): Promise<Res> {
    return this.post("/api/act", { type, cmd: id, ...fields });
  }

  async me(): Promise<Record<string, any>> {
    const res = await fetch(url("/api/me"), { headers: { cookie: this.cookie } });
    return (await res.json()).me;
  }

  test(op: string, fields: Record<string, unknown> = {}): Promise<Res> {
    return this.post("/api/test", { op, ...fields });
  }

  place(map: MapId, x: number, y: number): Promise<Res> {
    return this.test("place", { map, x, y });
  }
}

// A client with no character, for world-wide test ops.
export const admin = new Client();

export async function logs(n = 200): Promise<string[]> {
  return (await admin.test("logs", { n })).body.lines;
}

export async function logsSince(mark: number): Promise<string[]> {
  const all = await logs(500);
  return all.slice(Math.max(0, all.length - (all.length - mark)));
}

export async function logMark(): Promise<number> {
  return (await logs(500)).length;
}

// Finds a row of open tiles: [x, y] such that x..x+len-1 on row y are all
// walkable, with walkable rows above and below.
export function openSpot(map: MapId, len = 6): [number, number] {
  const m = MAPS[map];
  for (let y = 3; y < m.h - 3; y++) {
    for (let x = 3; x < m.w - len - 3; x++) {
      let ok = true;
      for (let i = -1; i <= len && ok; i++) for (let dy = -1; dy <= 1 && ok; dy++) ok = walkable(m, x + i, y + dy) && !m.portals.some((p) => p.x === x + i && p.y === y + dy);
      if (ok) return [x, y];
    }
  }
  throw new Error(`no open spot on ${map}`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(100);
  }
}

export async function audit(): Promise<Record<string, any>> {
  return (await admin.test("audit")).body.audit;
}
