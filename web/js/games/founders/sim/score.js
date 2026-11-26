// Founders: score and "You vs. history". Pure.
//
//   prosperity(env, state) → {score, parts}        the in-game score
//   makeHistory({world, counties, cities, nation}) → H   built once at the end (needs counties.json)
//   compareHistory(env, state, H) → {...}           how your country lines up with where Americans really live
//
// Real population inside your borders: each county's 2020s population (counties.json, ACS) is spread evenly over
// the hexes whose centre lies in it (world.json county); a county too small to own a hex puts its people on its
// representative cell. Real GDP: each metro's GDP (cities.json, BEA) spread evenly over its footprint hexes; GDP
// outside metro and micro areas is not in the data, so shares are of the national total (nation.json).
import { owners, nationOutput } from "./state.js";
import { baseYields } from "./yields.js";

export const TOP_METROS = 50;
export const NEAR_HEXES = 2;

export function prosperity(env, state) {
  const n = nationOutput(env, state);
  const parts = {
    towns: state.towns.length * 10,
    people: n.pop * 4,
    wealth: Math.floor(state.wealth / 5),
    links: state.links.reduce((a, l) => a + (l.kind === "rail" ? 6 : 3), 0),
    improvements: Object.keys(state.improvements).length * 2,
    projects: state.towns.reduce((a, t) => a + (t.projects?.length || 0), 0) * 5,
    culture: Math.floor(n.culture / 10),
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, parts };
}

export function makeHistory({ world, counties, cities, nation }) {
  const size = world.grid.cols * world.grid.rows;
  const cellPop = new Float64Array(size);
  let popTotal = 0;
  if (counties?.rows) {
    const col = (k) => counties.columns.indexOf(k);
    const iPop = col("population"), iCell = col("cell");
    const byCounty = new Map();
    for (let i = 0; i < size; i++) {
      const k = world.county[i];
      if (k >= 0 && world.owner[i] >= 0) (byCounty.get(k) || byCounty.set(k, []).get(k)).push(i);
    }
    counties.rows.forEach((r, k) => {
      const pop = r[iPop] || 0;
      popTotal += pop;
      const cells = byCounty.get(k);
      if (cells?.length) for (const c of cells) cellPop[c] += pop / cells.length;
      else if (r[iCell] != null && r[iCell] >= 0) cellPop[r[iCell]] += pop;
    });
  }
  const cellGdp = new Float64Array(size);
  let gdpMetros = 0;
  for (const c of cities || []) {
    if (!(c.gdp > 0) || !c.footprint?.length) continue;
    gdpMetros += c.gdp;
    for (const cell of c.footprint) cellGdp[cell] += c.gdp / c.footprint.length;
  }
  const gdpTotal = nation?.nation?.gdp || gdpMetros;
  const top = (cities || []).filter((c) => c.metro && c.cell != null).sort((a, b) => b.population - a.population)
    .slice(0, TOP_METROS).map((c, k) => ({ id: c.id, name: c.name, cell: c.cell, population: c.population, rank: k + 1 }));
  return { cellPop, popTotal, cellGdp, gdpTotal, gdpMetros, top, hasCounties: !!counties?.rows };
}

export function compareHistory(env, state, H) {
  const { T, map } = env;
  const own = owners(env, state);
  // 1. Towns near a top-50 metro.
  const near = [];
  for (const t of state.towns) {
    let best = null;
    for (const m of H.top) {
      const d = map.dist(t.cell, m.cell);
      if (d <= NEAR_HEXES && (!best || d < best.dist)) best = { metro: m, dist: d };
    }
    if (best) near.push({ town: t.id, name: t.name, metro: best.metro.name, rank: best.metro.rank, population: best.metro.population, dist: best.dist });
  }
  // 2. Real people and GDP inside your borders; your share of the land's output.
  let pop = 0, gdp = 0, held = 0, out = 0, outAll = 0;
  const b = baseYields(T);
  for (const c of T.landCells) {
    const y = b.food[c] + b.materials[c] + b.trade[c];
    outAll += y;
    if (!own[c]) continue;
    held++;
    out += y;
    pop += H.cellPop[c];
    gdp += H.cellGdp[c];
  }
  const metrosInside = H.top.filter((m) => own[m.cell]).map((m) => m.name);
  return {
    towns: state.towns.length,
    near, nearCount: near.length,
    popInside: Math.round(pop), popTotal: H.popTotal, popShare: H.popTotal ? pop / H.popTotal : 0,
    gdpInside: gdp, gdpTotal: H.gdpTotal, gdpShare: H.gdpTotal ? gdp / H.gdpTotal : 0,
    landShare: held / T.landCells.length, outputShare: outAll ? out / outAll : 0,
    metrosInside,
  };
}
