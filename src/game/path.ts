// A* over the tile grid, 8-way, no corner cutting. The client uses it to
// preview a route; the server recomputes it and walks it, so a client that
// lies about the path changes nothing.

import { walkable, type GameMap } from "./data.ts";

export type Step = [number, number];

export function findPath(
  map: GameMap,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  maxNodes = 2000,
  blocked?: (x: number, y: number) => boolean,
): Step[] | null {
  if (!walkable(map, tx, ty)) return null;
  if (sx === tx && sy === ty) return [];
  const w = map.w;
  const key = (x: number, y: number): number => y * w + x;
  const h = (x: number, y: number): number => Math.max(Math.abs(x - tx), Math.abs(y - ty));
  const g = new Map<number, number>([[key(sx, sy), 0]]);
  const from = new Map<number, number>();
  const open: [number, number, number][] = [[h(sx, sy), sx, sy]];
  const closed = new Set<number>();
  let expanded = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, x, y] = open.splice(bi, 1)[0];
    const k = key(x, y);
    if (closed.has(k)) continue;
    closed.add(k);
    if (x === tx && y === ty) {
      const out: Step[] = [];
      let c = k;
      while (c !== key(sx, sy)) {
        out.push([c % w, Math.floor(c / w)]);
        c = from.get(c)!;
      }
      return out.reverse();
    }
    if (++expanded > maxNodes) return null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!walkable(map, nx, ny)) continue;
        if (dx && dy && (!walkable(map, x + dx, y) || !walkable(map, x, y + dy))) continue;
        if (blocked && blocked(nx, ny) && !(nx === tx && ny === ty)) continue;
        const nk = key(nx, ny);
        const ng = g.get(k)! + (dx && dy ? 1.4 : 1);
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          from.set(nk, k);
          open.push([ng + h(nx, ny), nx, ny]);
        }
      }
    }
  }
  return null;
}
