// The panels around the canvas: status, skills, bag, party and guild, chat,
// and the NPC, trade and stall windows. Plain DOM; every button posts an
// intent and the next `me` event redraws the panel.

import { EMOTES, ITEMS, JOBS, SHOP_STOCK, SKILLS, STATS, type ItemId, type SkillId } from "../game/data.ts";
import { SAFE_REFINE, baseXpToNext, jobXpToNext, refineChance, refineCost, statCost } from "../game/rules.ts";
import type { Game } from "./game.ts";
import type { Me } from "./net.ts";
import { iconStyle } from "./sprites.ts";

export interface Ui {
  me(m: Me): void;
  log(text: string, kind?: string): void;
  chat(c: { from: string; scope: string; text: string }): void;
  announce(text: string): void;
  status(s: string): void;
  mapChanged(name: string): void;
  selected(p: { id: string; name: string } | null): void;
  npc(id: string): void;
  stall(seller: string): void;
  focusChat(): void;
  emotePicker(): void;
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const itemLabel = (r: { item: ItemId; refine?: number; cards?: ItemId[]; qty?: number }): string =>
  `${r.refine ? "+" + r.refine + " " : ""}${ITEMS[r.item].name}${r.cards?.length ? " [" + r.cards.map((c) => ITEMS[c].name.replace(" Card", "")).join(", ") + "]" : ""}${r.qty && r.qty > 1 ? " ×" + r.qty : ""}`;
const icon = (item: ItemId): string => `<span class="icon" style="${iconStyle(ITEMS[item].sprite)}"></span>`;

export function initUi(game: Game): Ui {
  let me: Me | null = null;
  let tab = "status";
  let modal: { kind: string; arg?: string } | null = null;
  let selectedPlayer: { id: string; name: string } | null = null;
  let stallDraft: Record<number, { qty: number; price: number }> = {};
  let tradeDraft: { items: Record<number, number>; zeny: number } = { items: {}, zeny: 0 };

  const logEl = $("#log");
  const tabs = $("#tabs");
  const panel = $("#panel");
  const modalEl = $("#modal");
  const bars = $("#bars");
  const targetEl = $("#target");

  function line(html: string, kind = ""): void {
    const p = document.createElement("p");
    p.className = kind;
    p.innerHTML = html;
    logEl.append(p);
    while (logEl.children.length > 80) logEl.firstElementChild!.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  tabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button[data-tab]") as HTMLElement | null;
    if (!b) return;
    tab = b.dataset.tab!;
    render();
  });

