// Mainline's pure simulation (no DOM). See state.js for the state shape and actions.
export { SCENARIOS, scenarioById, START_YEAR, END_YEAR } from "./scenarios.js";
export { makeEnv, HUB_KIND, HUB_MAX } from "./env.js";
export {
  newGame, apply, applyValid, check, plan, describePath, evaluate, networkCells, connectedCities, migrate, SAVE_VERSION,
  repairCost, hardenCost, hardenOptions, doubleCost, hubCost, maintenance, DOUBLE_MAINT, HUB_MAINT, DEBT_RATE, creditLine, MAINT_RATE,
} from "./state.js";
export { summary, byState, regionGdp } from "./score.js";
export { USD_PER_CREDIT, linkCost } from "./costs.js";
export { TYPE_NAME, HZ_TYPES, linkHazards } from "./events.js";
export { greedyTurn } from "./bot.js";
export { payFor, DOUBLE_BONUS } from "./contracts.js";
export { HUB_GROWTH } from "./growth.js";
export {
  corridors, corridorStatus, expressCost, expressOps, EXPRESS_GROWTH, EXPRESS_CAP, EXPRESS_OPS,
} from "./express.js";
export { stateHash } from "./hash.js";
export {
  newVersus, vsCheck, vsAct, settle, resolve as vsResolve, botActions, applyEntry, replay as vsReplay, standings, vsHash,
  VS_MAX, VS_YEARS, VS_COLORS, BOT_NAMES,
} from "./versus.js";
