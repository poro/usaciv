// A short, stable fingerprint of a game state (FNV-1a over its canonical JSON), for replay checks: two clients that
// applied the same actions must print the same hash. Keys are sorted so object insertion order does not matter.
import { seedFrom } from "../../shared/rng.js";

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function stateHash(state) {
  return seedFrom(canon(state)).toString(16).padStart(8, "0");
}
