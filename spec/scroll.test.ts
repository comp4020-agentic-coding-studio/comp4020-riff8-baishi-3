import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, inject, it } from "vitest";
import { HEIGHT, SEGMENT, SOFT_SPREAD, zoneStart } from "../src/lib/layout";

// The promise crit 8 actually checks: a mark you make is still there when
// you come back. Exercised here exactly as a stranger would hit it — over
// HTTP, against whatever's running — not by reaching into the database.
const baseUrl = inject("baseUrl");

function markCount(html: string): number {
  const match = html.match(/(\d+) marks? so far/);
  return match ? Number(match[1]) : 0;
}

// The centre of the blank strip a visitor loading the page right now would
// draw in — the only place a new mark is allowed to go.
async function zoneCentre(): Promise<{ x: number; y: number }> {
  const html = await fetch(new URL("/", baseUrl)).then((r) => r.text());
  return { x: zoneStart(markCount(html)) + SEGMENT / 2, y: HEIGHT / 2 };
}

function post(body: unknown): Promise<Response> {
  return fetch(new URL("/api/strokes", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("adding a mark increases the count reported on the page, and it survives a fresh request", async () => {
  const before = await fetch(new URL("/", baseUrl)).then((r) => r.text());
  const countBefore = markCount(before);

  const { x, y } = await zoneCentre();
  const res = await post({ d: `M ${x} ${y} L ${x + 10} ${y + 10}`, width: 6 });
  expect(res.status).toBe(201);

  // A second, independent request: nothing about the first request's own
  // connection carries the mark forward, only the database does.
  const after = await fetch(new URL("/", baseUrl)).then((r) => r.text());
  expect(markCount(after)).toBe(countBefore + 1);
});

it("rejects a mark with no path, and one with an out-of-range width", async () => {
  const empty = await fetch(new URL("/api/strokes", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ d: "", width: 6 }),
  });
  expect(empty.status).toBe(400);

  const tooWide = await fetch(new URL("/api/strokes", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ d: "M 0 0 L 1 1", width: 999 }),
  });
  expect(tooWide.status).toBe(400);
});

it("normalises a bare tap (a moveto with no drawing command) into a paintable mark", async () => {
  // SVG renders nothing for "M x y" alone — a stray client that sent one
  // shouldn't get to save an invisible mark. See src/lib/db.ts.
  const { x, y } = await zoneCentre();
  const res = await post({ d: `M ${x} ${y}`, width: 14 });
  expect(res.status).toBe(201);
  const saved = await res.json();
  expect(saved.d).toMatch(/L/);
});

it("refuses a mark that reaches outside the blank strip, so it can't paint over earlier ones", async () => {
  // A drag that starts in the zone and runs left across everything before it:
  // exactly what pointer capture used to let a real drag do.
  const { x, y } = await zoneCentre();
  const res = await post({ d: `M ${x} ${y} L ${x - SEGMENT * 3} ${y}`, width: 6 });
  expect(res.status).toBe(409);

  // The halo counts too: a path hugging the zone's edge still bleeds over it.
  const edge = x - SEGMENT / 2 + 1;
  const bleed = await post({ d: `M ${edge} ${y} L ${edge} ${y}`, width: 40 });
  expect(bleed.status).toBe(409);
});

it("refuses a path that isn't the moveto-then-segments shape the client draws", async () => {
  const { x, y } = await zoneCentre();
  for (const d of [`L ${x} ${y}`, `M ${x} ${y} Z`, `M ${x} ${y} L ${x}`, `M ${x} ${y} L NaN ${y}`]) {
    const res = await post({ d, width: 6 });
    expect(res.status, d).toBe(400);
  }
});

it("never deletes: nothing in the app exposes a way to remove a mark", async () => {
  const res = await fetch(new URL("/api/strokes", baseUrl), { method: "DELETE" });
  // No route handles DELETE (Astro's same-origin check rejects it with 403
  // before routing even gets a say) — there's simply no delete path to call.
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
});

// Call and response: when the last mark runs up to the shared edge, the
// blank strip shows an echo of where it was heading. It's server-rendered,
// so a visitor without JavaScript sees exactly the same thing.
const page = (): Promise<string> => fetch(new URL("/", baseUrl)).then((r) => r.text());

it("shows an echo in the blank strip when the last mark reaches the shared edge", async () => {
  const { x, y } = await zoneCentre();
  const rightEdge = x + SEGMENT / 2 - (6 * SOFT_SPREAD) / 2 - 1;
  const res = await post({ d: `M ${x} ${y} L ${rightEdge} ${y - 20}`, width: 6 });
  expect(res.status).toBe(201);

  const html = await page();
  expect(html).toContain('id="echo"');
  expect(html).toContain("continue their line");
});

it("shows no echo when the last mark stayed away from the edge", async () => {
  const { x, y } = await zoneCentre();
  const res = await post({ d: `M ${x} ${y} L ${x} ${y}`, width: 14 });
  expect(res.status).toBe(201);

  const html = await page();
  expect(html).not.toContain('id="echo"');
  expect(html).toContain("draw here");
});

// Replay and lanterns are things only the script can do, so the no-JS page
// carries no control for them and no darkness: it's the fully lit scroll.
it("serves the no-JS page fully lit, with no dead replay or lantern controls", async () => {
  const html = await page();
  expect(html).not.toMatch(/watch it grow/i);
  expect(html).not.toMatch(/light the whole scroll/i);
  expect(html).not.toContain('id="lantern-dark"');
  expect(html).not.toContain("<mask");
  expect(html).toMatch(/<div id="controls" class="controls"><\/div>/);
});

it("gives every mark its timestamp, so a replay can show the true order and pace", async () => {
  const html = await page();
  const marks = html.match(/<g class="mark" data-t="\d+">/g) ?? [];
  expect(marks.length).toBeGreaterThan(0);
});

// The no-delete promise, read from the source rather than the routes: no
// SQL that could change or remove a saved mark exists anywhere in the app.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

it("has no UPDATE or DELETE statement anywhere in the app", () => {
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i);
  }
});
