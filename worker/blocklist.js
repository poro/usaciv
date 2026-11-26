// Names that are refused (docs/MULTIPLAYER.md "Names"). Deliberately short: the worst slurs only, matched as
// substrings of the name after it is lower-cased, de-leeted (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s) and stripped
// of everything that is not a letter. Names are public but not unique, and there is no chat, so this is a floor,
// not a moderation system. Add to it sparingly; every entry is a substring, so keep entries specific.
export const BLOCKED = [
  "nigger", "nigga", "faggot", "fagot", "kike", "kyke", "chink", "gook", "wetback", "tranny", "retard",
  "raghead", "towelhead", "beaner",
  "hitler", "nazi", "kkk",
  // Not listed because they hide inside ordinary words: "spic" (spicy), "coon" (tycoon), "dyke" (Van Dyke).
];

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };

/** The letters-only, de-leeted form a name is checked in. */
export function squash(name) {
  return String(name).toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]).replace(/[^a-z]/g, "");
}

/** True when the name contains a blocked word. */
export function isBlocked(name) {
  const s = squash(name);
  return BLOCKED.some((w) => s.includes(w));
}
