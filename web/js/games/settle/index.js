// Settle (sim/settle.js): one region with its real cities hidden (Founders' cover layer paints the land as it would be
// without them); place five settlements where you think the most people live, then reveal the real map.
//   #play=settle            today's region (resumes after a reload)
//   #play=settle~p-<seed>   practice
// Saves: "d:<key>" = {sites, done}, "stats" = {played, best, last}. Online: the day's board (/api/settle/daily).
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import { prepareCover, coverLayer } from "../founders/render.js";
import * as S from "./sim/settle.js";

const utcKey = () => new Date().toISOString().slice(0, 10);
const MINE = "#ffd75e", PAR = "#8ff0a0";

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/settle.css");
  const body = ctx.dock("left", { width: 330, title: "Settle" });
  body.classList.add("st");
  body.innerHTML = `<p class="g-note">Clearing the map…</p>`;
  const counties = await ctx.loadData("counties");
  const hexmap = ctx.hexmap, grid = hexmap.grid;
  const E = S.settleEnv({ world: ctx.data.world, counties }, hexmap);
  const model = { cover: prepareCover(app.w, ctx.cities, null), revealed: false };

  // --- hide the real country (as Founders does) ------------------------------------------------------------------
  const toggledOff = new Set();
  let hidResources = false;
  function hide() {
    if (model.revealed) return;
    app.setCitiesHidden(true);
    try { for (const t of app.ui.mapToggles?.() || []) if (t.on && app.ui.setMapToggle(t.id, false)) toggledOff.add(t.id); } catch { /* none */ }
    if (app.state.showResources && app.w?.resources) { app.setShowResources?.(false); hidResources = true; }
    app.setLens?.(null);
    document.body.classList.remove("st-revealed");
  }
  function reveal() {
    model.revealed = true;
    app.setCitiesHidden(false);
    for (const id of toggledOff) app.ui.setMapToggle?.(id, true);
    toggledOff.clear();
    if (hidResources) { app.setShowResources?.(true); hidResources = false; }
    document.body.classList.add("st-revealed");
    app.invalidate?.();
  }
  ctx.on("extensions", () => hide());
  ctx.onCleanup(() => { model.revealed = true; reveal(); document.body.classList.remove("st-revealed"); });
  ctx.addLayer(coverLayer(model));

  let g = null; // {mode, key, seed, puzzle, par, sites: [cell], done, result}
  let hover = null;
  const online = { avail: false, status: "idle", res: null, board: null, err: null };
  const race = makeRace({ ctx, game: "settle", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => (p.score ? `${p.score}` : `${p.round}/5 placed`) });
  const region = () => S.regionById(g.puzzle.region);

  function newGame(mode, seedOrKey) {
    const puzzle = S.settlePuzzle(mode === "daily" ? S.dailySeed(seedOrKey) : S.practiceSeed(seedOrKey));
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, puzzle, par: S.parSites(E, puzzle), sites: [], done: false, result: null };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (saved && Array.isArray(saved.sites)) {
        for (const c of saved.sites.slice(0, S.SITES)) if (!S.siteProblem(E, puzzle, g.sites, c)) g.sites.push(c);
        if (saved.done && g.sites.length === S.SITES) { g.done = true; g.result = S.scoreSites(E, puzzle, g.sites, g.par); }
      }
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    if (g.done) reveal(); else { model.revealed = false; hide(); }
    frame();
    refresh();
    if (g.done && mode === "daily") postDaily();
  }
  function frame() {
    const cells = E.regionCells.get(g.puzzle.region);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cells) { const x = grid.cx(c), y = grid.cy(c); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    fitVisible(app, body, x0 - 60, y0 - 60, x1 + 60, y1 + 60, { maxScale: 1.4 });
  }
  const save = () => { if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, { sites: g.sites, done: g.done }); };
  const locked = () => !g || g.done || (race.active && g.mode !== "race");

  function click(cell) {
    if (locked() || cell == null || cell < 0) return;
    const at = g.sites.indexOf(cell);
    if (at >= 0) { g.sites.splice(at, 1); save(); refresh(); return; }
    // a click on a site's circle picks that site up
    const near = g.sites.findIndex((s) => hexmap.dist(s, cell) <= S.RADIUS);
    if (near >= 0) { g.sites.splice(near, 1); save(); refresh(); return; }
    if (g.sites.length >= S.SITES) { ctx.toast("Five settlements placed: click one to move it, or Reveal"); return; }
    const why = S.siteProblem(E, g.puzzle, g.sites, cell);
    if (why) { ctx.toast(why[0].toUpperCase() + why.slice(1)); return; }
    g.sites.push(cell);
    save();
    if (g.mode === "race") race.progress({ round: g.sites.length, score: 0 });
    refresh();
  }
  function finish() {
    if (locked() || g.sites.length !== S.SITES) return;
    const r = S.scoreSites(E, g.puzzle, g.sites, g.par);
    if (r.error) { ctx.toast(r.error); return; }
    g.done = true; g.result = r;
    save();
    reveal();
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, r.score); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ sites: g.sites });
    refresh();
  }

  // --- map ---------------------------------------------------------------------------------------------------------
  const hexRing = (c, cell, r) => {
    for (const k of hexmap.within(cell, r)) {
      const x = grid.cx(k), y = grid.cy(k);
      c.moveTo(x + grid.corners[0][0], y + grid.corners[0][1]);
      for (let i = 1; i < 6; i++) c.lineTo(x + grid.corners[i][0], y + grid.corners[i][1]);
      c.closePath();
    }
  };
  // Outside the region: dimmed (a rectangle with the region's hexes cut out, even-odd).
  ctx.addOverlay({
    id: "region", z: 90, space: "world", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const pad = 1e5;
      c.beginPath();
      c.rect(-pad, -pad, pad * 3, pad * 3);
      for (const k of E.regionCells.get(g.puzzle.region)) {
        const x = grid.cx(k), y = grid.cy(k);
        c.moveTo(x + grid.corners[0][0], y + grid.corners[0][1]);
        for (let i = 1; i < 6; i++) c.lineTo(x + grid.corners[i][0], y + grid.corners[i][1]);
        c.closePath();
      }
      c.fillStyle = "rgba(6,10,16,.6)";
      c.fill("evenodd");
    },
  });
  ctx.addOverlay({
    id: "sites", z: 96, space: "world", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const s = cam.scale;
      const draw = (cell, col, dashed) => {
        c.beginPath(); hexRing(c, cell, S.RADIUS);
        c.fillStyle = dashed ? "rgba(143,240,160,.12)" : "rgba(255,215,94,.22)"; c.fill();
        c.beginPath(); c.arc(grid.cx(cell), grid.cy(cell), grid.R * 2.4, 0, Math.PI * 2);
        c.strokeStyle = col; c.lineWidth = 3 / s; if (dashed) c.setLineDash([8 / s, 6 / s]); c.stroke(); c.setLineDash([]);
      };
      if (g.done) for (const p of g.par.sites) draw(p, PAR, true);
      for (const cell of g.sites) draw(cell, MINE, false);
      if (!locked() && hover != null && g.sites.length < S.SITES && !g.sites.some((x) => hexmap.dist(x, hover) <= S.RADIUS)) {
        const bad = S.siteProblem(E, g.puzzle, g.sites, hover);
        c.beginPath(); hexRing(c, hover, S.RADIUS);
        c.strokeStyle = bad ? "rgba(255,120,100,.8)" : "rgba(255,240,200,.9)"; c.lineWidth = 2 / s; c.stroke();
      }
    },
  });
  ctx.addOverlay({
    id: "site-labels", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g?.done || !g.result) return;
      c.font = "600 12px system-ui, sans-serif";
      const boxes = [];
      const label = (cell, text, col, dy) => {
        const [sx, sy] = cam.toScreen(grid.cx(cell), grid.cy(cell));
        const w = c.measureText(text).width + 12;
        const x = Math.min(cam.w - w - 4, Math.max(4, sx - w / 2));
        let y = sy + dy;
        // step down (or up, for par) past any label already drawn
        for (let k = 0; k < 6 && boxes.some((b) => x < b.x + b.w + 3 && b.x < x + w + 3 && y < b.y + 22 && b.y < y + 22); k++) y += dy > 0 ? 22 : -22;
        boxes.push({ x, y, w });
        c.fillStyle = "rgba(14,18,24,.9)"; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 19, 4) : c.rect(x, y, w, 19); c.fill();
        c.fillStyle = col; c.fillText(text, x + 6, y + 13.5);
      };
      g.sites.forEach((cell, i) => label(cell, S.peopleText(g.result.each[i]), MINE, 18));
      for (const p of g.par.sites) if (!g.sites.includes(p)) label(p, `par ${S.peopleText(Math.round(S.catchment(E, g.puzzle, p)))}`, PAR, -38);
    },
  });
  ctx.on("hover", (h) => {
    const cell = h?.cell ?? -1;
    const nh = cell >= 0 ? cell : null;
    if (nh !== hover) { hover = nh; if (!locked()) app.requestDraw?.(); }
  });
  ctx.on("mapclick", (ev) => { if (g && !locked()) click(ev.cell); return !!g && !g.done; });

  // --- online board -------------------------------------------------------------------------------------------------
  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !g.done || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/settle/daily", { key: g.key, sites: g.sites });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/settle/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same region for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first game today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="st-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="st-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.err ? `<p class="st-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  // --- panel ---------------------------------------------------------------------------------------------------------
  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.();
    const head = `<div class="st-head"><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</span></div>${race.active ? race.html() : ""}`;
    if (g.done) {
      const r = g.result, st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}<h3 class="st-final">${r.score} <small>points</small></h3>
        <p>Your five settlements reach <b>${S.peopleText(r.people)}</b> people; par (dashed green) reaches ${S.peopleText(r.par)}.</p>
        <ol class="st-list">${r.each.map((n) => `<li>${S.peopleText(n)}</li>`).join("")}</ol>
        <p class="g-note">The real cities are back on the map.</p>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice region</button><button class="g-btn" data-act="race-create" title="Race friends on the same region">Race friends</button>${g.mode !== "daily" ? `<button class="g-btn" data-act="daily">Today's region</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("settle") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}</p>` : ""}${how()}`;
      return;
    }
    body.innerHTML = `${head}<p class="st-q">Where do people live in <b>${esc(region().name)}</b>?</p>
      <p class="g-note">The real cities are hidden. Read the land (coasts, rivers, flat valleys) and place ${S.SITES} settlements where you think the most people are. Each one counts the people on its hex and the six around it.</p>
      <div class="st-count"><b>${g.sites.length}</b>/${S.SITES} placed</div>
      <div class="g-row"><button class="g-btn primary" data-act="finish" ${g.sites.length === S.SITES ? "" : "disabled"}>Reveal <kbd>⏎</kbd></button><button class="g-btn" data-act="undo" ${g.sites.length ? "" : "disabled"}>Undo <kbd>⌫</kbd></button></div>
      <p class="g-note">Click a settlement to pick it up. They must stand ${S.MIN_APART}+ hexes apart.</p>${how()}`;
  }
  const how = () => `<details class="st-how"><summary>How it works</summary><p>People per hex: each county's 2024 Census
    population, shared among its hexes by how much of each is developed land (NLCD). Par is the game's own placement:
    the most-peopled circle first, then the best one that keeps its distance, and so on. Matching par scores 1000. One
    region a day, the same for everyone.</p></details>`;
  const share = () => `Settle ${g.mode === "daily" ? g.key : "practice"} · ${region().name}\n${g.result.score} pts · ${S.peopleText(g.result.people)} people (par ${S.peopleText(g.result.par)}) ${g.result.score >= 1000 ? "🟩" : g.result.score >= 800 ? "🟨" : g.result.score >= 500 ? "🟧" : "🟥"}`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "finish": finish(); break;
      case "undo": if (!locked() && g.sites.length) { g.sites.pop(); save(); refresh(); } break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=settle`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || model.revealed) return false;
    if (k === "r" || k === "R" || k === "l" || k === "L" || k === "/") return true; // resources, lenses, search would show real places
    if (k === "Backspace" && !locked() && g.sites.length) { g.sites.pop(); save(); refresh(); return true; }
    if (k === "Enter" && e.target?.tagName !== "BUTTON") { finish(); return true; }
    return false;
  });

  app.settle = { get g() { return g; }, click: (c) => click(c), finish: () => finish(), E, S }; // debugging handle
  ctx.onCleanup(() => { delete app.settle; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  hide();
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g) frame(); }, 900); ctx.onCleanup(() => clearTimeout(t)); }
  const offPlayer = net.onPlayer?.(() => { if (g?.done) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g?.done && g.mode === "daily") postDaily(); else refresh(); });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
