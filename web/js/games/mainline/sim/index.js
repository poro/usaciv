// Mainline's pure simulation (no DOM). See state.js for the state shape and actions.
export { SCENARIOS, scenarioById, START_YEAR, END_YEAR } from "./scenarios.js";
export { makeEnv } from "./env.js";
export { newGame, apply, check, plan, describePath, evaluate, networkCells, repairCost, hardenCost, maintenance } from "./state.js";
export { summary, byState, regionGdp } from "./score.js";
export { USD_PER_CREDIT, linkCost } from "./costs.js";
export { TYPE_NAME } from "./events.js";
export { greedyTurn } from "./bot.js";
export { payFor } from "./contracts.js";
