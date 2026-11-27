// Rail Link (sim/link.js): join five real metros with the cheapest rail network you can. Click a metro (or your own
// track) to start from it, then click anywhere: the cheapest track from there to the click is laid (your own track is
// free to reuse), and the click becomes the next starting point. Junctions in the right places beat par.
//   #play=link            today's puzzle (resumes after a reload)
//   #play=link~p-<seed>   practice
// Saves: "d:<key>" = {segs, done}, "stats" = {played, best, last}. Online: the day's board (/api/link/daily).
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as K from "./sim/link.js";

const utcKey = () => new Date().toISOString().slice(0, 10);
const TRACK = "#ffb347", PAR = "#8ff0a0", TERM = "#ffd75e";

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/link.css");
  const body = ctx.dock("left", { width: 330, title: "Rail Link" });
  body.classList.add("lk");
  body.innerHTML = `<p class="g-note">Surveying the terrain…</p>`;
  const infrastructure = ctx.data.infrastructure || (await ctx.loadData("infrastructure"));
  const hexmap = ctx.hexmap, grid = hexmap.grid;
  const L = K.linkEnv({ world: ctx.data.world, infrastructure }, hexmap);
  const pool = K.linkPool(ctx.cities, L);
  const cityById = ctx.cityById;

  // g = {mode, key, seed, puzzle, par, segs: [[[a, b]…]…], anchor: cell | null, done, result}
  let g = null;
  let hover = null, preview = null; // preview = {cells, add (credits)} from the anchor to the hovered hex
  const online = { avail: false, status: "idle", res: null, board: null, err: null };
  const race = makeRace({ ctx, game: "link", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => (p.score ? `${p.score}` : `${p.round}/5 joined`) });

  const edges = () => g.segs.flat();
  const freeKeys = () => { const s = new Set(); for (const [a, b] of edges()) s.add(a < b ? a * 65536 + b : b * 65536 + a); return s; };
  const onNetwork = () => { const s = new Set(); for (const [a, b] of edges()) { s.add(a); s.add(b); } return s; };
  const cost = () => K.networkCost(L, edges()).cost || 0;
  const joined = () => (edges().length ? K.connectedCount(g.puzzle.cells, edges()) : 1);
  const termAt = (cell) => g.puzzle.cells.indexOf(cell);

  function newGame(mode, seedOrKey) {
    const puzzle = K.linkPuzzle(pool, L, mode === "daily" ? K.dailySeed(seedOrKey) : K.practiceSeed(seedOrKey));
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, puzzle, par: K.parNetwork(L, puzzle.cells), segs: [], anchor: null, done: false, result: null };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (saved && Array.isArray(saved.segs) && !K.networkCost(L, saved.segs.flat()).error) {
        g.segs = saved.segs;
        if (saved.done) { const r = K.scoreNetwork(L, puzzle, edges(), g.par); if (!r.error) { g.done = true; g.result = r; } }
      }
    }
    hover = null; preview = null;
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    app.setHighlight?.({ cities: new Set(puzzle.ids), color: TERM, dimOthers: false });
    frame();
    refresh();
    if (g.done && mode === "daily") postDaily();
  }
  function frame() {
    const xs = g.puzzle.cells.map((c) => grid.cx(c)), ys = g.puzzle.cells.map((c) => grid.cy(c));
    fitVisible(app, body, Math.min(...xs) - 180, Math.min(...ys) - 180, Math.max(...xs) + 180, Math.max(...ys) + 180, { maxScale: 1.2 });
  }
  const save = () => { if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, { segs: g.segs, done: g.done }); };
  const locked = () => !g || g.done || (race.active && g.mode !== "race");

  function routeTo(cell) {
    const { prev, dist } = K.dijkstra(L, [g.anchor], { free: freeKeys(), target: cell });
    if (!(dist[cell] < Infinity)) return null;
    const cells = K.pathTo(prev, cell);
    const have = freeKeys();
    let add = 0;
    const segEdges = [];
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i];
      if (have.has(a < b ? a * 65536 + b : b * 65536 + a)) continue;
      segEdges.push([a, b]);
      add += K.edgeCost(L, a, b);
    }
    return { cells, segEdges, add: Math.round(add * 10) / 10 };
  }
  function click(cell) {
    if (locked() || cell == null || cell < 0) return;
    if (g.anchor == null) {
      // a click near a metro or your track starts there (the nearest within two hexes)
      const net = onNetwork();
      const ok = (c) => termAt(c) >= 0 || net.has(c);
      const near = ok(cell) ? cell : hexmap.within(cell, 2, ok).sort((a, b) => hexmap.dist(cell, a) - hexmap.dist(cell, b) || a - b)[0];
      if (near != null) { g.anchor = near; refresh(); }
      else ctx.toast("Start from one of the five metros (gold) or from your own track");
      return;
    }
    if (cell === g.anchor) { g.anchor = null; preview = null; refresh(); return; }
    const r = routeTo(cell);
    if (!r) { ctx.toast("No way to build there (open sea or across the border)"); return; }
    if (r.segEdges.length) g.segs.push(r.segEdges);
    g.anchor = cell;
    preview = null;
    save();
    if (g.mode === "race") race.progress({ round: joined(), score: 0 });
    refresh();
  }
  function undo() {
    if (locked() || !g.segs.length) return;
    const seg = g.segs.pop();
    g.anchor = seg[0][0];
    preview = null;
    save();
    refresh();
  }
  function clearAll() { if (locked()) return; g.segs = []; g.anchor = null; preview = null; save(); refresh(); }
  function finish() {
    if (locked() || joined() < K.TERMINALS) return;
    const r = K.scoreNetwork(L, g.puzzle, edges(), g.par);
    if (r.error) { ctx.toast(r.error); return; }
    g.done = true; g.result = r; g.anchor = null; preview = null;
    save();
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, r.score); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ edges: edges() });
    refresh();
  }

  // --- map --------------------------------------------------------------------------------------------------------
  const line = (c, pairs) => { c.beginPath(); for (const [a, b] of pairs) { c.moveTo(grid.cx(a), grid.cy(a)); c.lineTo(grid.cx(b), grid.cy(b)); } };
  ctx.addOverlay({
    id: "track", z: 95, space: "world", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const s = cam.scale;
      c.lineCap = "round";
      if (g.done) { // par under yours
        line(c, g.par.edges);
        c.strokeStyle = "rgba(10,10,10,.5)"; c.lineWidth = 6 / s; c.setLineDash([9 / s, 7 / s]); c.stroke();
        c.strokeStyle = PAR; c.lineWidth = 3 / s; c.stroke(); c.setLineDash([]);
      }
      const es = edges();
      if (es.length) {
        line(c, es);
        c.strokeStyle = "rgba(20,12,4,.75)"; c.lineWidth = 8 / s; c.stroke();
        c.strokeStyle = TRACK; c.lineWidth = 4.5 / s; c.stroke();
      }
      if (preview && preview.cells.length > 1) {
        c.beginPath();
        preview.cells.forEach((cell, i) => (i ? c.lineTo(grid.cx(cell), grid.cy(cell)) : c.moveTo(grid.cx(cell), grid.cy(cell))));
        c.strokeStyle = "rgba(255,240,200,.9)"; c.lineWidth = 3 / s; c.setLineDash([7 / s, 6 / s]); c.stroke(); c.setLineDash([]);
      }
      const r = Math.max(6 / s, grid.R * 0.45);
      for (const cell of g.puzzle.cells) {
        c.fillStyle = TERM; c.strokeStyle = "#3a2a08"; c.lineWidth = 2.5 / s;
        c.beginPath(); c.rect(grid.cx(cell) - r, grid.cy(cell) - r, r * 2, r * 2); c.fill(); c.stroke();
      }
      if (g.anchor != null) {
        c.strokeStyle = "#fff"; c.lineWidth = 3 / s;
        c.beginPath(); c.arc(grid.cx(g.anchor), grid.cy(g.anchor), r * 1.7, 0, Math.PI * 2); c.stroke();
      }
    },
  });
  ctx.addOverlay({
    id: "names", z: 100, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      c.font = "600 12.5px system-ui, sans-serif";
      g.puzzle.cells.forEach((cell, i) => {
        const [sx, sy] = cam.toScreen(grid.cx(cell), grid.cy(cell));
        const text = cityById.get(g.puzzle.ids[i])?.name || "";
        const w = c.measureText(text).width + 12;
        const x = Math.min(cam.w - w - 4, Math.max(4, sx - w / 2)), y = sy + 13;
        c.fillStyle = "rgba(14,18,24,.88)"; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 19, 4) : c.rect(x, y, w, 19); c.fill();
        c.fillStyle = TERM; c.fillText(text, x + 6, y + 13.5);
      });
    },
  });
  ctx.addOverlay({
    id: "cost", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g || !preview || hover == null) return;
      const [sx, sy] = cam.toScreen(grid.cx(hover), grid.cy(hover));
      const text = preview.add ? `+${preview.add} cr · ${K.dollars(preview.add)}` : "on your track (free)";
      c.font = "600 12px system-ui, sans-serif";
      const w = c.measureText(text).width + 12;
      // above and to the left of the pointer: the map's own tooltip opens below and to the right
      const x = Math.max(4, sx - w - 10), y = Math.max(4, sy - 32);
      c.fillStyle = "rgba(14,18,24,.9)"; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 20, 4) : c.rect(x, y, w, 20); c.fill();
      c.fillStyle = "#ffe2b0"; c.fillText(text, x + 6, y + 14);
    },
  });
  ctx.on("hover", (h) => {
    if (!g || locked() || g.anchor == null) { if (preview) { preview = null; app.requestDraw?.(); } return; }
    const cell = h?.cell ?? -1;
    if (cell === hover) return;
    hover = cell >= 0 ? cell : null;
    preview = hover != null && hover !== g.anchor ? routeTo(hover) : null;
    app.requestDraw?.();
  });
  ctx.on("mapclick", (ev) => { if (g && !locked()) click(ev.cell); return !!g && !g.done; });

  // --- online board -----------------------------------------------------------------------------------------------
  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !g.done || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/link/daily", { key: g.key, edges: edges() });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/link/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same five metros for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first network today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="lk-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="lk-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.status === "sending" ? `<p class="g-note">Checking your network…</p>` : ""}${online.err ? `<p class="lk-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  // --- panel ------------------------------------------------------------------------------------------------------
  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.();
    const names = g.puzzle.ids.map((id) => cityById.get(id)?.name || id);
    const head = `<div class="lk-head"><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</span><span class="g-note">Par ${g.par.cost} cr · ${K.dollars(g.par.cost)}</span></div>${race.active ? race.html() : ""}`;
    const list = `<ul class="lk-metros">${names.map((n) => `<li>▪ ${esc(n)}</li>`).join("")}</ul>`;
    if (g.done) {
      const r = g.result, st = ctx.storage.get("stats", null);
      const vs = r.cost < r.par ? `${Math.round((1 - r.cost / r.par) * 1000) / 10}% under par!` : r.cost === r.par ? "exactly par" : `${Math.round((r.cost / r.par - 1) * 1000) / 10}% over par`;
      body.innerHTML = `${head}<h3 class="lk-final">${r.score} <small>points</small></h3>
        <p>Your network: <b>${r.cost} cr</b> (${K.dollars(r.cost)}), ${vs}. <span class="g-note">Par (dashed green) ${r.par} cr.</span></p>
        ${list}
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice puzzle</button><button class="g-btn" data-act="race-create" title="Race friends on the same five metros">Race friends</button>${g.mode !== "daily" ? `<button class="g-btn" data-act="daily">Today's puzzle</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("link") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}</p>` : ""}${how()}`;
      return;
    }
    const c = cost(), j = joined();
    const est = j === K.TERMINALS ? K.scoreFor(g.par.cost, c) : null;
    body.innerHTML = `${head}<p class="lk-q">Join all five metros by rail, as cheaply as you can.</p>${list}
      <div class="lk-stats"><div class="g-stat"><b>${c}</b><span>cr spent</span></div><div class="g-stat"><b>${j}/${K.TERMINALS}</b><span>joined</span></div><div class="g-stat"><b>${est ?? "–"}</b><span>score</span></div></div>
      <p class="g-note lk-hint">${g.anchor == null ? "Click a gold metro (or your track) to build from it." : `Building from ${termAt(g.anchor) >= 0 ? esc(names[termAt(g.anchor)]) : "your track"}: click anywhere to lay the cheapest track there. Click the start again (or Esc) to stop.`}</p>
      <div class="g-row"><button class="g-btn primary" data-act="finish" ${j === K.TERMINALS ? "" : "disabled"}>Finish <kbd>⏎</kbd></button><button class="g-btn" data-act="undo" ${g.segs.length ? "" : "disabled"}>Undo <kbd>⌫</kbd></button><button class="g-btn" data-act="clear" ${g.segs.length ? "" : "disabled"}>Clear</button></div>
      ${how()}`;
  }
  const how = () => `<details class="lk-how"><summary>How it works</summary><p>Costs are Mainline's: each link between
    two hexes costs credits for its relief, land cover and river crossings (1 cr ≈ $20M); real rail lines are upgrades at
    about half price, so following them pays. Track you already own is free to route along, so a junction in the right
    place serves two metros at once. Par is the game's own good network; matching it scores 1000, 10% over scores 751,
    and a cheaper one scores more. One puzzle a day, the same for everyone.</p></details>`;
  const share = () => `Rail Link ${g.mode === "daily" ? g.key : "practice"} · ${g.result.score} pts\n${g.result.cost} cr vs par ${g.result.par} ${g.result.cost <= g.result.par ? "🟩" : g.result.score >= 750 ? "🟨" : "🟧"}`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "finish": finish(); break;
      case "undo": undo(); break;
      case "clear": clearAll(); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=link`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || g.done) return false;
    if (k === "Backspace" || k === "z") { undo(); return true; }
    if (k === "Enter" && e.target?.tagName !== "BUTTON") { finish(); return true; }
    return false;
  });

  app.link = { get g() { return g; }, click: (c) => click(c), finish: () => finish(), K, L }; // debugging handle
  ctx.onCleanup(() => { delete app.link; app.setHighlight?.(null); });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g) frame(); }, 900); ctx.onCleanup(() => clearTimeout(t)); } // after the dock lays out
  const offPlayer = net.onPlayer?.(() => { if (g?.done) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g?.done && g.mode === "daily") postDaily(); else refresh(); });
  return {
    stop() {},
    onEscape: () => { if (g && g.anchor != null) { g.anchor = null; preview = null; refresh(); } return true; },
    param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null),
  };
}