  // all panel buttons are delegated: data-act names the intent, data-* the fields
  document.addEventListener("click", async (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-do]") as HTMLElement | null;
    if (!b) return;
    ev.preventDefault();
    const d = b.dataset;
    const n = (k: string): number => Number(d[k]);
    switch (d.do) {
      case "stat": await game.act("stat", { stat: d.stat }); break;
      case "learn": await game.act("learn", { skill: d.skill }); break;
      case "skill": game.useSkill(d.skill as SkillId); break;
      case "use": await game.act("use", { item: n("id") }); break;
      case "equip": await game.act("equip", { item: n("id") }); break;
      case "unequip": await game.act("unequip", { item: n("id") }); break;
      case "card": {
        const gear = (me?.inventory ?? []).filter((r: any) => ITEMS[r.item as ItemId].kind === "equip" && r.cards.length < (ITEMS[r.item as ItemId].slots ?? 0));
        if (!gear.length) return game.log("No equipment with a free card slot.", "error");
        const pick = gear.find((r: any) => r.equipped) ?? gear[0];
        if (confirm(`Slot this card into ${itemLabel(pick)}? It can't be removed.`)) await game.act("card", { card: n("id"), equip: pick.id });
        break;
      }
      case "respawn": await game.act("respawn"); break;
      case "party-create": {
        const name = prompt("Name your party:");
        if (name) await game.act("party_create", { name });
        break;
      }
      case "party-join": await game.act("party_join", { party: n("id") }); break;
      case "party-leave": await game.act("party_leave"); break;
      case "guild-create": {
        const name = prompt("Name your guild:");
        if (name) await game.act("guild_create", { name });
        break;
      }
      case "guild-join": await game.act("guild_join", { guild: n("id") }); break;
      case "guild-leave": await game.act("guild_leave"); break;
      case "invite-party": if (selectedPlayer) await game.act("party_invite", { target: selectedPlayer.id }); break;
      case "invite-guild": if (selectedPlayer) await game.act("guild_invite", { target: selectedPlayer.id }); break;
      case "heal-target": if (selectedPlayer) game.useSkill("heal"); break;
      case "trade-request": if (selectedPlayer) await game.act("trade_request", { target: selectedPlayer.id }); break;
      case "trade-accept": await game.act("trade_accept", { from: d.from }); break;
      case "trade-add": tradeDraft.items[n("id")] = Math.min((tradeDraft.items[n("id")] ?? 0) + 1, n("max")); render(); break;
      case "trade-remove": delete tradeDraft.items[n("id")]; render(); break;
      case "trade-offer": {
        const zeny = Number(($("#trade-zeny") as HTMLInputElement)?.value || 0);
        tradeDraft.zeny = zeny;
        await game.act("trade_offer", { zeny, items: Object.entries(tradeDraft.items).map(([id, qty]) => ({ id: Number(id), qty })) });
        break;
      }
      case "trade-confirm": await game.act("trade_confirm", { version: n("version") }); break;
      case "trade-cancel": await game.act("trade_cancel"); break;
      case "shop-buy": {
        const r = await game.act("shop_buy", { item: d.item, qty: 1 });
        if (r.ok) game.log(`Bought ${ITEMS[d.item as ItemId].name}.`, "good");
        break;
      }
      case "shop-sell": await game.act("shop_sell", { item: n("id"), qty: n("qty") }); break;
      case "refine": {
        const r = await game.act("refine", { item: n("id") });
        if (r.ok) game.log(r.success ? `It held: now +${r.refine}.` : "The anvil rang wrong. It broke.", r.success ? "good" : "error");
        break;
      }
      case "store-put": await game.act("storage_put", { item: n("id"), qty: n("qty") }); break;
      case "store-take": await game.act("storage_take", { item: n("id"), qty: n("qty") }); break;
      case "stall-add": stallDraft[n("id")] = { qty: n("max"), price: Math.max(1, Math.floor(ITEMS[d.item as ItemId].price * 0.8)) }; render(); break;
      case "stall-remove": delete stallDraft[n("id")]; render(); break;
      case "stall-open": {
        const title = (($("#stall-title") as HTMLInputElement)?.value || "").trim() || `${me?.name}'s wares`;
        const items = Object.entries(stallDraft).map(([id, v]) => {
          const price = Number(($(`#price-${id}`) as HTMLInputElement)?.value || v.price);
          return { id: Number(id), qty: v.qty, price };
        });
        const r = await game.act("stall_open", { title, items });
        if (r.ok) {
          stallDraft = {};
          close();
        }
        break;
      }
      case "stall-close": await game.act("stall_close"); break;
      case "stall-buy": {
        const r = await game.act("stall_buy", { seller: d.seller, item: n("id"), qty: 1 });
        if (r.ok) {
          game.log(`Bought ${ITEMS[d.item as ItemId].name}.`, "good");
          showStall(d.seller!);
        }
        break;
      }
      case "emote": await game.act("emote", { emote: n("e") }); close(); break;
      case "open": modal = { kind: d.kind! }; render(); break;
      case "close": close(); break;
      case "forget":
        if (confirm("Forget this character in this browser? You'll start a new one; the old one can't be recovered.")) {
          await fetch("/api/character", { method: "DELETE" });
          location.reload();
        }
        break;
    }
  });

  function close(): void {
    modal = null;
    render();
    ($("#game") as HTMLCanvasElement).focus();
  }

  const chatForm = $("#chat") as HTMLFormElement;
  chatForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = chatForm.elements.namedItem("text") as HTMLInputElement;
    const scope = (chatForm.elements.namedItem("scope") as HTMLSelectElement).value;
    const text = input.value.trim();
    if (!text) return ($("#game") as HTMLCanvasElement).focus();
    input.value = "";
    await game.act("chat", { text, scope });
    ($("#game") as HTMLCanvasElement).focus();
  });

  function renderBars(): void {
    if (!me) return;
    const d = me.derived;
    const pct = (a: number, b: number): number => Math.max(0, Math.min(100, (a / b) * 100));
    const weightPct = Math.round((me.weight / d.maxWeight) * 100);
    bars.innerHTML = `
      <div class="who"><span class="icon" style="${iconStyle(JOBS[me.job as keyof typeof JOBS].sprite)}"></span>
        <div><strong>${esc(me.name)}</strong><br><small>${JOBS[me.job as keyof typeof JOBS].name} · Lv ${me.level} · Job ${me.jobLevel}</small></div></div>
      <div class="bar hp"><i style="width:${pct(me.hp, d.maxHp)}%"></i><span>HP ${me.hp}/${d.maxHp}</span></div>
      <div class="bar sp"><i style="width:${pct(me.sp, d.maxSp)}%"></i><span>SP ${me.sp}/${d.maxSp}</span></div>
      <div class="bar xp"><i style="width:${pct(me.xp, baseXpToNext(me.level))}%"></i><span>Base ${me.xp}/${baseXpToNext(me.level)}</span></div>
      <div class="bar job"><i style="width:${pct(me.jobXp, jobXpToNext(me.jobLevel))}%"></i><span>Job ${me.jobXp}/${jobXpToNext(me.jobLevel)}</span></div>
      <small>${me.zeny}z · weight ${weightPct}%${weightPct > 90 ? " (too heavy to fight)" : weightPct > 50 ? " (no regen)" : ""}
      ${Object.entries(me.buffs).map(([b, ms]) => ` · ${b} ${Math.ceil((ms as number) / 1000)}s`).join("")}</small>
      <div class="hotbar">${(JOBS[me.job as keyof typeof JOBS].skills as SkillId[]).map((s) => {
        const known = me!.skills.includes(s);
        const cd = me!.cooldowns[s] ?? 0;
        return `<button data-do="skill" data-skill="${s}" ${known ? "" : "disabled"} title="${esc(SKILLS[s].desc)}">
          <kbd>${SKILLS[s].key}</kbd> ${SKILLS[s].name}${cd > 0 ? ` <small>${(cd / 1000).toFixed(0)}s</small>` : ""}</button>`;
      }).join("")}</div>
      ${me.dead ? `<p class="dead">You have fallen. <button data-do="respawn">Wake in Hollowfield (R)</button></p>` : ""}
      ${me.partyInvites.map((i: any) => `<p class="invite">Invited to party "${esc(i.name)}" <button data-do="party-join" data-id="${i.id}">Join</button></p>`).join("")}
      ${me.guildInvites.map((i: any) => `<p class="invite">Invited to guild "${esc(i.name)}" <button data-do="guild-join" data-id="${i.id}">Join</button></p>`).join("")}
      ${me.tradeInvite ? `<p class="invite">${esc(me.tradeInvite.name)} wants to trade <button data-do="trade-accept" data-from="${me.tradeInvite.from}">Open trade</button></p>` : ""}
    `;
  }

  function renderTarget(): void {
    if (!selectedPlayer) {
      targetEl.hidden = true;
      return;
    }
    targetEl.hidden = false;
    const canHeal = me?.skills.includes("heal");
    targetEl.innerHTML = `<strong>${esc(selectedPlayer.name)}</strong>
      ${canHeal ? `<button data-do="heal-target">Heal (1)</button>` : ""}
      <button data-do="invite-party">Invite to party</button>
      <button data-do="invite-guild">Invite to guild</button>
      <button data-do="trade-request">Trade</button>`;
  }

  function renderPanel(): void {
    if (!me) return;
    for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", (b as HTMLElement).dataset.tab === tab);
    if (tab === "status") {
      panel.innerHTML = `<h3>Stats <small>${me.statPoints} points</small></h3>
        <table class="stats">${STATS.map((s) => `<tr><th>${s.toUpperCase()}</th><td>${me!.stats[s]}</td>
          <td><button data-do="stat" data-stat="${s}" ${me!.statPoints >= statCost(me!.stats[s]) ? "" : "disabled"}>+ (${statCost(me!.stats[s])})</button></td></tr>`).join("")}</table>
        <p class="derived">ATK ${me.derived.atk} · MATK ${me.derived.matk} · DEF ${me.derived.def}<br>HIT ${me.derived.hit} · FLEE ${me.derived.flee} · CRIT ${me.derived.crit}% · ${(me.derived.attackMs / 1000).toFixed(2)}s/attack</p>
        <p><button data-do="forget" class="quiet">Start over in this browser</button></p>`;
    } else if (tab === "skills") {
      const job = JOBS[me.job as keyof typeof JOBS];
      panel.innerHTML = `<h3>Skills <small>${me.skillPoints} points</small></h3>` + (job.skills as SkillId[]).map((s) => {
        const sk = SKILLS[s];
        const known = me!.skills.includes(s);
        const ready = !known && sk.prereq.every((q) => me!.skills.includes(q)) && me!.skillPoints > 0;
        return `<div class="skill ${known ? "known" : ""}"><strong>${sk.key}. ${sk.name}</strong> <small>${sk.sp} SP${sk.castMs ? ` · ${sk.castMs / 1000}s cast` : ""} · range ${sk.range || "self"}</small>
          <p>${esc(sk.desc)}${sk.prereq.length ? ` <em>Needs ${sk.prereq.map((q) => SKILLS[q].name).join(", ")}.</em>` : ""}</p>
          ${known ? "" : `<button data-do="learn" data-skill="${s}" ${ready ? "" : "disabled"}>Learn</button>`}</div>`;
      }).join("") + `<p class="hint">Skill points come from job levels.</p>`;
    } else if (tab === "bag") {
      panel.innerHTML = `<h3>Bag <small>${me.zeny}z</small></h3><ul class="bag">` + me.inventory.map((r: any) => {
        const def = ITEMS[r.item as ItemId];
        const btns = def.kind === "consumable" ? `<button data-do="use" data-id="${r.id}">Use</button>`
          : def.kind === "equip" ? (r.equipped ? `<button data-do="unequip" data-id="${r.id}">Unequip</button>` : `<button data-do="equip" data-id="${r.id}">Equip</button>`)
          : def.kind === "card" ? `<button data-do="card" data-id="${r.id}">Slot</button>` : "";
        return `<li>${icon(r.item)}<span>${esc(itemLabel(r))}${r.equipped ? " <em>(worn)</em>" : ""}</span>${btns}</li>`;
      }).join("") + `</ul>${me.map === "town" ? `<button data-do="open" data-kind="stall-setup">${me.stall ? "Your stall" : "Open a stall here"}</button>` : ""}`;
    } else if (tab === "party") {
      const p = me.party;
      const g = me.guild;
      panel.innerHTML = `<h3>Party</h3>${p ? `<p><strong>${esc(p.name)}</strong> · XP shared with members on your map (+15% each)</p><ul class="members">${p.members.map((m: any) => `<li>${m.pid === p.leader ? "★ " : ""}${esc(m.name)} <small>${JOBS[m.job as keyof typeof JOBS].name} ${m.level}${m.online ? ` · ${m.hp}/${m.mhp} HP` : " · offline"}</small></li>`).join("")}</ul>
        <button data-do="party-leave">Leave party</button>` : `<p>No party. Click another player on the map to invite them once you have one.</p><button data-do="party-create">Make a party</button>`}
        <h3>Guild</h3>${g ? `<p><strong>${esc(g.name)}</strong> · ${g.members.length} member${g.members.length === 1 ? "" : "s"} · ${g.storage.length} stacks in storage (Ilse, in Hollowfield)</p>
        <ul class="members">${g.members.map((m: any) => `<li>${m.pid === g.leader ? "★ " : ""}${esc(m.name)} <small>${m.online ? "online" : "offline"}</small></li>`).join("")}</ul>
        <button data-do="guild-leave">Leave guild</button>` : `<p>No guild.</p><button data-do="guild-create">Found a guild</button>`}`;
    } else if (tab === "help") {
      panel.innerHTML = `<h3>How to play</h3><ul class="help">
        <li><b>Click</b> the ground to walk, a monster to attack, an item to pick it up, a person for options.</li>
        <li><b>Arrows</b> step. <b>A</b> or <b>Space</b> attacks the nearest monster. <b>1–4</b> use skills. <b>Z</b> picks up. <b>Enter</b> chats. <b>E</b> emotes. <b>Esc</b> stops.</li>
        <li>The gate east of town leads to the Amber Fields; the far corner of the fields leads to the Barrow.</li>
        <li>Loot belongs to whoever dealt the most damage for 6s, then it's anyone's. Mosslings eat loot nobody claims.</li>
        <li>A party splits XP among members on the map, with a bonus: together beats alone.</li></ul>`;
    }
  }

  function renderModal(): void {
    if (!me || !modal) {
      if (!me?.trade) {
        modalEl.hidden = true;
        return;
      }
    }
    const kind = me?.trade ? "trade" : modal!.kind;
    modalEl.hidden = false;
    let body = "";
    if (kind === "trade") {
      const t = me!.trade;
      const offer = (o: any): string => `<ul>${o.items.map((i: any) => `<li>${i.item ? icon(i.item) + esc(itemLabel({ item: i.item, refine: i.refine, qty: i.qty })) : "?"}</li>`).join("") || "<li><em>nothing</em></li>"}</ul><p>${o.zeny}z</p>`;
      body = `<h2>Trading with ${esc(t.withName)}</h2>
        <div class="trade"><div><h3>You give ${t.iConfirmed ? "✔" : ""}</h3>${offer(t.mine)}</div><div><h3>${esc(t.withName)} gives ${t.theyConfirmed ? "✔" : ""}</h3>${offer(t.theirs)}</div></div>
        <h3>Your offer</h3><ul class="bag">${me!.inventory.filter((r: any) => !r.equipped).map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))}${tradeDraft.items[r.id] ? ` <b>→ ${tradeDraft.items[r.id]}</b>` : ""}</span>
          <button data-do="trade-add" data-id="${r.id}" data-max="${r.qty}">+</button>${tradeDraft.items[r.id] ? `<button data-do="trade-remove" data-id="${r.id}">×</button>` : ""}</li>`).join("")}</ul>
        <label>Zeny <input id="trade-zeny" type="number" min="0" value="${tradeDraft.zeny}"></label>
        <p><button data-do="trade-offer">Put this on the table</button>
        <button data-do="trade-confirm" data-version="${t.version}" ${t.iConfirmed ? "disabled" : ""}>Confirm (both must)</button>
        <button data-do="trade-cancel">Cancel</button></p>
        <p class="hint">Any change to either side clears both confirmations.</p>`;
    } else if (kind === "shop") {
      body = `<h2>Marta the Grocer</h2><p>You have ${me!.zeny}z.</p><h3>Buy</h3><ul class="bag">${SHOP_STOCK.map((i) => `<li>${icon(i)}<span>${ITEMS[i].name} <small>${ITEMS[i].price}z</small></span><button data-do="shop-buy" data-item="${i}">Buy</button></li>`).join("")}</ul>
        <h3>Sell</h3><ul class="bag">${me!.inventory.filter((r: any) => !r.equipped).map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))} <small>${Math.floor(ITEMS[r.item as ItemId].price / 2)}z each</small></span><button data-do="shop-sell" data-id="${r.id}" data-qty="1">Sell 1</button>${r.qty > 1 ? `<button data-do="shop-sell" data-id="${r.id}" data-qty="${r.qty}">All</button>` : ""}</li>`).join("")}</ul>`;
    } else if (kind === "smith") {
      body = `<h2>Old Tobin's anvil</h2><p>Safe to +${SAFE_REFINE}. Past that, a failure breaks the item for good. You have ${me!.zeny}z.</p><ul class="bag">${me!.inventory.filter((r: any) => ITEMS[r.item as ItemId].kind === "equip").map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))} <small>${refineCost(r.refine)}z · ${Math.round(refineChance(r.refine) * 100)}%</small></span><button data-do="refine" data-id="${r.id}" ${r.refine >= 10 ? "disabled" : ""}>Refine</button></li>`).join("") || "<li>No equipment.</li>"}</ul>`;
    } else if (kind === "steward") {
      const g = me!.guild;
      body = `<h2>Ilse the Steward</h2>` + (g ? `<p>"${esc(g.name)}" storage. Only members can open it.</p>
        <h3>In storage</h3><ul class="bag">${g.storage.map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))}</span><button data-do="store-take" data-id="${r.id}" data-qty="1">Take 1</button>${r.qty > 1 ? `<button data-do="store-take" data-id="${r.id}" data-qty="${r.qty}">All</button>` : ""}</li>`).join("") || "<li><em>empty</em></li>"}</ul>
        <h3>Your bag</h3><ul class="bag">${me!.inventory.filter((r: any) => !r.equipped).map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))}</span><button data-do="store-put" data-id="${r.id}" data-qty="${r.qty}">Store</button></li>`).join("")}</ul>`
        : `<p>"Guild storage is for guild members. Found or join a guild first."</p>`);
    } else if (kind === "stall-setup") {
      if (me!.stall) {
        body = `<h2>Your stall: ${esc(me!.stall.title)}</h2><ul class="bag">${me!.stall.items.map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))} <small>${r.price}z</small></span></li>`).join("") || "<li>sold out</li>"}</ul>
          <p>It stays open while you're away. <button data-do="stall-close">Close stall</button></p>`;
      } else {
        body = `<h2>Open a stall</h2><label>Sign <input id="stall-title" maxlength="30" placeholder="${esc(me!.name)}'s wares"></label>
          <ul class="bag">${me!.inventory.filter((r: any) => !r.equipped).map((r: any) => stallDraft[r.id]
            ? `<li>${icon(r.item)}<span>${esc(itemLabel(r))}</span><input id="price-${r.id}" type="number" min="1" value="${stallDraft[r.id].price}" aria-label="price">z<button data-do="stall-remove" data-id="${r.id}">×</button></li>`
            : `<li>${icon(r.item)}<span>${esc(itemLabel(r))}</span><button data-do="stall-add" data-id="${r.id}" data-max="${r.qty}" data-item="${r.item}">List</button></li>`).join("")}</ul>
          <button data-do="stall-open" ${Object.keys(stallDraft).length ? "" : "disabled"}>Open stall</button>`;
      }
    } else if (kind === "stall-view") {
      body = modal!.arg ?? "";
    } else if (kind === "emote") {
      body = `<h2>Emote</h2><p class="emotes">${EMOTES.map((e, i) => `<button data-do="emote" data-e="${i}">${e}</button>`).join("")}</p>`;
    }
    modalEl.innerHTML = `<div class="window">${body}<button class="x" data-do="close" aria-label="close">×</button></div>`;
  }

  async function showStall(seller: string): Promise<void> {
    const res = await fetch(`/api/stall?seller=${encodeURIComponent(seller)}`);
    const d = await res.json();
    if (!d.ok) {
      game.log(d.error, "error");
      if (modal?.kind === "stall-view") close();
      return;
    }
    const s = d.stall;
    modal = {
      kind: "stall-view",
      arg: `<h2>${esc(s.title)}</h2><p>${esc(s.name)}'s stall. You have ${me?.zeny ?? 0}z.</p><ul class="bag">${s.items.map((r: any) => `<li>${icon(r.item)}<span>${esc(itemLabel(r))} <small>${r.price}z</small></span><button data-do="stall-buy" data-seller="${s.seller}" data-id="${r.id}" data-item="${r.item}">Buy 1</button></li>`).join("")}</ul>`,
    };
    render();
  }

  function render(): void {
    renderBars();
    renderTarget();
    renderPanel();
    renderModal();
  }

  return {
    me(m) {
      const firstTrade = m.trade && !me?.trade;
      me = m;
      if (firstTrade) tradeDraft = { items: {}, zeny: 0 };
      // don't redraw a modal under someone typing a price
      const typing = document.activeElement instanceof HTMLInputElement && modalEl.contains(document.activeElement);
      renderBars();
      renderTarget();
      renderPanel();
      if (!typing) renderModal();
    },
    log: (text, kind) => line(esc(text), kind),
    chat(c) {
      if (c.scope === "system") line(esc(c.text), "system");
      else line(`<b>${esc(c.from)}</b>${c.scope !== "say" ? ` <small>[${c.scope}]</small>` : ""}: ${esc(c.text)}`, c.scope);
    },
    announce(text) {
      line(`★ ${esc(text)}`, "announce");
      const a = $("#announce");
      a.textContent = text;
      a.classList.remove("show");
      void a.offsetWidth;
      a.classList.add("show");
    },
    status(s) {
      $("#conn").textContent = s === "live" ? "" : "reconnecting…";
    },
    mapChanged(name) {
      line(`You arrive in ${esc(name)}.`, "system");
      $("#mapname").textContent = name;
    },
    selected(p) {
      selectedPlayer = p;
      renderTarget();
    },
    npc(id) {
      modal = { kind: id };
      render();
    },
    stall: (seller) => void showStall(seller),
    focusChat: () => (chatForm.elements.namedItem("text") as HTMLInputElement).focus(),
    emotePicker() {
      modal = { kind: "emote" };
      render();
    },
  };
}
