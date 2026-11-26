// Disasters, from FEMA's real county rates (disasters.json, lazy). Pure (no DOM); randomness only through the rng
// passed in, so a seed replays the same storms.
//
// Each turn, every county that holds one of your intact links rolls once. Its yearly rate of
// damaging events is Σ over hazard types of (declarations of that type ÷ years in FEMA's window) × SEVERITY[type] ×
// DAMAGE_SCALE: a FEMA major-disaster declaration is an administrative act, not every one would cut a rail line, so
// only a share of them do. On a hit the type is drawn in proportion to those weighted rates, and each unhardened
// link touching the county's hexes is damaged with chance LINK_HIT unless it is hardened against that type
// (link.h is a bitmask over HZ_TYPES). Damaged links carry nothing until repaired.
//
// Determinism: rates and chances are rounded to 1e-6 (fix) so a last-digit difference in Math.exp between browsers
// can never flip a roll.

export const DAMAGE_SCALE = 0.14;
export const SEVERITY = { hurricane: 1.0, flood: 0.8, fire: 0.6, severe_storm: 0.35, winter: 0.35, other: 0.25 };
export const LINK_HIT = 0.6;
export const HZ_TYPES = Object.keys(SEVERITY);
export const HZ_BIT = Object.fromEntries(HZ_TYPES.map((t, k) => [t, 1 << k]));
export const HZ_ALL = (1 << HZ_TYPES.length) - 1;
export const fix = (x, k = 1e6) => Math.round(x * k) / k;

/** Per-county hazard table from disasters.json → Map<county index, {geoid, name, total, counts, rates, p, years}>. */
export function hazardTable(world, disasters) {
  const out = new Map();
  const fema = disasters?.fema;
  if (!fema?.counties) return out;
  const cols = fema.counties.columns;
  const types = fema.types.map((t) => t.id);
  const idx = Object.fromEntries(cols.map((c, k) => [c, k]));
  const [w0, w1] = fema.window || ["2000-01-01", fema.as_of || "2026-11-25"];
  const years = Math.max(1, (Date.parse(w1) - Date.parse(w0)) / (365.25 * 864e5));
  const byGeoid = new Map(world.counties.map((c, k) => [c.geoid, k]));
  for (const row of fema.counties.rows) {
    const k = byGeoid.get(row[idx.geoid]);
    if (k == null) continue;
    const counts = {}, lam = {};
    let lambda = 0;
    for (const t of types) {
      const n = row[idx[t]] || 0;
      counts[t] = n;
      lam[t] = fix((n / years) * (SEVERITY[t] ?? 0.25) * DAMAGE_SCALE);
      lambda += lam[t];
    }
    out.set(k, {
      geoid: row[idx.geoid], name: world.counties[k].name, total: row[idx.total] || 0, counts, lam,
      years: Math.round(years * 10) / 10, p: fix(1 - Math.exp(-fix(lambda))),
    });
  }
  return out;
}

export const TYPE_NAME = {
  hurricane: "Hurricane", flood: "Flood", fire: "Wildfire", severe_storm: "Severe storm", winter: "Winter storm", other: "Disaster",
};

/**
 * The hazards a link is exposed to: one row per type with a FEMA record in the counties of its two hexes.
 * lam = the yearly rate of damaging events of that type (summed over its distinct counties), count/years = the record.
 * → [{type, bit, lam, count, years, counties: [name]}], most frequent first
 */
export function linkHazards(env, l) {
  const ks = [...new Set([l.a, l.b].map((c) => env.world.county[c]).filter((k) => k != null && k >= 0))].sort((p, q) => p - q);
  const out = [];
  for (const t of HZ_TYPES) {
    let lam = 0, count = 0, years = 0;
    const names = [];
    for (const k of ks) {
      const hz = env.hazard.get(k);
      if (!hz || !hz.counts[t]) continue;
      lam += hz.lam[t];
      count += hz.counts[t];
      years = hz.years;
      names.push(hz.name);
    }
    if (count > 0) out.push({ type: t, bit: HZ_BIT[t], lam: fix(lam), count, years, counties: names });
  }
  return out.sort((x, y) => y.lam - x.lam || HZ_TYPES.indexOf(x.type) - HZ_TYPES.indexOf(y.type));
}

/**
 * Roll this year's disasters against the network. links = state.links. → {links (new object if anything changed),
 * events: [{county, geoid, name, state, type, count, total, years, damaged, held}]}
 */
export function rollDisasters(env, links, rng, year) {
  const { world } = env;
  // county index → link keys touching it (only unhardened, intact links can be hurt)
  const byCounty = new Map();
  const keys = Object.keys(links).sort();
  for (const key of keys) {
    const l = links[key];
    for (const c of [l.a, l.b]) {
      const k = world.county[c];
      if (k == null || k < 0) continue;
      if (!byCounty.has(k)) byCounty.set(k, new Set());
      byCounty.get(k).add(key);
    }
  }
  let out = links;
  const events = [];
  const types = HZ_TYPES;
  for (const k of [...byCounty.keys()].sort((p, q) => p - q)) {
    const hz = env.hazard.get(k);
    if (!hz || !(hz.p > 0)) continue;
    const here = [...byCounty.get(k)].sort();
    if (!here.some((key) => !out[key].d)) continue; // everything here is already down
    if (!rng.chance(hz.p)) continue;
    const t = types[rng.weighted(types.map((x) => hz.lam[x] || 0))] || "other";
    const bit = HZ_BIT[t];
    const exposed = here.filter((key) => !out[key].d && !((out[key].h | 0) & bit));
    const hardened = here.filter((key) => !out[key].d && ((out[key].h | 0) & bit)).length;
    let damaged = 0;
    for (const key of exposed) {
      if (!rng.chance(LINK_HIT)) continue;
      if (out === links) out = { ...links };
      out[key] = { ...out[key], d: 1, dy: year };
      damaged++;
    }
    const st = world.states[world.owner[env.cellOfCounty(k)]]?.abbr || "";
    events.push({
      county: k, geoid: hz.geoid, name: hz.name, state: st, type: t, count: hz.counts[t] || 0, total: hz.total,
      years: hz.years, damaged, held: hardened, year,
    });
  }
  return { links: out, events };
}
