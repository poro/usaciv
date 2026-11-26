// Mainline scenarios: each fixes a start metro, a starting budget, a goal and the region you may build in, so runs
// are comparable. Region = US land hexes in `states` (null = the whole lower 48) and inside the box around
// `bounds.cities` padded by `bounds.padKm` (null = no box). City ids are cities.json CBSA codes.

export const START_YEAR = 2026;
export const END_YEAR = 2050; // the last year you play; ending it ends the game (25 turns)

export const SCENARIOS = [
  {
    id: "texas",
    name: "Texas Triangle",
    blurb: "Houston, Dallas, San Antonio and Austin: four fast-growing metros, Gulf freight and hurricane country.",
    home: "26420", // Houston
    cash: 70,
    goal: 0.04,
    states: ["TX", "LA", "OK"],
    bounds: { cities: ["26420", "19100", "41700", "12420", "35380", "36420"], padKm: 110 },
    models: 26,
  },
  {
    id: "rust",
    name: "Rust to Rail",
    blurb: "Rebuild Great Lakes freight from Chicago. Old rail is everywhere, so upgrades are cheap; winters and floods are not.",
    home: "16980", // Chicago
    cash: 80,
    goal: 0.035,
    states: ["IL", "IN", "MI", "OH", "WI", "PA", "IA"],
    bounds: { cities: ["16980", "19820", "18140", "38300", "17410", "33340", "26900", "19780"], padKm: 90 },
    models: 20,
  },
  {
    id: "northeast",
    name: "Northeast Corridor",
    blurb: "The densest freight market in the country, from Washington to Boston. Every hex is expensive and the coast floods.",
    home: "35620", // New York
    cash: 70,
    goal: 0.045,
    states: ["VA", "DC", "MD", "DE", "PA", "NJ", "NY", "CT", "RI", "MA", "NH", "VT"],
    bounds: { cities: ["47900", "12580", "37980", "35620", "25540", "39300", "14460"], padKm: 90 },
    models: 16,
  },
  {
    id: "sandbox",
    name: "Sandbox",
    blurb: "The whole lower 48 and every one of the 40 largest freight flows. Pick a home metro and go.",
    home: null, // chosen by the player
    cash: 150,
    goal: 0.01,
    states: null,
    bounds: null,
    models: 45,
  },
];

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || null;
