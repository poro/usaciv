// A simple greedy player, for balance tests (and later an AI rival). Pure and deterministic.
// Each turn:
//   1. repair everything it can;
//   2. repeatedly connect the unserved contract with the best pay per credit of new track it can afford (keeping a
//      small reserve). Only the few most promising contracts (by a cheap hex-distance estimate) are routed, and every
//      route search stops at the money in hand, so a whole-country Sandbox stays fast;
//   3. if it is saving for a contract it cannot afford yet, keep that money; spend the rest on the upgrade with the
//      best payback over the years left (double track, terminals, hardening per hazard, express services with the
//      double track their route still needs; see upgradeOptions);
//   4. end the turn.
// opts.log (an array) records every action it applied, for replay tests. opts.endTurn = false stops before step 4
// (versus: the room ends the year for every company at once). Contracts a rival holds (state.rivals) are skipped.
import { apply, check, evaluate, plan, networkCells, connectedCities, hardenOptions, doubleCost, hubCost, DOUBLE_MAINT, MAINT_RATE } from "./state.js";
import { payFor, DOUBLE_BONUS } from "./contracts.js";
import { accessShares, HUB_GROWTH } from "./growth.js";
import { regionGdp } from "./score.js";
import { END_YEAR } from "./scenarios.js";
import { LINK_HIT } from "./events.js";
import { corridors } from "./express.js";

const CANDIDATES = 8; // contracts routed per pick (out of the 32 best by estimate)
const EST_PER_HEX = 6; // cr, for the pre-ranking estimate only

export function greedyTurn(env, state, { reserve = 4, maxBuilds = 6, upgrades = true, maxUpgrades = 400, log = null, endTurn = true } = {}) {
  let s = state;
  const act = (a) => {
    const n = apply(env, s, a);
    if (n !== s) { s = n; log?.push(a); }
  };
  if (!check(env, s, { type: "repairAll" })) act({ type: "repairAll" });
  let saving = 0;
  const hm = env.hexmap;
  for (let n = 0; n < maxBuilds; n++) {
    const ev = evaluate(env, s);
    const budget = s.cash - reserve;
    const horizon = Math.max(0, budget) + 4 * Math.max(0, ev.revenue - ev.maint);
    const net = [...networkCells(s), ...env.homeCells];
    const netSet = new Set(net);
    const near = (end) => {
      if (end.cells.some((x) => netSet.has(x))) return 0;
      let d = Infinity;
      for (const c of net) d = Math.min(d, hm.dist(c, end.cell));
      return d;
    };
    const cands = [];
    for (const c of env.contracts) {
      if (ev.served.has(c.id) || s.rivals?.[c.id]) continue;
      const pay = payFor(c.value, 1, c.km);
      const na = near(c.a), nb = near(c.b), ab = hm.dist(c.a.cell, c.b.cell);
      for (const [x, y, nx, ny] of [[c.a, c.b, na, nb], [c.b, c.a, nb, na]]) {
        const est = (nx + Math.min(ab, ny + 0)) * EST_PER_HEX;
        cands.push({ c, x, y, pay, est: pay / Math.max(1, est) });
      }
    }
    cands.sort((p, q) => q.est - p.est || (p.c.id < q.c.id ? -1 : p.c.id > q.c.id ? 1 : 0));
    const memo = new Map();
    const route = (a, b, max) => {
      const k = `${a}>${b}`;
      if (!memo.has(k) || (memo.get(k).cost === Infinity && memo.get(k).max < max)) memo.set(k, { ...plan(env, s, a, b, { maxCost: max }), max });
      return memo.get(k);
    };
    let best = null, wait = null, routed = 0;
    for (const cd of cands.slice(0, CANDIDATES * 4)) {
      if (routed >= CANDIDATES) break;
      const p1 = route(env.home.cell, cd.x.cell, horizon);
      if (!p1.path) continue;
      const p2 = route(cd.x.cell, cd.y.cell, horizon - p1.cost);
      if (!p2.path) continue;
      routed++;
      const cost = p1.cost + p2.cost;
      const ratio = cd.pay / Math.max(1, cost);
      if (cost > budget) { if (!wait || ratio > wait.ratio) wait = { ratio, cost }; continue; }
      if (!best || ratio > best.ratio) best = { ratio, x: cd.x, y: cd.y };
    }
    if (!best) { saving = wait ? wait.cost : 0; break; }
    const p1 = plan(env, s, env.home.cell, best.x.cell);
    if (p1.fresh) act({ type: "build", path: p1.path });
    const p2 = plan(env, s, best.x.cell, best.y.cell);
    if (p2.fresh) act({ type: "build", path: p2.path });
  }
  if (upgrades) {
    // one appraisal a turn, then buy down the list (hardening is cheap insurance: it may dip into savings)
    let n = 0;
    // idle money: nothing to save for and more than a year of surplus in hand. Then cash is worth less than
    // anything that scores, so the bar drops and running costs count less (the surplus pays them)
    const ev = evaluate(env, s);
    const idle = !saving && s.cash - reserve > Math.max(0, ev.revenue - ev.maint);
    for (const up of upgradeOptions(env, s, { idle })) {
      if (n >= maxUpgrades) break;
      const room = s.cash - reserve - (up.actions[0].type === "harden" ? 0 : saving);
      if (up.cost > room) continue;
      // a bundle (an express and the double track its route needs) goes in order; parts already done are skipped
      const last = up.actions[up.actions.length - 1];
      if (up.actions.length === 1 && check(env, s, last)) continue;
      for (const a of up.actions) if (!check(env, s, a)) act(a);
      n++;
    }
  }
  if (endTurn) act({ type: "endTurn" });
  return s;
}

