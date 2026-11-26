// Disasters, from FEMA's real county rates (disasters.json, lazy). Pure (no DOM); randomness only through the rng
// passed in, so a seed replays the same storms.
//
// Each turn, every county that holds one of your intact links rolls once. Its yearly rate of
// damaging events is Σ over hazard types of (declarations of that type ÷ years in FEMA's window) × SEVERITY[type] ×
// DAMAGE_SCALE: a FEMA major-disaster declaration is an administrative act, not every one would cut a rail line, so
// only a share of them do. On a hit the type is drawn in proportion to those weighted rates, and each unhardened
// link touching the county's hexes is damaged with chance LINK_HIT. Damaged links carry nothing until repaired.

export const DAMAGE_SCALE = 0.14;
export const SEVERITY = { hurricane: 1.0, flood: 0.8, fire: 0.6, severe_storm: 0.35, winter: 0.35, other: 0.25 };
export const LINK_HIT = 0.6;

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
    const counts = {};
    let lambda = 0;
    for (const t of types) {
      const n = row[idx[t]] || 0;
      counts[t] = n;
      lambda += (n / years) * (SEVERITY[t] ?? 0.25) * DAMAGE_SCALE;
    }
    out.set(k, {
      geoid: row[idx.geoid], name: world.counties[k].name, total: row[idx.total] || 0, counts,
      years: Math.round(years * 10) / 10, p: 1 - Math.exp(-lambda),
    });
  }
  return out;
}

export const TYPE_NAME = {
  hurricane: "Hurricane", flood: "Flood", fire: "Wildfire", severe_storm: "Severe storm", winter: "Winter storm", other: "Disaster",
};

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
  const types = Object.keys(SEVERITY);
  for (const k of [...byCounty.keys()].sort((p, q) => p - q)) {
    const hz = env.hazard.get(k);
    if (!hz || !(hz.p > 0)) continue;
    const here = [...byCounty.get(k)].sort();
    const exposed = here.filter((key) => !out[key].d && !out[key].h);
    const hardened = here.filter((key) => !out[key].d && out[key].h).length;
    if (!exposed.length && !hardened) continue; // everything here is already down
    if (!rng.chance(hz.p)) continue;
    const t = types[rng.weighted(types.map((x) => (hz.counts[x] || 0) * SEVERITY[x]))] || "other";
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
