// The client's half of the protocol: post intents with a fresh command id
// (retrying the same id on a network failure, so a resend applies once), and
// hold one EventSource that reopens from a fresh snapshot whenever the
// sequence skips.

export interface ActResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

const cmdId = (): string => crypto.randomUUID().replace(/-/g, "");

export async function act(type: string, fields: Record<string, unknown> = {}): Promise<ActResult> {
  const body = JSON.stringify({ type, cmd: cmdId(), ...fields });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/api/act", { method: "POST", headers: { "content-type": "application/json" }, body });
      return (await res.json()) as ActResult;
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { ok: false, error: "couldn't reach the server" };
}

export interface Handlers {
  snapshot(d: { map: string; seq: number; you: string; ents: Ent[] }): void;
  delta(d: { seq: number; ents: Ent[]; gone: string[]; fx: Fx[] }): void;
  me(d: Me): void;
  chat(d: { from: string; scope: string; text: string }): void;
  announce(d: { text: string; sound: string | null }): void;
  status(s: "live" | "reconnecting"): void;
}

export interface Ent {
  k: "p" | "m" | "i" | "s";
  id: string | number;
  x: number;
  y: number;
  [k: string]: unknown;
}
export interface Fx {
  t: string;
  [k: string]: unknown;
}
// The full shape lives in server/world.ts meView; the UI reads it loosely.
export type Me = Record<string, any>;

export function connect(h: Handlers): { resync(): void } {
  let es: EventSource | null = null;
  let seq = -1;
  let retry = 1000;
  const open = (): void => {
    es?.close();
    es = new EventSource("/api/stream");
    es.addEventListener("open", () => {
      retry = 1000;
      h.status("live");
    });
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      seq = d.seq;
      h.snapshot(d);
    });
    es.addEventListener("delta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (seq >= 0 && d.seq !== seq + 1) {
        // a gap: something was missed, so start again from a snapshot
        seq = -1;
        open();
        return;
      }
      seq = d.seq;
      h.delta(d);
    });
    es.addEventListener("me", (e) => h.me(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("chat", (e) => h.chat(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("announce", (e) => h.announce(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("error", () => {
      h.status("reconnecting");
      // EventSource retries a dropped connection itself, but gives up for
      // good on a non-200 answer (a proxy 502 during a deploy): reopen.
      if (es?.readyState === EventSource.CLOSED) {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      }
    });
  };
  open();
  // A map change arrives as a new snapshot on the same stream; a snapshot
  // resets the sequence. Expose a manual resync for after a long sleep.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && es?.readyState !== EventSource.OPEN) open();
  });
  return { resync: open };
}
