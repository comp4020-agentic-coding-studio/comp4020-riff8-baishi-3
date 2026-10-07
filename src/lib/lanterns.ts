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
  // Your key: it only ever goes to the server. Everyone else, you included,
  // sees your lantern under the public id the server answers with.
  const id = tabId();
  let mineOnStream: string | null = null;

  // --- the dark, and the holes lanterns make in it ---------------------
  const defs = el("defs", {});
  defs.append(
    gradient("lantern-hole", [
      [0, "#000", 1],
      [0.5, "#000", 1],
      [1, "#000", 0],
    ]),
    // A faint amber wash, strongest at the rim like a flame's halo, light
    // enough that ink inside keeps its contrast.
    gradient("lantern-warm", [
      [0, "#ffb866", 0.1],
      [0.5, "#ffb866", 0.12],
      [0.78, "#ffb866", 0.3],
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
  // The warm wash is for the dark part of the scroll only: your strip stays
  // plain paper, so its prompt and echo read exactly as they do lit.
  const beforeZone = el("clipPath", { id: "lantern-clip" });
  beforeZone.append(
    el("rect", { x: "0", y: "0", width: zone.getAttribute("x") ?? String(width), height: String(height) }),
  );
  defs.append(mask, beforeZone);

  const dark = el("rect", {
    id: "lantern-dark",
    class: "lantern-dark",
    x: "0",
    y: "0",
    width: String(width),
    height: String(height),
    mask: "url(#lantern-mask)",
  });
  const glows = el("g", { class: "lantern-glows", "clip-path": "url(#lantern-clip)" });
  svg.prepend(defs);
  svg.insertBefore(dark, anchor);
  svg.insertBefore(glows, anchor);

  const makeLight = (mine: boolean): Light => {
    const hole = el("circle", { r: String(RADIUS), cx: "0", cy: "0", fill: "url(#lantern-hole)", class: "lantern" });
    const glow = el("circle", { r: String(RADIUS), cx: "0", cy: "0", fill: "url(#lantern-warm)", class: "lantern glow" });
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

  let away = false;

  const schedule = (delay: number): void => {
    if (pending !== null || away) return;
    pending = window.setTimeout(send, delay);
  };

  function send(): void {
    pending = null;
    if (away) return;
    lastSent = Date.now();
    fetch("/api/lanterns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, x: Math.round(pos.x), y: Math.round(pos.y) }),
    })
      .then(async (res) => {
        // Refused for going too fast: make sure where the hand came to rest
        // still arrives, rather than whatever got through before it.
        if (res.status === 429) schedule(SEND_EVERY_MS * 2);
        if (!res.ok || mineOnStream) return;
        const { lantern } = (await res.json()) as { lantern?: string };
        if (typeof lantern === "string") {
          mineOnStream = lantern;
          drop(lantern);
        }
      })
      .catch(() => {
        // a dropped update is fine: the next one, or the heartbeat, carries on
      });
  }

  const moveTo = (x: number, y: number): void => {
    pos.x = Math.min(width, Math.max(0, x));
    pos.y = Math.min(height, Math.max(0, y));
    place(own, pos.x, pos.y);
    schedule(Math.max(0, SEND_EVERY_MS - (Date.now() - lastSent)));
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

  // Arrow keys move your lantern while the scroll has focus (or nothing
  // does), and are left alone everywhere else so the page still scrolls.
  root.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as Element | null;
    if (t && t !== root.body && !wrap.contains(t)) return;
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
    if (!away && Date.now() - lastSent >= STILL_HERE_MS) send();
  }, 1_000);
  const putOut = (): void => {
    void fetch("/api/lanterns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, gone: true }),
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener("pagehide", putOut);

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
    if (l.id === mineOnStream) return;
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

  // Gone at once, no fade: for a light that turns out to be your own.
  function drop(otherId: string): void {
    const light = others.get(otherId);
    if (!light) return;
    others.delete(otherId);
    light.hole.remove();
    light.glow.remove();
    describe();
  }

  const hide = (otherId: string): void => {
    const light = others.get(otherId);
    if (!light) return;
    others.delete(otherId);
    fadeOut(light);
    describe();
  };

  describe();

  // EventSource retries a dropped connection by itself, but gives up for
  // good on an error response (a restarting machine, a proxy hiccup), so
  // a closed stream is reopened here, backing off up to half a minute.
  let source: EventSource | null = null;
  let retryMs = 1_000;
  let retryTimer: number | null = null;

  const open = (): void => {
    if (source || away) return;
    const s = new EventSource("/api/lanterns");
    source = s;
    s.addEventListener("snapshot", (e) => {
      retryMs = 1_000;
      const all = JSON.parse((e as MessageEvent).data) as { id: string; x: number; y: number }[];
      const here = new Set(all.map((l) => l.id));
      for (const otherId of [...others.keys()]) if (!here.has(otherId)) hide(otherId);
      for (const l of all) show(l);
    });
    s.addEventListener("move", (e) => show(JSON.parse((e as MessageEvent).data)));
    s.addEventListener("gone", (e) => hide((JSON.parse((e as MessageEvent).data) as { id: string }).id));
    s.addEventListener("error", () => {
      if (s.readyState !== EventSource.CLOSED) return;
      close();
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        open();
      }, retryMs);
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };

  const close = (): void => {
    source?.close();
    source = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  // A hidden tab isn't on the page right now: its lantern goes out for
  // everyone, and it stops listening, so a forgotten tab neither haunts the
  // room nor keeps the machine awake.
  root.addEventListener("visibilitychange", () => {
    if (root.visibilityState === "hidden") {
      away = true;
      if (pending !== null) clearTimeout(pending);
      pending = null;
      putOut();
      close();
      for (const otherId of [...others.keys()]) drop(otherId);
    } else {
      away = false;
      open();
      send();
    }
  });

  open();
}
