// Founders: the end of a turn. endTurn(env, state) → new state. Pure and deterministic (state.rng is the seed).
//
// Order: every town produces (from the state as the player left it) → food grows or shrinks towns, culture grows
// borders → materials (plus a third of trade) go to the national store, trade to wealth → parties walk on toward
// their targets with fresh moves → at most one random event → next turn (the game ends after maxTurns).
import { RULES, clone, townOutput, growthNeed, rngOf, landPath } from "./state.js";
import { moveCost } from "./yields.js";
import { rollEvents } from "./events.js";

/** Walk `party` along `path` (cells, path[0] = where it stands) while it has moves. Mutates the party. */
export function walk(env, party, path) {
  let k = 1;
  while (k < path.length) {
    const c = moveCost(env.T, path[k]);
    // A party with all its moves left can always take one step, however rough the ground.
    if (c > party.moves && party.moves < RULES.partyMoves) break;
    party.moves = Math.max(0, party.moves - c);
    party.cell = path[k];
    k++;
    if (party.moves <= 0) break;
  }
  return path[path.length - 1] === party.cell;
}

export function endTurn(env, state) {
  if (state.phase !== "play") return state;
  const s = clone(state);
  const rng = rngOf(s);
  const report = { turn: s.turn, grew: [], shrank: [], borders: [], events: [], income: 0, trade: 0, food: 0 };

  // 1. Production, from the state as it stands (outputs first, then apply, so town order does not matter).
  const outs = s.towns.map((t) => townOutput(env, s, t));
  let materials = 0, trade = 0;
  s.towns.forEach((t, k) => {
    const o = outs[k];
    materials += o.materials;
    trade += o.trade;
    report.food += o.food;
    t.food += o.surplus;
    const need = growthNeed(t.pop);
    const room = o.worked.length < o.tiles.length || t.radius < RULES.maxRadius;
    if (t.food >= need) {
      if (room) {
        t.pop++;
        t.food -= need;
        report.grew.push({ town: t.id, name: t.name, pop: t.pop });
      } else t.food = need; // no free hex to work: the town waits for its border to grow
    } else if (t.food < 0) {
      if (t.pop > 1) {
        t.pop--;
        report.shrank.push({ town: t.id, name: t.name, pop: t.pop });
      }
      t.food = 0;
    }
    // Culture: one a turn (time) plus half the town's trade. Borders grow at the thresholds.
    t.culture += 1 + Math.floor(o.trade / 2);
    const r = t.culture >= RULES.cultureR3 ? 3 : t.culture >= RULES.cultureR2 ? 2 : 1;
    if (r > t.radius) {
      t.radius = r;
      report.borders.push({ town: t.id, name: t.name, radius: r });
    }
  });
  const income = materials + Math.floor(trade / RULES.tradeToMaterials);
  s.materials += income;
  s.wealth += trade;
  report.income = income;
  report.trade = trade;

  // 2. Parties: fresh moves, then on toward their targets.
  for (const p of s.parties) {
    p.moves = RULES.partyMoves;
    if (p.target != null && p.target !== p.cell) {
      const r = landPath(env, p.cell, p.target);
      if (!r) p.target = null;
      else if (walk(env, p, r.path)) p.target = null;
    } else p.target = null;
  }

  // 3. Events.
  report.events = rollEvents(env, s, rng);
  s.stats.events += report.events.length;

  // 4. Log and advance.
  for (const g of report.grew) s.log.push({ turn: s.turn, kind: "grow", text: `${g.name} grows to ${g.pop}.` });
  for (const g of report.shrank) s.log.push({ turn: s.turn, kind: "shrink", text: `${g.name} goes hungry and shrinks to ${g.pop}.` });
  for (const b of report.borders) s.log.push({ turn: s.turn, kind: "border", text: `${b.name}'s border grows (radius ${b.radius}).` });
  for (const e of report.events) s.log.push({ turn: s.turn, kind: "event", text: `${e.icon} ${e.text}`, bad: e.bad });
  if (s.log.length > 200) s.log = s.log.slice(-200);
  s.rng = rng.state;
  s.lastTurn = report;
  if (s.turn >= s.maxTurns) {
    s.phase = "over";
  } else {
    s.turn++;
    if (s.turn === RULES.railTurn) s.log.push({ turn: s.turn, kind: "info", text: "Rail is here: upgrade roads to rail for more trade." });
  }
  return s;
}
