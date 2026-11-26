// Founders: player actions. apply(env, state, action) → {ok, state, error?, msg?}. Pure: never mutates `state`.
//
// Actions (plain JSON, so a game can be replayed or sent over a network later):
//   {type: "start", cell}                 leave setup with a founding party on cell
//   {type: "move", party, to}             walk a party toward a hex (as far as its moves allow; it keeps going next turn)
//   {type: "found", party}                found a town where the party stands
//   {type: "party", town}                 build a founding party in a town (materials + 1 population)
//   {type: "improve", cell, kind}         farmstead | mine | quarry | dock on a hex inside your borders
//   {type: "link", a, b}                  road between two towns (or upgrade a road to rail once rail opens)
//   {type: "focus", town, focus}          balanced | food | materials | trade
//   {type: "pin", town, cell}             always work this hex (toggle)
//   {type: "project", town, project}      build a town project (granary, school, market, harbor, depot, college)
//   {type: "grow", town}                  homesteaders: materials → +1 person now (once a turn per town)
//   {type: "festival", town}              materials → +8 culture now (once a turn per town)
//   {type: "auto", town, on}              auto-spend for this town when the turn ends (town: "all" = every town); auto.js
//   {type: "end"}                         end the turn: auto towns spend first (auto.js runAuto), then turn.js endTurn
//
// Town orders by the player (improve, project, grow, festival, party) mark the town as ordered this turn
// (town.acted = turn) and become state.lastOrder ({type, town, kind?, project?}) for "repeat last order". The same
// actions with auto: true (what auto towns do) leave both alone.
import { IMPROVEMENTS, improvementFits } from "./yields.js";
import {
  RULES, FOCI, PROJECTS, clone, partyCost, chooseStart, owners, townById, townAt, partyById, landPath, foundBlocker, townName, rngOf,
  improvementCost, projectCost, hasProject, growCost, townOutput,
} from "./state.js";
import { endTurn, walk } from "./turn.js";
import { runAuto } from "./auto.js";

const fail = (state, error) => ({ ok: false, state, error });

/** Record a player's town order on the (already cloned) state s. */
function markOrder(s, action, townId, order) {
  if (action.auto) return;
  const t = townById(s, townId);
  if (t) t.acted = s.turn;
  s.lastOrder = { ...order, town: townId };
}

export function apply(env, state, action) {
  if (!action || !action.type) return fail(state, "No action");
  if (state.phase === "over" && action.type !== "noop") return fail(state, "The game is over");
  if (state.phase === "setup" && action.type !== "start") return fail(state, "Choose a start first");
  switch (action.type) {
    case "start": {
      const s = chooseStart(env, state, action.cell);
      return s === state ? fail(state, "Pick a US land hex that is not a peak") : { ok: true, state: s };
    }
    case "move": return move(env, state, action);
    case "found": return found(env, state, action);
    case "party": return buildParty(env, state, action);
    case "improve": return improve(env, state, action);
    case "link": return link(env, state, action);
    case "focus": {
      const t = townById(state, action.town);
      if (!t || !FOCI.includes(action.focus)) return fail(state, "Unknown town or focus");
      const s = clone(state);
      townById(s, t.id).focus = action.focus;
      return { ok: true, state: s };
    }
    case "pin": {
      const t = townById(state, action.town);
      if (!t) return fail(state, "Unknown town");
      if (owners(env, state)[action.cell] !== t.id || action.cell === t.cell) return fail(state, "Not a hex this town can work");
      const s = clone(state);
      const tt = townById(s, t.id);
      tt.pins = tt.pins || [];
      const k = tt.pins.indexOf(action.cell);
      if (k >= 0) tt.pins.splice(k, 1);
      else tt.pins.push(action.cell);
      return { ok: true, state: s };
    }
    case "project": return buildProject(env, state, action);
    case "grow": return grow(env, state, action);
    case "festival": return festival(env, state, action);
    case "auto": {
      const ids = action.town === "all" ? state.towns.map((t) => t.id) : [action.town];
      if (!ids.length || ids.some((id) => !townById(state, id))) return fail(state, "Unknown town");
      const s = clone(state);
      for (const id of ids) {
        const t = townById(s, id);
        if (action.on) t.auto = true;
        else delete t.auto;
      }
      return { ok: true, state: s };
    }
    case "end": {
      const pre = runAuto(env, state);
      const s = endTurn(env, pre.state);
      if (pre.done.length && s.lastTurn) s.lastTurn.auto = pre.done;
      return { ok: true, state: s };
    }
    default: return fail(state, `Unknown action ${action.type}`);
  }
}

