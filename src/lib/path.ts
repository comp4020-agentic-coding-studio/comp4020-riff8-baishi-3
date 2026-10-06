// Every point a path names, control points included, or null if it isn't the
// one shape draw.ts emits: a moveto, then any run of L and Q segments. A
// quadratic curve never leaves the hull of its control points, so bounding
// these bounds the ink. Shared by the write path (validating a new mark) and
// the page (reading where the last mark ended, for its echo).
export function pathPoints(d: string): { x: number; y: number }[] | null {
  const tokens = d.trim().split(/\s+/);
  const arity: Record<string, number> = { M: 2, L: 2, Q: 4 };
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i];
    const n = arity[command];
    if (n === undefined || (command === "M") !== (i === 0)) return null;
    const args = tokens.slice(i + 1, i + 1 + n).map(Number);
    if (args.length !== n || !args.every(Number.isFinite)) return null;
    for (let j = 0; j < n; j += 2) points.push({ x: args[j], y: args[j + 1] });
    i += 1 + n;
  }
  return points;
}
