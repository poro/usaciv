// Lens Detective: the map is coloured by one of the data lenses (lenses.json) with its name, legend and tooltips
// hidden; pick which lens it is from four choices. Pure: the browser and the Worker build the same rounds.
import { makeRng } from "../../shared/rng.js";

export const ROUNDS = 6;
export const CHOICES = 4;

/** The lenses a round can use: every numeric lens (the categorical "largest tradition" is left out). */
export const lensPool = (lensFile) => (lensFile?.lenses || []).filter((l) => l.format !== "category").map((l) => ({ id: l.id, name: l.name, unit: l.unit, group: l.group }));

/** ROUNDS rounds from a seed: [{answer: lensId, options: [lensId × CHOICES]}], six different answers. */
export function lensRounds(pool, seed) {
  const rng = makeRng(seed);
  const pickOut = (arr) => arr.splice(Math.floor(rng.next() * arr.length), 1)[0];
  const answers = pool.slice();
  const out = [];
  for (let k = 0; k < ROUNDS && answers.length; k++) {
    const a = pickOut(answers);
    // decoys: one from the same group when there is one (harder), the rest from anywhere
    const others = pool.filter((l) => l.id !== a.id);
    const same = others.filter((l) => l.group === a.group);
    const opts = [a];
    if (same.length) opts.push(pickOut(same.slice()));
    const rest = others.filter((l) => !opts.includes(l));
    while (opts.length < CHOICES && rest.length) opts.push(pickOut(rest));
    for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
    out.push({ answer: a.id, options: opts.map((l) => l.id) });
  }
  return out;
}
export const dailySeed = (key) => `lens:${key}`;

/** Score a list of picks (lens ids, in round order). → {score, results: [bool]} or {error}. */
export function scoreLens(rounds, picks) {
  if (!Array.isArray(picks) || picks.length !== rounds.length) return { error: `need ${rounds.length} picks` };
  const results = [];
  for (let i = 0; i < rounds.length; i++) {
    if (typeof picks[i] !== "string" || !rounds[i].options.includes(picks[i])) return { error: `pick ${i + 1} is not one of the choices` };
    results.push(picks[i] === rounds[i].answer);
  }
  return { score: results.filter(Boolean).length, results };
}
