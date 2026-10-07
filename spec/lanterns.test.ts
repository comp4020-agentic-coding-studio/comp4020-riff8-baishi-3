import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, inject, it } from "vitest";

// Lantern viewing: presence is live, in memory, and validated like any other
// input. Exercised over HTTP against the running app, as a browser would.
const baseUrl = inject("baseUrl");
const url = new URL("/api/lanterns", baseUrl);

const id = (): string => `test-${Math.random().toString(36).slice(2, 12)}`;
// What the stream calls a lantern: a hash of the tab's own id, never the id.
const shown = (secret: string): string => createHash("sha256").update(secret).digest("hex").slice(0, 16);

function post(body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("accepts a lantern inside the scroll, and tells the tab its public id", async () => {
  const mine = id();
  const res = await post({ id: mine, x: 100, y: 100 });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lantern: shown(mine) });
});

it("rejects a lantern with a bad shape or outside the scroll", async () => {
  for (const body of [
    { x: 10, y: 10 },
    { id: "short", x: 10, y: 10 },
    { id: "has spaces in it!", x: 10, y: 10 },
    { id: id(), x: "10", y: 10 },
    { id: id(), x: -5, y: 10 },
    { id: id(), x: 10, y: 99_999 },
    { id: id(), x: 1e9, y: 10 },
  ]) {
    const res = await post(body);
    expect(res.status, JSON.stringify(body)).toBe(400);
  }

  const huge = await post({ id: id(), x: 1, y: 1, pad: "x".repeat(2000) });
  expect(huge.status).toBe(413);
});

it("refuses a flood of updates from one lantern, but not a hand moving", async () => {
  const flooder = id();
  const statuses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => post({ id: flooder, x: 10 + i, y: 10 }).then((r) => r.status)),
  );
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
  expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(6);
  expect(statuses).toContain(429);

  // about ten a second, the pace the page sends at, all get through
  const steady = id();
  for (let i = 0; i < 8; i++) {
    expect((await post({ id: steady, x: 10 + i, y: 10 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
  }
});

// Reads the live stream until `predicate` matches what has arrived so far.
async function readStreamUntil(predicate: (text: string) => boolean, act: () => Promise<void>): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  // the snapshot arrives first; act once we know we're subscribed
  while (!text.includes("event: snapshot")) text += decoder.decode((await reader.read()).value);
  await act();
  try {
    while (!predicate(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } finally {
    controller.abort();
  }
  return text;
}

it("broadcasts a lantern's move, and its departure, to everyone on the stream", async () => {
  const mine = id();
  const moved = await readStreamUntil(
    (t) => t.includes(`"id":"${shown(mine)}","x":321`),
    async () => {
      await post({ id: mine, x: 321, y: 123 });
    },
  );
  expect(moved).toContain("event: move");
  expect(moved).not.toContain(mine);

  const left = await readStreamUntil(
    (t) => t.includes(`event: gone\ndata: {"id":"${shown(mine)}"}`),
    async () => {
      await post({ id: mine, gone: true });
    },
  );
  expect(left).toContain(`event: gone\ndata: {"id":"${shown(mine)}"}`);
});

it("never lets someone watching the stream move or put out another lantern", async () => {
  const theirs = id();
  await post({ id: theirs, x: 200, y: 200 });
  const marker = id();
  const text = await readStreamUntil(
    (t) => t.includes(`"id":"${shown(marker)}"`),
    async () => {
      // everything the stream offers about them is their public id
      await post({ id: shown(theirs), gone: true });
      await post({ id: shown(theirs), x: 7, y: 7 });
      await post({ id: marker, x: 9, y: 9 });
    },
  );
  expect(text).toContain(`"id":"${shown(theirs)}","x":200,"y":200`);
  expect(text).not.toContain(`event: gone\ndata: {"id":"${shown(theirs)}"}`);
  expect(text).not.toContain(`"id":"${shown(theirs)}","x":7`);
  await post({ id: theirs, gone: true });
  await post({ id: marker, gone: true });
});

it("never writes presence to the database", () => {
  const db = readFileSync("src/lib/db.ts", "utf8");
  expect(db).not.toMatch(/lantern|presence/i);
});
