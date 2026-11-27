// Game modes. Each entry is a folder under web/js/games/<id>/ whose index.js exports
//   start(ctx) → session | Promise<session>      session = { stop?(), onEscape?() → true to stay, param?() → string }
// `ctx` is built by games/host.js (see the comment there for the full surface). The Play menu lists these in order.
// "explore" is not a game: it is the base map (no mode), always first in the menu.
export const GAMES = [
  {
    id: "whichMetro",
    title: "Which Metro?",
    tagline: "A daily puzzle: name the city from its workforce, industries and yields.",
    players: "Single player · daily",
    minutes: "3 min",
    icon: "❓",
    load: () => import("./whichMetro/index.js"),
  },
  {
    id: "pinpoint",
    title: "Pinpoint",
    tagline: "Eight real places a day: metros, parks, ports, dams. Click where each one is; the closer, the more points.",
    players: "Single player · daily",
    minutes: "3 min",
    icon: "📍",
    load: () => import("./pinpoint/index.js"),
  },
  {
    id: "duel",
    title: "Metro Duel",
    tagline: "Higher or lower? Two real metros, one statistic: rent, income, growth… How long can your streak run?",
    players: "Single player · daily",
    minutes: "2 min",
    icon: "⚖️",
    load: () => import("./duel/index.js"),
  },
  {
    id: "trip",
    title: "Road Trip",
    tagline: "Six real metros, one loop home. Pick the order; the shorter your trip against the best one, the higher the score.",
    players: "Single player · daily",
    minutes: "2 min",
    icon: "🚗",
    load: () => import("./trip/index.js"),
  },
  {
    id: "lens",
    title: "Lens Detective",
    tagline: "The map is coloured by a hidden data lens (income, degrees, broadband, faith…). Which one is it?",
    players: "Single player · daily",
    minutes: "2 min",
    icon: "🔎",
    load: () => import("./lens/index.js"),
  },
  {
    id: "rank",
    title: "Metro Ranking",
    tagline: "Five real metros, one statistic: put them in order, highest first. Ten pairs, ten points each.",
    players: "Single player · daily",
    minutes: "2 min",
    icon: "📊",
    load: () => import("./rank/index.js"),
  },
  {
    id: "mainline",
    title: "Mainline",
    tagline: "Lay rail across the real map from 2026 to 2050. Real freight is your demand, real disaster risk your enemy.",
    players: "Single player · daily challenge · versus",
    minutes: "20–40 min",
    icon: "🚆",
    load: () => import("./mainline/index.js"),
  },
  {
    id: "founders",
    title: "Founders",
    tagline: "An empty America with its real terrain and resources. Found cities, grow, and compare with the real country.",
    players: "Single player · daily challenge · multiplayer",
    minutes: "20–30 min",
    icon: "🏕️",
    load: () => import("./founders/index.js"),
  },
];

export const gameById = (id) => GAMES.find((g) => g.id === id) || null;
