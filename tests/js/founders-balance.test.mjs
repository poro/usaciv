// node --test tests/js: Founders economy balance (headless). The bot must keep spending its materials (no
// stockpile of more than ~10 turns of income for long) and must clearly beat a player who founds one town and
// only ends turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../../web/js/games/founders/sim/index.js";

const D = (n) => JSON.parse(readFileSync(new URL(`../../web/data/${n}.json`, import.meta.url)));
const world = D("world");
const env = S.makeEnv({ world, resources: D("resources"), hazards: S.buildHazards(D("disasters"), world) });

function idleGame(seed) {
  let s = S.newGame(env, seed);
  s = S.apply(env, s, { type: "start", cell: s.starts[0].cell }).state;
  s = S.apply(env, s, { type: "found", party: s.parties[0].id }).state;
  while (s.phase !== "over") s = S.apply(env, s, { type: "end" }).state;
  return s;
}

test("balance: the bot spends its materials and beats a do-nothing player", () => {
  for (const seed of ["bal-1", "bal-2", "bal-3", "bal-4"]) {
    let s = S.newGame(env, seed);
    let hoard = 0, maxHoard = 0;
    while (s.phase !== "over") {
      s = S.botTurn(env, s);
      const income = Math.max(10, S.nationOutput(env, s).income);
      // Over 10 turns of income in store counts as hoarding; a turn or two (saving for something) is fine.
      hoard = s.materials > 10 * income ? hoard + 1 : 0;
      maxHoard = Math.max(maxHoard, hoard);
    }
    assert.ok(maxHoard <= 2, `${seed}: hoarded for ${maxHoard} turns in a row`);
    const n = S.nationOutput(env, s);
    assert.ok(s.materials <= 3 * Math.max(10, n.income), `${seed}: ends with ${s.materials} materials on +${n.income}`);
    // The new sinks are used.
    assert.ok(s.towns.some((t) => t.projects?.length), `${seed}: some town projects`);
    const idle = idleGame(seed);
    const ni = S.nationOutput(env, idle);
    assert.ok(s.towns.length > idle.towns.length, `${seed}: towns ${s.towns.length} vs ${idle.towns.length}`);
    assert.ok(n.pop > 2 * ni.pop, `${seed}: people ${n.pop} vs ${ni.pop}`);
    assert.ok(S.prosperity(env, s).score > 3 * S.prosperity(env, idle).score, `${seed}: score`);
  }
});

test("balance: costs rise with what you own; upkeep, projects, homesteaders and festivals", () => {
  let s = S.newGame(env, "sinks", {});
  s = S.apply(env, s, { type: "start", cell: s.starts[1].cell }).state;
  s = S.apply(env, s, { type: "found", party: s.parties[0].id }).state;
  s = { ...s, materials: 5000 };
  const t = s.towns[0];
  // Improvement cost: +12% for each one of that kind already built.
  const own = S.owners(env, s);
  const spots = env.map.within(t.cell, 1).filter((c) => own[c] && c !== t.cell);
  const kind = ["farmstead", "quarry", "dock", "mine"].find((k) => spots.filter((c) => !S.improveBlocker(env, s, c, k)).length >= 2);
  assert.ok(kind, "two hexes for the same improvement");
  const base = S.improvementCost(s, kind);
  assert.equal(base, S.IMPROVEMENTS[kind].cost);
  const c0 = spots.find((c) => !S.improveBlocker(env, s, c, kind));
  s = S.apply(env, s, { type: "improve", cell: c0, kind }).state;
  assert.ok(S.improvementCost(s, kind) > base);
  // Projects: one of each per town; effects show in the output.
  const before = S.townOutput(env, s, s.towns[0]);
  const r = S.apply(env, s, { type: "project", town: t.id, project: "granary" });
  assert.ok(r.ok, r.error);
  assert.equal(r.state.materials, s.materials - S.PROJECTS.granary.cost);
  assert.equal(S.townOutput(env, r.state, r.state.towns[0]).food, before.food + 2);
  assert.ok(S.townGrowthNeed(r.state.towns[0]) < S.growthNeed(t.pop));
  assert.match(S.apply(env, r.state, { type: "project", town: t.id, project: "granary" }).error, /Built/);
  assert.match(S.apply(env, r.state, { type: "project", town: t.id, project: "college" }).error, /turn|school/);
  s = r.state;
  // Homesteaders: +1 person for materials, once a turn.
  const g = S.apply(env, s, { type: "grow", town: t.id });
  assert.ok(g.ok, g.error);
  assert.equal(g.state.towns[0].pop, t.pop + 1);
  assert.equal(g.state.materials, s.materials - S.growCost(s.towns[0]));
  assert.match(S.apply(env, g.state, { type: "grow", town: t.id }).error, /already/);
  // Festival: culture for materials, once a turn.
  const f = S.apply(env, g.state, { type: "festival", town: t.id });
  assert.ok(f.ok, f.error);
  assert.equal(f.state.towns[0].culture, g.state.towns[0].culture + S.RULES.festivalCulture);
  assert.ok(S.apply(env, f.state, { type: "festival", town: t.id }).error);
  // Upkeep comes out of income: a town of 4 pays 2 a turn.
  const big = { ...f.state, towns: [{ ...f.state.towns[0], pop: 4 }] };
  const n = S.nationOutput(env, big);
  assert.equal(n.upkeep, 2);
  assert.equal(n.income, n.gross - 2);
  const after = S.apply(env, big, { type: "end" }).state;
  assert.equal(after.lastTurn.income, n.income);
});