/**
 * Upgrades worth buying, best payback over the years left first: [{actions, cost, ratio}]. It wants 1.2× back while
 * there is time to reinvest, less near the end, and in the last two years anything that pays at all back (money left
 * in 2050 scores nothing). With idle money (opts.idle) the bar is low all game. 1 bp of GDP uplift counts as 10 cr
 * (the score's exchange rate).
 */
export function upgradeOptions(env, s, { idle = false } = {}) {
  const years = (s.end ?? END_YEAR) - s.year + 1;
  const bar = years <= 1 ? 0.01 : idle ? 0.05 : years > 6 ? 1.2 : years > 2 ? 0.4 : 0.1;
  const ev = evaluate(env, s);
  const out = [];
  const consider = (action, cost, benefit) => {
    if (!(cost > 0)) return;
    const ratio = benefit / cost;
    const actions = Array.isArray(action) ? action : [action];
    if (ratio >= bar) out.push({ actions, cost, ratio });
  };
  const keys = Object.keys(s.links).sort();
  for (const k of keys) {
    const l = s.links[k];
    if (l.d) continue;
    const ld = ev.loads.get(k);
    if (!ld) continue;
    // double track: the extra pay on the routes over it, less the extra upkeep
    if (!l.dt) {
      const gain = DOUBLE_BONUS * ld.base - MAINT_RATE * l.cost * (DOUBLE_MAINT - 1);
      consider({ type: "double", key: k }, doubleCost(env, l), gain * years);
    }
    // hardening: the chance a hit cuts it × (the year's pay over it + the repair)
    for (const o of hardenOptions(env, l)) {
      if (o.done) continue;
      const loss = o.lam * LINK_HIT * (ld.pay + 0.4 * l.cost);
      consider({ type: "harden", key: k, hz: o.type }, o.cost, loss * years);
    }
  }
  // terminals: extra pay on contracts touching the metro + its extra growth (1 bp of uplift ≈ 10 cr of score)
  const access = accessShares(env, ev.graph);
  const region = regionGdp(env, s.cities);
  for (const c of connectedCities(env, s)) {
    const cost = hubCost(env, s, c.id);
    if (cost == null) continue;
    const site = env.hubs.get(c.id);
    let pay = 0;
    for (const [id, sv] of ev.served) {
      const ct = env.contractById.get(id);
      if (ct.a.cities.includes(c.id) || ct.b.cities.includes(c.id)) pay += sv.base;
    }
    const i = env.cityIdx.get(c.id);
    const growth = (s.cities[c.id].gdp / region) * HUB_GROWTH * access[i] * years * 0.5 * 1e5;
    consider({ type: "hub", city: c.id }, cost, pay * site.rate * years + growth - cost * 0.03 * years);
  }
  // express services: the growth at both ends less the operating cost, plus the double track's own extra pay
  for (const k of corridors(env, s, ev.served)) {
    if (k.on) continue;
    const doubles = k.keys.filter((key) => !s.links[key].d);
    if (doubles.length !== k.keys.length) continue;
    let cost = k.cost, benefit = (k.gain / region) * years * 1e5 - (idle ? 0.25 : 1) * k.ops * years;
    for (const key of doubles) {
      const l = s.links[key];
      cost += doubleCost(env, l);
      const ld = ev.loads.get(key);
      benefit += ((ld ? DOUBLE_BONUS * ld.base : 0) - MAINT_RATE * l.cost * (DOUBLE_MAINT - 1)) * years;
    }
    consider([...doubles.map((key) => ({ type: "double", key })), { type: "express", id: k.id }], cost, benefit);
  }
  return out.sort((a, b) => b.ratio - a.ratio || a.cost - b.cost);
}
