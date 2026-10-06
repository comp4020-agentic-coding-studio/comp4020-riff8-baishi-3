// Lantern viewing: with this script running, the scroll goes dark except
// where lanterns light it, yours and those of everyone else on the page right
// now. The darkness is added here, so without JavaScript the scroll is simply
// fully lit. Lanterns only change what you see; nothing about them is saved.

const NS = "http://www.w3.org/2000/svg";
const RADIUS = 170;
const SEND_EVERY_MS = 100;
const STILL_HERE_MS = 4_000; // well inside the server's 10s before a quiet lantern fades
const STEP = 40; // arrow keys move your lantern this far
const LIT_KEY = "scroll:lit";

interface Light {
  hole: SVGCircleElement;
  glow: SVGCircleElement;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function gradient(id: string, stops: [number, string, number][]): SVGRadialGradientElement {
  const g = el("radialGradient", { id });
  for (const [offset, color, opacity] of stops) {
    g.append(el("stop", { offset: String(offset), "stop-color": color, "stop-opacity": String(opacity) }));
  }
  return g;
}

function tabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function readLit(): boolean {
  try {
    return localStorage.getItem(LIT_KEY) === "1";
  } catch {
    return false;
  }
}

function saveLit(lit: boolean): void {
  try {
    localStorage.setItem(LIT_KEY, lit ? "1" : "0");
  } catch {
    // private window or blocked storage: the switch still works for this visit
  }
}

export function initLanterns(root: Document): void {
  const svg = root.querySelector<SVGSVGElement>("#scroll");
  const wrap = root.querySelector<HTMLElement>("#canvas-wrap");
  const zone = root.querySelector<SVGRectElement>("#zone-hit");
  const anchor = root.querySelector("#zone-outline");
  const controls = root.querySelector<HTMLElement>("#controls");
  const presence = root.querySelector<HTMLElement>("#presence");
  if (!svg || !wrap || !zone || !anchor || !controls || !presence) return;

  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const id = tabId();

  // --- the dark, and the holes lanterns make in it ---------------------
  const defs = el("defs", {});
  defs.append(
    gradient("lantern-hole", [
      [0, "#000", 1],
      [0.5, "#000", 1],
      [1, "#000", 0],
    ]),
    gradient("lantern-warm", [
      [0, "#ffb866", 0],
      [0.55, "#ffb866", 0],
      [0.8, "#ffb866", 0.16],
      [1, "#ffb866", 0],
    ]),
  );
  const mask = el("mask", {
    id: "lantern-mask",
    maskUnits: "userSpaceOnUse",
    x: "0",
    y: "0",
    width: String(width),
    height: String(height),
  });
  mask.append(el("rect", { x: "0", y: "0", width: String(width), height: String(height), fill: "#fff" }));
  // Your own drawing strip is always lit: nobody draws in the dark.
  mask.append(
    el("rect", {
      x: zone.getAttribute("x") ?? "0",
      y: "0",
      width: zone.getAttribute("width") ?? "0",
      height: String(height),
      fill: "#000",
    }),
  );
  const holes = el("g", {});
  mask.append(holes);
  defs.append(mask);

  const dark = el("rect", {
    id: "lantern-dark",
    class: "lantern-dark",
    x: "0",
    y: "0",
    width: String(width),
    height: String(height),
    mask: "url(#lantern-mask)",
  });
  const glows = el("g", { class: "lantern-glows" });
  svg.prepend(defs);
  svg.insertBefore(dark, anchor);
  svg.insertBefore(glows, anchor);

  const makeLight = (mine: boolean): Light => {
    const hole = el("circle", { r: String(RADIUS), cx: "0", cy: "0", fill: "url(#lantern-hole)", class: "lantern" });
    const glow = el("circle", { r: String(RADIUS), cx: "0", cy: "0", fill: "url(#lantern-warm)", class: "lantern" });
    if (!mine && !reduced) {
      hole.classList.add("drifts");
      glow.classList.add("drifts");
    }
    holes.append(hole);
    glows.append(glow);
    return { hole, glow };
  };

  const place = (light: Light, x: number, y: number): void => {
    const t = `translate(${x}px, ${y}px)`;
    light.hole.style.transform = t;
    light.glow.style.transform = t;
  };

  const fadeOut = (light: Light): void => {
    light.hole.classList.add("leaving");
    light.glow.classList.add("leaving");
    window.setTimeout(() => {
      light.hole.remove();
      light.glow.remove();
    }, reduced ? 0 : 1500);
  };

  // --- the switch for anyone who wants to see everything ---------------
  const button = root.createElement("button");
  button.type = "button";
  button.className = "control";
  button.textContent = "Light the whole scroll";
  controls.append(button);
  const setLit = (lit: boolean): void => {
    svg.classList.toggle("fully-lit", lit);
    button.setAttribute("aria-pressed", String(lit));
  };
  setLit(readLit());
  button.addEventListener("click", () => {
    const lit = button.getAttribute("aria-pressed") !== "true";
    setLit(lit);
    saveLit(lit);
  });

  // --- your lantern ----------------------------------------------------
  const own = makeLight(true);
  const pos = { x: wrap.scrollLeft + wrap.clientWidth / 2, y: height / 2 };
  let lastSent = 0;
  let pending: number | null = null;
  let lastPointer = "mouse";

  const send = (): void => {
    pending = null;
    lastSent = Date.now();
    void fetch("/api/lanterns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, x: Math.round(pos.x), y: Math.round(pos.y) }),
    }).catch(() => {
      // a dropped update is fine: the next one, or the heartbeat, carries on
    });
  };

