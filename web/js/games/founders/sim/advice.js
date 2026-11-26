// Founders: "what to do next" hints and a simple bot (used by the tests, and handy for auto-play). Pure.
import { RULES, partyCost, owners, townOutput, foundBlocker, siteScore, townById } from "./state.js";
import { IMPROVEMENTS, hexYield } from "./yields.js";
import { apply, improveBlocker, linkPlan } from "./actions.js";

/** Best place to found a town within `radius` of `cell`: {cell, score} or null. */
export function bestSiteNear(env, state, cell, radius = 5) {
  const { T, map } = env;
  let best = null;
  for (const c of map.within(cell, radius)) {
    if (!T.land[c] || foundBlocker(env, state, c)) continue;
    const sc = siteScore(env, c) - 2.5 * map.dist(cell, c);
    if (!best || sc > best.score || (sc === best.score && c < best.cell)) best = { cell: c, score: sc };
  }
  return best;
}

/** The best improvement per town: [{town, cell, kind, gain}] sorted by gain per material. */
export function improvementIdeas(env, state) {
  const { T } = env;
  const ideas = [];
  for (const t of state.towns) {
    const o = townOutput(env, state, t);
    const worked = new Set(o.worked);
    for (const c of o.tiles) {
      if (state.improvements[c]) continue;
      for (const kind of Object.keys(IMPROVEMENTS)) {
        const why = improveBlocker(env, { ...state, materials: Infinity }, c, kind);
        if (why) continue;
        const a = hexYield(T, c, null), b = hexYield(T, c, kind);
        const hungry = o.surplus < 2;
        const gain = (b.food - a.food) * (hungry ? 2 : 1.2) + (b.materials - a.materials) + (b.trade - a.trade) * 0.9 + (worked.has(c) ? 1 : 0)
          + (a.food + a.materials + a.trade) * 0.15;
        ideas.push({ town: t.id, name: t.name, cell: c, kind, gain, cost: IMPROVEMENTS[kind].cost });
      }
    }
  }
  return ideas.sort((x, y) => y.gain / y.cost - x.gain / x.cost || x.cell - y.cell);
}

/** Unlinked town pairs close enough for a road, nearest first: [{a, b, plan}]. */
export function linkIdeas(env, state) {
  const out = [];
  for (let i = 0; i < state.towns.length; i++) {
    for (let j = i + 1; j < state.towns.length; j++) {
      const a = state.towns[i], b = state.towns[j];
      if (env.map.dist(a.cell, b.cell) > RULES.maxLinkLen) continue;
      const plan = linkPlan(env, state, a.id, b.id);
      if (!plan.error) out.push({ a: a.id, b: b.id, plan, names: [a.name, b.name] });
    }
  }
  return out.sort((x, y) => x.plan.cost - y.plan.cost || x.a - y.a || x.b - y.b);
}

export function nextHint(env, state) {
  if (state.phase === "setup") return "Pick a start: one of the gold markers, or click any land hex you like.";
  if (state.phase === "over") return "The game is over: see how your country compares with history.";
  if (!state.towns.length) {
    const p = state.parties[0];
    if (p && !foundBlocker(env, state, p.cell)) return "Found your first town here (F), or click a nearby hex to move the party first.";
    return "Move your founding party to a good hex, then found your first town (F).";
  }
  const idle = state.parties.find((p) => p.moves > 0 && p.target == null);
  if (idle) {
    return foundBlocker(env, state, idle.cell)
      ? `Move your founding party (it is too close to a town): click a hex ${RULES.minTownDist}+ hexes from your towns.`
      : "Your founding party can found a town here (F), or move on to a better hex.";
  }
  const left = state.maxTurns - state.turn;
  if (state.materials >= partyCost(state) && state.towns.length + state.parties.length < 12 && left > 6) {
    const t = state.towns.filter((x) => x.pop >= 3).sort((a, b) => b.pop - a.pop)[0];
    if (t) return `You can afford settlers: select ${t.name} and press "Send settlers" to found another town.`;
  }
  const imp = improvementIdeas(env, state).find((x) => x.cost <= state.materials);
  if (imp) return `Build a ${IMPROVEMENTS[imp.kind].name.toLowerCase()} near ${imp.name} (select the town, then a hex).`;
  const link = linkIdeas(env, state).find((x) => x.plan.cost <= state.materials);
  if (link) return `${link.plan.kind === "rail" ? "Upgrade to rail" : "Build a road"} between ${link.names[0]} and ${link.names[1]} for more trade.`;
  return `End the turn (Enter). ${left} turn${left === 1 ? "" : "s"} left after this one.`;
}

/** One bot turn: found, settle, build, link, then end the turn. Returns the new state. */
export function botTurn(env, state) {
  let s = state;
  const act = (a) => {
    const r = apply(env, s, a);
    if (r.ok) s = r.state;
    return r.ok;
  };
  if (s.phase === "setup") act({ type: "start", cell: s.starts[0].cell });
  // Parties: found when the current hex is about as good as anything near, else walk to the best spot.
  for (const p of [...s.parties]) {
    const here = foundBlocker(env, s, p.cell) ? -Infinity : siteScore(env, p.cell);
    const best = bestSiteNear(env, s, p.cell, 6);
    if (here > -Infinity && (!best || here >= best.score * 0.92 || !s.towns.length)) { act({ type: "found", party: p.id }); continue; }
    if (best) act({ type: "move", party: p.id, to: best.cell });
    const pp = s.parties.find((x) => x.id === p.id);
    if (pp && pp.target == null && !foundBlocker(env, s, pp.cell)) act({ type: "found", party: pp.id });
  }
  // Settlers while there is time and room.
  if (s.turn < s.maxTurns - 10 && s.towns.length + s.parties.length < 10) {
    const t = s.towns.filter((x) => x.pop >= 3).sort((a, b) => b.pop - a.pop || a.id - b.id)[0];
    if (t && s.materials >= partyCost(s)) act({ type: "party", town: t.id });
  }
  // Improvements and links with what is left (keep a reserve for settlers early on).
  const reserve = s.turn < 35 ? partyCost(s) : 0;
  for (let k = 0; k < 4; k++) {
    const imp = improvementIdeas(env, s).find((x) => x.cost <= s.materials - reserve);
    if (!imp || !act({ type: "improve", cell: imp.cell, kind: imp.kind })) break;
  }
  const link = linkIdeas(env, s).find((x) => x.plan.cost <= s.materials - reserve);
  if (link) act({ type: "link", a: link.a, b: link.b });
  act({ type: "end" });
  return s;
}

export { townById, owners };
