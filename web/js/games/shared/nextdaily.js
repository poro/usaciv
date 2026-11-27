// "Next daily" for end screens: the next short daily (in Play menu order) not finished today on this device, so a
// player can run through the day's games without going back to the menu. Finished = the game's saved stats
// ("usaciv:<id>:stats".last) are dated today: the local date for Which Metro?, the UTC date for the others.
import { GAMES } from "../registry.js";
import { makeStorage } from "./storage.js";
import { todayKey } from "./rng.js";
import { esc } from "../../format.js";

export const SHORT_DAILIES = ["whichMetro", "pinpoint", "duel", "trip", "lens", "rank", "shapes", "guess", "link"];

export function dailyDone(id) {
  const key = id === "whichMetro" ? todayKey() : new Date().toISOString().slice(0, 10);
  return makeStorage(id).get("stats", null)?.last === key;
}

/** The next unfinished short daily after `current`, wrapping around, or null when every one is done. */
export function nextDaily(current) {
  const i = SHORT_DAILIES.indexOf(current);
  for (let k = 1; k < SHORT_DAILIES.length; k++) {
    const id = SHORT_DAILIES[(i + k) % SHORT_DAILIES.length];
    if (id !== current && !dailyDone(id)) return GAMES.find((g) => g.id === id) || null;
  }
  return null;
}

/** A link to the next daily (a plain #play= link, so the host switches modes), or a "all done" note. */
export function nextDailyHtml(current) {
  const g = nextDaily(current);
  if (!g) return `<p class="g-note g-nextdaily">That's every short daily done today. 🎉</p>`;
  const left = SHORT_DAILIES.filter((id) => id !== current && !dailyDone(id)).length;
  return `<p class="g-nextdaily"><a class="g-btn" href="#play=${esc(g.id)}">${esc(g.icon)} Next daily: ${esc(g.title)} →</a> <span class="g-note">${left} left today</span></p>`;
}
