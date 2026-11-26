// Wrong-guess hints: how far off a guess is and in which direction, without naming the answer. Pure, no DOM.
// Uses cities.json's map positions (x, y in km, y pointing south). Alaska and Hawaii sit in insets on the map, so
// their map distance to the mainland means nothing: those pairs get a plain "off the mainland" style hint instead.

const INSET = new Set(["AK", "HI"]);
const DIRS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
const SHORT = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];

const inset = (c) => INSET.has(c?.states?.[0]);
const roundKm = (km) => (km >= 1000 ? Math.round(km / 50) * 50 : km >= 100 ? Math.round(km / 10) * 10 : Math.round(km));

/**
 * The hint for guessing `g` when the answer is `a` (city records). → {km, dir, short, arrow, text, sameState}
 * dir = where the guess lies from the answer ("west": the guess is too far west); the arrow points the way to go.
 * km and dir are null when the map can't tell (an inset state on one side only).
 */
export function guessHint(g, a) {
  const sameState = !!(g?.states && a?.states && g.states.some((s) => a.states.includes(s)));
  if (!g || !a) return { km: null, dir: null, short: null, arrow: null, text: "", sameState };
  if (inset(g) !== inset(a) || (inset(g) && g.states[0] !== a.states[0])) {
    const text = inset(a) ? "Far off: not in the lower 48" : "Far off: the answer is in the lower 48";
    return { km: null, dir: null, short: null, arrow: null, text, sameState };
  }
  const dx = g.x - a.x, dy = g.y - a.y;
  const km = Math.hypot(dx, dy);
  // Angle of the guess seen from the answer, counter-clockwise from east, with north up.
  const ang = Math.atan2(-dy, dx);
  const k = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  const idx = (8 - k) % 8; // DIRS run clockwise from east
  const dir = DIRS[idx], back = (idx + 4) % 8;
  const r = roundKm(km);
  const text = km < 60
    ? `Very close: ${r} km off${sameState ? ", same state" : ""}`
    : `${r.toLocaleString("en-US")} km too far ${dir}${sameState ? " · same state" : ""}`;
  return { km: r, dir, short: SHORT[idx], arrow: ARROWS[back], text, sameState };
}
