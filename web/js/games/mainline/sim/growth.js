// Growth: every city follows its real population trend (cities.json `growth`, 2021→2025, as a yearly rate) plus a
// flat productivity term, in both your world and "baseline America". In your world a city on your network also gets
// an access bonus: up to ACCESS_BONUS a year, scaled by the share of its gravity-weighted partners (other region
// metros, GDP ÷ distance^1.5) that your intact network reaches, plus HUB_GROWTH per terminal level (scaled by the
// same access share). Those bonuses are a game model, not a forecast.

export const PRODUCTIVITY = 0.015; // real GDP per head, a year
export const ACCESS_BONUS = 0.004; // extra GDP growth a year for a city that reaches all of its partners
export const DEFAULT_POP_GROWTH = 0.004;
export const HUB_GROWTH = 0.0012; // extra GDP growth a year per terminal level, × the city's access share

const fix = (x, k = 1e9) => Math.round(x * k) / k; // Math.pow differs in the last digit between engines

/** Yearly population growth rate from the 2021→end change in cities.json. */
export function yearlyRate(city) {
  const g = city.growth;
  const years = Array.isArray(city.growth_years) ? Math.max(1, city.growth_years[1] - city.growth_years[0]) : 4;
  if (g == null || !Number.isFinite(g)) return DEFAULT_POP_GROWTH;
  return fix(Math.pow(1 + g, 1 / years) - 1);
}

/** Partner weights between region cities, precomputed once: weights[i] = [[j, w]], totals[i] = Σ w. */
export function partnerWeights(env) {
  const cs = env.cities;
  const weights = cs.map(() => []);
  const totals = cs.map(() => 0);
  for (let i = 0; i < cs.length; i++) {
    for (let j = 0; j < cs.length; j++) {
      if (i === j) continue;
      const km = Math.max(80, env.km(cs[i].cell, cs[j].cell));
      const w = cs[j].gdp0 / (km * Math.sqrt(km)); // km^1.5 with exactly rounded operations only
      weights[i].push([j, w]);
      totals[i] += w;
    }
  }
  return { weights, totals };
}

/**
 * Access share per region city (0..1) given the network graph: the gravity-weighted share of partners that sit in
 * a network component this city touches.
 */
export function accessShares(env, graph) {
  const cs = env.cities;
  const comps = cs.map((c) => {
    const s = new Set();
    for (const x of c.cells) if (graph.comp.has(x)) s.add(graph.comp.get(x));
    return s;
  });
  const out = new Array(cs.length).fill(0);
  for (let i = 0; i < cs.length; i++) {
    if (!comps[i].size) continue;
    let reach = 0;
    for (const [j, w] of env.partners.weights[i]) {
      for (const k of comps[j]) if (comps[i].has(k)) { reach += w; break; }
    }
    out[i] = env.partners.totals[i] > 0 ? reach / env.partners.totals[i] : 0;
  }
  return out;
}

/** One year of growth. world = {id: {gdp, pop}}; access = per-city shares or null (baseline); hubs = {cityId: level}. */
export function grow(env, world, access, hubs = null) {
  const next = {};
  env.cities.forEach((c, i) => {
    const cur = world[c.id];
    const pg = c.rate;
    const bonus = access ? (ACCESS_BONUS + HUB_GROWTH * (hubs?.[c.id] || 0)) * access[i] : 0;
    next[c.id] = {
      pop: cur.pop * (1 + pg + bonus * 0.5),
      gdp: cur.gdp * (1 + pg + PRODUCTIVITY + bonus),
    };
  });
  return next;
}
