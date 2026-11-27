// Game-mode host: the Play menu, the "game" app mode, and the `ctx` each game's start(ctx) receives.
// Installed like an extension (ext/index.js lists it). URL: #play=<gameId> or #play=<gameId>~<param>.
//
// ctx = {
//   app, game,                 the app API (docs/DATA_CONTRACTS.md) and the registry entry (games/registry.js)
//   param,                     string from the URL after "~" (e.g. a seed or scenario), or null
//   data, cities, cityById,    app.data, the cities.json list, Map<id, city>
//   loadData(name),            app.loadData (lazy files: citizens, districts, disasters, counties, …)
//   hexmap,                    games/shared/hexmap.js over world.json (neighbours, dist, path, within, …)
//   makeRng, seedFrom, todayKey, storage   (games/shared/rng.js, a namespaced games/shared/storage.js)
//   dock(side?, {width, title}) → body element of a docked panel with a title bar and an Exit button
//   toast(msg), setParam(str|null) (rewrites the URL), exit(), onCleanup(fn),
//   on(event, fn)              app.on, removed automatically on exit ("mapclick" handlers: return true to consume)
//   addLayer(layer)            app.registerStaticLayer, removed on exit (id is prefixed with the game id; its
//                              tooltips still show while app.setCitiesHidden(true) hides the real places)
//   addOverlay(overlay)        app.registerOverlay, removed on exit
//   onKey(fn)                  fn(event, key) for keydown while the game is open, before the map's own shortcuts
//                              (L lenses, R resources, arrows…); return true to consume the key (the map then ignores
//                              it). Skipped while typing in a field, with Ctrl/Cmd/Alt held, and for Escape (the host's)
// }
// session (what start returns, all optional) = { stop(), onEscape() → false to leave the game, param() → string }
import { GAMES, gameById } from "./registry.js";
import { makeRng, seedFrom, todayKey } from "./shared/rng.js";
import { makeHexMap } from "./shared/hexmap.js";
import { makeStorage } from "./shared/storage.js";
import { esc } from "../format.js";
import { net } from "./shared/net.js";

