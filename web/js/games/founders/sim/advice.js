// Founders: "what to do next" hints and a simple bot (used by the tests, and handy for auto-play). Pure.
import {
  RULES, PROJECTS, partyCost, owners, townOutput, foundBlocker, siteScore, townById, improvementCost, projectCost, growCost, nationOutput,
} from "./state.js";
import { IMPROVEMENTS, hexYield } from "./yields.js";
import { apply, improveBlocker, linkPlan, projectBlocker, growBlocker, festivalBlocker } from "./actions.js";

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
        ideas.push({ town: t.id, name: t.name, cell: c, kind, gain, cost: improvementCost(state, kind) });
      }
    }
  }
  return ideas.sort((x, y) => y.gain / y.cost - x.gain / x.cost || x.cell - y.cell);
}

/**
 * Town projects worth building: [{town, name, project, gain, cost}] sorted by gain per material. gain is in the same
 * rough units as improvementIdeas (food ×1.2, materials ×1, trade ×0.9, culture ×0.5 a turn).
 */
export function projectIdeas(env, state) {
  const ideas = [];
  for (const t of state.towns) {
    const o = townOutput(env, state, t);
    for (const id of Object.keys(PROJECTS)) {
      if (projectBlocker(env, state, t, id, { noCost: true })) continue;
      const after = townOutput(env, state, { ...t, projects: [...(t.projects || []), id] });
      const p = PROJECTS[id];
      let gain = (after.food - o.food) * (o.surplus < 2 ? 1.8 : 1.2) + (after.materials - o.materials) + (after.trade - o.trade) * 0.9
        + ((p.culture || 0) + Math.floor((after.trade - o.trade) / 2)) * 0.5;
      if (id === "granary") gain += 1;
      if (gain <= 0) continue;
      ideas.push({ town: t.id, name: t.name, project: id, gain, cost: projectCost(state, id) });
    }
  }
  return ideas.sort((x, y) => y.gain / y.cost - x.gain / x.cost || x.town - y.town);
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
  const proj = projectIdeas(env, state).find((x) => x.cost <= state.materials);
  if (proj && (!imp || proj.gain / proj.cost > imp.gain / imp.cost)) {
    return `Build a ${PROJECTS[proj.project].name.toLowerCase()} in ${proj.name} (${proj.cost}): select the town, then Projects.`;
  }
  if (imp) return `Build a ${IMPROVEMENTS[imp.kind].name.toLowerCase()} near ${imp.name} (${imp.cost}): select the town, then a hex.`;
  const link = linkIdeas(env, state).find((x) => x.plan.cost <= state.materials);
  if (link) return `${link.plan.kind === "rail" ? "Upgrade to rail" : "Build a road"} between ${link.names[0]} and ${link.names[1]} for more trade.`;
  const income = Math.max(1, nationOutput(env, state).income);
  if (state.materials >= Math.max(60, 3 * income)) {
    const g = state.towns.filter((t) => !growBlocker(env, state, t)).sort((a, b) => growCost(a) - growCost(b))[0];
    if (g) return `Materials are piling up: bring homesteaders to ${g.name} (+1 person, ${growCost(g)}), or hold a festival.`;
    const f = state.towns.find((t) => !festivalBlocker(state, t));
    if (f) return `Materials are piling up: hold a festival in ${f.name} (+${RULES.festivalCulture} culture, ${RULES.festivalCost}).`;
  }
  return `End the turn (Enter). ${left} turn${left === 1 ? "" : "s"} left after this one.`;
}

/** One bot turn: found, settle, build, link, spend what is left on people and culture, then end the turn. */
export function botTurn(env, state, { log = null, end = true } = {}) {
  let s = state;
  const act = (a) => {
    if (a.type === "end" && !end) return true;
    const r = apply(env, s, a);
    if (r.ok) { s = r.state; log?.push(a); }
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
  const wantTowns = s.turn < s.maxTurns - 12 && s.towns.length + s.parties.length < 12;
  if (wantTowns) {
    const t = s.towns.filter((x) => x.pop >= 3).sort((a, b) => b.pop - a.pop || a.id - b.id)[0];
    if (t && s.materials >= partyCost(s)) act({ type: "party", town: t.id });
  }
  // Improvements, projects and links with what is left (keep a reserve for settlers while still expanding).
  const reserve = wantTowns && s.turn < 35 ? partyCost(s) : 0;
  const free = () => s.materials - reserve;
  for (let k = 0; k < 8; k++) {
    const imp = improvementIdeas(env, s).find((x) => x.cost <= free());
    const proj = projectIdeas(env, s).find((x) => x.cost <= free());
    if (proj && (!imp || proj.gain / proj.cost > imp.gain / imp.cost)) { if (!act({ type: "project", town: proj.town, project: proj.project })) break; }
    else if (imp) { if (!act({ type: "improve", cell: imp.cell, kind: imp.kind })) break; }
    else break;
  }
  const link = linkIdeas(env, s).find((x) => x.plan.cost <= free());
  if (link) act({ type: "link", a: link.a, b: link.b });
  // Whatever is still idle: homesteaders (cheapest first), then festivals, keeping a small buffer.
  if (s.turn >= 8) {
    const towns = [...s.towns].sort((a, b) => growCost(a) - growCost(b) || a.id - b.id);
    for (const t of towns) if (growCost(t) <= free() - 20) act({ type: "grow", town: t.id });
    for (const t of [...s.towns].sort((a, b) => a.culture - b.culture || a.id - b.id)) {
      if (free() - RULES.festivalCost < 40) break;
      act({ type: "festival", town: t.id });
    }
  }
  act({ type: "end" });
  return s;
}

export { townById, owners };