// --- parties -------------------------------------------------------------------------------------------------------

function move(env, state, { party, to }) {
  const p = partyById(state, party);
  if (!p) return fail(state, "No such party");
  if (!env.T.land[to]) return fail(state, "Parties travel over US land only");
  const r = landPath(env, p.cell, to);
  if (!r) return fail(state, "No land route there");
  const s = clone(state);
  const pp = partyById(s, party);
  const arrived = walk(env, pp, r.path);
  pp.target = arrived ? null : to;
  return { ok: true, state: s, msg: arrived ? null : "On the way: the party will keep going next turn" };
}

function found(env, state, { party }) {
  const p = partyById(state, party);
  if (!p) return fail(state, "No such party");
  const why = foundBlocker(env, state, p.cell);
  if (why) return fail(state, why);
  const s = clone(state);
  const rng = rngOf(s);
  const first = s.towns.length === 0;
  const town = {
    id: s.nextId++, name: townName(env, s, p.cell, rng), cell: p.cell, pop: first ? 2 : 1, food: 0, culture: 0,
    radius: 1, focus: "balanced", pins: [], founded: s.turn, projects: [],
  };
  s.rng = rng.state;
  s.towns.push(town);
  s.parties = s.parties.filter((x) => x.id !== party);
  s.stats.founded++;
  s.log.push({ turn: s.turn, kind: "found", text: `${town.name} is founded${first ? ": your first town" : ""}.` });
  return { ok: true, state: s, msg: `${town.name} founded`, town: town.id };
}

function buildParty(env, state, action) {
  const { town } = action;
  const t = townById(state, town);
  if (!t) return fail(state, "No such town");
  if (t.pop < 2) return fail(state, `${t.name} needs 2+ population to send settlers`);
  const cost = partyCost(state);
  if (state.materials < cost) return fail(state, `Needs ${cost} materials`);
  const s = clone(state);
  const tt = townById(s, town);
  tt.pop--;
  tt.food = 0;
  s.materials -= cost;
  s.parties.push({ id: s.nextId++, cell: tt.cell, moves: RULES.partyMoves, target: null });
  s.stats.built++;
  markOrder(s, action, town, { type: "party" });
  s.log.push({ turn: s.turn, kind: "build", text: `A founding party sets out from ${tt.name}.` });
  return { ok: true, state: s };
}

// --- improvements --------------------------------------------------------------------------------------------------

/** Why improvement `kind` cannot go on `cell` (null = it can), cost included. */
export function improveBlocker(env, state, cell, kind) {
  const imp = IMPROVEMENTS[kind];
  if (!imp) return "Unknown improvement";
  const own = owners(env, state);
  if (!own[cell]) return "Only inside your borders";
  if (townAt(state, cell)) return "Not on a town's own hex";
  if (state.improvements[cell]) return `Already has a ${IMPROVEMENTS[state.improvements[cell]].name.toLowerCase()}`;
  if (!improvementFits(env.T, cell, kind)) return imp.rule;
  const cost = improvementCost(state, kind);
  if (state.materials < cost) return `Needs ${cost} materials`;
  return null;
}

function improve(env, state, action) {
  const { cell, kind } = action;
  const why = improveBlocker(env, state, cell, kind);
  if (why) return fail(state, why);
  const s = clone(state);
  s.materials -= improvementCost(state, kind);
  s.improvements[cell] = kind;
  s.stats.built++;
  markOrder(s, action, owners(env, state)[cell], { type: "improve", kind });
  return { ok: true, state: s };
}

// --- links ---------------------------------------------------------------------------------------------------------

export const linkKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export const findLink = (state, a, b) => state.links.find((l) => linkKey(l.a, l.b) === linkKey(a, b)) || null;

/** What linking towns a and b would take: {kind, path, cost} or {error}. */
export function linkPlan(env, state, a, b) {
  const ta = townById(state, a), tb = townById(state, b);
  if (!ta || !tb || a === b) return { error: "Pick two of your towns" };
  const have = findLink(state, a, b);
  if (have?.kind === "rail") return { error: "Already linked by rail" };
  if (have) {
    if (state.turn < RULES.railTurn) return { error: `Rail opens in turn ${RULES.railTurn}` };
    const cost = RULES.railPerHex * (have.path.length - 1);
    return { kind: "rail", path: have.path, cost, upgrade: true };
  }
  const r = landPath(env, ta.cell, tb.cell, RULES.maxLinkLen * 3);
  if (!r) return { error: "No land route" };
  if (r.path.length - 1 > RULES.maxLinkLen) return { error: `Too far (max ${RULES.maxLinkLen} hexes)` };
  return { kind: "road", path: r.path, cost: RULES.roadPerHex * Math.round(r.cost) };
}

