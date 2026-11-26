// Founders: settle an empty America on its real terrain, then compare your country with the real one.
// The rules live in ./sim (pure, tested in tests/js/founders.test.mjs); this file is the UI around them: a dock
// panel, map clicks and keys, saves, and the end screen. Map art is in ./render.js.
//
// Host needs (all through ctx and the documented app API; nothing in host.js changed):
//   * Real cities are hidden while playing: the "cover" layer paints plain terrain over city tiles, and
//     app.setCitiesHidden(true) switches off the city banners and every non-game tooltip (restored on exit and at
//     the end, when the real cities are revealed). Map-layer toggles that would show real places (roads, rail, ports…) are switched off and
//     restored on exit, and the lens dock is hidden by founders.css.
import { loadCss } from "../shared/css.js";
import * as S from "./sim/index.js";
import { prepareCover, prepareLand, coverLayer, landLayer, yieldsLayer, townsLayer, makeOverlay, COLORS } from "./render.js";
import { esc, int, popShort, compact } from "../../format.js";

const SAVE_KEY = "save";
const SAVE_V = 1;

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
    cover: prepareCover(app.w, ctx.cities),
  };

  // --- hide the real country while playing -----------------------------------------------------------------------
  app.setCitiesHidden(true);
  ctx.onCleanup(() => { app.setCitiesHidden(false); app.invalidate?.(); });
  // Map-layer toggles (roads, rail, ports…) and resource icons (power plants are built by people) would give the
  // real country away. Extensions may register toggles after the game starts, so this runs again on refresh and on
  // data arrivals; whatever it switched off is switched back on at exit.
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
  ctx.on("data", () => setTimeout(enforceHidden, 0));
  for (const ms of [0, 300, 1000, 2500, 5000]) {
    const t = setTimeout(enforceHidden, ms);
    ctx.onCleanup(() => clearTimeout(t));
  }

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
    if (model.revealed) { model.revealed = false; app.setCitiesHidden(true); }
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
    const r = act({ type: "end" });
    if (!r.ok) return;
    const rep = model.state.lastTurn;
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
  }

  function reveal(on) {
    model.revealed = on;
    app.setCitiesHidden(!on);
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

  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (document.querySelector(".modal:not([hidden])")) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "Enter" || k === "e") {
      if (k === "Enter" && e.target?.tagName === "BUTTON") return; // the button handles its own Enter
      e.preventDefault();
      endTurn();
    } else if (k === "f") { e.preventDefault(); found(); }
    else if (k === " " || k === "n") { e.preventDefault(); nextParty(); }
    else if (k === "y") { model.showYields = !model.showYields; refresh(); }
  }
  window.addEventListener("keydown", onKey);
  ctx.onCleanup(() => window.removeEventListener("keydown", onKey));

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
      case "party": {
        const r = act({ type: "party", town: +d.town });
        if (r.ok) { model.selParty = model.state.parties.at(-1).id; model.selTown = null; }
        break;
      }
      case "improve": act({ type: "improve", cell: +d.cell, kind: d.kind }); break;
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
    body.innerHTML = `
      <div class="fd-top">
        <div class="fd-year"><b>${year}</b><span>Turn ${s.turn} of ${s.maxTurns}</span></div>
        <div class="fd-stats">
          <div class="g-stat" title="Materials in store (income per turn: town materials plus a quarter of trade)"><b class="fd-mat">${int(s.materials)}</b><span>Materials +${n.income}</span></div>
          <div class="g-stat" title="Population across your towns"><b>${n.pop}</b><span>People</span></div>
          <div class="g-stat" title="Trade per turn (culture, wealth and score)"><b class="fd-trade">${n.trade}</b><span>Trade</span></div>
          <div class="g-stat" title="Prosperity score"><b>${int(score)}</b><span>Score</span></div>
        </div>
      </div>
      <div class="fd-hint" role="status">${esc(hint)}</div>
      <div class="g-row fd-actions">
        <button class="g-btn primary fd-end" data-act="end" ${s.phase !== "play" ? "disabled" : ""} title="End the turn (Enter or E)">End turn <kbd>⏎</kbd></button>
        <button class="g-btn" data-act="nextparty" ${s.parties.some((p) => p.moves > 0) ? "" : "disabled"} title="Next founding party (Space or N)">Next party</button>
        <button class="g-btn fd-toggle${model.showYields ? " on" : ""}" data-act="yields" title="Show yields on the map when zoomed in (Y)" aria-pressed="${model.showYields}">Yields</button>
      </div>
      <div class="fd-sel">${selectionPanel()}</div>
      ${turnReport()}
      ${townList()}
      ${logPanel()}
      ${howItWorks()}
      <div class="fd-foot g-row">
        <span class="g-note">Seed <code>${esc(s.seed)}</code></span>
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
    const need = S.growthNeed(t.pop);
    const nextR = t.radius === 1 ? S.RULES.cultureR2 : t.radius === 2 ? S.RULES.cultureR3 : null;
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
      <p>Culture <b>${t.culture}</b> · border radius ${t.radius}${nextR ? ` (grows at ${nextR})` : " (full)"} · works ${o.worked.length} of ${o.tiles.length} hexes</p>
      <div class="fd-row"><span class="g-note">Focus</span> ${foci}</div>
      <div class="g-row"><button class="g-btn primary" data-act="party" data-town="${t.id}" ${canParty ? "" : "disabled"}
        title="Costs ${cost} materials and 1 person" aria-label="Send settlers: ${cost} materials and 1 person">Send settlers · ${cost}</button>
        ${t.pop < 2 ? `<span class="g-note">needs 2 people</span>` : ""}</div>
      ${links ? `<h4 class="fd-h4">Links (+${S.RULES.roadTrade} trade each end; rail +${S.RULES.railTrade} from turn ${S.RULES.railTurn})</h4><ul class="fd-links">${links}</ul>` : ""}
      <p class="g-note">Click a hex inside the border to build on it, or to always work it. White dots mark worked hexes.</p>`;
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
          return `<button class="g-btn" data-act="improve" data-cell="${c}" data-kind="${I.id}" ${s.materials < I.cost ? "disabled" : ""} title="${esc(I.rule)}" aria-label="${esc(`${I.name}, ${I.cost} materials, ${gain}`)}">${I.icon} ${I.name} · ${I.cost} <small>${gain}</small></button>`;
        }).join("");
        builds = opts ? `<div class="fd-builds">${opts}</div>` : `<p class="g-note">Nothing to build here.</p>`;
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
    return `<h3 class="g-section">Last turn</h3><p>+${r.income} materials, ${r.trade} trade${bits.length ? ` · ${bits.join(" · ")}` : ""}</p>${ev}`;
  }

  function townList() {
    const s = model.state;
    if (!s.towns.length && !s.parties.length) return "";
    const rows = s.towns.map((t) => {
      const o = S.townOutput(env, s, t);
      const arrow = o.surplus > 0 ? "▲" : o.surplus < 0 ? "▼" : "◆";
      return `<li><button class="fd-li${model.selTown === t.id ? " on" : ""}" data-act="town" data-id="${t.id}">
        <b>${esc(t.name)}</b><span>${t.pop} <small class="${o.surplus < 0 ? "fd-warn" : "muted"}">${arrow}</small></span>
        <span class="fd-li-y">${yl(o)}</span></button></li>`;
    }).join("");
    const parties = s.parties.map((p, k) => `<li><button class="fd-li${model.selParty === p.id ? " on" : ""}" data-act="party-sel" data-id="${p.id}">
        <b>Founding party ${k + 1}</b><span class="muted">${p.moves} moves${p.target != null ? " · travelling" : ""}</span></button></li>`).join("");
    return `<h3 class="g-section">Your country</h3><ul class="fd-list">${rows}${parties}</ul>`;
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
        <li>Developed land is ignored (the country is empty). Wetland costs 2 moves, mountains 2, peaks 3.</li>
      </ul>
      <p>Each person works one hex and eats ${R_.foodPerPop} food. Surplus food grows the town (${R_.growthBase} + ${R_.growthPerPop} × people). Culture (1 a turn + half the trade) widens the border at ${R_.cultureR2} and ${R_.cultureR3}. Materials (plus a quarter of trade) build settlers, improvements and links. Towns must be ${R_.minTownDist}+ hexes apart.</p>
      <p>Events are seeded; floods, storms, fires and winters strike where FEMA recorded them most (county declarations since 2000), droughts where NOAA counted billion-dollar droughts.</p>
      <p>Keys: <kbd>Enter</kbd>/<kbd>E</kbd> end turn · <kbd>F</kbd> found · <kbd>Space</kbd>/<kbd>N</kbd> next party · <kbd>Y</kbd> yields · <kbd>Esc</kbd> deselect.</p>
    </details>`;
  }

  function endScreen() {
    const s = model.state;
    const h = model.history;
    const sc = S.prosperity(env, s);
    const pctS = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
    const near = h.near.map((x) => `<li>${esc(x.name)} → ${x.dist === 0 ? "on" : `${x.dist} hex${x.dist > 1 ? "es" : ""} from`} <b>${esc(x.metro)}</b> <span class="muted">(#${x.rank})</span></li>`).join("");
    return `<div class="fd-end">
      <h3 class="g-section">You vs. history</h3>
      <p>${S.yearOf(s.maxTurns) + S.RULES.yearsPerTurn}: after ${s.maxTurns} turns you lead <b>${s.towns.length} towns</b> and <b>${S.nationOutput(env, s).pop} people</b>. Prosperity score <b>${int(sc.score)}</b>.</p>
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
