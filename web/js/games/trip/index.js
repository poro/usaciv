// Road Trip: a daily routing puzzle (sim/trip.js). Leave the start metro, visit six others in the order you choose,
// and come home; the shorter your loop against the best possible one, the more points.
//   #play=trip            today's trip (the same for everyone; resumes after a reload)
//   #play=trip~p-<seed>   a practice trip
// Saves (ctx.storage): "d:<key>" = today's order, "stats" = {played, best, last}. Online: the day's board
// (docs/MULTIPLAYER.md "Road Trip daily"); the server rebuilds the trip and scores the order.
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { mapImage, downloadBlob } from "../shared/shareimg.js";
import { net } from "../shared/net.js";
import { esc } from "../../format.js";
import * as T from "./sim/trip.js";

const utcKey = () => new Date().toISOString().slice(0, 10);
const kmFmt = (n) => `${Math.round(n).toLocaleString("en-US")} km`;

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/trip.css");
  const body = ctx.dock("left", { width: 330, title: "Road Trip" });
  body.classList.add("tr");
  const pool = T.tripPool(ctx.cities);
  const grid = ctx.hexmap.grid;
  app.setCitiesHidden(true); // our own labels name the stops; the banners would only clutter
  ctx.onCleanup(() => { app.setCitiesHidden(false); app.setHighlight?.(null); app.invalidate?.(); });

  // g = {mode, key, seed, trip, order: [stop ids], done}
  let g = null;
  let hover = null;
  const online = { avail: false, status: "idle", res: null, board: null, err: null };

  // Races (shared/race.js): everyone plays the same practice seed; the room scores the result.
  const race = makeRace({ ctx, game: "trip", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => (p.done ? `${p.score}` : `${p.round}/6 stops`) });
  function newGame(mode, seedOrKey) {
    const trip = T.tripFor(pool, mode === "daily" ? T.dailySeed(seedOrKey) : `trip-practice:${seedOrKey}`);
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, trip, order: [], done: false, result: null };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved) && saved.every((id) => trip.stops.some((s) => s.id === id))) g.order = saved.slice(0, T.STOPS);
      if (g.order.length === T.STOPS) finish({ quiet: true });
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    highlight();
    frame();
    refresh();
  }
  const stopById = (id) => g.trip.stops.find((s) => s.id === id);

  function highlight() {
    const cells = new Set([g.trip.start, ...g.trip.stops].flatMap((m) => m.footprint));
    app.setHighlight?.({ cells, color: "#ffd75e", dimOthers: false });
  }
  function frame() {
    const ms = [g.trip.start, ...g.trip.stops];
    const pad = 160;
    fitVisible(app, body, Math.min(...ms.map((m) => m.x)) - pad, Math.min(...ms.map((m) => m.y)) - pad, Math.max(...ms.map((m) => m.x)) + pad, Math.max(...ms.map((m) => m.y)) + pad, { maxScale: 1.2 });
  }

  function pick(id) {
    if (!g || g.done || g.order.includes(id) || !stopById(id) || (race.active && g.mode !== "race")) return;
    g.order.push(id);
    save();
    if (g.mode === "race") race.progress({ round: g.order.length, score: 0 });
    if (g.order.length === T.STOPS) finish();
    else refresh();
  }
  function undo() {
    if (!g || g.done || !g.order.length) return;
    g.order.pop();
    save();
    refresh();
  }
  const save = () => { if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.order); };
  function finish({ quiet = false } = {}) {
    g.done = true;
    g.result = T.scoreTrip(g.trip, g.order);
    if (g.mode === "race" && !quiet) race.finish({ order: g.order });
    if (g.mode === "daily" && !quiet) {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, g.result.points); ctx.storage.set("stats", st); }
    }
    refresh();
    if (g.mode === "daily") postDaily();
  }

  // The stop nearest a map point, if within 2.5 hexes of its centre (or the click is in its footprint).
  function stopAt(cell) {
    if (cell == null || cell < 0) return null;
    const x = grid.cx(cell), y = grid.cy(cell);
    let best = null, bd = grid.R * 2.5 * 1.8;
    for (const s of g.trip.stops) {
      if (g.order.includes(s.id)) continue;
      if (s.footprint.includes(cell)) return s;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // --- map -----------------------------------------------------------------------------------------------------
  function path(c, ms) {
    c.beginPath();
    c.moveTo(ms[0].x, ms[0].y);
    for (const m of ms.slice(1)) c.lineTo(m.x, m.y);
  }
  const myOverlays = []; // also drawn into the share image
  const addOv = (o) => { myOverlays.push(o); ctx.addOverlay(o); };
  addOv({
    id: "route", z: 95, space: "world", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const s = cam.scale;
      const st = g.trip.start;
      const yours = [st, ...g.order.map(stopById)];
      if (g.done) yours.push(st);
      else if (hover && g.order.length < T.STOPS) {
        const h = stopAt(hover);
        if (h) yours.push(h);
      }
      if (yours.length > 1) {
        path(c, yours);
        c.strokeStyle = "rgba(10,10,10,.6)"; c.lineWidth = 7 / s; c.stroke();
        c.strokeStyle = "#ffb347"; c.lineWidth = 4 / s; c.stroke();
      }
      if (g.done) { // the best loop on top of yours
        path(c, [st, ...g.trip.best.order.map(stopById), st]);
        c.strokeStyle = "rgba(10,10,10,.55)"; c.lineWidth = 5 / s; c.setLineDash([10 / s, 7 / s]); c.stroke();
        c.strokeStyle = "#8ff0a0"; c.lineWidth = 3 / s; c.stroke(); c.setLineDash([]);
      }
      const r = Math.max(7 / s, grid.R * 0.42);
      c.fillStyle = "#ffd75e"; c.strokeStyle = "#3a2a08"; c.lineWidth = 2.5 / s;
      c.beginPath(); c.rect(st.x - r, st.y - r, r * 2, r * 2); c.fill(); c.stroke();
      for (const p of g.trip.stops) {
        const k = g.order.indexOf(p.id);
        c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fillStyle = k >= 0 ? "#ffb347" : "#fff4dc"; c.fill(); c.stroke();
      }
    },
  });
  addOv({
    id: "labels", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      c.font = "600 12.5px system-ui, sans-serif";
      const items = [[g.trip.start, "⌂"], ...g.trip.stops.map((p) => [p, g.order.includes(p.id) ? String(g.order.indexOf(p.id) + 1) : ""])];
      for (const [m, tag] of items) {
        const [sx, sy] = cam.toScreen(m.x, m.y);
        if (tag) {
          c.fillStyle = "#1a1206"; c.textAlign = "center"; c.fillText(tag, sx, sy + 4.5); c.textAlign = "left";
        }
        const text = m.name;
        const w = c.measureText(text).width + 12;
        const x = Math.min(cam.w - w - 4, Math.max(4, sx - w / 2)), y = sy + 14;
        c.fillStyle = "rgba(14,18,24,.88)"; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 19, 4) : c.rect(x, y, w, 19); c.fill();
        c.fillStyle = m === g.trip.start ? "#ffd75e" : "#fff6dc"; c.fillText(text, x + 6, y + 13.5);
      }
    },
  });
  ctx.on("hover", (h) => {
    if (!g || g.done) return;
    const cell = h?.cell ?? -1;
    if (cell !== hover) { hover = cell >= 0 ? cell : null; app.requestDraw?.(); }
  });
  ctx.on("mapclick", (ev) => {
    if (!g || g.done || (race.active && g.mode !== "race")) return true;
    const s = stopAt(ev.cell);
    if (s) pick(s.id); else ctx.toast("Click one of the stops (white circles)");
    return true;
  });
  ctx.onKey((e, k) => {
    if (!g || g.done) return false;
    if (k === "Backspace" || k === "z") { undo(); return true; }
    return false;
  });

  // --- online board --------------------------------------------------------------------------------------------
  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !g.done || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/trip/daily", { key: g.key, order: g.order });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/trip/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  // --- panel ---------------------------------------------------------------------------------------------------
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same trip for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first route today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me
      ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="tr-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="tr-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.status === "sending" ? `<p class="g-note">Checking your route…</p>` : ""}${online.err ? `<p class="tr-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }
  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.(); // the map overlays follow the game state
    const st = g.trip.start;
    const sofar = T.loopKm(st, g.order.map(stopById)) - (g.order.length ? T.km(stopById(g.order.at(-1)), st) : 0);
    const list = g.trip.stops.map((p) => {
      const k = g.order.indexOf(p.id);
      return `<li class="${k >= 0 ? "on" : ""}"><span class="n">${k >= 0 ? k + 1 : "·"}</span>${esc(p.name)} <span class="muted">${esc(p.states.join("-"))}</span></li>`;
    }).join("");
    if (g.done) {
      const r = g.result;
      const s = ctx.storage.get("stats", null);
      body.innerHTML = `${race.active ? race.html() : ""}<p class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"} · from ${esc(st.name)}</p>
        <h3 class="tr-final">${r.points} <small>of ${T.MAX_POINTS}</small></h3>
        <p>Your loop: <b>${kmFmt(r.km)}</b> · best possible: <b>${kmFmt(r.best)}</b>${r.points === T.MAX_POINTS ? " · <b class=\"ok\">perfect!</b>" : ` (+${(((r.km - r.best) / r.best) * 100).toFixed(1)}%)`}</p>
        <p class="g-note">Orange: your route. Dashed green: the shortest loop.</p>
        <ol class="tr-order">${[...g.order.map(stopById)].map((p) => `<li>${esc(p.name)}</li>`).join("")}</ol>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">${g.mode === "practice" ? "Another trip" : "Practice trip"}</button><button class="g-btn" data-act="race-create" title="Race friends on the same trip">Race friends</button><button class="g-btn" data-act="image" title="A PNG of your route and the best one">Download image</button>
          ${g.mode === "practice" ? `<button class="g-btn" data-act="daily">Today's trip</button>` : ""}</div>
        ${boardHtml()}
        ${s && g.mode === "daily" ? `<p class="g-note">Days played ${s.played} · best ${s.best}</p>` : ""}${how()}`;
      return;
    }
    body.innerHTML = `${race.active ? race.html() : ""}<p class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</p>
      <p class="tr-q">Leave <b>${esc(st.name)}</b> (⌂), visit all six, and come home by the shortest loop. Click the stops in order.</p>
      <ul class="tr-stops">${list}</ul>
      <p class="tr-km">So far: <b>${kmFmt(sofar)}</b>${g.order.length ? ` · then ${kmFmt(T.km(stopById(g.order.at(-1)), st))} home` : ""}</p>
      <div class="g-row"><button class="g-btn" data-act="undo" ${g.order.length ? "" : "disabled"}>Undo <kbd>Z</kbd></button></div>${how()}`;
  }
  const how = () => `<details class="tr-how"><summary>How it works</summary><p>Six real metros within 900 km of the start,
    straight-line distances between metro centres. The best loop is found by trying all 720 orders; your score is the best
    loop's length divided by yours, to the 4th power, × 1000 (10% longer than the best scores 683). One trip a day for everyone; the board takes your first route.</p></details>`;
  const share = () => `Road Trip ${g.mode === "daily" ? g.key : "practice"} · ${g.result.points}/1000 · ${kmFmt(g.result.km)} (best ${kmFmt(g.result.best)})`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "undo": undo(); break;
      case "image": {
        const ms = [g.trip.start, ...g.trip.stops], pad = 140;
        mapImage(app, { box: { x0: Math.min(...ms.map((m) => m.x)) - pad, y0: Math.min(...ms.map((m) => m.y)) - pad, x1: Math.max(...ms.map((m) => m.x)) + pad, y1: Math.max(...ms.map((m) => m.y)) + pad },
          overlays: myOverlays, kicker: `Road Trip · ${g.mode === "daily" ? g.key : g.mode} · from ${g.trip.start.name}`, title: `${g.result.points} / 1000`,
          sub: `${kmFmt(g.result.km)} · best ${kmFmt(g.result.best)}` }).then((b) => downloadBlob(b, `road-trip-${g.key || g.seed}.png`) || ctx.toast("Could not draw the image"));
        break;
      }
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=trip`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });

  app.trip = { get g() { return g; }, pick: (id) => pick(id) }; // debugging handle, removed on exit
  ctx.onCleanup(() => { delete app.trip; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => g && frame(), 900); ctx.onCleanup(() => clearTimeout(t)); }
  const offPlayer = net.onPlayer?.(() => { if (g?.done) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => {
    online.avail = !!ok;
    if (ok && g?.done && g.mode === "daily") postDaily(); else refresh();
  });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
