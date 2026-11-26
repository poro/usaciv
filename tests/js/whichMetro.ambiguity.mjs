// Which Metro? clue ambiguity: how many pool metros are still plausible after the first clues. Shared by
// whichMetro.test.mjs (the guard) and by hand runs:  node tests/js/whichMetro.ambiguity.mjs
//
// It judges clues as displayed (the strings the player reads), never the raw data, with the slack a player has
// when comparing a clue against what they know of a metro:
//   percentages  within 2 points or 20% of the larger value      "28.2%" vs "9.3%": different
//   amounts      within 30% (people, dollars, jobs, workers)      "about 20 million" vs "about 13 million": different
//   multiples    within 25% ("2.4×")                              plain numbers (median age) within 1.5
//   words        equal (bands, labels, city types, regions)
//   per 1,000    an amount (within 30%); the "1,000" is the same on both sides
// Two clues of the same tier agree when they show the same rows (bars, facts, chips by label) and every row agrees.
// Arrows (dir) are derived from the numbers, so they are not compared.

const NUM = /([≥+−-]?)\$?(\d[\d,]*(?:\.\d+)?)\s*(%|×|K|M|million|billion|trillion)?/g;
const BAND = /\d\s*(?:to|–)\s*\$?\d|\bor more\b|\bunder\b/;
const SCALE = { K: 1e3, M: 1e6, million: 1e6, billion: 1e9, trillion: 1e12 };

/** The numbers in a displayed value: [{kind: "pct" | "mag" | "ratio" | "num", v}], plus its words with numbers blanked. */
export function parseValue(s) {
  const str = String(s ?? "");
  // A band ("2 to 5 million", "5 million or more", "under 500,000") is read as words: same band or not.
  if (BAND.test(str)) return { nums: [], words: str };
  const nums = [];
  for (const m of str.matchAll(NUM)) {
    let v = parseFloat(m[2].replace(/,/g, ""));
    if (m[1] === "−" || m[1] === "-") v = -v;
    const u = m[3];
    if (u === "%") nums.push({ kind: "pct", v: v / 100 });
    else if (u === "×") nums.push({ kind: "ratio", v });
    else if (u) nums.push({ kind: "mag", v: v * SCALE[u] });
    else if (str.includes("$") || /\b(about|jobs|workers|per)\b/.test(str)) nums.push({ kind: "mag", v });
    else nums.push({ kind: "num", v });
  }
  return { nums, words: str.replace(NUM, "#").replace(/\s+/g, " ").trim() };
}

function close(a, b) {
  if (a.kind !== b.kind) return false;
  const x = a.v, y = b.v, big = Math.max(Math.abs(x), Math.abs(y));
  if (a.kind === "pct") return Math.abs(x - y) <= Math.max(0.02, 0.2 * big);
  if (a.kind === "mag") return x > 0 && y > 0 ? Math.max(x, y) / Math.min(x, y) <= 1.3 : x === y;
  if (a.kind === "ratio") return x > 0 && y > 0 && Math.max(x, y) / Math.min(x, y) <= 1.25;
  return Math.abs(x - y) <= 1.5;
}

function sameValue(s, t) {
  const a = parseValue(s), b = parseValue(t);
  return a.words === b.words && a.nums.length === b.nums.length && a.nums.every((n, k) => close(n, b.nums[k]));
}

// A clue's rows: label → displayed value(s).
function rows(clue) {
  const out = new Map();
  if (clue.lead) out.set("lead", [clue.lead]);
  for (const b of clue.bars || []) out.set(`bar:${b.label}`, [b.value ?? `${(b.share * 100).toFixed(1)}%`]);
  for (const f of clue.facts || []) out.set(`fact:${f.label}`, [f.value]);
  for (const c of clue.chips || []) out.set(`chip:${c.label}`, [c.value, c.note || ""]);
  return out;
}

/** True when clue b (same tier, another metro) could be mistaken for clue a. */
export function cluesAgree(a, b) {
  const ra = rows(a), rb = rows(b);
  if (ra.size !== rb.size) return false;
  for (const [k, va] of ra) {
    const vb = rb.get(k);
    if (!vb || !va.every((v, i) => sameValue(v, vb[i]))) return false;
  }
  return true;
}

/**
 * For every pool metro: how many pool metros (itself included) are still plausible after clue 1, clues 1–2, …
 * buildClues = (city) → clues. → [{id, name, counts: [n after 1 clue, n after 2, …], need}]
 * need = clues until it is the only plausible metro (tiers + 1 when never).
 */
export function ambiguity(pool, buildClues, tiers = 3) {
  const all = pool.map((c) => ({ c, clues: buildClues(c) }));
  return all.map(({ c, clues }) => {
    let alive = all;
    const counts = [];
    for (let t = 0; t < tiers; t++) {
      alive = alive.filter((o) => o.c === c || cluesAgree(clues[t], o.clues[t]));
      counts.push(alive.length);
    }
    const k = counts.findIndex((n) => n === 1);
    return { id: c.id, name: c.name, counts, need: k < 0 ? tiers + 1 : k + 1 };
  });
}

export function summarize(res, tiers = 3) {
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const out = {};
  for (let t = 0; t < tiers; t++) {
    const xs = res.map((r) => r.counts[t]);
    out[`after${t + 1}`] = { min: Math.min(...xs), median: med(xs), unique: xs.filter((n) => n === 1).length };
  }
  const top10 = res.slice(0, 10);
  out.top10need = top10.reduce((a, r) => a + r.need, 0) / top10.length;
  return out;
}

// Hand run: print the numbers for the current clues.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const { buildPool } = await import("../../web/js/games/whichMetro/sim/puzzle.js");
  const { buildClues } = await import("../../web/js/games/whichMetro/sim/clues.js");
  const load = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
  const pool = buildPool(load("cities"));
  const data = { citizens: load("citizens"), districts: load("districts"), nation: load("nation"), pool };
  const res = ambiguity(pool, (c) => buildClues(c, data), 3);
  console.log(JSON.stringify(summarize(res, 3), null, 1));
  console.log("top 10:", res.slice(0, 10).map((r) => `${r.name} ${r.counts.join("/")}`).join(" · "));
  console.log("unique after clue 1:", res.filter((r) => r.counts[0] === 1).map((r) => r.name).join(", ") || "none");
}
