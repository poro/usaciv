// Founders: settle an empty America on its real terrain, then compare your country with the real one.
// The rules live in ./sim (pure, tested in tests/js/founders.test.mjs); this file is the UI around them: a dock
// panel, map clicks and keys, saves, and the end screen. Map art is in ./render.js.
//
// Host needs (all through ctx and the documented app API; nothing in host.js changed):
//   * Real cities are hidden while playing: the "cover" layer paints the land as it would be without the city over
//     city tiles (the engine's terrain art drawn from the sim's open-land estimate, sim/terrain.js openLand), and
//     app.setCitiesHidden(true) switches off the city banners and every non-game tooltip (restored on exit and at
//     the end, when the real cities are revealed). Map-layer toggles that would show real places (roads, rail, ports…) are switched off and
//     restored on exit, and the lens dock, the national totals (#yields) and city search are hidden by founders.css.
//   * Keys go through ctx.onKey (before the map's own shortcuts); R, L and / are swallowed while the country is
//     hidden, so resource icons, lenses and city search (which show real places) cannot come back. While hidden, R is
//     Founders' own "repeat last order".
//
// Turn helpers (sim/auto.js): towns on Auto spend for themselves when the turn ends, R repeats the last town order
// on the selected town, N jumps to the next party or town that needs orders, and End turn warns (once) only when
// something is truly idle. A three-step first-run tutorial (TUT_KEY in the game's storage) can be replayed from
// How to play.
import { loadCss } from "../shared/css.js";
import * as S from "./sim/index.js";
import { prepareCover, prepareLand, coverLayer, landLayer, yieldsLayer, townsLayer, makeOverlay, COLORS } from "./render.js";
import { esc, int, popShort, compact } from "../../format.js";

