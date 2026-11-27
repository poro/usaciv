// Pinpoint: find real places on the map. Pure (no DOM): the browser and the Worker build the same rounds from the same
// data files and score a guess the same way.
//
// A round names one real place: a metro (cities.json), a national park, landmark or research university
// (wonders.json), a port or airport (infrastructure.json, USACE / FAA), or a big power plant or dam (resources.json,
// EIA-860M). You click a hex; the score is by distance between hex centres (exact sqrt, so every engine agrees):
//   points = 1000 within one hex (25 km), then 1000 − (km − 25), never below 0 (so 0 from about 1,025 km away).
// A day has ROUNDS rounds, one per slot below, picked by a seeded RNG from "pinpoint:<YYYY-MM-DD>"; practice uses any
// other seed. Each slot draws from its own pool, so a day always mixes big cities with places you have to think about.
import { makeRng } from "../../shared/rng.js";

export const ROUNDS = 8;
export const MAX_POINTS = 1000;
export const HEX_KM = 25;
export const SLOTS = ["metroBig", "metroMid", "park", "university", "metroSmall", "airport", "plant", "port"];

const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const mw = (n) => `${fmtInt(n)} MW`;
const PLANT_KIND = { nuclear: "nuclear plant", hydro: "hydroelectric dam", pumped_storage: "pumped-storage plant", coal_plant: "coal plant", gas_plant: "gas plant" };

/**
 * Every candidate place, by slot. data = {cities, resources, wonders, infrastructure}; grid = hexmap.grid (cx, cy).
 * place = {id, slot, kind, name, where (state or states), detail, cell, x, y}
 */
export function buildPool(data, grid) {
  const at = (cell) => ({ cell, x: grid.cx(cell), y: grid.cy(cell) });
  const ok = (cell) => Number.isInteger(cell) && cell >= 0 && cell < grid.size;
  const pool = Object.fromEntries(SLOTS.map((s) => [s, []]));
  const metros = (data.cities || []).filter((c) => c.metro && ok(c.cell)).sort((a, b) => b.population - a.population || (a.id < b.id ? -1 : 1));
  metros.forEach((c, k) => {
    const slot = k < 40 ? "metroBig" : k < 130 ? "metroMid" : k < 260 ? "metroSmall" : null;
    if (!slot) return;
    pool[slot].push({ id: `m:${c.id}`, slot, kind: "metro", name: c.name, where: c.states.join("-"),
      detail: `Metro area of ${c.population >= 1e6 ? `${(c.population / 1e6).toFixed(1)} million` : `${fmtInt(Math.round(c.population / 1000))},000`} people`, ...at(c.cell) });
  });
  for (const w of data.wonders?.wonders || []) {
    if (!ok(w.cell)) continue;
    const slot = w.rule === "research_university" ? "university" : w.rule === "national_park" || w.rule === "landmark" || w.rule === "park_unit" ? "park" : null;
    if (!slot) continue;
    const detail = w.rule === "research_university" ? "Research university" : w.rule === "landmark" ? "National landmark" : w.metrics?.visits ? `${(w.metrics.visits / 1e6).toFixed(1)} million visits a year` : "National Park Service unit";
    pool[slot].push({ id: `w:${w.id}`, slot, kind: w.rule, name: w.name, where: w.state, detail, ...at(w.cell) });
  }
  const air = (data.infrastructure?.airports || []).filter((a) => ok(a.cell) && (a.hub === "M" || a.hub === "S")).sort((a, b) => b.enplanements - a.enplanements).slice(0, 80);
  for (const a of air) pool.airport.push({ id: `a:${a.id}`, slot: "airport", kind: "airport", name: `${a.name} (${a.id})`, where: a.state, detail: `Airport, ${fmtInt(a.enplanements)} boardings a year`, ...at(a.cell) });
  const ports = (data.infrastructure?.ports || []).filter((p) => ok(p.cell)).sort((a, b) => b.tons - a.tons).slice(0, 60);
  for (const p of ports) pool.port.push({ id: `p:${p.id}`, slot: "port", kind: "port", name: p.name, where: p.state, detail: `${p.type[0].toUpperCase()}${p.type.slice(1)} port, ${fmtInt(p.tons / 1e6)} million tons a year`, ...at(p.cell) });
  const plants = (data.resources?.items || []).filter((r) => PLANT_KIND[r.type] && ok(r.cell) && r.value >= 1500 && !/\(\+\d+\)/.test(r.name)).sort((a, b) => b.value - a.value);
  for (const r of plants) pool.plant.push({ id: `r:${r.type}:${r.cell}`, slot: "plant", kind: r.type, name: r.name, where: r.state, detail: `${PLANT_KIND[r.type][0].toUpperCase()}${PLANT_KIND[r.type].slice(1)}, ${mw(r.value)}`, ...at(r.cell) });
  return pool;
}

/** The rounds for a seed string: one place per slot, never two in the same hex. */
export function roundsFor(pool, seed) {
  const rng = makeRng(seed);
  const used = new Set();
  const out = [];
  for (const slot of SLOTS) {
    const cands = pool[slot].filter((p) => !used.has(p.cell));
    if (!cands.length) continue;
    const p = cands[Math.floor(rng.next() * cands.length)];
    used.add(p.cell);
    out.push(p);
  }
  // shuffle the order (Fisher–Yates), keeping the first round a metro so the day starts gently
  for (let i = out.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(rng.next() * i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export const dailySeed = (key) => `pinpoint:${key}`;
export const dailyRounds = (pool, key) => roundsFor(pool, dailySeed(key));

/** Score a guessed hex against a place. → {km, points} */
export function scoreGuess(grid, place, cell) {
  const dx = grid.cx(cell) - place.x, dy = grid.cy(cell) - place.y;
  const km = Math.round(Math.sqrt(dx * dx + dy * dy));
  const points = km <= HEX_KM ? MAX_POINTS : Math.max(0, MAX_POINTS - (km - HEX_KM));
  return { km, points };
}

/** Score a whole game. guesses = [cell] in round order. → {total, results: [{km, points}]} or {error}. */
export function scoreGame(grid, rounds, guesses) {
  if (!Array.isArray(guesses) || guesses.length !== rounds.length) return { error: `need ${rounds.length} guesses` };
  const results = [];
  for (let i = 0; i < rounds.length; i++) {
    const c = guesses[i];
    if (!Number.isInteger(c) || c < 0 || c >= grid.size) return { error: `guess ${i + 1} is not a hex` };
    results.push(scoreGuess(grid, rounds[i], c));
  }
  return { total: results.reduce((s, r) => s + r.points, 0), results };
}

/** One emoji per round for the share text. */
export const square = (points) => (points >= 950 ? "🟩" : points >= 800 ? "🟨" : points >= 500 ? "🟧" : "🟥");
