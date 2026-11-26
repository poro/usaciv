// Census regions and divisions by state postal code (U.S. Census Bureau, "Census Regions and Divisions of the
// United States"). Used for the last clue tier. Pure data, no DOM.

const DIVISIONS = {
  "New England": ["CT", "ME", "MA", "NH", "RI", "VT"],
  "Middle Atlantic": ["NJ", "NY", "PA"],
  "East North Central": ["IL", "IN", "MI", "OH", "WI"],
  "West North Central": ["IA", "KS", "MN", "MO", "NE", "ND", "SD"],
  "South Atlantic": ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV"],
  "East South Central": ["AL", "KY", "MS", "TN"],
  "West South Central": ["AR", "LA", "OK", "TX"],
  "Mountain": ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"],
  "Pacific": ["AK", "CA", "HI", "OR", "WA"],
};
const REGION_OF_DIVISION = {
  "New England": "Northeast", "Middle Atlantic": "Northeast",
  "East North Central": "Midwest", "West North Central": "Midwest",
  "South Atlantic": "South", "East South Central": "South", "West South Central": "South",
  "Mountain": "West", "Pacific": "West",
};

const DIVISION_OF = new Map();
for (const [div, list] of Object.entries(DIVISIONS)) for (const s of list) DIVISION_OF.set(s, div);

/** {division, region} for a postal code, or null. */
export function regionOf(abbr) {
  const division = DIVISION_OF.get(String(abbr || "").toUpperCase());
  return division ? { division, region: REGION_OF_DIVISION[division] } : null;
}

export const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