const SAVE_KEY = "save";
const SAVE_V = 1;
const HOWTO_KEY = "howto-seen";
const TUT_KEY = "tutorial";

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/founders.css");
  const body = ctx.dock("left", { width: 360, title: "Founders" });
  body.classList.add("fd");
  body.innerHTML = `<p class="g-note">Surveying the land…</p>`;

  const disasters = await ctx.loadData("disasters").catch(() => null);
  const world = ctx.data.world;
  const env = S.makeEnv({ world, resources: ctx.data.resources, hazards: S.buildHazards(disasters, world) });

  const model = {
    env, grid: env.map.grid, state: null, ver: 0, land: null, revealed: false, showYields: true,
    selTown: null, selParty: null, selCell: null, hoverCell: null, history: null, confirmNew: false,
    showHow: false, warnedTurn: null, tut: null,
    cover: prepareCover(app.w, ctx.cities, env.T),
  };

  // First run: the tutorial; afterwards the How-to-play card shows until it has been dismissed once.
  if (!ctx.storage.get(TUT_KEY)?.done) model.tut = { step: 0, base: null };
  else model.showHow = !ctx.storage.get(HOWTO_KEY);

  // --- hide the real country while playing -----------------------------------------------------------------------
  app.setCitiesHidden(true);
  ctx.onCleanup(() => { app.setCitiesHidden(false); app.invalidate?.(); });
  // Map-layer toggles (roads, rail, ports…) and resource icons (power plants are built by people) would give the
  // real country away. Extensions install before the game host, so their toggles exist when the game starts; this runs
  // again on every refresh and when the extension loader reports in ("extensions"), so a late one is caught too.
  // Whatever it switched off is switched back on at exit.
  const toggledOff = new Set();
  let hidResources = false;
  function enforceHidden() {
    if (model.revealed) return;
    try {
      for (const t of app.ui.mapToggles?.() || []) if (t.on && app.ui.setMapToggle(t.id, false)) toggledOff.add(t.id);
    } catch { /* no toggles */ }
    if (app.state.showResources && app.w?.resources) { app.setShowResources?.(false); hidResources = true; }
  }
  ctx.onCleanup(() => {
    for (const id of toggledOff) app.ui.setMapToggle?.(id, true);
    if (hidResources) app.setShowResources?.(true);
  });
  ctx.on("extensions", () => enforceHidden());
  enforceHidden();
  document.body.classList.remove("fd-revealed");
  ctx.onCleanup(() => document.body.classList.remove("fd-revealed"));

  ctx.addLayer(coverLayer(model));
  ctx.addLayer(landLayer(model));
  ctx.addLayer(yieldsLayer(model));
  ctx.addLayer(townsLayer(model));
  ctx.addOverlay(makeOverlay(model));

  // --- state, saves, seed ----------------------------------------------------------------------------------------
  const randomSeed = () => Math.random().toString(36).slice(2, 8);
  const saved = ctx.storage.get(SAVE_KEY);
  const savedState = saved && saved.v === SAVE_V && saved.state && saved.state.v === 1 ? saved.state : null;
  const seed = ctx.param || savedState?.seed || randomSeed();
  setState(savedState && savedState.seed === seed ? savedState : S.newGame(env, seed), false);
  ctx.setParam(model.state.seed);

  function setState(s, save = true) {
    model.state = s;
    model.ver++;
    model.land = s.phase === "setup" ? null : prepareLand(env, s);
    if (save) ctx.storage.set(SAVE_KEY, { v: SAVE_V, state: s });
  }

  function act(action, { quiet = false } = {}) {
    const r = S.apply(env, model.state, action);
    if (!r.ok) {
      if (!quiet) ctx.toast(r.error);
      return r;
    }
    setState(r.state);
    if (r.msg && !quiet) ctx.toast(r.msg);
    return r;
  }

  function newGame(seedStr) {
    model.selTown = model.selParty = model.selCell = null;
    model.history = null;
    if (model.revealed) reveal(false);
    setState(S.newGame(env, seedStr));
    ctx.setParam(seedStr);
    app.home?.();
    refresh();
  }

  // --- turn ------------------------------------------------------------------------------------------------------
  function endTurn() {
    const s = model.state;
    if (s.phase !== "play") return;
    if (!s.towns.length) { ctx.toast("Found your first town before ending the turn (F)."); return; }
    // Warn once a turn, and only when something is truly idle; a second End turn goes ahead.
    const idle = model.warnedTurn === s.turn ? null : S.endTurnCheck(env, s);
    if (idle) {
      model.warnedTurn = s.turn;
      selectItem(idle, true);
      ctx.toast(`${idle.text} Press End turn again to end anyway.`);
      refresh();
      return;
    }
    const r = act({ type: "end" });
    if (!r.ok) return;
    const rep = model.state.lastTurn;
    if (rep?.auto?.length) ctx.toast(`Auto: ${rep.auto.length} order${rep.auto.length > 1 ? "s" : ""} (${rep.auto.slice(0, 3).map((a) => a.text).join(", ")}${rep.auto.length > 3 ? "…" : ""})`);
    for (const e of rep?.events || []) ctx.toast(`${e.icon} ${e.text}`);
    if (model.state.phase === "over") finish();
    refresh();
  }

  async function finish() {
    body.querySelector(".fd-sel")?.insertAdjacentHTML("afterbegin", `<p class="g-note">Comparing with the real country…</p>`);
    const counties = await ctx.loadData("counties").catch(() => null);
    const H = S.makeHistory({ world, counties, cities: ctx.cities, nation: ctx.data.nation });
    model.history = { ...S.compareHistory(env, model.state, H), vintage: counties?.vintage || "ACS", hasCounties: H.hasCounties };
    reveal(true);
    model.selTown = model.selParty = model.selCell = null;
    refresh();
    frameTowns();
    // Again once the host has framed the docked map (a resumed game reaches here before that).
    const t = setTimeout(frameTowns, 1000);
    ctx.onCleanup(() => clearTimeout(t));
  }

  function reveal(on) {
    model.revealed = on;
    app.setCitiesHidden(!on);
    document.body.classList.toggle("fd-revealed", on);
    app.invalidate?.();
  }

  // --- camera ----------------------------------------------------------------------------------------------------
  const R = model.grid.R;
  function flyToCell(c, zoomIn = false) {
    const scale = zoomIn ? Math.max(app.cam.scale, 22 / R) : app.cam.scale;
    app.flyTo(model.grid.cx(c), model.grid.cy(c), scale);
  }
  function frameTowns() {
    const ts = model.state.towns;
    if (!ts.length || !app.fitBounds) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of ts) {
      const x = model.grid.cx(t.cell), y = model.grid.cy(t.cell);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const m = 4 * R;
    app.fitBounds(x0 - m, y0 - m, x1 + m, y1 + m, { maxScale: 22 / R });
  }

  // --- input -----------------------------------------------------------------------------------------------------
  ctx.on("mapclick", (ev) => {
    const s = model.state;
    if (s.phase === "over") return false; // the real map is back: let clicks open real cities
    const c = ev.cell;
    if (c == null || c < 0 || !env.T.land[c]) {
      model.selTown = model.selParty = model.selCell = null;
      refresh();
      return true;
    }
    if (s.phase === "setup") {
      if (s.starts.some((st) => st.cell === c)) beginAt(c);
      else { model.selCell = c; refresh(); }
      return true;
    }
    const partiesHere = s.parties.filter((p) => p.cell === c);
    const town = S.townAt(s, c);
    // A selected party walks to the clicked hex (unless the click picks something else to select).
    if (model.selParty != null && !partiesHere.some((p) => p.id === model.selParty) && !town) {
      const r = act({ type: "move", party: model.selParty, to: c });
      if (r.ok) model.hoverCell = null;
      refresh();
      return true;
    }
    if (partiesHere.length && (!town || model.selTown === town.id || model.selParty != null)) {
      const k = partiesHere.findIndex((p) => p.id === model.selParty);
      model.selParty = partiesHere[(k + 1) % partiesHere.length].id;
      model.selTown = null;
      model.selCell = null;
    } else if (town) {
      model.selTown = town.id;
      model.selParty = null;
      model.selCell = null;
    } else {
      model.selParty = null;
      model.selCell = c;
      const own = S.owners(env, s)[c];
      model.selTown = own || null;
    }
    refresh();
    return true;
  });

  ctx.on("hover", (h) => {
    if (model.selParty == null) return;
    const c = h?.cell ?? null;
    if (c !== model.hoverCell) { model.hoverCell = c; app.requestDraw(); }
  });

  function beginAt(cell) {
    const r = act({ type: "start", cell });
    if (!r.ok) return;
    model.selCell = null;
    model.selParty = model.state.parties[0]?.id ?? null;
    flyToCell(cell, true);
    refresh();
  }

  function found() {
    const s = model.state;
    let p = s.parties.find((x) => x.id === model.selParty);
    if (!p && s.parties.length === 1) p = s.parties[0];
    if (!p) { ctx.toast("Select a founding party first."); return; }
    const r = act({ type: "found", party: p.id });
    if (r.ok) {
      model.selParty = null;
      model.selTown = r.town;
      model.selCell = null;
    }
    refresh();
  }

  function nextParty() {
    const s = model.state;
    const list = s.parties.filter((p) => p.moves > 0);
    if (!list.length) { ctx.toast("No founding party waiting for orders."); return; }
    const k = list.findIndex((p) => p.id === model.selParty);
    const p = list[(k + 1) % list.length];
    model.selParty = p.id;
    model.selTown = model.selCell = null;
    flyToCell(p.cell, true);
    refresh();
  }

  /** Select a party or town ({kind, id}) and bring it into view. */
  function selectItem(it, fly = true) {
    const s = model.state;
    if (it.kind === "party") {
      const p = S.partyById(s, it.id);
      if (!p) return;
      model.selParty = p.id; model.selTown = null; model.selCell = null;
      if (fly) flyToCell(p.cell, true);
    } else {
      const t = S.townById(s, it.id);
      if (!t) return;
      model.selTown = t.id; model.selParty = null; model.selCell = null;
      if (fly) flyToCell(t.cell, true);
    }
  }

  /** N: the next founding party or town that needs orders (sim/auto.js ordersNeeded), after the current selection. */
  function nextNeedingOrders() {
    const s = model.state;
    if (s.phase !== "play") return;
    const list = S.ordersNeeded(env, s);
    if (!list.length) { ctx.toast("Nothing needs orders: end the turn (Enter)."); return; }
    const k = list.findIndex((x) => (x.kind === "party" ? x.id === model.selParty : x.id === model.selTown));
    const it = list[(k + 1) % list.length];
    selectItem(it, true);
    ctx.toast(it.why);
    refresh();
  }

  /** R: give the selected town the last town order (homesteaders, festival, an improvement on its best hex…). */
  function repeatOrder() {
    const s = model.state;
    if (s.phase !== "play") return;
    if (!s.lastOrder) { ctx.toast("No order to repeat yet: give a town an order first."); return; }
    const t = model.selTown != null ? S.townById(s, model.selTown) : null;
    if (!t) { ctx.toast(`Select a town to repeat "${S.orderLabel(s.lastOrder)}" (N jumps to the next town).`); return; }
    const a = S.repeatAction(env, s, t.id);
    if (!a) { ctx.toast(`${t.name} cannot take "${S.orderLabel(s.lastOrder)}" now.`); return; }
    const r = act(a);
    if (r.ok && !r.msg) ctx.toast(`${S.orderLabel(s.lastOrder)}: ${t.name}`);
    refresh();
  }

  function toggleAuto(townId) {
    const t = S.townById(model.state, townId);
    if (!t) return;
    act({ type: "auto", town: t.id, on: !t.auto }, { quiet: true });
    ctx.toast(`${t.name}: auto ${t.auto ? "off" : "on"}`);
  }

  // Keys (ctx.onKey runs before the map's own shortcuts; true = handled, so the map ignores it).
  ctx.onKey((e, k) => {
    const onButton = e.target?.tagName === "BUTTON";
    if (k === "Enter" || k === "e") {
      if (k === "Enter" && onButton) return false; // the button handles its own Enter
      endTurn();
      return true;
    }
    if (k === "f") { found(); return true; }
    if (k === " ") {
      if (onButton) return false;
      nextParty();
      return true;
    }
    if (k === "n") { nextNeedingOrders(); return true; }
    if (k === "a" && model.state.phase === "play") {
      if (model.selTown != null) { toggleAuto(model.selTown); refresh(); } else ctx.toast("Select a town to put it on auto (A).");
      return true;
    }
    if (k === "r" && !model.revealed) { repeatOrder(); return true; }
    if (k === "y") { model.showYields = !model.showYields; refresh(); return true; }
    if (k === "h") { model.showHow = !model.showHow; if (!model.showHow) ctx.storage.set(HOWTO_KEY, true); refresh(); return true; }
    // While the country is hidden: no resource icons (R), no lenses (L) and no city search (/): they show real places.
    if (!model.revealed && (k === "r" || k === "l" || k === "/")) return true;
    return false;
  });

  // --- panel -----------------------------------------------------------------------------------------------------
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const d = b.dataset;
    const s = model.state;
    switch (d.act) {
      case "end": endTurn(); return;
      case "start": beginAt(+d.cell); return;
      case "found": found(); return;
      case "nextparty": nextParty(); return;
      case "nextorder": nextNeedingOrders(); return;
      case "repeat": repeatOrder(); return;
      case "auto": toggleAuto(+d.town); break;
      case "autoall": act({ type: "auto", town: "all", on: d.on === "1" }, { quiet: true }); break;
      case "tut-next": tutAdvance(true); break;
      case "tut-skip": tutFinish(false); break;
      case "tut-replay": ctx.storage.remove(TUT_KEY); model.tut = { step: 0, base: null }; model.showHow = false; break;
      case "party": {
        const r = act({ type: "party", town: +d.town });
        if (r.ok) { model.selParty = model.state.parties.at(-1).id; model.selTown = null; }
        break;
      }
      case "improve": act({ type: "improve", cell: +d.cell, kind: d.kind }); break;
      case "project": act({ type: "project", town: +d.town, project: d.p }); break;
      case "grow": act({ type: "grow", town: +d.town }); break;
      case "festival": act({ type: "festival", town: +d.town }); break;
      case "how": model.showHow = !model.showHow; if (!model.showHow) ctx.storage.set(HOWTO_KEY, true); break;
      case "share": copyResult(); return;
      case "pin": act({ type: "pin", town: +d.town, cell: +d.cell }); break;
      case "focus": act({ type: "focus", town: +d.town, focus: d.v }); break;
      case "link": act({ type: "link", a: +d.a, b: +d.b }); break;
      case "town": {
        const t = S.townById(s, +d.id);
        if (!t) return;
        model.selTown = t.id; model.selParty = null; model.selCell = null;
        flyToCell(t.cell, true);
        break;
      }
      case "party-sel": {
        const p = S.partyById(s, +d.id);
        if (!p) return;
        model.selParty = p.id; model.selTown = null; model.selCell = null;
        flyToCell(p.cell, true);
        break;
      }
      case "yields": model.showYields = !model.showYields; break;
      case "reveal": reveal(!model.revealed); break;
      case "new":
        if (!model.confirmNew && s.phase === "play" && s.turn > 1) {
          model.confirmNew = true;
          b.textContent = "Click again to abandon this game";
          setTimeout(() => { model.confirmNew = false; refresh(); }, 4000);
          return;
        }
        model.confirmNew = false;
        newGame(randomSeed());
        return;
      case "replay": newGame(s.seed); return;
      case "deselect": model.selTown = model.selParty = model.selCell = null; break;
      default: return;
    }
    refresh();
  });

  function refresh() {
    enforceHidden();
    tutAdvance(false);
    render();
    app.requestDraw();
  }

  const yl = (y) => `<span class="fd-food" title="Food">🌾 ${y.food}</span> <span class="fd-mat" title="Materials">🪵 ${y.materials}</span> <span class="fd-trade" title="Trade">⚖️ ${y.trade}</span>`;

  function render() {
    const s = model.state;
    if (s.phase === "over" && model.history) { body.innerHTML = endScreen(); return; }
    const n = S.nationOutput(env, s);
    const score = S.prosperity(env, s).score;
    const hint = S.nextHint(env, s);
    const year = S.yearOf(s.turn);
    const needs = S.ordersNeeded(env, s);
    model.needs = new Set(needs.map((x) => `${x.kind}:${x.id}`));
    const warned = model.warnedTurn === s.turn && s.phase === "play" ? S.endTurnCheck(env, s) : null;
    const idleWarn = warned ? `<p class="fd-idle" role="status">${esc(warned.text)} <b>End turn</b> again to end anyway.</p>` : "";
    body.innerHTML = `
      <div class="fd-top">
        <div class="fd-year"><b>${year}</b><span>Turn ${s.turn} of ${s.maxTurns}</span></div>
        <div class="fd-stats">
          <div class="g-stat" title="Materials in store. Per turn: +${n.gross} (town materials plus a quarter of trade) − ${n.upkeep} upkeep (1 per 2 people, 1 per rail line)"><b class="fd-mat">${int(s.materials)}</b><span>Materials ${n.income >= 0 ? "+" : ""}${n.income}</span></div>
          <div class="g-stat" title="Population across your towns"><b>${n.pop}</b><span>People</span></div>
          <div class="g-stat" title="Trade per turn (culture, wealth and score)"><b class="fd-trade">${n.trade}</b><span>Trade</span></div>
          <div class="g-stat" title="Prosperity score"><b>${int(score)}</b><span>Score</span></div>
        </div>
      </div>
      ${model.showHow ? howToPlay() : ""}
      ${model.tut ? tutorialCard() : `<div class="fd-hint" role="status"><span class="fd-hint-k">Next</span> ${esc(hint)}</div>`}
      ${idleWarn}
      <div class="g-row fd-actions">
        <button class="g-btn primary fd-end" data-act="end" ${s.phase !== "play" ? "disabled" : ""} title="End the turn (Enter or E)">End turn <kbd>⏎</kbd></button>
        <button class="g-btn" data-act="nextorder" ${needs.length ? "" : "disabled"} title="Next party or town that needs orders (N)">Next${needs.length ? ` · ${needs.length}` : ""} <kbd>N</kbd></button>
        <button class="g-btn fd-toggle${model.showYields ? " on" : ""}" data-act="yields" title="Show yields on the map when zoomed in (Y)" aria-pressed="${model.showYields}">Yields</button>
      </div>
      <div class="fd-sel">${selectionPanel()}</div>
      ${turnReport()}
      ${townList()}
      ${logPanel()}
      ${howItWorks()}
      <div class="fd-foot g-row">
        <span class="g-note">Seed <code>${esc(s.seed)}</code></span>
        <button class="g-btn" data-act="how" title="How to play (H)">How to play</button>
        <button class="g-btn" data-act="replay" title="Restart with the same seed">Restart</button>
        <button class="g-btn" data-act="new">New game</button>
      </div>`;
  }

  function selectionPanel() {
    const s = model.state;
    const { T } = env;
    if (s.phase === "setup") {
      const starts = s.starts.map((st, k) => {
        const y = S.hexYield(T, st.cell, null, true);
        return `<button class="fd-start" data-act="start" data-cell="${st.cell}">
          <span class="fd-num">${k + 1}</span><span><b>${esc(st.label)}</b><small>Site value ${st.score} · centre ${yl(y)}</small></span></button>`;
      }).join("");
      const sel = model.selCell != null ? `<div class="fd-card"><b>This hex</b> ${hexDetail(model.selCell)}
          <button class="g-btn primary" data-act="start" data-cell="${model.selCell}" ${T.relief[model.selCell] >= 3 ? "disabled" : ""}>Begin here</button></div>` : "";
      return `<h3 class="g-section">Choose where to begin</h3>
        <p class="g-note">An empty country on the real terrain of the lower 48. Four fair starts on a coast or river (gold rings), or click any land hex to look and begin there.</p>
        <div class="fd-starts">${starts}</div>${sel}`;
    }
    const party = model.selParty != null ? S.partyById(s, model.selParty) : null;
    if (party) {
      const why = S.foundBlocker(env, s, party.cell);
      return `<h3 class="g-section">Founding party</h3>
        <p>Moves left <b>${party.moves}/${S.RULES.partyMoves}</b>${party.target != null ? " · on the way" : ""}</p>
        <button class="g-btn primary" data-act="found" ${why ? "disabled" : ""}>Found a town here <kbd>F</kbd></button>
        ${why ? `<p class="fd-warn">${esc(why)}</p>` : ""}
        <p class="g-note">Click any hex to walk there (the number is turns to arrive; ✓ = this turn). Red hexes are too close to a town.</p>
        <div class="fd-card"><b>Here</b> ${hexDetail(party.cell)}<p class="g-note">Site value ${Math.round(S.siteScore(env, party.cell))} (what a town here could work)</p></div>`;
    }
    const town = model.selTown != null ? S.townById(s, model.selTown) : null;
    const hex = model.selCell;
    let html = "";
    if (town) html += townPanel(town);
    if (hex != null && (!town || hex !== town.cell)) html += hexPanel(hex, town);
    if (!html) html = `<p class="g-note">Click a town, a founding party or a hex. Hover any hex to see what it yields and why.</p>`;
    return html;
  }

  function hexDetail(c) {
    const e = S.explainHex(env.T, c);
    const parts = e.parts.map((p) => {
      const bits = [p.food ? `+${p.food} food` : "", p.materials ? `+${p.materials} mat.` : "", p.trade ? `+${p.trade} trade` : "", p.note || ""].filter(Boolean).join(", ");
      return `<li>${esc(p.label)} <span class="muted">→ ${esc(bits || "nothing")}</span></li>`;
    }).join("");
    return `<ul class="fd-parts">${parts || "<li class='muted'>Nothing grows here</li>"}</ul><div class="fd-total">= ${yl(e)}</div>`;
  }

  function townPanel(t) {
    const s = model.state;
    const o = S.townOutput(env, s, t);
    const need = S.townGrowthNeed(t);
    const nextR = [null, S.RULES.cultureR2, S.RULES.cultureR3, S.RULES.cultureR4][t.radius] ?? null;
    const cost = S.partyCost(s);
    const canParty = t.pop >= 2 && s.materials >= cost;
    const grow = o.surplus > 0 ? `+${o.surplus}/turn, grows in ${Math.max(1, Math.ceil((need - t.food) / o.surplus))}` : o.surplus < 0 ? `<span class="fd-warn">${o.surplus}/turn: starving</span>` : "stagnant";
    const foci = S.FOCI.map((f) => `<button class="fd-chip${t.focus === f ? " on" : ""}" data-act="focus" data-town="${t.id}" data-v="${f}">${f}</button>`).join("");
    const links = s.towns.filter((x) => x.id !== t.id && env.map.dist(x.cell, t.cell) <= S.RULES.maxLinkLen)
      .map((x) => ({ x, plan: S.linkPlan(env, s, t.id, x.id), d: env.map.dist(x.cell, t.cell) }))
      .sort((a, b) => a.d - b.d).slice(0, 5)
      .map(({ x, plan }) => plan.error
        ? `<li>${esc(x.name)} <span class="muted">· ${esc(plan.error)}</span></li>`
        : `<li><button class="g-btn" data-act="link" data-a="${t.id}" data-b="${x.id}" ${s.materials < plan.cost ? "disabled" : ""}>${plan.kind === "rail" ? "Rail" : "Road"} to ${esc(x.name)} · ${plan.cost}</button></li>`).join("");
    return `<h3 class="g-section">${esc(t.name)} <small class="muted">founded ${S.yearOf(t.founded)}</small></h3>
      <div class="fd-town-stats">
        <div class="g-stat"><b>${t.pop}</b><span>People</span></div>
        <div class="g-stat"><b class="fd-food">${o.food}</b><span>Food (eats ${o.eat})</span></div>
        <div class="g-stat"><b class="fd-mat">${o.materials}</b><span>Materials</span></div>
        <div class="g-stat"><b class="fd-trade">${o.trade}</b><span>Trade</span></div>
      </div>
      <p>Food store <b>${t.food}/${need}</b> · ${grow}</p>
      <p>Culture <b>${t.culture}</b>${o.culture ? ` (+${1 + Math.floor(o.trade / 2) + o.culture}/turn)` : ""} · border radius ${t.radius}${nextR ? ` (grows at ${nextR})` : " (full)"} · works ${o.worked.length} of ${o.tiles.length} hexes · upkeep ${Math.floor(S.townUpkeep(s, t))}</p>
      <div class="fd-row"><span class="g-note">Focus</span> ${foci}</div>
      ${ordersRow(t)}
      <div class="g-row"><button class="g-btn primary" data-act="party" data-town="${t.id}" ${canParty ? "" : "disabled"}
        title="Costs ${cost} materials and 1 person" aria-label="Send settlers: ${cost} materials and 1 person">Send settlers · ${cost}</button>
        ${t.pop < 2 ? `<span class="g-note">needs 2 people</span>` : ""}</div>
      ${spendPanel(t)}
      ${projectsPanel(t)}
      ${links ? `<h4 class="fd-h4">Links (+${S.RULES.roadTrade} trade each end; rail +${S.RULES.railTrade} from turn ${S.RULES.railTurn})</h4><ul class="fd-links">${links}</ul>` : ""}
      <p class="g-note">Click a hex inside the border to build on it, or to always work it. White dots mark worked hexes.</p>`;
  }

  /** Auto and Repeat: the late-game helpers for this town. */
  function ordersRow(t) {
    const s = model.state;
    const lo = s.lastOrder;
    const rep = lo ? S.repeatAction(env, s, t.id) : null;
    const label = lo ? S.orderLabel(lo) : "";
    return `<div class="g-row fd-orders">
      <button class="g-btn fd-toggle${t.auto ? " on" : ""}" data-act="auto" data-town="${t.id}" aria-pressed="${!!t.auto}"
        title="Auto: when you end the turn, this town builds its best improvement or project, links to other auto towns and spends spare materials on homesteaders and festivals. It keeps enough for the next settlers while you are still expanding. (A)">⚙ Auto ${t.auto ? "on" : "off"} <kbd>A</kbd></button>
      ${lo ? `<button class="g-btn" data-act="repeat" ${rep ? "" : "disabled"} title="Give ${esc(t.name)} the last order again (R)">↻ ${esc(label)} <kbd>R</kbd></button>` : ""}
    </div>`;
  }

  /** Homesteaders and festivals: turn spare materials into people or culture, once a turn each. */
  function spendPanel(t) {
    const s = model.state;
    const gc = S.growCost(t);
    const gWhy = S.growBlocker(env, s, t);
    const fWhy = S.festivalBlocker(s, t);
    return `<div class="g-row fd-spend">
      <button class="g-btn" data-act="grow" data-town="${t.id}" ${gWhy ? "disabled" : ""} title="${esc(gWhy || `+1 person now for ${gc} materials (once a turn)`)}">🧳 Homesteaders · ${gc} <small>+1 person</small></button>
      <button class="g-btn" data-act="festival" data-town="${t.id}" ${fWhy ? "disabled" : ""} title="${esc(fWhy || `+${S.RULES.festivalCulture} culture now (once a turn)`)}">🎉 Festival · ${S.RULES.festivalCost} <small>+${S.RULES.festivalCulture} culture</small></button>
    </div>`;
  }

  function projectsPanel(t) {
    const s = model.state;
    const rows = Object.values(S.PROJECTS).map((P) => {
      if (S.hasProject(t, P.id)) return `<li class="fd-proj done"><span>${P.icon} ${esc(P.name)}</span><span class="muted">✓ built</span></li>`;
      const why = S.projectBlocker(env, s, t, P.id, { noCost: true });
      if (why && /^Only in a town/.test(why)) return "";
      const cost = S.projectCost(s, P.id);
      const short = !why && s.materials < cost;
      return `<li class="fd-proj"><button class="g-btn" data-act="project" data-town="${t.id}" data-p="${P.id}" ${why || short ? "disabled" : ""}
        title="${esc(P.text)}${why ? ` (${esc(why)})` : ""}" aria-label="${esc(`${P.name}, ${cost} materials: ${P.text}`)}">${P.icon} ${esc(P.name)} · ${cost}</button>
        <small class="muted">${esc(why || P.text)}</small></li>`;
    }).join("");
    return `<h4 class="fd-h4">Projects <span class="muted">(one of each per town; each copy elsewhere costs 25% more)</span></h4><ul class="fd-projs">${rows}</ul>`;
  }

  function hexPanel(c, town) {
    const s = model.state;
    const own = S.owners(env, s)[c];
    let builds = "";
    if (own) {
      const owner = S.townById(s, own);
      if (s.improvements[c]) {
        builds = `<p>Has a <b>${esc(S.IMPROVEMENTS[s.improvements[c]].name.toLowerCase())}</b>.</p>`;
      } else if (!S.townAt(s, c)) {
        const opts = Object.values(S.IMPROVEMENTS).filter((I) => S.improvementFits(env.T, c, I.id)).map((I) => {
          const gain = [I.food ? `+${I.food} food` : "", I.materials ? `+${I.materials} materials` : "", I.trade ? `+${I.trade} trade` : ""].filter(Boolean).join(" ");
          const cost = S.improvementCost(s, I.id);
          return `<button class="g-btn" data-act="improve" data-cell="${c}" data-kind="${I.id}" ${s.materials < cost ? "disabled" : ""} title="${esc(I.rule)}" aria-label="${esc(`${I.name}, ${cost} materials, ${gain}`)}">${I.icon} ${I.name} · ${cost} <small>${gain}</small></button>`;
        }).join("");
        builds = opts ? `<div class="fd-builds">${opts}</div><p class="g-note">Each improvement of a kind you already own costs 12% more.</p>` : `<p class="g-note">Nothing to build here.</p>`;
      }
      const pinned = owner.pins?.includes(c);
      const pin = S.townAt(s, c) ? "" : `<button class="g-btn" data-act="pin" data-town="${owner.id}" data-cell="${c}">${pinned ? "Stop always working" : "Always work this hex"}</button>`;
      return `<div class="fd-card"><b>Hex in ${esc(owner.name)}'s border</b>${hexDetail(c)}${builds}${pin}</div>`;
    }
    void town;
    return `<div class="fd-card"><b>Outside your borders</b>${hexDetail(c)}<p class="g-note">Site value ${Math.round(S.siteScore(env, c))}${S.foundBlocker(env, s, c) ? "" : " · a party could found a town here"}</p></div>`;
  }

  function turnReport() {
    const r = model.state.lastTurn;
    if (!r || r.turn !== model.state.turn - 1) return "";
    const ev = (r.events || []).map((e) => `<div class="fd-event${e.bad ? " bad" : ""}"><b>${e.icon} ${esc(e.title)}</b><p>${esc(e.text)}</p>${e.rec ? `<p class="g-note">${esc(e.rec)}</p>` : ""}</div>`).join("");
    const bits = [];
    if (r.grew.length) bits.push(`${r.grew.map((g) => esc(g.name)).join(", ")} grew`);
    if (r.borders.length) bits.push(`${r.borders.map((g) => esc(g.name)).join(", ")} border grew`);
    if (r.shrank.length) bits.push(`<span class="fd-warn">${r.shrank.map((g) => esc(g.name)).join(", ")} starved</span>`);
    const auto = r.auto?.length ? `<p class="g-note">Auto: ${r.auto.map((a) => esc(a.text)).join(", ")}.</p>` : "";
    return `<h3 class="g-section">Last turn</h3><p>${r.income >= 0 ? "+" : ""}${r.income} materials${r.upkeep ? ` (after ${r.upkeep} upkeep)` : ""}, ${r.trade} trade${bits.length ? ` · ${bits.join(" · ")}` : ""}</p>${auto}${ev}`;
  }

  function townList() {
    const s = model.state;
    if (!s.towns.length && !s.parties.length) return "";
    const rows = s.towns.map((t) => {
      const o = S.townOutput(env, s, t);
      const arrow = o.surplus > 0 ? "▲" : o.surplus < 0 ? "▼" : "◆";
      const need = model.needs?.has(`town:${t.id}`);
      return `<li><button class="fd-li${model.selTown === t.id ? " on" : ""}" data-act="town" data-id="${t.id}">
        <b>${need ? `<span class="fd-need" title="Needs orders (N)">●</span> ` : ""}${esc(t.name)}${t.auto ? ` <small class="fd-auto" title="On auto">⚙</small>` : ""}</b><span>${t.pop} <small class="${o.surplus < 0 ? "fd-warn" : "muted"}">${arrow}</small></span>
        <span class="fd-li-y">${yl(o)}</span></button></li>`;
    }).join("");
    const allAuto = s.towns.length && s.towns.every((t) => t.auto);
    const autoAll = s.towns.length > 1 && s.phase === "play"
      ? `<button class="g-btn fd-autoall" data-act="autoall" data-on="${allAuto ? 0 : 1}" title="${allAuto ? "Take every town off auto" : "Put every town on auto: they spend for themselves when you end the turn"}">⚙ ${allAuto ? "All manual" : "All auto"}</button>` : "";
    const parties = s.parties.map((p, k) => `<li><button class="fd-li${model.selParty === p.id ? " on" : ""}" data-act="party-sel" data-id="${p.id}">
        <b>${model.needs?.has(`party:${p.id}`) ? `<span class="fd-need" title="Needs orders (N)">●</span> ` : ""}Founding party ${k + 1}</b><span class="muted">${p.moves} moves${p.target != null ? " · travelling" : ""}</span></button></li>`).join("");
    return `<h3 class="g-section fd-country">Your country ${autoAll}</h3><ul class="fd-list">${rows}${parties}</ul>`;
  }

  function logPanel() {
    const log = model.state.log.slice(-8).reverse();
    if (!log.length) return "";
    return `<details class="fd-log"><summary>Chronicle</summary><ul>${log.map((l) => `<li class="${l.bad ? "fd-warn" : ""}"><span class="muted">${S.yearOf(l.turn)}</span> ${esc(l.text)}</li>`).join("")}</ul></details>`;
  }

  function howItWorks() {
    const R_ = S.RULES;
    return `<details class="fd-how"><summary>How it works</summary>
      <p><b>Every hex's output comes from real data</b> (world.json land cover, relief, rivers and coast; resources.json sites). Hover a hex to see its sum.</p>
      <ul>
        <li><span class="fd-food">Food</span> = round(crop%÷25 + pasture%÷40 + grass%÷60 × relief) + river (big +2, other +1) + coast +1 + lake +1. Hills ×0.75, mountains ×0.4, peaks 0, barren ×0.3.</li>
        <li><span class="fd-mat">Materials</span> = round(forest%÷30 + scrub%÷100) + hills 1 / mountains 2 / peaks 1 + mine site 3, oil or gas play 2, hydro or geothermal 1.</li>
        <li><span class="fd-trade">Trade</span> = coast 2, river 1–2, lake 1, plus roads (+${R_.roadTrade}) and rail (+${R_.railTrade}) to your other towns.</li>
        <li>The country is empty: land built up today counts as the open land around it (the hex's own fields, forest or grass, and its neighbours'). Wetland costs 2 moves, mountains 2, peaks 3.</li>
      </ul>
      <p>Each person works one hex and eats ${R_.foodPerPop} food. Surplus food grows the town (${R_.growthBase} + ${R_.growthPerPop} × people). Culture (1 a turn + half the trade + schools and colleges) widens the border at ${R_.cultureR2}, ${R_.cultureR3} and ${R_.cultureR4}. Towns must be ${R_.minTownDist}+ hexes apart.</p>
      <p><span class="fd-mat">Materials</span> (town output plus a quarter of trade, minus upkeep of 1 per ${R_.upkeepPerPop} people and 1 per rail line) buy settlers, improvements, links and town projects. Everything gets dearer the more you own: settlers +8 per town, each improvement of a kind +12%, each copy of a project +25%. Spare materials can bring homesteaders (+1 person for ${R_.growBase} + ${R_.growPerPop} × people) or pay for a festival (+${R_.festivalCulture} culture for ${R_.festivalCost}), once a turn per town.</p>
      <p>Score: 10 a town, 4 a person, 1 per 5 trade ever earned, 2 an improvement, 3 a road (6 rail), 5 a project, 1 per 10 culture.</p>
      <p>Events are seeded; floods, storms, fires and winters strike where FEMA recorded them most (county declarations since 2000), droughts where NOAA counted billion-dollar droughts.</p>
      <p><b>Many towns?</b> Put a town on <b>Auto</b> (<kbd>A</kbd>, or "All auto" above the town list): when you end the turn it builds its best improvement or project, links to other auto towns and spends what is spare on homesteaders and festivals, keeping enough for the next settlers while you are still expanding. <kbd>R</kbd> repeats your last town order on the selected town; <kbd>N</kbd> jumps to the next party or town that needs orders (● in the list). End turn only stops you when a party is waiting or materials pile up unused.</p>
      <p>Keys: <kbd>Enter</kbd>/<kbd>E</kbd> end turn · <kbd>F</kbd> found · <kbd>N</kbd> next that needs orders · <kbd>Space</kbd> next party · <kbd>A</kbd> auto · <kbd>R</kbd> repeat order · <kbd>Y</kbd> yields · <kbd>H</kbd> how to play · <kbd>Esc</kbd> deselect.</p>
    </details>`;
  }

  function howToPlay() {
    return `<div class="fd-howto" role="note">
      <b>How to play</b>
      <ol>
        <li><b>Settle.</b> Pick a start, then found towns (<kbd>F</kbd>) on good land: food grows people, rivers and coasts bring trade.</li>
        <li><b>Grow.</b> Each person works one hex. Select a town to send settlers, build on its hexes, or buy projects.</li>
        <li><b>Spend.</b> Materials pay for everything, and prices rise the more you own. Never sit on a pile: spare materials buy homesteaders or festivals.</li>
        <li><b>Finish.</b> ${S.RULES.maxTurns} turns (1790–${S.yearOf(S.RULES.maxTurns) + S.RULES.yearsPerTurn}). Then the real cities come back and you see how close to history you built.</li>
      </ol>
      <p class="g-note">The teal line below always says a good next step. <kbd>Enter</kbd> ends the turn. With many towns, use Auto (<kbd>A</kbd>), Repeat (<kbd>R</kbd>) and Next (<kbd>N</kbd>).</p>
      <div class="g-row"><button class="g-btn primary" data-act="how">Got it</button>
        <button class="g-btn" data-act="tut-replay">Replay the tutorial</button></div>
    </div>`;
  }

  // --- tutorial: three steps, advanced by what the player does (or "Next step"), stored once finished or skipped ----
  const TUT = [
    {
      title: "Found your first town",
      text: (s) => s.phase === "setup"
        ? "Pick one of the four gold-ringed starts (or click any land hex, then Begin here). Your founding party appears there."
        : "Press F (or Found a town here) to found your first town. Good sites have food nearby and a river or coast for trade: hover hexes to see what they yield.",
      done: (s) => s.towns.length > 0,
    },
    {
      title: "Claim and build",
      text: () => "Your town claims the hexes in its teal border, and the border widens as culture grows. Click a hex inside it and build: a farmstead on farmland, a quarry in the hills, a dock on water. Or buy a project for the town.",
      done: (s, b) => s.stats.built > b.built,
    },
    {
      title: "End the turn",
      text: () => "Press End turn (Enter). Towns produce, grow and the year moves on four years. Later, with many towns, put them on Auto (A) and press N to jump to whatever needs orders.",
      done: (s, b) => s.turn > b.turn,
    },
  ];
  function tutAdvance(force) {
    const tut = model.tut, s = model.state;
    if (!tut || !s) return;
    if (s.phase === "over") { tutFinish(true); return; }
    tut.base ||= { built: s.stats.built, turn: s.turn };
    while (model.tut && (force || TUT[tut.step].done(s, tut.base))) {
      force = false;
      if (tut.step >= TUT.length - 1) { tutFinish(true); return; }
      tut.step++;
      tut.base = { built: s.stats.built, turn: s.turn };
      if (tut.step === 1 && model.selTown == null && s.towns[0]) model.selTown = s.towns[0].id;
    }
  }
  function tutFinish(completed) {
    model.tut = null;
    ctx.storage.set(TUT_KEY, { done: true });
    ctx.storage.set(HOWTO_KEY, true);
    ctx.toast(completed ? "Tutorial done. Replay it any time from How to play (H)." : "Tutorial skipped. Replay it any time from How to play (H).");
  }
  function tutorialCard() {
    const { step } = model.tut;
    const t = TUT[step];
    const dots = TUT.map((_, k) => `<span class="fd-tut-dot${k < step ? " done" : k === step ? " on" : ""}"></span>`).join("");
    return `<div class="fd-tut" role="note" aria-live="polite">
      <div class="fd-tut-head"><span class="fd-hint-k">Tutorial · ${step + 1} of ${TUT.length}</span><span class="fd-tut-dots" aria-hidden="true">${dots}</span></div>
      <b>${esc(t.title)}</b>
      <p>${esc(t.text(model.state))}</p>
      <div class="g-row"><button class="g-btn" data-act="tut-next">${step === TUT.length - 1 ? "Finish" : "Next step"}</button>
        <button class="g-btn fd-tut-skip" data-act="tut-skip">Skip tutorial</button></div>
    </div>`;
  }

  /** The headline for the end screen: how close to history, and how big. */
  function verdict(h, score) {
    const ratio = h.towns ? h.nearCount / h.towns : 0;
    const rank = score >= 2800 ? "a continental power" : score >= 1500 ? "a thriving republic" : score >= 500 ? "a growing territory" : "a frontier outpost";
    const head = ratio >= 0.5 ? "You think like history"
      : ratio >= 0.25 ? "Close to history"
      : h.nearCount > 0 ? "Your own America, with a nod to history"
      : "A country the map has never seen";
    const sub = ratio >= 0.5 ? `Half or more of your towns stand where America built its great cities. You built ${rank}.`
      : ratio >= 0.25 ? `A good share of your towns sit on the sites of real great cities. You built ${rank}.`
      : h.nearCount > 0 ? `Most of your towns are on land the real country left quieter. You built ${rank}.`
      : `None of your towns is near a top-${S.TOP_METROS} metro: an alternative America. You built ${rank}.`;
    return { head, sub, rank };
  }

  /** One or two real facts about the land you chose. */
  function facts(h) {
    const out = [];
    const best = h.near.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    if (best?.population) {
      out.push(`${esc(best.name)} stands ${best.dist === 0 ? "on the very hex of" : `${best.dist} hex${best.dist > 1 ? "es" : ""} from`} today's <b>${esc(best.metro)}</b>, the ${ordinal(best.rank)} largest metro: ${popShort(best.population)} people live there now.`);
    }
    if (h.landShare > 0 && h.popInside > 0) {
      const k = h.popShare / h.landShare;
      out.push(k >= 1.3
        ? `Your land is <b>${k.toFixed(1)}×</b> as crowded today as the average American hex: you found the places people still want to live.`
        : k <= 0.75
          ? `Your land holds only <b>${Math.round(k * 100)}%</b> of the people the average American hex holds today: the real country passed it by.`
          : `Your land is about as crowded today as the average American hex (${k.toFixed(2)}×).`);
    }
    if (h.gdpShare > 0 && h.popShare > 0 && out.length < 2) {
      out.push(`The real economy inside your borders is ${(h.gdpShare * 100).toFixed(1)}% of US GDP, from ${(h.popShare * 100).toFixed(1)}% of its people.`);
    }
    return out.slice(0, 2);
  }
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

  function shareText() {
    const s = model.state, h = model.history;
    const sc = S.prosperity(env, s).score;
    const v = verdict(h, sc);
    const n = S.nationOutput(env, s);
    return [
      `Founders · ${v.head}`,
      `🏛️ ${s.towns.length} towns · ${n.pop} people · score ${int(sc)} (${v.rank})`,
      `📍 ${h.nearCount}/${h.towns} towns on real top-${S.TOP_METROS} metro sites`,
      `👥 ${popShort(h.popInside)} real Americans live inside my borders today (${(h.popShare * 100).toFixed(1)}%)`,
      `Seed ${s.seed}: ${location.origin}${location.pathname}#play=founders~${encodeURIComponent(s.seed)}`,
    ].join("\n");
  }

  async function copyResult() {
    const text = shareText();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back below */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    ctx.toast(ok ? "Result copied: paste it anywhere" : "Could not copy: select the text below");
    if (!ok) { const pre = body.querySelector(".fd-share-text"); if (pre) pre.hidden = false; }
  }

  function endScreen() {
    const s = model.state;
    const h = model.history;
    const sc = S.prosperity(env, s);
    const pctS = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
    const near = h.near.map((x) => `<li>${esc(x.name)} → ${x.dist === 0 ? "on" : `${x.dist} hex${x.dist > 1 ? "es" : ""} from`} <b>${esc(x.metro)}</b> <span class="muted">(#${x.rank})</span></li>`).join("");
    const v = verdict(h, sc.score);
    const fx = facts(h).map((f) => `<li>${f}</li>`).join("");
    return `<div class="fd-endscreen">
      <p class="fd-kicker">You vs. history · ${S.yearOf(s.maxTurns) + S.RULES.yearsPerTurn}</p>
      <h3 class="fd-verdict">${esc(v.head)}</h3>
      <p class="fd-verdict-sub">${esc(v.sub)}</p>
      <div class="fd-end-stats">
        <div class="g-stat"><b>${s.towns.length}</b><span>Towns</span></div>
        <div class="g-stat"><b>${S.nationOutput(env, s).pop}</b><span>People</span></div>
        <div class="g-stat"><b>${int(sc.score)}</b><span>Score</span></div>
      </div>
      ${fx ? `<ul class="fd-facts">${fx}</ul>` : ""}
      <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button></div>
      <pre class="fd-share-text" hidden>${esc(shareText())}</pre>
      <div class="fd-res"><span class="fd-big">${h.nearCount}<small>/${h.towns}</small></span>
        <p>of your towns sit within ${S.NEAR_HEXES} hexes of one of the ${S.TOP_METROS} largest real metros.</p></div>
      ${near ? `<ul class="fd-near">${near}</ul>` : `<p class="g-note">None: you built a country the map has not seen.</p>`}
      <div class="fd-res"><span class="fd-big">${popShort(h.popInside)}</span>
        <p>real Americans live inside your borders today: ${pctS(h.popShare)} of ${popShort(h.popTotal)}.
        <span class="g-note">${h.hasCounties ? `Each county's population (${esc(h.vintage)}) spread evenly over its hexes.` : "County data did not load."}</span></p></div>
      <div class="fd-res"><span class="fd-big">${pctS(h.outputShare)}</span>
        <p>of the map's food, materials and trade comes from your land (${pctS(h.landShare)} of it). The real economy inside your borders is <b>${pctS(h.gdpShare)}</b> of US GDP
        (${compact(h.gdpInside)} of ${compact(h.gdpTotal)}). <span class="g-note">BEA metro GDP spread over each metro's hexes; GDP outside metro and micro areas is not counted.</span></p></div>
      ${h.metrosInside.length ? `<p>Top-${S.TOP_METROS} metros inside your borders: ${h.metrosInside.map(esc).join(", ")}.</p>` : ""}
      <p class="g-note">The real cities are back on the map, under your own towns (teal flags).</p>
      <div class="g-row">
        <button class="g-btn" data-act="reveal">${model.revealed ? "Hide real cities" : "Show real cities"}</button>
        <button class="g-btn" data-act="replay">Replay this seed</button>
        <button class="g-btn primary" data-act="new">New game</button>
      </div>
      <p class="g-note">Seed <code>${esc(s.seed)}</code>: share the link to play the same starts.</p>
    </div>`;
  }

  // Resume a finished game straight to its end screen.
  if (model.state.phase === "over") finish();
  else if (model.state.phase === "play") {
    const c = model.state.towns[0]?.cell ?? model.state.parties[0]?.cell;
    // After the host has framed the docked map.
    if (c != null) { const t = setTimeout(() => flyToCell(c, true), 1000); ctx.onCleanup(() => clearTimeout(t)); }
    if (model.state.parties.length && !model.state.towns.length) model.selParty = model.state.parties[0].id;
  }
  refresh();
  void COLORS;

  return {
    stop() {},
    onEscape() {
      if (model.selTown != null || model.selParty != null || model.selCell != null) {
        model.selTown = model.selParty = model.selCell = null;
        refresh();
      }
      return true; // stay in the game; leave with the ✕ in the panel
    },
    param: () => model.state?.seed || null,
  };
}
