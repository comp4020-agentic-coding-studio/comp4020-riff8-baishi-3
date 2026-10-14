// Loading and drawing Kenney's 16px sheets (see docs/ASSETS.md). Every
// character, monster, tile and item on screen is one of these sprites.

import { SHEET_COLS, TILE, type Sheet, type Sprite } from "../game/data.ts";

const sheets: Partial<Record<Sheet, HTMLImageElement>> = {};
const tinted = new Map<string, HTMLCanvasElement>();

export async function loadSheets(): Promise<void> {
  await Promise.all(
    (["town", "dungeon"] as Sheet[]).map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => reject(new Error(`couldn't load ${s} sprites`));
          img.src = `/sprites/${s}.png`;
          sheets[s] = img;
        }),
    ),
  );
}

// A recoloured copy of one sprite, cached (hue-rotate is slow per frame).
function hued(sp: Sprite, hue: number): HTMLCanvasElement {
  const key = `${sp.sheet}:${sp.i}:${hue}`;
  let c = tinted.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = TILE;
    const ctx = c.getContext("2d")!;
    ctx.filter = `hue-rotate(${hue}deg)`;
    ctx.drawImage(sheets[sp.sheet]!, (sp.i % SHEET_COLS) * TILE, Math.floor(sp.i / SHEET_COLS) * TILE, TILE, TILE, 0, 0, TILE, TILE);
    tinted.set(key, c);
  }
  return c;
}

export function draw(ctx: CanvasRenderingContext2D, sp: Sprite, x: number, y: number, size: number, opts: { hue?: number; flip?: boolean; alpha?: number } = {}): void {
  const img = sheets[sp.sheet];
  if (!img) return;
  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  if (opts.flip) {
    ctx.translate(x + size, y);
    ctx.scale(-1, 1);
    x = 0;
    y = 0;
  }
  if (opts.hue) ctx.drawImage(hued(sp, opts.hue), 0, 0, TILE, TILE, x, y, size, size);
  else ctx.drawImage(img, (sp.i % SHEET_COLS) * TILE, Math.floor(sp.i / SHEET_COLS) * TILE, TILE, TILE, x, y, size, size);
  ctx.restore();
}

// CSS for showing a sprite as a DOM icon at `scale` x its native 16px.
export function iconStyle(sp: Sprite, scale = 2): string {
  const s = TILE * scale;
  return `background-image:url(/sprites/${sp.sheet}.png);background-size:${192 * scale}px ${176 * scale}px;` +
    `background-position:-${(sp.i % SHEET_COLS) * s}px -${Math.floor(sp.i / SHEET_COLS) * s}px;width:${s}px;height:${s}px`;
}
