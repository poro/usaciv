// The static side of a game: everything derived once from web/data and the scenario (region, costs, contracts,
// hazards, partner weights). Pure (no DOM); the same env in Node tests and the browser.
//
//   makeEnv(data, scenarioId, {home, hexmap}) → env
//   data = {world, cities, trade, infrastructure, disasters}   (the parsed web/data files)
import { makeHexMap } from "../../shared/hexmap.js";
import { scenarioById } from "./scenarios.js";
import { riverCrossings, realRail, costTable } from "./costs.js";
import { buildUtility } from "./utility.js";
import { buildContracts, payFor } from "./contracts.js";
import { hazardTable } from "./events.js";
import { yearlyRate, partnerWeights } from "./growth.js";

/**
 * What a terminal in each region metro builds on: its busiest real port (USACE tons), else its biggest cargo airport
 * (FAA all-cargo lbs), else a plain rail terminal. → Map<cityId, {kind, name, rate (pay bonus per level), base (cr)}>
 */
export const HUB_KIND = {
  port: { rate: 0.1, label: "Port" },
  airport: { rate: 0.07, label: "Air cargo" },
  terminal: { rate: 0.05, label: "Rail terminal" },
};
export const HUB_MAX = 3;
function hubSites(env, infrastructure) {
  const out = new Map();
  const ports = infrastructure?.ports || [], airports = infrastructure?.airports || [];
  for (const c of env.cities) {
    const port = ports.filter((p) => p.cbsa === c.id && p.tons >= 5e6).sort((a, b) => b.tons - a.tons)[0];
    const air = airports.filter((a) => a.cbsa === c.id && a.cargo_lbs >= 3e8).sort((a, b) => b.cargo_lbs - a.cargo_lbs)[0];
    const kind = port ? "port" : air ? "airport" : "terminal";
    const name = port ? port.name : air ? air.name : `${c.name} rail terminal`;
    const detail = port ? `${Math.round(port.tons / 1e6)}M tons a year (USACE ${port.year})`
      : air ? `${Math.round(air.cargo_lbs / 1e6).toLocaleString("en-US")}M lbs of air cargo (FAA ${air.year})` : "";
    // price per level: a floor plus the metro's size (bigger metros: dearer land, more to gain)
    const base = Math.round(10 + c.gdp0 / 20e9);
    out.set(c.id, { kind, name, detail, rate: HUB_KIND[kind].rate, base });
  }
  return out;
}

/**
 * Sandbox's frontier grant, a game model for balance. A remote home (the West, the Florida peninsula) has few, small
 * flows within reach, so the same budget buys a network that earns a third of what an Ohio Valley one does and never
 * compounds (diagnosed with the bot: Phoenix, Seattle and Denver missed the goal on 240 cr and cleared it on 300+).
 * The grant tops up the start: market = the full pay of every contract with both ends within grant.km of home;
 * grant = max × (1 − market ÷ ref), at least 0. It echoes the 1862 Pacific Railway Act, which backed the first
 * transcontinental line with federal bonds per mile. → {market, grant, startCash}
 */
export function frontierGrant(env) {
  const g = env.scenario.grant;
  const startCash = env.scenario.cash;
  if (!g || !env.home) return { market: null, grant: 0, startCash };
  let market = 0;
  for (const c of env.contracts) {
    if (env.km(env.home.cell, c.a.cell) < g.km && env.km(env.home.cell, c.b.cell) < g.km) market += payFor(c.value, 1, c.km);
  }
  market = Math.round(market * 10) / 10;
  const grant = Math.round(g.max * Math.max(0, 1 - market / g.ref));
  return { market, grant, startCash: startCash + grant };
}

export const DEFAULT_GDP_PER_HEAD = 75000; // only for a city with no BEA GDP (none today)

// The river table depends only on the world: share it between envs.
const riverCache = new WeakMap();