function link(env, state, { a, b }) {
  const plan = linkPlan(env, state, a, b);
  if (plan.error) return fail(state, plan.error);
  if (state.materials < plan.cost) return fail(state, `Needs ${plan.cost} materials`);
  const s = clone(state);
  s.materials -= plan.cost;
  if (plan.upgrade) findLink(s, a, b).kind = "rail";
  else s.links.push({ id: s.nextId++, a, b, kind: "road", path: plan.path });
  s.stats.built++;
  const na = townById(s, a).name, nb = townById(s, b).name;
  s.log.push({ turn: s.turn, kind: "build", text: `${plan.upgrade ? "Rail" : "A road"} now links ${na} and ${nb}.` });
  return { ok: true, state: s };
}

// --- town projects and conversions ---------------------------------------------------------------------------------

/** Why town `town` cannot build project `id` (terrain, size, era, prerequisites; `cost` too unless noCost). */
export function projectBlocker(env, state, town, id, { noCost = false } = {}) {
  const p = PROJECTS[id];
  const t = typeof town === "object" ? town : townById(state, town);
  if (!p || !t) return "Unknown town or project";
  if (hasProject(t, id)) return "Built";
  if (p.fromTurn && state.turn < p.fromTurn) return `From turn ${p.fromTurn}`;
  if (p.needs && !hasProject(t, p.needs)) return `Needs a ${PROJECTS[p.needs].name.toLowerCase()}`;
  if (p.water) {
    const T = env.T, c = t.cell;
    if (!(T.coast[c] || T.lake[c] || (T.river[c] && T.river[c] <= 4))) return "Only in a town on the coast, a lake or a large river";
  }
  if (t.pop < p.minPop) return `Needs ${p.minPop} people`;
  if (!noCost) {
    const cost = projectCost(state, id);
    if (state.materials < cost) return `Needs ${cost} materials`;
  }
  return null;
}

function buildProject(env, state, action) {
  const { town, project } = action;
  const why = projectBlocker(env, state, town, project);
  if (why) return fail(state, why);
  const s = clone(state);
  const t = townById(s, town);
  s.materials -= projectCost(state, project);
  t.projects = [...(t.projects || []), project];
  s.stats.built++;
  markOrder(s, action, town, { type: "project", project });
  s.log.push({ turn: s.turn, kind: "build", text: `${t.name} builds a ${PROJECTS[project].name.toLowerCase()}.` });
  return { ok: true, state: s, msg: `${PROJECTS[project].name} built in ${t.name}` };
}

/** Why homesteaders cannot come to this town now (null = they can). */
export function growBlocker(env, state, town, { noCost = false } = {}) {
  const t = typeof town === "object" ? town : townById(state, town);
  if (!t) return "No such town";
  if (t.grown === state.turn) return "Homesteaders already came this turn";
  const o = townOutput(env, state, t);
  if (o.worked.length >= o.tiles.length) return "No free hex to work: wait for the border to grow";
  const next = townOutput(env, state, { ...t, pop: t.pop + 1 });
  if (next.surplus < 0) return "Not enough food for one more person";
  if (!noCost && state.materials < growCost(t)) return `Needs ${growCost(t)} materials`;
  return null;
}

function grow(env, state, action) {
  const { town } = action;
  const why = growBlocker(env, state, town);
  if (why) return fail(state, why);
  const s = clone(state);
  const t = townById(s, town);
  s.materials -= growCost(t);
  t.pop++;
  t.grown = s.turn;
  s.stats.built++;
  markOrder(s, action, town, { type: "grow" });
  return { ok: true, state: s, msg: `Homesteaders settle in ${t.name}: population ${t.pop}` };
}

export function festivalBlocker(state, town) {
  const t = typeof town === "object" ? town : townById(state, town);
  if (!t) return "No such town";
  if (t.fest === state.turn) return "One festival a turn";
  if (state.materials < RULES.festivalCost) return `Needs ${RULES.festivalCost} materials`;
  return null;
}

function festival(env, state, action) {
  const { town } = action;
  const why = festivalBlocker(state, town);
  if (why) return fail(state, why);
  const s = clone(state);
  const t = townById(s, town);
  s.materials -= RULES.festivalCost;
  t.culture += RULES.festivalCulture;
  t.fest = s.turn;
  markOrder(s, action, town, { type: "festival" });
  return { ok: true, state: s, msg: `${t.name} holds a festival: +${RULES.festivalCulture} culture` };
}
