// The browser half of Hollowfield. It draws what the server says, previews
// routes, and turns clicks and keys into intents. It never decides an
// outcome: every number on screen came from the server.

import { EMOTES, ITEMS, JOBS, MAPS, MONSTERS, SKILLS, TERRAIN, TILE, dist, walkable, type GameMap, type ItemId, type MapId, type MonsterId, type SkillId } from "../game/data.ts";
import { findPath } from "../game/path.ts";
import { act, connect, type Ent, type Fx, type Me } from "./net.ts";
import { draw } from "./sprites.ts";
import { initUi, type Ui } from "./ui.ts";

const SCALE = 3;
const PX = TILE * SCALE;

interface View extends Ent {
  rx: number;
  ry: number;
  flip: boolean;
  bubble?: { text: string; until: number };
  emote?: { e: number; until: number };
  castUntil?: number;
  castStart?: number;
}
interface Floater {
  x: number;
  y: number;
  text: string;
  colour: string;
  born: number;
  big: boolean;
}

export interface Game {
  me: Me | null;
  map: GameMap;
  ents: Map<string, View>;
  selected: string | null;
  act: typeof act;
  log(text: string, kind?: string): void;
  playerName(pid: string): string;
  nearestMonster(): View | null;
  useSkill(id: SkillId): void;
  walkTo(x: number, y: number): void;
}

