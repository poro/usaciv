// Founders: turn helpers, so a late-game turn with many towns takes a handful of clicks. Pure and deterministic.
//
//   runAuto(env, state) → {state, done: [{town, name, text}]}
//       What "auto" towns (town.auto) do when the turn ends, before production (actions.js "end" runs it):
//       1. builds: the best-value improvement or project across the auto towns, one per town a turn, best first;
//       2. one road or rail upgrade between two auto towns, cheapest first;
//       3. homesteaders, cheapest first, while 20+ materials would be left over;
//       4. festivals, lowest culture first, while 40+ would be left over.
//       It keeps a reserve for the next founding party while the country is still expanding (as the bot does:
//       fewer than 12 towns and parties, before turn 35 and 12+ turns from the end), and it skips a town the player
//       gave an order to this turn (town.acted === state.turn).
//   repeatAction(env, state, townId, order = state.lastOrder) → action | null
//       The player's last town order (homesteaders, festival, an improvement kind, a project, settlers) as an action
//       for another town: an improvement goes on that town's best hex for the kind.
//   ordersNeeded(env, state) → [{kind: "party" | "town", id, why}]
//       Founding parties waiting for orders (all their moves, no destination), then towns not on auto and not yet
//       ordered this turn that are starving or could afford something worth building.
//   endTurnCheck(env, state) → null | {kind, id, text}
//       Only when something is truly idle: a party waiting for orders, or materials piling up (3+ turns of income,
//       60+) while a town not on auto could use them. The UI warns once, then ends the turn on a second press.
import { RULES, PROJECTS, partyCost, townById, townOutput, nationOutput, growCost, improvementCost } from "./state.js";
import { IMPROVEMENTS } from "./yields.js";
import { apply, growBlocker, festivalBlocker, projectBlocker } from "./actions.js";
import { improvementIdeas, projectIdeas, linkIdeas } from "./advice.js";

export const AUTO = { growSpare: 20, festivalSpare: 40, minGain: 0.5, maxTowns: 12, expandUntil: 35, expandLeft: 12 };

/** Materials auto towns leave in store: the next settlers' cost while the country is still expanding. */
export function autoReserve(state) {
  const expanding = state.turn < AUTO.expandUntil && state.turn < state.maxTurns - AUTO.expandLeft
    && state.towns.length + state.parties.length < AUTO.maxTowns;
  return expanding ? partyCost(state) : 0;
}

const orderText = (s, a) => {
  const t = townById(s, a.town);
  switch (a.type) {
    case "improve": return `${IMPROVEMENTS[a.kind].name} near ${t?.name}`;
    case "project": return `${PROJECTS[a.project].name} in ${t?.name}`;
    case "grow": return `homesteaders to ${t?.name}`;
    case "festival": return `festival in ${t?.name}`;
    case "link": return `${findLinkKind(s, a)} ${t?.name}–${townById(s, a.b)?.name}`;
    default: return a.type;
  }
};

const findLinkKind = (s, a) => (s.links.find((l) => (l.a === a.a && l.b === a.b) || (l.a === a.b && l.b === a.a))?.kind === "rail" ? "rail" : "road");

export function runAuto(env, state) {
  const done = [];
  if (state.phase !== "play" || !state.towns.some((t) => t.auto)) return { state, done };
  let s = state;
  const reserve = autoReserve(state);
  const free = () => s.materials - reserve;
  const eligible = (id) => {
    const t = townById(s, id);
    return !!t && t.auto && t.acted !== state.turn;
  };
  const act = (a) => {
    const r = apply(env, s, { ...a, auto: true }); // auto: not the player's order (no "acted", no lastOrder)
    if (!r.ok) return false;
    s = r.state;
    done.push({ town: a.town, name: townById(s, a.town)?.name, text: orderText(s, a) });
    return true;
  };
  // 1. Builds: one per town, best gain per material first, recomputed after each (costs rise with what you own).
  const built = new Set();
  for (let guard = 0; guard < s.towns.length; guard++) {
    const ok = (x) => eligible(x.town) && !built.has(x.town) && x.cost <= free() && x.gain >= AUTO.minGain;
    const imp = improvementIdeas(env, s).find(ok);
    const proj = projectIdeas(env, s).find(ok);
    let a = null;
    if (proj && (!imp || proj.gain / proj.cost > imp.gain / imp.cost)) a = { type: "project", town: proj.town, project: proj.project };
    else if (imp) a = { type: "improve", town: imp.town, cell: imp.cell, kind: imp.kind };
    if (!a) break;
    built.add(a.town);
    if (!act(a)) break;
  }
  // 2. One road (or rail upgrade) a turn between two auto towns, cheapest first.
  const link = linkIdeas(env, s).find((x) => eligible(x.a) && eligible(x.b) && x.plan.cost <= free());
  if (link) act({ type: "link", a: link.a, b: link.b, town: link.a });
  // 3. Homesteaders with what is left, cheapest first.
  for (const t of [...s.towns].sort((a, b) => growCost(a) - growCost(b) || a.id - b.id)) {
    if (!eligible(t.id) || growCost(t) > free() - AUTO.growSpare || growBlocker(env, s, t)) continue;
    act({ type: "grow", town: t.id });
  }
  // 4. Festivals, lowest culture first.
  for (const t of [...s.towns].sort((a, b) => a.culture - b.culture || a.id - b.id)) {
    if (free() - RULES.festivalCost < AUTO.festivalSpare) break;
    if (!eligible(t.id) || festivalBlocker(s, t)) continue;
    act({ type: "festival", town: t.id });
  }
  return { state: s, done };
}

