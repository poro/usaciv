// The URL param after "#play=mainline~": "<scenario>.<seed>" or, for the sandbox, "sandbox.<seed>.<home CBSA id>".
import { scenarioById } from "./sim/scenarios.js";

export function formatParam({ scenario, seed, home = null }) {
  return home && scenario === "sandbox" ? `${scenario}.${seed}.${home}` : `${scenario}.${seed}`;
}

export function parseParam(p) {
  if (!p) return null;
  const [scenario, seedStr, home] = String(p).split(".");
  if (!scenarioById(scenario)) return null;
  const seed = Number.parseInt(seedStr, 10);
  if (!Number.isFinite(seed) || seed < 0) return null;
  return { scenario, seed, home: scenario === "sandbox" && /^\d{5}$/.test(home || "") ? home : null };
}
