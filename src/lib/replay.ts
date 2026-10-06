// "Watch it grow": replays the saved marks in the order they were made,
// each one drawn along its own path. Strictly read-only. It only hides and
// re-shows what's already on the page, and the fully drawn scroll is the
// resting state before and after. The control is created here, so a
// visitor without JavaScript never sees a button that does nothing.

// Pacing follows the real gaps between marks, so a burst of visitors replays
// as a burst and a quiet week as a pause, but squeezed into a range that's
// watchable for a scroll of five marks or five thousand.
const MIN_STEP_MS = 140;
const MAX_STEP_MS = 1400;
const GAP_CAP_MS = 60 * 60 * 1000; // any gap of an hour or more reads as the longest pause
const MAX_TOTAL_MS = 45_000;

function steps(times: number[]): number[] {
  const raw = times.map((t, i) => {
    if (i === 0) return MIN_STEP_MS;
    const gap = Math.min(Math.max(0, t - times[i - 1]), GAP_CAP_MS) / GAP_CAP_MS;
    return MIN_STEP_MS + Math.sqrt(gap) * (MAX_STEP_MS - MIN_STEP_MS);
  });
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > MAX_TOTAL_MS ? MAX_TOTAL_MS / total : 1;
  return raw.map((s) => s * scale);
}

export function initReplay(root: Document): void {
  const svg = root.querySelector<SVGSVGElement>("#scroll");
  const wrap = root.querySelector<HTMLElement>("#canvas-wrap");
  const controls = root.querySelector<HTMLElement>("#controls");
  const status = root.querySelector<HTMLElement>("#status");
  const zoneHit = root.querySelector<SVGRectElement>("#zone-hit");
  if (!svg || !wrap || !controls || !status) return;

  const marks = [...svg.querySelectorAll<SVGGElement>("g.mark")];
  if (marks.length === 0) return;
  const times = marks.map((m) => Number(m.dataset.t) || 0);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const button = root.createElement("button");
  button.type = "button";
  button.className = "control";
  button.textContent = "Watch it grow";
  controls.append(button);

  let timers: number[] = [];
  let restingStatus = "";
  let running = false;

  const reset = (): void => {
    for (const m of marks) {
      m.classList.remove("replay-hidden");
      for (const p of m.querySelectorAll<SVGPathElement>("path")) {
        p.style.transition = "";
        p.style.strokeDasharray = "";
        p.style.strokeDashoffset = "";
      }
    }
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    for (const t of timers) clearTimeout(t);
    timers = [];
    reset();
    svg.classList.remove("replaying");
    status.textContent = restingStatus;
    button.textContent = "Watch it grow";
    button.setAttribute("aria-pressed", "false");
  };

  const reveal = (mark: SVGGElement, duration: number): void => {
    mark.classList.remove("replay-hidden");
    if (reduced) return;
    for (const p of mark.querySelectorAll<SVGPathElement>("path")) {
      const len = Math.max(1, p.getTotalLength());
      p.style.transition = "none";
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
      p.getBoundingClientRect(); // commit the starting offset before animating from it
      p.style.transition = `stroke-dashoffset ${duration}ms ease-out`;
      p.style.strokeDashoffset = "0";
    }
  };

  const follow = (mark: SVGGElement): void => {
    const box = mark.getBBox();
    const left = box.x + box.width / 2 - wrap.clientWidth / 2;
    wrap.scrollTo({ left, behavior: reduced ? "auto" : "smooth" });
  };

  const start = (): void => {
    running = true;
    restingStatus = status.textContent ?? "";
    button.textContent = "Stop replay";
    button.setAttribute("aria-pressed", "true");
    // Watching it grow is about the whole scroll, so the lanterns' dark lifts.
    svg.classList.add("replaying");
    for (const m of marks) m.classList.add("replay-hidden");

    const pace = steps(times);
    let at = 400;
    marks.forEach((mark, i) => {
      timers.push(
        window.setTimeout(() => {
          reveal(mark, Math.min(700, pace[i] * 0.9));
          follow(mark);
          const when = new Date(times[i]).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
          status.textContent = `mark ${i + 1} of ${marks.length}, made ${when}`;
        }, at),
      );
      at += pace[i];
    });
    timers.push(
      window.setTimeout(() => {
        stop();
        wrap.scrollTo({ left: wrap.scrollWidth, behavior: reduced ? "auto" : "smooth" });
      }, at + 900),
    );
  };

  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => (running ? stop() : start()));

  // Picking up the brush always wins over watching.
  zoneHit?.addEventListener("pointerdown", stop, { capture: true });
  zoneHit?.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === " ") stop();
    },
    { capture: true },
  );
}
