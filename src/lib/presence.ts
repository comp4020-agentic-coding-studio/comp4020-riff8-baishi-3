// Lantern presence: where everyone on the page right now is holding their
// light. Held in this process's memory only. Nothing here is written to the
// database or logged, so where people looked is forgotten the moment they
// leave (see README.md, "All at once"). One machine, one room: a second
// machine would hold half the room each.

export interface Lantern {
  id: string;
  x: number;
  y: number;
}

type Send = (chunk: string) => void;

// A lantern that hasn't reported in this long has gone: its light fades out
// on every screen.
export const LANTERN_TTL_MS = 10_000;
// About 10 updates a second is what the page sends; anything much faster is
// a flood, not a hand moving.
export const MIN_INTERVAL_MS = 50;
export const MAX_LANTERNS = 500;
const HEARTBEAT_MS = 15_000;
const SWEEP_MS = 2_000;

const lanterns = new Map<string, Lantern & { seen: number }>();
const listeners = new Set<Send>();

const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function broadcast(chunk: string): void {
  for (const send of listeners) {
    try {
      send(chunk);
    } catch {
      listeners.delete(send);
    }
  }
}

export type MoveResult = "ok" | "too-fast" | "full";

export function moveLantern(id: string, x: number, y: number, now = Date.now()): MoveResult {
  const existing = lanterns.get(id);
  if (existing && now - existing.seen < MIN_INTERVAL_MS) return "too-fast";
  if (!existing && lanterns.size >= MAX_LANTERNS) return "full";
  lanterns.set(id, { id, x, y, seen: now });
  broadcast(event("move", { id, x, y }));
  return "ok";
}

export function removeLantern(id: string): void {
  if (lanterns.delete(id)) broadcast(event("gone", { id }));
}

// Registers a listener and hands it everyone who's already here; returns the
// unsubscribe.
export function subscribe(send: Send): () => void {
  listeners.add(send);
  send("retry: 2000\n\n");
  send(event("snapshot", [...lanterns.values()].map(({ id, x, y }) => ({ id, x, y }))));
  return () => listeners.delete(send);
}

setInterval(() => {
  const cutoff = Date.now() - LANTERN_TTL_MS;
  for (const [id, l] of lanterns) if (l.seen < cutoff) removeLantern(id);
}, SWEEP_MS).unref();

// A comment line keeps idle streams from being cut by proxies along the way.
setInterval(() => broadcast(": still here\n\n"), HEARTBEAT_MS).unref();