/** The best hex in `town`'s border for improvement `kind` (by the advisor's gain), or null. */
function bestHexFor(env, state, townId, kind) {
  const x = improvementIdeas(env, state).filter((i) => i.town === townId && i.kind === kind)
    .sort((a, b) => b.gain - a.gain || a.cell - b.cell)[0];
  return x ? x.cell : null;
}

export function repeatAction(env, state, townId, order = state.lastOrder) {
  const t = townById(state, townId);
  if (!t || !order) return null;
  switch (order.type) {
    case "grow": return growBlocker(env, state, t, { noCost: true }) ? null : { type: "grow", town: t.id };
    case "festival": return t.fest === state.turn ? null : { type: "festival", town: t.id };
    case "party": return t.pop >= 2 ? { type: "party", town: t.id } : null;
    case "project": return projectBlocker(env, state, t, order.project, { noCost: true }) ? null : { type: "project", town: t.id, project: order.project };
    case "improve": {
      const cell = bestHexFor(env, state, t.id, order.kind);
      return cell == null ? null : { type: "improve", cell, kind: order.kind };
    }
    default: return null;
  }
}

/** Plain words for an order (for the Repeat button). */
export function orderLabel(order) {
  if (!order) return "";
  switch (order.type) {
    case "grow": return "Homesteaders";
    case "festival": return "Festival";
    case "party": return "Send settlers";
    case "project": return PROJECTS[order.project]?.name || "Project";
    case "improve": return IMPROVEMENTS[order.kind]?.name || "Improvement";
    default: return order.type;
  }
}

const idleParty = (p) => p.target == null && p.moves >= RULES.partyMoves;

export function ordersNeeded(env, state) {
  const out = [];
  if (state.phase !== "play") return out;
  for (const p of state.parties) if (idleParty(p)) out.push({ kind: "party", id: p.id, why: "A founding party is waiting for orders" });
  const manual = state.towns.filter((t) => !t.auto && t.acted !== state.turn);
  if (!manual.length) return out;
  const afford = (x) => x.cost <= state.materials && x.gain >= AUTO.minGain;
  const imps = improvementIdeas(env, state).filter(afford);
  const projs = projectIdeas(env, state).filter(afford);
  for (const t of manual) {
    const o = townOutput(env, state, t);
    if (o.surplus < 0) { out.push({ kind: "town", id: t.id, why: `${t.name} is starving` }); continue; }
    const p = projs.find((x) => x.town === t.id);
    if (p) { out.push({ kind: "town", id: t.id, why: `${t.name} can build a ${PROJECTS[p.project].name.toLowerCase()} (${p.cost})` }); continue; }
    const i = imps.find((x) => x.town === t.id);
    if (i) out.push({ kind: "town", id: t.id, why: `${t.name} can build a ${IMPROVEMENTS[i.kind].name.toLowerCase()} (${improvementCost(state, i.kind)})` });
  }
  return out;
}

export function endTurnCheck(env, state) {
  if (state.phase !== "play") return null;
  const p = state.parties.find(idleParty);
  if (p) return { kind: "party", id: p.id, text: "A founding party is waiting for orders." };
  const income = Math.max(1, nationOutput(env, state).income);
  if (state.materials < Math.max(60, 3 * income)) return null;
  const t = ordersNeeded(env, state).find((x) => x.kind === "town");
  return t ? { kind: "town", id: t.id, text: `${state.materials} materials are piling up: ${t.why}.` } : null;
}
