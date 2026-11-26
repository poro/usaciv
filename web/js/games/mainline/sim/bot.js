// A simple greedy player, for balance tests (and later an AI rival). Pure and deterministic.
// Each turn: repair everything it can, then repeatedly connect the unserved contract with the best pay per credit
// of new track it can afford (keeping a small reserve), then end the turn.
import { apply, check, evaluate, plan } from "./state.js";
import { payFor } from "./contracts.js";

export function greedyTurn(env, state, { reserve = 4, maxBuilds = 6 } = {}) {
  let s = state;
  if (!check(env, s, { type: "repairAll" })) s = apply(env, s, { type: "repairAll" });
  for (let n = 0; n < maxBuilds; n++) {
    const served = evaluate(env, s).served;
    let best = null;
    for (const c of env.contracts) {
      if (served.has(c.id)) continue;
      for (const [x, y] of [[c.a, c.b], [c.b, c.a]]) {
        const p1 = plan(env, s, env.home.cell, x.cell);
        const p2 = plan(env, s, x.cell, y.cell);
        if (!p1.path || !p2.path) continue;
        const cost = p1.cost + p2.cost;
        if (cost > s.cash - reserve) continue;
        const ratio = payFor(c.value, 1) / Math.max(1, cost);
        if (!best || ratio > best.ratio) best = { ratio, x, y };
      }
    }
    if (!best) break;
    const p1 = plan(env, s, env.home.cell, best.x.cell);
    if (p1.fresh) s = apply(env, s, { type: "build", path: p1.path });
    const p2 = plan(env, s, best.x.cell, best.y.cell);
    if (p2.fresh) s = apply(env, s, { type: "build", path: p2.path });
  }
  return apply(env, s, { type: "endTurn" });
}