  const moveTo = (x: number, y: number): void => {
    pos.x = Math.min(width, Math.max(0, x));
    pos.y = Math.min(height, Math.max(0, y));
    place(own, pos.x, pos.y);
    if (pending !== null) return;
    pending = window.setTimeout(send, Math.max(0, SEND_EVERY_MS - (Date.now() - lastSent)));
  };

  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    const local = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
    return { x: local.x, y: local.y };
  };

  svg.addEventListener("pointermove", (e) => {
    lastPointer = e.pointerType;
    const p = toSvg(e.clientX, e.clientY);
    moveTo(p.x, p.y);
  });
  svg.addEventListener("pointerdown", (e) => {
    lastPointer = e.pointerType;
    const p = toSvg(e.clientX, e.clientY);
    moveTo(p.x, p.y);
  });
  // A finger can't hover, so on touch the lantern rides along with the view.
  wrap.addEventListener("scroll", () => {
    if (lastPointer !== "mouse") moveTo(wrap.scrollLeft + wrap.clientWidth / 2, pos.y);
  });

  root.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest("input, textarea, select, button")) return;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    moveTo(pos.x + d[0], pos.y + d[1]);
    // keep it in view
    if (pos.x < wrap.scrollLeft + RADIUS / 2 || pos.x > wrap.scrollLeft + wrap.clientWidth - RADIUS / 2) {
      wrap.scrollTo({ left: pos.x - wrap.clientWidth / 2, behavior: reduced ? "auto" : "smooth" });
    }
  });

  moveTo(pos.x, pos.y);
  window.setInterval(() => {
    if (Date.now() - lastSent >= STILL_HERE_MS) send();
  }, 1_000);
  window.addEventListener("pagehide", () => {
    void fetch("/api/lanterns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, gone: true }),
      keepalive: true,
    }).catch(() => {});
  });

  // --- everyone else ---------------------------------------------------
  const others = new Map<string, Light>();

  const describe = (): void => {
    const n = others.size;
    presence.textContent =
      n === 0
        ? "You're the only light here right now."
        : n === 1
          ? "Two lanterns lit: yours, and one other."
          : `${n + 1} lanterns lit: yours, and ${n} others.`;
  };

  const show = (l: { id: string; x: number; y: number }): void => {
    if (l.id === id) return;
    let light = others.get(l.id);
    if (!light) {
      light = makeLight(false);
      light.hole.classList.add("arriving");
      light.glow.classList.add("arriving");
      place(light, l.x, l.y);
      others.set(l.id, light);
      const arriving = light;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          arriving.hole.classList.remove("arriving");
          arriving.glow.classList.remove("arriving");
        }),
      );
      describe();
    } else {
      place(light, l.x, l.y);
    }
  };

  const hide = (otherId: string): void => {
    const light = others.get(otherId);
    if (!light) return;
    others.delete(otherId);
    fadeOut(light);
    describe();
  };

  describe();
  const source = new EventSource("/api/lanterns");
  source.addEventListener("snapshot", (e) => {
    const all = JSON.parse((e as MessageEvent).data) as { id: string; x: number; y: number }[];
    const here = new Set(all.map((l) => l.id));
    for (const otherId of [...others.keys()]) if (!here.has(otherId)) hide(otherId);
    for (const l of all) show(l);
  });
  source.addEventListener("move", (e) => show(JSON.parse((e as MessageEvent).data)));
  source.addEventListener("gone", (e) => hide((JSON.parse((e as MessageEvent).data) as { id: string }).id));
}
