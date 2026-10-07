// Lantern presence: where everyone on the page right now is holding their
// light. Held in this process's memory only. Nothing here is written to the
// database or logged, so where people looked is forgotten the moment they
// leave (see README.md, "All at once"). One machine, one room: a second
// machine would hold half the room each.

import { createHash } from "node:crypto";

export interface Lantern {
  id: string;
  x: number;
  y: number;
}

type Send = (chunk: string) => void;

// A lantern that hasn't reported in this long has gone: its light fades out
// on every screen.
export const LANTERN_TTL_MS = 10_000;
// About 10 updates a second is what the page sends. A small bucket absorbs
// network jitter, so a hand's last resting place isn't the update refused;
// anything sustained past the refill rate is a flood, not a hand moving.
export const RATE_PER_SECOND = 10;
export const BURST = 5;
export const MAX_LANTERNS = 500;
const HEARTBEAT_MS = 15_000;
const SWEEP_MS = 2_000;

// The id a tab posts with is its key: whoever holds it can move or put out
// that lantern. The stream only ever carries a one-way hash of it, so
// watching the stream never hands anyone someone else's key.
export const publicId = (secret: string): string => createHash("sha256").update(secret).digest("hex").slice(0, 16);

interface Held extends Lantern {
  seen: number;
  tokens: number;
}

const lanterns = new Map<string, Held>();
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

export function moveLantern(secret: string, x: number, y: number, now = Date.now()): MoveResult {
  const id = publicId(secret);
  const existing = lanterns.get(id);
  if (!existing && lanterns.size >= MAX_LANTERNS) return "full";
  const refilled = existing
    ? Math.min(BURST, existing.tokens + ((now - existing.seen) / 1000) * RATE_PER_SECOND)
    : BURST;
  if (refilled < 1) {
    if (existing) {
      existing.tokens = refilled;
      existing.seen = now;
    }
    return "too-fast";
  }
  lanterns.set(id, { id, x, y, seen: now, tokens: refilled - 1 });
  broadcast(event("move", { id, x, y }));
  return "ok";
}

export function removeLantern(secret: string): void {
  removeById(publicId(secret));
}

function removeById(id: string): void {
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

// `seen` also moves on a refused update, so a flooding tab stays lit; a
// silent one doesn't.
setInterval(() => {
  const cutoff = Date.now() - LANTERN_TTL_MS;
  for (const [id, l] of lanterns) if (l.seen < cutoff) removeById(id);
}, SWEEP_MS).unref();

// A comment line keeps idle streams from being cut by proxies along the way.
setInterval(() => broadcast(": still here\n\n"), HEARTBEAT_MS).unref();
