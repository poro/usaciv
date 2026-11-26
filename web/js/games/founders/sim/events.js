// Founders: seeded random events, weighted by real hazard records where we have them. Pure.
//
//   buildHazards(disasters, world) → hazards | null
//     From disasters.json: FEMA major-disaster declarations per county since 2000 (flood, hurricane, fire, winter)
//     and NOAA billion-dollar drought counts per state since 1980. Without the file, events fall back to terrain
//     (rivers flood, coasts get storms) and say so.
//   rollEvents(env, s, rng) → [event]   mutates s (a fresh clone owned by endTurn): applies at most one event
//
// Events never name a real disaster; they quote the real rate for the place ("this county had 9 flood
// declarations 2000–2026").
import { RULES, townOutput, owners, townGrowthNeed } from "./state.js";
import { IMPROVEMENTS } from "./yields.js";

export function buildHazards(disasters, world) {
  const f = disasters?.fema;
  if (!f?.counties?.rows) return null;
  const cols = f.counties.columns;
  const idx = (k) => cols.indexOf(k);
  const n = world.counties.length;
  const byGeoid = new Map(world.counties.map((c, k) => [c.geoid, k]));
  const out = { flood: new Int16Array(n), hurricane: new Int16Array(n), fire: new Int16Array(n), winter: new Int16Array(n), drought: {} };
  for (const r of f.counties.rows) {
    const k = byGeoid.get(r[0]);
    if (k == null) continue;
    for (const key of ["flood", "hurricane", "fire", "winter"]) out[key][k] = r[idx(key)] || 0;
  }
  for (const [abbr, st] of Object.entries(disasters.noaa?.states || {})) out.drought[abbr] = st.count?.drought || 0;
  out.years = `${(f.window?.[0] || "2000").slice(0, 4)}–${(f.as_of || f.window?.[1] || "").slice(0, 4)}`;
  out.noaaYears = disasters.noaa?.years ? `${disasters.noaa.years[0]}–${disasters.noaa.years[1]}` : "since 1980";
  return out;
}

const KIND_INFO = {
  flood: { title: "Flood", icon: "🌊", bad: true },
  hurricane: { title: "Storm from the sea", icon: "🌀", bad: true },
  fire: { title: "Wildfire", icon: "🔥", bad: true },
  winter: { title: "Hard winter", icon: "❄️", bad: true },
  drought: { title: "Drought", icon: "☀️", bad: true },
  harvest: { title: "Bumper harvest", icon: "🌽", bad: false },
  strike: { title: "Rich seam", icon: "💎", bad: false },
  newcomers: { title: "Newcomers", icon: "🧳", bad: false },
  fair: { title: "Trade fair", icon: "🎪", bad: false },
};
export const EVENT_KINDS = KIND_INFO;

function countyOf(env, town) {
  const k = env.T.county[town.cell];
  if (!(k >= 0)) return null;
  const c = env.T.counties[k];
  const st = env.T.states[env.T.owner[town.cell]]?.abbr || "";
  return { k, name: c?.name || "this county", st };
}

/** Cells a town holds (its border). */
function heldCells(env, s, town) {
  const own = owners(env, s);
  return env.map.within(town.cell, town.radius).filter((c) => own[c] === town.id);
}

/** Weight of each bad event for a town, and the real-record line to show. */
function hazardWeight(env, s, town, kind) {
  const { T } = env;
  const H = env.hazards;
  const cells = heldCells(env, s, town);
  const cty = countyOf(env, town);
  const any = (pred) => cells.some(pred);
  switch (kind) {
    case "flood": {
      if (!any((c) => T.river[c] || T.lake[c])) return { w: 0 };
      if (H && cty) {
        const n = H.flood[cty.k];
        return { w: n + 0.5, rec: `Real record: ${cty.name}, ${cty.st} had ${n} flood disaster declaration${n === 1 ? "" : "s"} ${H.years} (FEMA).` };
      }
      return { w: 1, rec: "Rivers and lakes flood (no hazard data loaded)." };
    }
    case "hurricane": {
      if (!any((c) => T.coast[c])) return { w: 0 };
      if (H && cty) {
        const n = H.hurricane[cty.k];
        return n ? { w: n, rec: `Real record: ${cty.name}, ${cty.st} had ${n} hurricane and tropical-storm declaration${n === 1 ? "" : "s"} ${H.years} (FEMA).` } : { w: 0 };
      }
      return { w: 1, rec: "Coasts see storms (no hazard data loaded)." };
    }
    case "fire": {
      if (H && cty) {
        const n = H.fire[cty.k];
        return n ? { w: n, rec: `Real record: ${cty.name}, ${cty.st} had ${n} fire disaster declaration${n === 1 ? "" : "s"} ${H.years} (FEMA).` } : { w: 0 };
      }
      return { w: any((c) => T.pct.forest[c] + T.pct.shrub[c] > 60) ? 1 : 0, rec: "Dry forest and scrub burn (no hazard data loaded)." };
    }
    case "winter": {
      if (H && cty) {
        const n = H.winter[cty.k];
        return n ? { w: n, rec: `Real record: ${cty.name}, ${cty.st} had ${n} winter-storm declaration${n === 1 ? "" : "s"} ${H.years} (FEMA).` } : { w: 0 };
      }
      return { w: T.elev[town.cell] > 1200 ? 1 : 0, rec: "High country has hard winters (no hazard data loaded)." };
    }
    case "drought": {
      if (H && cty) {
        const n = H.drought[cty.st] || 0;
        return n ? { w: n / 4, rec: `Real record: ${cty.st} was hit by ${n} billion-dollar drought${n === 1 ? "" : "s"} ${H.noaaYears} (NOAA).` } : { w: 0 };
      }
      return { w: T.pct.crop[town.cell] + T.pct.grass[town.cell] > 50 ? 1 : 0, rec: "Open farmland dries out (no hazard data loaded)." };
    }
    default: return { w: 0 };
  }
}

