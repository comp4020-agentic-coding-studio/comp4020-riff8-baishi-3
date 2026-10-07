// Call and response: the blank strip shows where the previous mark was
// heading as it reached the shared edge, as a faint dotted trail that is
// plainly not ink. It's computed from a mark that's already saved, so the
// server renders it and a visitor without JavaScript sees the same echo.
// It's only ever a suggestion: nothing checks whether the next mark follows it.

import { HEIGHT, zoneStart } from "./layout";
import { pathPoints } from "./path";

// How close to the shared edge the previous mark has to come to have
// anything to hand over. A mark that stayed in the middle of its own strip
// gets no echo, rather than one invented from the wrong part of the stroke.
export const ECHO_REACH = 48;
const ECHO_LENGTH = 140;
// However steep the last stretch was, the trail still has to lean into the
// new strip, or it would just run along the edge.
const MIN_RIGHTWARD = 0.35;
const MARGIN = 24;

export interface Echo {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function echoFor(previous: { d: string; width: number } | undefined, strokeCount: number): Echo | null {
  if (!previous) return null;
  const points = pathPoints(previous.d);
  if (!points || points.length === 0) return null;

  // The point that came nearest the edge, and the direction the brush was
  // travelling as it got there.
  let i = 0;
  for (let j = 1; j < points.length; j++) if (points[j].x > points[i].x) i = j;
  const edge = zoneStart(strokeCount);
  const tip = points[i];
  if (edge - tip.x > ECHO_REACH) return null;

  const from = points[i - 1] ?? points[i + 1] ?? tip;
  let dx = tip.x - from.x;
  let dy = tip.y - from.y;
  let len = Math.hypot(dx, dy);
  if (len < 1) {
    dx = 1;
    dy = 0;
    len = 1;
  }
  dx /= len;
  dy /= len;
  if (dx < MIN_RIGHTWARD) {
    dx = MIN_RIGHTWARD;
    dy = Math.sign(dy || 1) * Math.sqrt(1 - MIN_RIGHTWARD ** 2);
  }

  const x2 = tip.x + dx * ECHO_LENGTH;
  const y2 = Math.min(HEIGHT - MARGIN, Math.max(MARGIN, tip.y + dy * ECHO_LENGTH));
  return { x1: round(tip.x), y1: round(tip.y), x2: round(x2), y2: round(y2), width: previous.width };
}