export function makeEnv(data, scenarioId, { home = null, hexmap = null } = {}) {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`unknown scenario "${scenarioId}"`);
  const { world } = data;
  hexmap ||= makeHexMap(world);
  const g = hexmap.grid;
  const cityById = new Map(data.cities.map((c) => [c.id, c]));

  // --- region ---
  const stateIdx = scenario.states ? new Set(scenario.states.map((a) => world.states.findIndex((s) => s.abbr === a)).filter((k) => k >= 0)) : null;
  let bbox = null;
  if (scenario.bounds) {
    const pts = scenario.bounds.cities.map((id) => cityById.get(id)).filter(Boolean);
    const pad = scenario.bounds.padKm;
    bbox = {
      x0: Math.min(...pts.map((c) => g.cx(c.cell))) - pad, x1: Math.max(...pts.map((c) => g.cx(c.cell))) + pad,
      y0: Math.min(...pts.map((c) => g.cy(c.cell))) - pad, y1: Math.max(...pts.map((c) => g.cy(c.cell))) + pad,
    };
  }
  const inBox = (i) => !bbox || (g.cx(i) >= bbox.x0 && g.cx(i) <= bbox.x1 && g.cy(i) >= bbox.y0 && g.cy(i) <= bbox.y1);
  const region = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) {
    const o = world.owner[i];
    if (o >= 0 && (!stateIdx || stateIdx.has(o)) && inBox(i)) region[i] = 1;
  }
  // coastal and lake water next to region land may carry a causeway
  for (let i = 0; i < g.size; i++) {
    if (world.owner[i] !== -1 || !(world.water[i] === 2 || world.water[i] === 3) || !inBox(i)) continue;
    if (hexmap.neighbours(i).some((n) => region[n] === 1)) region[i] = 2;
  }
  const inRegion = (i) => i >= 0 && i < g.size && region[i] > 0;

  // region extent (for framing the camera)
  let ext = null;
  for (let i = 0; i < g.size; i++) {
    if (region[i] !== 1) continue;
    const x = g.cx(i), y = g.cy(i);
    if (!ext) ext = { x0: x, y0: y, x1: x, y1: y };
    else { ext.x0 = Math.min(ext.x0, x); ext.x1 = Math.max(ext.x1, x); ext.y0 = Math.min(ext.y0, y); ext.y1 = Math.max(ext.y1, y); }
  }

  // --- cities in the region (metros, by population) ---
  const cities = data.cities
    .filter((c) => c.metro && inRegion(c.cell) && region[c.cell] === 1)
    .map((c) => ({
      id: c.id, name: c.name, full: c.full, states: c.states, cell: c.cell, metro: true,
      population: c.population, gdp: c.gdp ?? c.population * DEFAULT_GDP_PER_HEAD, growth: c.growth, growth_years: c.growth_years,
      footprint: c.footprint,
    }));
  for (const c of cities) {
    c.gdp0 = c.gdp;
    c.pop0 = c.population;
    c.rate = yearlyRate(c);
    c.cells = (c.footprint || [c.cell]).filter((x) => region[x] === 1);
    if (!c.cells.includes(c.cell)) c.cells.push(c.cell);
  }
  // hex → the region metro whose footprint holds it (the biggest, if two overlap): express stations
  const cellMetro = new Map();
  cities.forEach((c, i) => { for (const x of c.cells) if (!cellMetro.has(x)) cellMetro.set(x, i); });
  const homeId = scenario.home || home || cities[0]?.id;
  const homeCity = cities.find((c) => c.id === homeId) || cities[0];

  // county → one of its cells (for the state on event cards)
  const countyCell = new Map();
  for (let i = 0; i < g.size; i++) {
    const k = world.county[i];
    if (k >= 0 && !countyCell.has(k)) countyCell.set(k, i);
  }

  // Distance between cell centres in km. Not hexmap.km (Math.hypot is not exactly rounded in every engine): sqrt is.
  const km = (a, b) => {
    const dx = g.cx(a) - g.cx(b), dy = g.cy(a) - g.cy(b);
    return Math.sqrt(dx * dx + dy * dy);
  };

  if (!riverCache.has(world)) riverCache.set(world, riverCrossings(world, hexmap));
  const env = {
    scenario, world, hexmap, km, cityById, trade: data.trade, region, inRegion, bbox, ext,
    cities, cityIdx: new Map(cities.map((c, k) => [c.id, k])), home: homeCity,
    cellMetro,
    rivers: riverCache.get(world),
    rail: realRail(data.infrastructure, hexmap),
    hazard: hazardTable(world, data.disasters),
    cellOfCounty: (k) => countyCell.get(k) ?? -1,
  };
  env.costs = costTable(env);
  env.edgeCost = (a, b) => {
    for (let d = 0; d < 6; d++) if (g.neighbour(a, d) === b) return env.costs[a * 6 + d];
    return Infinity;
  };
  env.contracts = buildContracts(env, { models: scenario.models });
  env.utility = buildUtility(env, data.resources); // power and talent contracts (utility.js)
  env.contractById = new Map(env.contracts.map((c) => [c.id, c]));
  Object.assign(env, frontierGrant(env));
  env.partners = partnerWeights(env);
  env.homeCells = new Set(homeCity ? homeCity.cells : []);
  env.hubs = hubSites(env, data.infrastructure);
  return env;
}