function goodWeight(env, s, town, kind) {
  const cells = heldCells(env, s, town);
  const has = (type) => cells.filter((c) => s.improvements[c] === type).length;
  switch (kind) {
    case "harvest": return has("farmstead") + 0.3;
    case "strike": return has("mine") + has("quarry") * 0.5;
    case "newcomers": return 1 + townOutput(env, s, town).trade / 4;
    case "fair": return townOutput(env, s, town).trade >= 4 ? 1 : 0;
    default: return 0;
  }
}

/** Remove one improvement of the given types from the town's border; returns its name or null. */
function damage(env, s, town, types, rng) {
  const hit = heldCells(env, s, town).filter((c) => types.includes(s.improvements[c]));
  if (!hit.length) return null;
  const c = hit[Math.floor(rng.next() * hit.length)];
  const name = IMPROVEMENTS[s.improvements[c]].name.toLowerCase();
  delete s.improvements[c];
  return name;
}

export function rollEvents(env, s, rng) {
  const out = [];
  if (!s.towns.length || s.turn < RULES.eventFromTurn) return out;
  if (!rng.chance(RULES.eventChance)) return out;
  const bad = rng.chance(0.55);
  const kinds = bad ? ["flood", "hurricane", "fire", "winter", "drought"] : ["harvest", "strike", "newcomers", "fair"];
  // Candidate (kind, town) pairs with weights; pick a kind uniformly among those possible, then a town by weight.
  const table = [];
  for (const kind of kinds) {
    const rows = s.towns.map((t) => {
      const h = bad ? hazardWeight(env, s, t, kind) : { w: goodWeight(env, s, t, kind) };
      return { t, ...h };
    }).filter((r) => r.w > 0);
    if (rows.length) table.push({ kind, rows });
  }
  if (!table.length) return out;
  const pick = table[Math.floor(rng.next() * table.length)];
  const k = rng.weighted(pick.rows.map((r) => r.w));
  const { t: town0, rec } = pick.rows[k];
  const town = s.towns.find((t) => t.id === town0.id);
  const info = KIND_INFO[pick.kind];
  let text = "";
  switch (pick.kind) {
    case "flood": {
      const lost = damage(env, s, town, ["farmstead", "dock"], rng);
      const loss = lost ? 0 : Math.min(s.materials, 8);
      s.materials -= loss;
      text = lost ? `Floodwaters wash out a ${lost} near ${town.name}.` : `Floodwaters soak ${town.name}'s stores: −${loss} materials.`;
      break;
    }
    case "hurricane": {
      const lost = damage(env, s, town, ["dock"], rng);
      town.food = Math.floor(town.food / 2);
      const loss = lost ? 0 : Math.min(s.materials, 12);
      s.materials -= loss;
      text = `A storm comes ashore at ${town.name}${lost ? `, wrecking the ${lost}` : `: −${loss} materials`}, and half its food stores spoil.`;
      break;
    }
    case "fire": {
      const loss = Math.min(s.materials, 10);
      s.materials -= loss;
      town.culture = Math.max(0, town.culture - 3);
      text = `Wildfire sweeps the hills around ${town.name}: −${loss} materials.`;
      break;
    }
    case "winter": {
      town.food = Math.floor(town.food / 2);
      text = `A hard winter at ${town.name}: half its food stores are eaten.`;
      break;
    }
    case "drought": {
      town.food = 0;
      text = `Drought around ${town.name}: its food stores are gone.`;
      break;
    }
    case "harvest": {
      const add = Math.ceil(townGrowthNeed(town) / 2);
      town.food += add;
      text = `A bumper harvest at ${town.name}: +${add} food in store.`;
      break;
    }
    case "strike": {
      s.materials += 20;
      text = `Workers near ${town.name} strike a rich seam: +20 materials.`;
      break;
    }
    case "newcomers": {
      town.pop += 1;
      text = `Newcomers settle in ${town.name}: +1 population.`;
      break;
    }
    case "fair": {
      s.wealth += 10;
      town.culture += 5;
      text = `${town.name} holds a trade fair: +10 wealth, +5 culture.`;
      break;
    }
  }
  const ev = { kind: pick.kind, title: info.title, icon: info.icon, bad: info.bad, town: town.id, cell: town.cell, text, rec: rec || null };
  out.push(ev);
  return out;
}
