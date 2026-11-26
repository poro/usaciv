// City search for the guess box: every city in cities.json, matched on its short name, its label ("Portland, OR")
// and the other principal cities in its full name ("Fort Worth" finds Dallas). Pure, no DOM.

/** Lower case, accents and punctuation stripped, single spaces. */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Portland, OR" / "New York, NY-NJ". */
export const cityLabel = (c) => `${c.name}${c.states?.length ? `, ${c.states.join("-")}` : ""}`;

/** Principal cities from the full name: "Dallas-Fort Worth-Arlington, TX Metro Area" → ["Dallas", "Fort Worth", "Arlington"]. */
export function principalCities(full) {
  const head = String(full || "").split(",")[0];
  return head.split(/[-–\/]/).map((s) => s.trim()).filter(Boolean);
}

export function buildIndex(cities) {
  return cities.map((c) => {
    const alts = principalCities(c.full).map(normalize).filter((a) => a && a !== normalize(c.name));
    return {
      id: c.id,
      label: cityLabel(c),
      sub: c.metro ? "Metro area" : "Micro area",
      pop: c.population || 0,
      name: normalize(c.name),
      full: normalize(cityLabel(c)),
      alts,
    };
  });
}

/**
 * Best matches for a query: [{id, label, sub, pop}] (at most `limit`), ranked by how the query matches
 * (exact name, name prefix, label prefix, word prefix, other principal city, substring), then population.
 */
export function matchCities(index, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  for (const e of index) {
    let s = 99;
    if (e.name === q) s = 0;
    else if (e.name.startsWith(q)) s = 1;
    else if (e.full.startsWith(q)) s = 2;
    else if (e.name.split(" ").some((w) => w.startsWith(q))) s = 3;
    else if (e.alts.some((a) => a === q || a.startsWith(q))) s = 4;
    else if (e.alts.some((a) => a.split(" ").some((w) => w.startsWith(q)))) s = 5;
    else if (q.length >= 3 && (e.full.includes(q) || e.alts.some((a) => a.includes(q)))) s = 6;
    if (s < 99) scored.push([s, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || b[1].pop - a[1].pop);
  return scored.slice(0, limit).map(([, e]) => ({ id: e.id, label: e.label, sub: e.sub, pop: e.pop }));
}
