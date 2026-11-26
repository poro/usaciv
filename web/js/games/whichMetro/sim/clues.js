// Clue building: five tiers per metro, from vague to specific, with real numbers from citizens.json,
// districts.json and cities.json. Pure, no DOM. Nothing here names the city: district names, specialities and
// city-type labels come from districts.json's catalog at runtime (never hardcoded ids), and free text that can
// name a place (the badge's IPEDS sentence) is left out.
//
// A clue = {id, title, source, facts?: [{label, value, note?, dir?}], bars?: [{key, label, share, national, ratio}],
//           chips?: [{label, value, note?, color?}], lead?: string}
// dir: "up" | "down" when a figure is clearly above / below the US figure.
import { regionOf, STATE_NAMES } from "./regions.js";

const pctTxt = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const intTxt = (n) => Math.round(n).toLocaleString("en-US");
const times = (r) => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;

/** Two significant digits. */
export function sig2(n) {
  if (!(n > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}
/** "about 2.3 million", "about 370,000". */
export function roughPeople(n) {
  const r = sig2(n);
  if (r >= 1e6) return `about ${+(r / 1e6).toFixed(r >= 1e7 ? 0 : 1)} million`;
  return `about ${intTxt(r)}`;
}
/** "$190 billion", "$2.1 trillion". */
export function roughDollars(n) {
  const r = sig2(n);
  if (r >= 1e12) return `$${+(r / 1e12).toFixed(1)} trillion`;
  if (r >= 1e9) return `$${+(r / 1e9).toFixed(r >= 1e10 ? 0 : 1)} billion`;
  if (r >= 1e6) return `$${+(r / 1e6).toFixed(0)} million`;
  return `$${intTxt(r)}`;
}
/** "$87K" (nearest thousand). */
const kDollars = (n) => (n == null ? "–" : `$${Math.round(n / 1000).toLocaleString("en-US")}K`);
const compact = (n) => {
  if (n == null) return "–";
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
};
const dirOf = (v, nat, k = 1.15) => (v == null || !nat ? null : v / nat >= k ? "up" : v / nat <= 1 / k ? "down" : null);

/** Short names for industries: a district speciality's label when the catalog has one, else the BLS title. */
export function industryLabels(districts) {
  const out = new Map();
  for (const [code, v] of Object.entries(districts?.industries || {})) out.set(code, v.title);
  for (const d of districts?.catalog || []) for (const [code, label] of Object.entries(d.sub || {})) out.set(code, label);
  return out;
}

const groupLabels = (citizens, row) => new Map((citizens?.groups?.[row] || []).map((g) => [g.key, g.label]));

// --- the tiers -------------------------------------------------------------------------------------------------

function workforceClue(city, citizens, nation) {
  const row = citizens?.cities?.[city.id]?.workforce;
  const nat = citizens?.national?.workforce;
  if (row && nat) {
    const labels = groupLabels(citizens, "workforce");
    const bars = (citizens.groups.workforce || []).map((g) => {
      const share = row.shares[g.key] ?? 0, national = nat.shares[g.key] ?? 0;
      return { key: g.key, label: labels.get(g.key) || g.key, share, national, ratio: national > 0 ? share / national : 1 };
    });
    return {
      id: "workforce", title: "Who works here",
      source: `Employed residents by occupation, ${citizens.vintage || "ACS"}`,
      lead: "Share of employed residents in each occupation group. Bar: this metro; tick: the US.",
      bars,
    };
  }
  // Fallback: jobs by industry from cities.json against the nation.
  const jobs = city.jobs || {}, nj = nation?.nation?.jobs || {};
  const tot = Object.values(jobs).reduce((a, b) => a + (b || 0), 0), ntot = Object.values(nj).reduce((a, b) => a + (b || 0), 0);
  const bars = Object.keys(ntot ? nj : jobs).map((k) => {
    const share = tot ? (jobs[k] || 0) / tot : 0, national = ntot ? nj[k] / ntot : 0;
    return { key: k, label: k.replace(/_/g, " "), share, national, ratio: national > 0 ? share / national : 1 };
  }).sort((a, b) => b.share - a.share).slice(0, 9);
  return { id: "workforce", title: "Who works here", source: "Employed residents by industry (ACS)", bars };
}

function peopleClue(city, citizens) {
  const r = citizens?.cities?.[city.id] || {};
  const n = citizens?.national || {};
  const facts = [];
  const add = (label, v, nv, fmt = pctTxt) => {
    if (v == null) return;
    facts.push({ label, value: fmt(v), note: nv != null ? `US ${fmt(nv)}` : null, dir: dirOf(v, nv) });
  };
  add("Median age", r.age?.median, n.age?.median, (x) => x.toFixed(1));
  add("Aged 65 and over", r.age?.shares?.elder, n.age?.shares?.elder);
  add("Children under 18", r.age?.shares?.child, n.age?.shares?.child);
  add("Drive to work alone", r.commute?.shares?.drove_alone, n.commute?.shares?.drove_alone);
  add("Take public transit", r.commute?.shares?.transit, n.commute?.shares?.transit, (x) => pctTxt(x, 1));
  add("Work from home", r.commute?.shares?.home, n.commute?.shares?.home);
  add("Bachelor's degree or more", r.education?.bachelors_plus, n.education?.bachelors_plus);
  add("Born in another country", r.nativity?.foreign_born, n.nativity?.foreign_born);
  add("Born in the same state", r.nativity?.born_in_state, n.nativity?.born_in_state);
  if (!facts.length) {
    add("Unemployment", city.unemployment, null, (x) => pctTxt(x, 1));
    add("Rent burden", city.rent_burden, null);
  }
  return { id: "people", title: "How people live", source: `Age, commute, schooling and birthplace, ${citizens?.vintage || "ACS"}`, facts };
}

function economyClue(city, districts) {
  const row = districts?.cities?.[city.id];
  const catalog = new Map((districts?.catalog || []).map((d) => [d.id, d]));
  const labels = industryLabels(districts);
  const facts = [], chips = [];
  let lead = "No district stands out: a diversified economy.";
  if (row?.badge?.label) lead = `City type: ${row.badge.label}`;
  for (const d of row?.districts || []) {
    const cat = catalog.get(d.id);
    const sub = d.sub && d.sub_lq > 1 ? `${labels.get(d.sub) || d.sub} ${d.sub_lower_bound ? "≥" : ""}${times(d.sub_lq)}` : null;
    chips.push({
      label: cat?.name || d.id, color: cat?.color || null,
      value: `${d.lower_bound ? "≥" : ""}${times(d.lq)} the US share · ${compact(d.emp)} jobs`,
      note: sub ? `strongest: ${sub}` : null,
    });
  }
  const listed = new Set((row?.districts || []).map((d) => d.sub).filter(Boolean)); // already shown on a district
  const tops = (row?.top || []).filter((t) => t.emp >= 1000 && t.lq >= 1 && !listed.has(t.naics)).sort((a, b) => b.lq - a.lq).slice(0, 3);
  for (const t of tops) {
    facts.push({ label: labels.get(t.naics) || t.naics, value: `${t.lower_bound ? "≥" : ""}${times(t.lq)}`, note: `${compact(t.emp)} jobs`, dir: t.lq >= 1.15 ? "up" : null });
  }
  if (row?.avg_pay && districts?.national?.avg_pay) {
    facts.push({ label: "Average pay per job", value: kDollars(row.avg_pay), note: `US ${kDollars(districts.national.avg_pay)}`, dir: dirOf(row.avg_pay, districts.national.avg_pay) });
  }
  return {
    id: "economy", title: "What the economy does",
    source: `Districts and industry specialisation (location quotients), ${districts?.vintage || "BLS QCEW"}`,
    lead, chips, facts, factsTitle: tops.length ? "Most over-represented industries" : null,
  };
}

function sizeClue(city, nation) {
  const facts = [];
  const nat = nation?.nation || {};
  facts.push({ label: "Population", value: roughPeople(city.population) });
  if (city.gdp) facts.push({ label: `GDP (${city.gdp_year || "BEA"})`, value: roughDollars(city.gdp) });
  if (city.gdp && city.population) {
    const v = city.gdp / city.population, nv = nat.gdp && nat.population ? nat.gdp / nat.population : null;
    facts.push({ label: "GDP per resident", value: kDollars(v), note: nv ? `US ${kDollars(nv)}` : null, dir: dirOf(v, nv) });
  }
  if (city.median_income) facts.push({ label: "Median household income", value: kDollars(city.median_income), note: nat.median_income ? `US ${kDollars(nat.median_income)}` : null, dir: dirOf(city.median_income, nat.median_income) });
  if (city.home_value) facts.push({ label: "Median home value", value: kDollars(city.home_value), note: nat.home_value ? `US ${kDollars(nat.home_value)}` : null, dir: dirOf(city.home_value, nat.home_value, 1.2) });
  if (city.growth != null) {
    const y = city.growth_years || [];
    const g = city.growth;
    facts.push({ label: `Population change ${y[0] || ""}–${y[1] || ""}`.trim(), value: `${g >= 0 ? "+" : "−"}${Math.abs(g * 100).toFixed(1)}%`, note: nat.growth != null ? `US ${nat.growth >= 0 ? "+" : "−"}${Math.abs(nat.growth * 100).toFixed(1)}%` : null, dir: dirOf(1 + g, 1 + (nat.growth || 0), 1.02) });
  }
  const chips = [];
  for (const y of nation?.yields || []) {
    const v = city.yields?.[y.key];
    if (v == null || y.unit === "usd") continue; // gold = GDP, already above
    chips.push({ label: `${y.emoji || ""} ${y.label}`.trim(), value: y.unit === "usd" ? roughDollars(v) : `${compact(sig2(v))} ${y.unit || ""}`.trim(), color: y.color });
  }
  return { id: "size", title: "Size and wealth", source: "Population (ACS), GDP (BEA), yields", facts, chips, chipsTitle: chips.length ? "Yields" : null, factsFirst: true };
}

function whereClue(city, pool) {
  const states = city.states || [];
  const reg = regionOf(states[0]);
  const facts = [];
  if (reg) facts.push({ label: "Census region", value: `${reg.region} · ${reg.division}` });
  facts.push({ label: states.length > 1 ? "States" : "State", value: states.map((s) => STATE_NAMES[s] || s).join(", ") || "–" });
  if (pool && states[0]) {
    const n = pool.filter((c) => (c.states || []).includes(states[0])).length;
    if (n > 0) facts.push({ label: `Puzzle metros in ${STATE_NAMES[states[0]] || states[0]}`, value: String(n), note: "possible answers there" });
  }
  return { id: "where", title: "Where it is", source: "Census regions and divisions; the metro's principal state first", facts };
}

/**
 * The five clues for a metro, vague → specific.
 * data = {citizens, districts, nation, pool}  (any may be missing: each tier then falls back to cities.json)
 */
export function buildClues(city, data = {}) {
  const { citizens, districts, nation, pool } = data;
  return [
    workforceClue(city, citizens, nation),
    peopleClue(city, citizens),
    economyClue(city, districts),
    sizeClue(city, nation),
    whereClue(city, pool),
  ];
}

/**
 * The single most telling fact, with real numbers, for the end-of-round "why" line: the strongest of the metro's
 * over-represented industries and its citizen specialists (by |log ratio|), else its size. → {text, tier}
 */
export function whyLine(city, data = {}) {
  const { citizens, districts } = data;
  const cands = [];
  const labels = industryLabels(districts);
  const row = districts?.cities?.[city.id];
  for (const t of row?.top || []) {
    if (t.emp < 1000 || !(t.lq > 1)) continue;
    cands.push({
      score: Math.log(t.lq),
      tier: 3,
      text: `${labels.get(t.naics) || t.naics}: ${t.lower_bound ? "at least " : ""}${times(t.lq)} the US share of jobs (${intTxt(t.emp)} jobs).`,
    });
  }
  const crow = citizens?.cities?.[city.id];
  for (const sp of crow?.specialists || []) {
    const label = groupLabels(citizens, sp.row).get(sp.key) || sp.key;
    const of = sp.row === "commute" ? "of commuters" : sp.row === "workforce" ? "of workers" : sp.row === "age" ? "of residents" : sp.row === "education" ? "of adults" : "of residents";
    const tier = sp.row === "workforce" ? 1 : 2;
    const text = sp.ratio >= 1
      ? `${label}: ${pctTxt(sp.share, 1)} ${of}, ${times(sp.ratio)} the US share.`
      : `${label}: only ${pctTxt(sp.share, 1)} ${of}, against ${pctTxt(sp.national, 1)} nationally.`;
    // Over-represented groups say more about a place than missing ones (few metros have much transit).
    cands.push({ score: Math.abs(Math.log(sp.ratio || 1)) * (sp.ratio >= 1 ? 0.9 : 0.5), tier, text });
  }
  cands.sort((a, b) => b.score - a.score || a.tier - b.tier);
  if (cands.length && cands[0].score > Math.log(1.3)) return { text: cands[0].text, tier: cands[0].tier };
  const g = city.gdp ? `, GDP ${roughDollars(city.gdp)}` : "";
  return { text: `Population ${roughPeople(city.population)}${g}.`, tier: 4 };
}
