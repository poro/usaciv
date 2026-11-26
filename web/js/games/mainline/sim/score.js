// Score against "baseline America": the same region's metros growing on their real trend with no network of yours.
//
//   uplift     = your region GDP ÷ baseline region GDP − 1   (the headline; the scenario goal is a minimum uplift)
//   resilience = freight revenue earned ÷ what the network would have earned with no disaster damage
//   score      = uplift in basis points + revenue earned ÷ 10, × (0.5 + resilience ÷ 2)
import { END_YEAR } from "./scenarios.js";

export function regionGdp(env, world) {
  let s = 0;
  for (const c of env.cities) s += world[c.id]?.gdp || 0;
  return s;
}

export function summary(env, state) {
  const you = regionGdp(env, state.cities);
  const base = regionGdp(env, state.base);
  const uplift = base > 0 ? you / base - 1 : 0;
  const t = state.totals;
  const resilience = t.potential > 0 ? t.revenue / t.potential : 1;
  const bps = uplift * 10000;
  const score = Math.round((bps + t.revenue / 10) * (0.5 + resilience / 2));
  const goal = env.scenario.goal;
  return { you, base, uplift, resilience, score, goal, beat: uplift >= goal, final: state.over, year: Math.min(state.year, END_YEAR) };
}

/** Per-state breakdown: GDP you vs baseline, by each metro's first-listed state. */
export function byState(env, state) {
  const m = new Map();
  for (const c of env.cities) {
    const st = c.states?.[0] || "?";
    if (!m.has(st)) m.set(st, { state: st, you: 0, base: 0, cities: 0, connected: 0 });
    const r = m.get(st);
    r.you += state.cities[c.id]?.gdp || 0;
    r.base += state.base[c.id]?.gdp || 0;
    r.cities++;
  }
  return [...m.values()].map((r) => ({ ...r, uplift: r.base > 0 ? r.you / r.base - 1 : 0 })).sort((a, b) => b.base - a.base);
}
