import type { APIRoute } from "astro";
import { addStroke, countStrokes, MAX_D_LENGTH, MAX_WIDTH, MIN_WIDTH } from "../../lib/db";
import { zoneBounds } from "../../lib/layout";
import { pathPoints } from "../../lib/path";

// The only write path into the scroll. Validated here, not just trusted
// from the client — see CLAUDE.md's rule that the data layer is the one
// place these promises actually hold.
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("expected a JSON body", { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).d !== "string" ||
    typeof (body as Record<string, unknown>).width !== "number"
  ) {
    return new Response('expected { "d": string, "width": number }', { status: 400 });
  }

  const { d, width } = body as { d: string; width: number };

  if (d.length === 0 || d.length > MAX_D_LENGTH) {
    return new Response("stroke path is empty or too long", { status: 400 });
  }
  if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    return new Response("stroke width out of range", { status: 400 });
  }

  const points = pathPoints(d);
  if (points === null) {
    return new Response("stroke path must be M, then L and Q segments only", { status: 400 });
  }

  // A mark painted outside its own blank strip would cover someone else's:
  // erasing by other means. Nothing awaits between this check and the
  // insert, so no other write can land in between.
  const { minX, maxX, minY, maxY } = zoneBounds(countStrokes(), width);
  if (!points.every((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) {
    return new Response("stroke reaches outside the blank strip at the end of the scroll", {
      status: 409,
    });
  }

  const stroke = addStroke(d, width);
  return new Response(JSON.stringify(stroke), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
};