export function start(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const ents = new Map<string, View>();
  const floaters: Floater[] = [];
  let youPid = "";
  let preview: [number, number][] = [];
  let pendingPickup: number | null = null;
  let pendingNpc: string | null = null;
  let hover: [number, number] | null = null;
  let lastMe: Me | null = null;

  const sounds: Record<string, HTMLAudioElement> = {};
  for (const s of ["levelup", "rare", "mvp", "break"]) {
    sounds[s] = new Audio(`/audio/${s}.ogg`);
    sounds[s].volume = 0.5;
  }
  const play = (s: string | null): void => {
    if (!s || !sounds[s]) return;
    sounds[s].currentTime = 0;
    void sounds[s].play().catch(() => {});
  };

  const game: Game = {
    me: null,
    map: MAPS.town,
    ents,
    selected: null,
    act: async (type, fields) => {
      const r = await act(type, fields);
      if (!r.ok && r.error) game.log(r.error, "error");
      return r;
    },
    log: (text, kind) => ui.log(text, kind),
    playerName: (pid) => (ents.get("p:" + pid)?.name as string) ?? "someone",
    nearestMonster() {
      const you = ents.get("p:" + youPid);
      if (!you) return null;
      let best: View | null = null;
      for (const e of ents.values()) {
        if (e.k !== "m") continue;
        if (!best || dist(e.x, e.y, you.x, you.y) < dist(best.x, best.y, you.x, you.y)) best = e;
      }
      return best && dist(best.x, best.y, you.x, you.y) <= 10 ? best : null;
    },
    useSkill(id) {
      const s = SKILLS[id];
      let target: unknown;
      if (s.target === "monster") {
        const sel = game.selected?.startsWith("m:") ? ents.get(game.selected) : game.nearestMonster();
        if (!sel) return game.log("No monster in reach.", "error");
        target = sel.id;
      } else if (s.target === "ally") {
        target = game.selected?.startsWith("p:") ? game.selected.slice(2) : youPid;
      }
      void game.act("skill", { skill: id, target });
    },
    walkTo(x, y) {
      const you = ents.get("p:" + youPid);
      if (!you || !walkable(game.map, x, y)) return;
      preview = findPath(game.map, you.x, you.y, x, y, 4000) ?? [];
      void game.act("move", { x, y });
    },
  };
  const ui: Ui = initUi(game);

  const keyOf = (e: Ent): string => `${e.k}:${e.id}`;
  function upsert(e: Ent): void {
    const k = keyOf(e);
    const old = ents.get(k);
    if (old) {
      if (e.x !== old.x) old.flip = e.x < old.x;
      Object.assign(old, e);
    } else ents.set(k, { ...e, rx: e.x, ry: e.y, flip: false });
  }

  function addFloater(key: string, text: string, colour: string, big = false): void {
    const e = ents.get(key);
    if (!e) return;
    floaters.push({ x: e.rx, y: e.ry, text, colour, born: performance.now(), big });
  }

  function applyFx(f: Fx): void {
    const now = performance.now();
    switch (f.t) {
      case "dmg": {
        const key = f.to as string;
        const mine = f.by === youPid || key === "p:" + youPid;
        if (f.heal) addFloater(key, `+${f.n}`, "#7dff8a");
        else if (f.miss) addFloater(key, "miss", "#cfd8dc");
        else addFloater(key, `${f.crit ? "CRIT " : ""}${f.n}`, key.startsWith("p:") ? "#ff6b6b" : f.crit ? "#ffd166" : mine ? "#ffffff" : "#e0c3fc", !!f.crit);
        break;
      }
      case "say": {
        const e = ents.get("p:" + f.id);
        if (e) e.bubble = { text: f.text as string, until: now + 5000 };
        break;
      }
      case "emote": {
        const e = ents.get("p:" + f.id);
        if (e) e.emote = { e: f.e as number, until: now + 2500 };
        break;
      }
      case "cast": {
        const e = ents.get("p:" + f.id);
        if (e) {
          e.castStart = now;
          e.castUntil = now + (f.ms as number);
        }
        break;
      }
      case "interrupt": {
        const e = ents.get("p:" + f.id);
        if (e) e.castUntil = undefined;
        addFloater("p:" + f.id, "interrupted", "#ffab40");
        break;
      }
      case "skill": {
        const e = ents.get("p:" + f.id);
        if (e) e.castUntil = undefined;
        addFloater("p:" + f.id, SKILLS[f.skill as SkillId].name, "#90caf9");
        break;
      }
      case "lvl":
        addFloater("p:" + f.id, f.kind === "base" ? `LEVEL ${f.level}!` : `Job Lv ${f.level}`, "#ffd166", true);
        if (f.id === youPid) play("levelup");
        break;
      case "refine":
        addFloater("p:" + f.id, f.ok ? `+${f.level}!` : "BROKE", f.ok ? "#ffd166" : "#ff6b6b", true);
        if (f.id === youPid) play(f.ok ? "levelup" : "break");
        break;
      case "die":
        floaters.push({ x: f.x as number, y: f.y as number, text: "✦", colour: "#fff3c4", born: now, big: true });
        break;
      case "eat":
        addFloater("m:" + f.m, "gulp!", "#a5d6a7");
        break;
    }
  }

  const net = connect({
    snapshot(d) {
      ents.clear();
      youPid = d.you;
      game.map = MAPS[d.map as MapId];
      preview = [];
      for (const e of d.ents) upsert(e);
      ui.mapChanged(game.map.name);
    },
    delta(d) {
      for (const e of d.ents) upsert(e);
      for (const k of d.gone) ents.delete(k);
      for (const f of d.fx) applyFx(f);
    },
    me(m) {
      if (lastMe && m.level > lastMe.level) game.log(`You reached level ${m.level}!`, "good");
      lastMe = m;
      game.me = m;
      ui.me(m);
    },
    chat(c) {
      ui.chat(c);
    },
    announce(a) {
      ui.announce(a.text);
      play(a.sound);
    },
    status(s) {
      ui.status(s);
    },
  });
  void net;

  // ----- input -----
  const cam = { x: 0, y: 0 };
  function tileAt(ev: MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [Math.floor((ev.clientX - r.left + cam.x) / PX), Math.floor((ev.clientY - r.top + cam.y) / PX)];
  }
  function entAt(x: number, y: number): View | undefined {
    const order = ["m", "p", "s", "i"];
    return [...ents.values()].filter((e) => e.x === x && e.y === y).sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k))[0];
  }

  canvas.addEventListener("mousemove", (ev) => {
    hover = tileAt(ev);
  });
  canvas.addEventListener("mouseleave", () => {
    hover = null;
  });
  canvas.addEventListener("click", (ev) => {
    canvas.focus();
    const [x, y] = tileAt(ev);
    const npc = game.map.npcs.find((n) => n.x === x && n.y === y);
    const you = ents.get("p:" + youPid);
    if (npc && you) {
      if (dist(you.x, you.y, npc.x, npc.y) <= 3) ui.npc(npc.id);
      else {
        pendingNpc = npc.id;
        game.walkTo(...nearestOpen(npc.x, npc.y));
      }
      return;
    }
    const e = entAt(x, y);
    if (e?.k === "m") {
      game.selected = keyOf(e);
      void game.act("attack", { target: e.id });
    } else if (e?.k === "p") {
      game.selected = keyOf(e);
      ui.selected(e.id === youPid ? null : (e as unknown as { id: string; name: string }));
    } else if (e?.k === "s") {
      ui.stall(e.id as string);
    } else if (e?.k === "i") {
      pendingPickup = e.id as number;
      if (you && dist(you.x, you.y, e.x, e.y) <= 1) tryPickup();
      else game.walkTo(e.x, e.y);
    } else {
      game.selected = null;
      ui.selected(null);
      game.walkTo(x, y);
    }
  });

  function nearestOpen(x: number, y: number): [number, number] {
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1]]) if (walkable(game.map, x + dx, y + dy)) return [x + dx, y + dy];
    return [x, y];
  }

  function tryPickup(): void {
    if (pendingPickup === null) return;
    const id = pendingPickup;
    pendingPickup = null;
    void game.act("pickup", { item: id });
  }

  const held = new Set<string>();
  let lastStep = 0;
  canvas.addEventListener("keydown", (ev) => {
    if (ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      held.add(ev.key);
      stepKeys(true);
      return;
    }
    if (ev.repeat) return;
    const k = ev.key.toLowerCase();
    if (k === "a" || k === " ") {
      ev.preventDefault();
      const m = game.nearestMonster();
      if (m) {
        game.selected = keyOf(m);
        void game.act("attack", { target: m.id });
      } else game.log("No monster in reach.", "error");
    } else if (k === "z") {
      const you = ents.get("p:" + youPid);
      const item = you && [...ents.values()].filter((e) => e.k === "i").sort((a, b) => dist(a.x, a.y, you.x, you.y) - dist(b.x, b.y, you.x, you.y))[0];
      if (item) {
        pendingPickup = item.id as number;
        if (dist(item.x, item.y, you!.x, you!.y) <= 1) tryPickup();
        else game.walkTo(item.x, item.y);
      }
    } else if (/^[1-4]$/.test(k) && game.me) {
      const job = JOBS[game.me.job as keyof typeof JOBS];
      const id = job.skills.find((s) => SKILLS[s].key === k);
      if (id && game.me.skills.includes(id)) game.useSkill(id);
      else if (id) game.log(`You haven't learned ${SKILLS[id].name} yet.`, "error");
    } else if (k === "enter") {
      ev.preventDefault();
      ui.focusChat();
    } else if (k === "escape") {
      game.selected = null;
      ui.selected(null);
      void game.act("stop");
    } else if (k === "e") {
      ui.emotePicker();
    } else if (k === "r" && game.me?.dead) {
      void game.act("respawn");
    }
  });
  canvas.addEventListener("keyup", (ev) => held.delete(ev.key));
  canvas.addEventListener("blur", () => held.clear());

  function stepKeys(now = false): void {
    const t = performance.now();
    if (!held.size || (!now && t - lastStep < 180)) return;
    const you = ents.get("p:" + youPid);
    if (!you) return;
    let dx = 0;
    let dy = 0;
    if (held.has("ArrowLeft")) dx--;
    if (held.has("ArrowRight")) dx++;
    if (held.has("ArrowUp")) dy--;
    if (held.has("ArrowDown")) dy++;
    if (!dx && !dy) return;
    lastStep = t;
    let [tx, ty] = [you.x + dx, you.y + dy];
    if (!walkable(game.map, tx, ty)) {
      if (dx && walkable(game.map, you.x + dx, you.y)) [tx, ty] = [you.x + dx, you.y];
      else if (dy && walkable(game.map, you.x, you.y + dy)) [tx, ty] = [you.x, you.y + dy];
      else return;
    }
    preview = [];
    void act("move", { x: tx, y: ty });
  }

  // ----- render -----
  function resize(): void {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width);
    canvas.height = Math.round(r.height);
    ctx.imageSmoothingEnabled = false;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  function frame(): void {
    const now = performance.now();
    stepKeys();
    const you = ents.get("p:" + youPid);
    for (const e of ents.values()) {
      e.rx += (e.x - e.rx) * 0.25;
      e.ry += (e.y - e.ry) * 0.25;
      if (Math.abs(e.x - e.rx) > 4 || Math.abs(e.y - e.ry) > 4) [e.rx, e.ry] = [e.x, e.y];
    }
    if (you) {
      if (pendingPickup !== null) {
        const it = ents.get("i:" + pendingPickup);
        if (!it) pendingPickup = null;
        else if (dist(it.x, it.y, you.x, you.y) <= 1) tryPickup();
      }
      if (pendingNpc) {
        const n = game.map.npcs.find((q) => q.id === pendingNpc);
        if (n && dist(n.x, n.y, you.x, you.y) <= 3) {
          ui.npc(n.id);
          pendingNpc = null;
        }
      }
      preview = preview.filter(([x, y], i) => i > 0 || x !== you.x || y !== you.y);
      if (preview.length && preview[0][0] === you.x && preview[0][1] === you.y) preview.shift();
    }
    const m = game.map;
    const W = canvas.width;
    const H = canvas.height;
    const fx = you ? you.rx * PX + PX / 2 - W / 2 : 0;
    const fy = you ? you.ry * PX + PX / 2 - H / 2 : 0;
    cam.x = Math.round(Math.max(Math.min(fx, m.w * PX - W), 0) - Math.max(0, (W - m.w * PX) / 2));
    cam.y = Math.round(Math.max(Math.min(fy, m.h * PX - H), 0) - Math.max(0, (H - m.h * PX) / 2));
    ctx.fillStyle = "#1b1410";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(-cam.x, -cam.y);
    const x0 = Math.max(0, Math.floor(cam.x / PX));
    const y0 = Math.max(0, Math.floor(cam.y / PX));
    const x1 = Math.min(m.w - 1, Math.ceil((cam.x + W) / PX));
    const y1 = Math.min(m.h - 1, Math.ceil((cam.y + H) / PX));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = TERRAIN[m.tiles[y][x]];
        if (t.under) draw(ctx, t.under, x * PX, y * PX, PX);
        draw(ctx, t.sprite, x * PX, y * PX, PX);
      }
    }
    for (const p of m.props) {
      if (p.under) draw(ctx, p.under, p.x * PX, p.y * PX, PX);
      draw(ctx, p.sprite, p.x * PX, p.y * PX, PX);
    }
    // portals pulse
    for (const p of m.portals) {
      ctx.fillStyle = `rgba(255, 220, 120, ${0.18 + 0.12 * Math.sin(now / 300)})`;
      ctx.fillRect(p.x * PX, p.y * PX, PX, PX);
    }
    // route preview
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    for (const [x, y] of preview) ctx.fillRect(x * PX + PX * 0.375, y * PX + PX * 0.375, PX / 4, PX / 4);
    if (hover && walkable(m, hover[0], hover[1])) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
      ctx.lineWidth = 2;
      ctx.strokeRect(hover[0] * PX + 1, hover[1] * PX + 1, PX - 2, PX - 2);
    }

    const sorted = [...ents.values()].sort((a, b) => a.ry - b.ry || (a.k === "i" ? -1 : 1));
    for (const e of sorted) if (e.k === "i") drawItem(e, now);
    for (const n of m.npcs) {
      draw(ctx, n.sprite, n.x * PX, n.y * PX, PX);
      label(n.name, n.x * PX + PX / 2, n.y * PX - 4, "#ffe0a3");
    }
    for (const e of sorted) {
      if (e.k === "s") drawStall(e);
      else if (e.k === "m") drawMonster(e);
      else if (e.k === "p") drawPlayer(e, now);
    }
    for (const f of overlay.splice(0)) f();
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = (now - f.born) / 1000;
      if (age > 1.4) {
        floaters.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.min(1, 1.6 - age);
      ctx.font = `${f.big ? 26 : 20}px "Kenney Pixel", monospace`;
      ctx.textAlign = "center";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#1b1410";
      const px = f.x * PX + PX / 2;
      const py = f.y * PX - 10 - age * 34;
      ctx.strokeText(f.text, px, py);
      ctx.fillStyle = f.colour;
      ctx.fillText(f.text, px, py);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (game.me?.dead) {
      ctx.fillStyle = "rgba(20, 0, 0, 0.45)";
      ctx.fillRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  // Names and bubbles are queued and drawn after every sprite, so a sprite
  // standing below someone never covers their name.
  const overlay: (() => void)[] = [];
  function label(text: string, x: number, y: number, colour: string): void {
    overlay.push(() => labelNow(text, x, y, colour));
  }
  function labelNow(text: string, x: number, y: number, colour: string): void {
    ctx.font = '18px "Kenney Pixel", monospace';
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(20, 14, 10, 0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  function bar(x: number, y: number, w: number, frac: number, colour: string): void {
    ctx.fillStyle = "rgba(20, 14, 10, 0.85)";
    ctx.fillRect(x - 1, y - 1, w + 2, 6);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, Math.max(0, w * frac), 4);
  }

  function drawItem(e: View, now: number): void {
    const def = ITEMS[e.item as ItemId];
    const bob = Math.sin(now / 250 + (e.id as number)) * 2;
    const size = PX * 0.7;
    const x = e.rx * PX + (PX - size) / 2;
    const y = e.ry * PX + (PX - size) / 2 + bob;
    if (def.rare) {
      ctx.fillStyle = `rgba(255, 215, 90, ${0.35 + 0.25 * Math.sin(now / 120)})`;
      ctx.beginPath();
      ctx.arc(e.rx * PX + PX / 2, e.ry * PX + PX / 2, PX * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    draw(ctx, def.sprite, x, y, size);
    const ownMs = (e.ownMs as number) ?? 0;
    if (e.owner && e.owner !== youPid && ownMs > 0) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fillRect(x, y, size, size);
    }
  }

  function drawStall(e: View): void {
    const x = e.rx * PX;
    const y = e.ry * PX;
    draw(ctx, { sheet: "dungeon", i: 72 }, x, y, PX);
    label(`🛒 ${e.title as string}`, x + PX / 2, y - 22, "#b3e5fc");
    label(e.name as string, x + PX / 2, y - 4, "#ffffff");
  }

  function drawMonster(e: View): void {
    const def = MONSTERS[e.type as MonsterId];
    const size = PX * def.scale;
    const x = e.rx * PX + PX / 2 - size / 2;
    const y = e.ry * PX + PX - size;
    if (game.selected === `m:${e.id}`) {
      ctx.strokeStyle = "#ff5252";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(e.rx * PX + PX / 2, e.ry * PX + PX - 4, size * 0.42, size * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    draw(ctx, def.sprite, x, y, size, { hue: def.hue, flip: e.flip });
    const hpf = (e.hp as number) / (e.mhp as number);
    if (hpf < 1 || def.ai === "mvp") bar(x + size * 0.1, y - 6, size * 0.8, hpf, def.ai === "mvp" ? "#ff7043" : "#e53935");
    if (def.ai === "mvp") label(`★ ${def.name} ★`, x + size / 2, y - 12, "#ffab40");
  }

  function drawPlayer(e: View, now: number): void {
    const job = JOBS[e.job as keyof typeof JOBS];
    const x = e.rx * PX;
    const y = e.ry * PX;
    const me = e.id === youPid;
    const sel = game.selected === `p:${e.id}`;
    if (me || sel) {
      ctx.strokeStyle = me ? "rgba(255, 255, 255, 0.6)" : "#69f0ae";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x + PX / 2, y + PX - 4, PX * 0.38, PX * 0.14, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    draw(ctx, job.sprite, x, y, PX, { flip: e.flip, alpha: e.dead ? 0.4 : 1 });
    const party = game.me?.party?.name;
    const colour = me ? "#ffffff" : party && e.party === party ? "#69f0ae" : "#ffe082";
    label(`${e.name as string}`, x + PX / 2, y + PX + 16, colour);
    if (e.guild) label(`‹${e.guild as string}›`, x + PX / 2, y + PX + 32, "#b39ddb");
    bar(x + 4, y - 8, PX - 8, (e.hp as number) / (e.mhp as number), "#43a047");
    if (e.castUntil && e.castUntil > now && e.castStart) {
      bar(x + 4, y - 15, PX - 8, (now - e.castStart) / (e.castUntil - e.castStart), "#42a5f5");
    }
    if (e.bubble && e.bubble.until > now) overlay.push(() => bubble(e.bubble!.text, x + PX / 2, y - 22));
    else if (e.emote && e.emote.until > now) overlay.push(() => bubble(EMOTES[e.emote!.e], x + PX / 2, y - 22));
  }

  function bubble(text: string, cx: number, by: number): void {
    ctx.font = '18px "Kenney Pixel", monospace';
    const lines: string[] = [];
    let line = "";
    for (const w of text.split(" ")) {
      if (ctx.measureText(line + " " + w).width > 180 && line) {
        lines.push(line);
        line = w;
      } else line = line ? line + " " + w : w;
    }
    lines.push(line);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
    const h = lines.length * 16 + 8;
    ctx.fillStyle = "rgba(255, 250, 240, 0.95)";
    ctx.strokeStyle = "#3e2723";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, by - h, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3e2723";
    ctx.textAlign = "center";
    lines.forEach((l, i) => ctx.fillText(l, cx, by - h + 18 + i * 16));
  }

  requestAnimationFrame(frame);
  canvas.focus();
}
