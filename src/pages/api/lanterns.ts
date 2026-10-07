import type { APIRoute } from "astro";
import { countStrokes } from "../../lib/db";
import { HEIGHT, totalWidth } from "../../lib/layout";
import { moveLantern, publicId, removeLantern, subscribe } from "../../lib/presence";

// A per-tab random id, never a person: the page makes a fresh one on every
// load and nothing stores it. It stays between the tab and this route; the
// stream only carries its hash (see presence.ts).
const ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_BODY = 512;

// The live stream of lanterns: a snapshot of everyone here, then every move
// and departure as it happens.
export const GET: APIRoute = ({ request }) => {
  let unsubscribe = (): void => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribe((chunk) => controller.enqueue(encoder.encode(chunk)));
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
};

// Where your lantern is now, or that it's gone. Validated like any other
// input: right shape, inside the scroll, and not faster than a hand moves.
// A move answers with the lantern's public id, so the tab can tell its own
// light apart on the stream.
export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("expected a JSON body", { status: 400 });
  }
  const b = body as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null || typeof b.id !== "string" || !ID.test(b.id)) {
    return new Response("expected an id", { status: 400 });
  }

  if (b.gone === true) {
    removeLantern(b.id);
    return new Response(null, { status: 204 });
  }

  const { x, y } = b;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return new Response('expected { "id": string, "x": number, "y": number }', { status: 400 });
  }
  if (x < 0 || x > totalWidth(countStrokes()) || y < 0 || y > HEIGHT) {
    return new Response("lantern is outside the scroll", { status: 400 });
  }

  const result = moveLantern(b.id, x, y);
  if (result === "too-fast") return new Response("too many updates", { status: 429 });
  if (result === "full") return new Response("the room is full", { status: 503 });
  return Response.json({ lantern: publicId(b.id) });
};
