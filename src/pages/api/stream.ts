import type { APIRoute } from "astro";
import { currentChar } from "../../server/auth.ts";
import { GameError } from "../../server/db.ts";
import { json } from "../../server/http.ts";
import { attachStream, ensureOnline } from "../../server/world.ts";

// Server -> client: a snapshot with a sequence number, then per-map deltas.
// A client that sees a gap in the sequence reconnects for a fresh snapshot.
export const GET: APIRoute = ({ request, cookies }) => {
  const row = currentChar(cookies);
  if (!row) return json(401, { ok: false, error: "no character in this browser" });
  let player;
  try {
    player = ensureOnline(row);
  } catch (e) {
    if (e instanceof GameError) return json(e.status, { ok: false, error: e.message });
    throw e;
  }
  let detach = (): void => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // the first byte goes out at once, so the proxy releases the headers
      controller.enqueue(encoder.encode(": open\n\n"));
      detach = attachStream(player, (chunk) => controller.enqueue(encoder.encode(chunk)));
      request.signal.addEventListener("abort", () => {
        detach();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      detach();
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