export async function install(app) {
  let active = null; // {id, game, session, cleanups, param, token}
  let token = 0;
  let hexmap = null;
  const cityById = new Map(app.data.cities.map((c) => [c.id, c]));

  // --- Play menu -------------------------------------------------------------------------------------------------
  const menu = document.createElement("div");
  menu.className = "modal games-menu";
  menu.hidden = true;
  menu.innerHTML = `<div class="modal-card panel games-card" role="dialog" aria-modal="true" aria-labelledby="games-title">
    <button class="close icon-btn" data-close aria-label="Close">✕</button>
    <h2 id="games-title">Play</h2>
    <p class="muted games-sub">The real United States, built from public data, as a board to play on. Pick a mode.</p>
    <div class="games-list"></div>
    <div class="games-day" hidden><button class="g-btn" data-act="copy-day">📋 Copy my day</button><span class="g-note"></span></div></div>`;
  document.body.appendChild(menu);
  const list = menu.querySelector(".games-list");
  const card = (g) => `<button class="games-item" data-game="${esc(g.id)}">
      <span class="games-ic" aria-hidden="true">${esc(g.icon || "•")}</span>
      <span class="games-txt"><b>${esc(g.title)}</b><span>${esc(g.tagline)}</span>
      <small class="muted">${esc(g.players)}${g.minutes ? ` · ${esc(g.minutes)}` : ""}</small>
      ${g.id ? `<small class="games-today" hidden></small>` : ""}</span></button>`;
  const group = (id) => GAMES.filter((g) => (g.group || "strategy") === id).map(card).join("");
  list.innerHTML = card({ id: "", title: "Explore", tagline: "The data map: lenses, City View and Advisors.", players: "No goal, just browse", icon: "🗺️" }) +
    `<h3 class="games-group">Daily puzzles <small class="muted">2–3 minutes, the same for everyone each day</small></h3><div class="games-grid">${group("daily")}</div>` +
    `<h3 class="games-group">Strategy games <small class="muted">20–40 minutes, solo or with friends</small></h3>${group("strategy")}`;
  const closeMenu = () => { menu.hidden = true; };
  // Today's boards on the cards (GET /api/today): how many played each daily and, signed in, your rank.
  const FMT = { whichMetro: (v) => `${v} pts`, pinpoint: (v) => `${Number(v).toLocaleString("en-US")} pts`, duel: (v) => `streak ${v}`, trip: (v) => `${v}/1000`, lens: (v) => `${v}/6`, rank: (v) => `${v}/500`, shapes: (v) => `${v}/8`,
    founders: (v) => `${Number(v).toLocaleString("en-US")} pts`, mainline: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%` };
  let dayText = "";
  async function decorateToday() {
    if (!(await net.available())) return;
    const r = await net.get(`/api/today?local=${encodeURIComponent(todayKey())}`);
    if (!r.ok || menu.hidden) return;
    const done = GAMES.filter((g) => r.data.games?.[g.id]?.you);
    const box = menu.querySelector(".games-day");
    dayText = done.length ? `usaciv ${r.data.utc}\n${done.map((g) => `${g.icon} ${g.title}: ${FMT[g.id]?.(r.data.games[g.id].you.value) ?? r.data.games[g.id].you.value} (#${r.data.games[g.id].you.rank})`).join("\n")}\n${location.origin}${location.pathname}` : "";
    box.hidden = !done.length;
    box.querySelector(".g-note").textContent = done.length ? `${done.length} of ${Object.keys(r.data.games).length} dailies done today` : "";
    for (const [id, g] of Object.entries(r.data.games || {})) {
      const el = list.querySelector(`.games-item[data-game="${id}"] .games-today`);
      if (!el) continue;
      const players = `${g.total} played today`;
      el.innerHTML = g.you ? `<span class="done">✓ ${esc(FMT[id]?.(g.you.value) ?? g.you.value)} · #${g.you.rank}</span> of ${g.total}`
        : `${g.total ? players : "Nobody yet today"} · <span class="todo">your daily is waiting</span>`;
      el.hidden = false;
    }
  }
  const openMenu = () => {
    menu.hidden = false;
    for (const b of list.querySelectorAll(".games-item")) b.classList.toggle("on", (b.dataset.game || "") === (active?.id || ""));
    list.querySelector(".games-item.on, .games-item")?.focus();
    decorateToday();
  };
  menu.addEventListener("click", (e) => {
    if (e.target === menu || e.target.closest("[data-close]")) return closeMenu();
    if (e.target.closest('[data-act="copy-day"]')) {
      navigator.clipboard?.writeText(dayText).then(() => app.ui.toast?.("Today's results copied"), () => app.ui.toast?.("Could not copy"));
      return;
    }
    const b = e.target.closest(".games-item");
    if (!b) return;
    closeMenu();
    const id = b.dataset.game;
    if (!id) app.setMode(null);
    else play(id);
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeMenu(); }
  });
  app.ui.addTopButton({ id: "btn-play", icon: "🎲", label: "Play", title: "Play a game mode on the real map", onClick: openMenu });

  // --- ctx -------------------------------------------------------------------------------------------------------
  function makeCtx(game, param, cleanups) {
    hexmap ||= makeHexMap(app.data.world);
    const own = (off) => { cleanups.push(off); return off; };
    let docked = new Set();
    const ctx = {
      app, game, param,
      data: app.data, cities: app.data.cities, cityById,
      loadData: (n) => app.loadData(n),
      hexmap, makeRng, seedFrom, todayKey,
      storage: makeStorage(game.id),
      toast: (m) => app.ui.toast?.(m),
      dock(side = "left", { width = 360, title = game.title } = {}) {
        const el = app.ui.dock(side, { width, label: title });
        el.classList.add("games-dock");
        el.innerHTML = `<header class="games-dock-head"><span class="games-ic" aria-hidden="true">${esc(game.icon || "")}</span>
          <h2>${esc(title)}</h2><button class="games-menu-btn btn" type="button" title="Choose another mode">Modes</button>
          <button class="icon-btn" data-exit type="button" aria-label="Leave ${esc(game.title)}" title="Leave the game">✕</button></header>
          <div class="games-dock-body"></div>`;
        el.querySelector("[data-exit]").addEventListener("click", () => ctx.exit());
        el.querySelector(".games-menu-btn").addEventListener("click", openMenu);
        if (!docked.has(side)) { docked.add(side); own(() => { app.ui.undock(side); el.classList.remove("games-dock"); }); }
        return el.querySelector(".games-dock-body");
      },
      setParam(p) {
        if (active && active.cleanups === cleanups) { active.param = p || null; app.hash.update(); }
      },
      exit() { if (active && active.cleanups === cleanups) app.setMode(null); },
      onCleanup: (fn) => own(fn),
      on: (name, fn) => own(app.on(name, fn)),
      addLayer(layer) {
        // A game's own layers keep their tooltips while app.setCitiesHidden(true) hides everyone else's.
        const l = { tooltipWhenHidden: true, ...layer, id: `${game.id}:${layer.id || "layer"}` };
        return own(app.registerStaticLayer(l));
      },
      onKey(fn) {
        const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
        const h = (e) => {
          if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.key === "Escape" || typing(e.target)) return;
          if (!menu.hidden || document.querySelector(".modal:not([hidden]):not(.games-menu)")) return;
          const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          let used = false;
          try { used = fn(e, k) === true; } catch (err) { console.error(`game "${game.id}" key handler failed`, err); }
          if (used) e.preventDefault();
        };
        // Capture phase on window: runs before main.js's own (bubble-phase) shortcuts, which skip prevented keys.
        window.addEventListener("keydown", h, true);
        return own(() => window.removeEventListener("keydown", h, true));
      },
      addOverlay(o) {
        const ov = { ...o, id: `${game.id}:${o.id || "overlay"}` };
        return own(app.registerOverlay(ov));
      },
    };
    return ctx;
  }

  // --- mode ------------------------------------------------------------------------------------------------------
  async function enter(params) {
    const game = gameById(params?.id);
    if (!game) return;
    const my = ++token;
    const cleanups = [];
    active = { id: game.id, game, session: null, cleanups, param: params.param ?? null, token: my };
    document.body.classList.add("in-game");
    document.body.dataset.game = game.id;
    app.clearSelection?.();
    app.setLens?.(null);
    try {
      const mod = await game.load();
      if (my !== token) return;
      const session = await mod.start(makeCtx(game, active.param, cleanups));
      if (my !== token) { try { session?.stop?.(); } catch { /* ignore */ } return; }
      active.session = session || null;
    } catch (err) {
      console.error(`game "${game.id}" failed to start`, err);
      app.ui.toast?.(`${game.title} could not start (${err.message || err})`);
      if (my === token) app.setMode(null);
    }
    app.hash.update();
  }
  function exit() {
    token++;
    const a = active;
    active = null;
    document.body.classList.remove("in-game");
    delete document.body.dataset.game;
    if (!a) return;
    try { a.session?.stop?.(); } catch (err) { console.error(`game "${a.id}" stop() failed`, err); }
    for (const off of a.cleanups.reverse()) {
      try { off?.(); } catch (err) { console.error("game cleanup failed", err); }
    }
    app.setHighlight?.(null);
    app.setCitiesHidden?.(false); // in case a game hid the real places and its own cleanup missed it
    app.invalidate?.();
  }
  app.registerMode("game", {
    enter,
    exit,
    // Esc never drops you out of a game by accident: a game may close its own dialogs, or return false to leave.
    onEscape: () => (active?.session?.onEscape ? active.session.onEscape() !== false : true),
  });

  function play(id, param = null) {
    if (!gameById(id)) return false;
    if (app.mode === "game" && active?.id === id && param == null) return true;
    return app.setMode("game", { id, param });
  }

  app.hash.register("play", {
    get() {
      if (app.mode !== "game" || !active) return null;
      let p = active.param;
      try { p = active.session?.param?.() ?? p; } catch { /* ignore */ }
      return p ? `${active.id}~${p}` : active.id;
    },
    set(v) {
      if (!v) { if (app.mode === "game") app.setMode(null); return; }
      const [id, ...rest] = String(v).split("~");
      const param = rest.length ? rest.join("~") : null;
      if (app.mode === "game" && active?.id === id && (active.param || null) === param) return;
      play(id, param);
    },
  });

  app.games = { list: GAMES, play, openMenu, get active() { return active ? { id: active.id, session: active.session } : null; } };
}
