// Pinpoint: find real places on the map (sim/rounds.js). Each day brings eight places for everyone: a few metros, a
// national park or landmark, a research university, an airport, a port and a big power plant or dam. Click the hex
// where you think it is; the closer, the more points. City names, tooltips, resource icons and map layers are hidden
// while you guess (they would give the answer away) and come back when you leave.
//   #play=pinpoint            today's game (resumes where you left off)
//   #play=pinpoint~p-<seed>   a practice game
// Saves (ctx.storage): "d:<key>" = today's guesses, "stats" = {played, best, streak, last, total}. Online: the day's
// board (docs/MULTIPLAYER.md "Pinpoint daily"); the server rebuilds the rounds from the date and scores the guesses.
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { mapImage, downloadBlob } from "../shared/shareimg.js";
import { net } from "../shared/net.js";
import { esc } from "../../format.js";
import * as P from "./sim/rounds.js";

const KIND_ICON = { metro: "🏙️", national_park: "🏞️", park_unit: "🏞️", landmark: "🗽", research_university: "🎓", airport: "✈️", port: "⚓",
  nuclear: "⚛️", hydro: "💧", pumped_storage: "💧", coal_plant: "🏭", gas_plant: "🔥" };
const KIND_WORD = { metro: "Metro area", national_park: "National park", park_unit: "Park", landmark: "Landmark", research_university: "University",
  airport: "Airport", port: "Port", nuclear: "Power plant", hydro: "Dam", pumped_storage: "Dam", coal_plant: "Power plant", gas_plant: "Power plant" };
const utcKey = () => new Date().toISOString().slice(0, 10);

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/pinpoint.css");
  const body = ctx.dock("left", { width: 340, title: "Pinpoint" });
  body.classList.add("pp");
  body.innerHTML = `<p class="g-note">Unfolding the map…</p>`;

  const grid = ctx.hexmap.grid;
  const [wonders, infrastructure] = await Promise.all([
    ctx.data.wonders || ctx.loadData("wonders").catch(() => null),
    ctx.data.infrastructure || ctx.loadData("infrastructure").catch(() => null),
  ]);
  const pool = P.buildPool({ cities: ctx.cities, resources: ctx.data.resources, wonders, infrastructure }, grid);
  // The whole country inside the part of the map the dock leaves visible (app.home() centres on the full canvas).
  const all = Object.values(pool).flat();
  const usBox = { x0: Math.min(...all.map((p) => p.x)), x1: Math.max(...all.map((p) => p.x)), y0: Math.min(...all.map((p) => p.y)), y1: Math.max(...all.map((p) => p.y)) };
  const frameUS = (ms) => app.fitBounds ? fitVisible(app, body, usBox.x0 - 60, usBox.y0 - 60, usBox.x1 + 60, usBox.y1 + 60, { ms }) : app.home?.();

  // --- hide what names places (like Founders) ------------------------------------------------------------------
  app.setCitiesHidden(true);
  const toggledOff = new Set();
  let hidResources = false;
  function enforceHidden() {
    try { for (const t of app.ui.mapToggles?.() || []) if (t.on && app.ui.setMapToggle(t.id, false)) toggledOff.add(t.id); } catch { /* none */ }
    if (app.state.showResources && app.w?.resources) { app.setShowResources?.(false); hidResources = true; }
  }
  ctx.onCleanup(() => {
    app.setCitiesHidden(false);
    for (const id of toggledOff) app.ui.setMapToggle?.(id, true);
    if (hidResources) app.setShowResources?.(true);
    app.invalidate?.();
  });
  ctx.on("extensions", () => enforceHidden());
  enforceHidden();

  // --- game state --------------------------------------------------------------------------------------------------
  // g = {mode: "daily"|"practice", key, seed, rounds, guesses: [cell], results: [{km, points}], i (current round)}
  let g = null;
  let hover = null;
  const online = { avail: false, status: "idle", res: null, board: null, err: null };

  // Races (shared/race.js): everyone plays the same practice seed; the room scores the guesses.
  const race = makeRace({ ctx, game: "pinpoint", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `${p.score.toLocaleString("en-US")} pts` });
  function newGame(mode, seedOrKey) {
    const rounds = mode === "daily" ? P.dailyRounds(pool, seedOrKey) : P.roundsFor(pool, `pinpoint-practice:${seedOrKey}`);
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, rounds, guesses: [], results: [], i: 0 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved)) for (const c of saved.slice(0, rounds.length)) guessAt(c, { quiet: true });
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    if (g.guesses.length < g.rounds.length) { g.i = g.guesses.length; frameUS(); }
    else { g.i = g.rounds.length; finish({ quiet: true }); }
    refresh();
  }
  const done = () => g.guesses.length >= g.rounds.length;
  const revealing = () => g.guesses.length > g.i; // the current round has a guess: show the answer

  function guessAt(cell, { quiet = false } = {}) {
    if (done() || revealing()) return;
    const place = g.rounds[g.guesses.length];
    const r = P.scoreGuess(grid, place, cell);
    g.guesses.push(cell);
    g.results.push(r);
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.guesses);
    if (quiet) { g.i = g.guesses.length; return; }
    if (g.mode === "race") race.progress({ round: g.guesses.length, score: total() });
    frameRound(g.i);
    refresh();
  }
  function next() {
    if (!revealing()) return;
    g.i++;
    if (done()) { finish(); return; }
    frameUS();
    refresh();
  }
  function frameRound(i) {
    const p = g.rounds[i], c = g.guesses[i];
    if (p == null || c == null || !app.fitBounds) return;
    const pad = 120;
    const xs = [p.x, grid.cx(c)], ys = [p.y, grid.cy(c)];
    fitVisible(app, body, Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad, { maxScale: 2 });
  }
  function finish({ quiet = false } = {}) {
    g.i = g.rounds.length;
    if (g.mode === "daily" && !quiet) {
      const st = ctx.storage.get("stats", { played: 0, best: 0, streak: 0, last: null, total: 0 });
      if (st.last !== g.key) {
        const y = new Date(`${g.key}T00:00:00Z`); y.setUTCDate(y.getUTCDate() - 1);
        st.streak = st.last === y.toISOString().slice(0, 10) ? st.streak + 1 : 1;
        st.played++; st.last = g.key; st.total += total(); st.best = Math.max(st.best, total());
        ctx.storage.set("stats", st);
      }
    }
    frameUS();
    refresh();
    if (g.mode === "daily") postDaily();
    if (g.mode === "race") race.finish({ guesses: g.guesses });
  }
  const total = () => g.results.reduce((s, r) => s + r.points, 0);

  // --- online board ------------------------------------------------------------------------------------------------
  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !done() || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; } // shown with a "post as" form
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/pp/daily", { key: g.key, guesses: g.guesses });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/pp/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  // --- map overlay ---------------------------------------------------------------------------------------------------
  const hexPath = (p, c, k = 1) => {
    const x = grid.cx(c), y = grid.cy(c);
    for (let i = 0; i < 6; i++) { const [ox, oy] = grid.corners[i]; i ? p.lineTo(x + ox * k, y + oy * k) : p.moveTo(x + ox * k, y + oy * k); }
    p.closePath();
  };
  function drawPair(c, s, i, faint) {
    const p = g.rounds[i], cell = g.guesses[i], r = g.results[i];
    if (cell == null) return;
    const gx = grid.cx(cell), gy = grid.cy(cell);
    c.globalAlpha = faint ? 0.55 : 1;
    c.beginPath(); c.moveTo(gx, gy); c.lineTo(p.x, p.y);
    c.strokeStyle = "rgba(10,10,10,.6)"; c.lineWidth = 5 / s; c.stroke();
    c.setLineDash([8 / s, 6 / s]);
    c.strokeStyle = r.points >= 950 ? "#7be38f" : r.points >= 800 ? "#ffd75e" : r.points >= 500 ? "#ffa04d" : "#ff6b5e";
    c.lineWidth = 2.5 / s; c.stroke(); c.setLineDash([]);
    const gp = new Path2D(); hexPath(gp, cell, 0.85);
    c.fillStyle = "rgba(255,107,94,.35)"; c.fill(gp); c.strokeStyle = "#ff6b5e"; c.lineWidth = 2 / s; c.stroke(gp);
    // the answer: a gold pin
    const R = Math.max(6 / s, grid.R * 0.35);
    c.beginPath(); c.arc(p.x, p.y, R, 0, Math.PI * 2);
    c.fillStyle = "#ffd75e"; c.fill(); c.lineWidth = 2.5 / s; c.strokeStyle = "#3a2a08"; c.stroke();
    c.globalAlpha = 1;
  }
  const myOverlays = []; // also drawn into the share image
  const addOv = (o) => { myOverlays.push(o); ctx.addOverlay(o); };
  addOv({
    id: "pins", z: 95, space: "world", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const s = cam.scale;
      if (done()) { for (let i = 0; i < g.rounds.length; i++) drawPair(c, s, i, true); return; }
      if (revealing()) { drawPair(c, s, g.i, false); return; }
      if (hover != null && hover >= 0) {
        const p = new Path2D(); hexPath(p, hover, 0.9);
        c.strokeStyle = "#fff4d0"; c.lineWidth = 2.5 / s; c.stroke(p);
        c.fillStyle = "rgba(255,244,208,.18)"; c.fill(p);
      }
    },
  });
  addOv({
    id: "pin-label", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g) return;
      const list = done() ? g.rounds.map((_, i) => i) : revealing() ? [g.i] : [];
      c.font = "600 13px system-ui, sans-serif";
      for (const i of list) {
        const p = g.rounds[i];
        const [sx, sy] = cam.toScreen(p.x, p.y);
        if (sx < -50 || sy < -20 || sx > cam.w + 50 || sy > cam.h + 20) continue;
        const text = done() ? `${i + 1}. ${p.name}` : `${p.name} · ${g.results[i].km.toLocaleString("en-US")} km`;
        const w = c.measureText(text).width + 14;
        const x = Math.min(cam.w - w - 6, Math.max(6, sx - w / 2)), y = sy - 34;
        c.fillStyle = "rgba(14,18,24,.92)"; c.strokeStyle = "#ffd75e"; c.lineWidth = 1;
        c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 22, 5) : c.rect(x, y, w, 22); c.fill(); c.stroke();
        c.fillStyle = "#fff6dc"; c.fillText(text, x + 7, y + 15);
      }
    },
  });

  ctx.on("hover", (h) => {
    if (!g || done() || revealing()) return;
    const cell = h?.cell ?? -1;
    if (cell !== hover) { hover = cell >= 0 ? cell : null; app.requestDraw?.(); }
  });
  ctx.on("mapclick", (ev) => {
    if (!g || (race.active && g.mode !== "race")) return true;
    if (done()) return true;
    if (revealing()) { next(); return true; }
    if (ev.cell == null || ev.cell < 0) return true;
    guessAt(ev.cell);
    return true;
  });
  ctx.onKey((e, k) => {
    if (!g) return false;
    if ((k === "Enter" || k === "n" || k === " ") && revealing() && e.target?.tagName !== "BUTTON") { next(); return true; }
    return false;
  });

  // --- panel -------------------------------------------------------------------------------------------------------
  function clueHtml(p, i) {
    return `<div class="pp-clue">
      <div class="pp-kind">${KIND_ICON[p.kind] || "📍"} ${esc(KIND_WORD[p.kind] || "Place")} · round ${i + 1} of ${g.rounds.length}</div>
      <div class="pp-name">${esc(p.name)}</div>
      <div class="pp-where">${esc(p.where)} · <span class="muted">${esc(p.detail)}</span></div></div>`;
  }
  function verdict(r) {
    if (r.points === P.MAX_POINTS) return "Right on it!";
    if (r.points >= 950) return "Very close.";
    if (r.points >= 800) return "Close.";
    if (r.points >= 500) return "In the region.";
    if (r.points > 0) return "Far off.";
    return "Wrong part of the country.";
  }
  const share = () => `Pinpoint ${g.mode === "daily" ? g.key : `practice ${g.seed}`} · ${total().toLocaleString("en-US")}/${(g.rounds.length * P.MAX_POINTS).toLocaleString("en-US")}\n${g.results.map((r) => P.square(r.points)).join("")}`;

  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">Same eight places for everyone today. Share your result to compare.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? " <span class=\"g-note\">(your first game today counts)</span>" : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me
      ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="pp-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="pp-top">${b.top.map((r) => `<li${b.you && r.rank === b.you.rank && r.score === b.you.score && r.name === me?.name ? ` class="me"` : ""}><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score.toLocaleString("en-US")}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.status === "sending" ? `<p class="g-note">Checking your guesses…</p>` : ""}${online.err ? `<p class="pp-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.(); // the map overlays follow the game state
    const tot = total();
    const head = `<div class="pp-top-row"><div class="g-stat"><b>${tot.toLocaleString("en-US")}</b><span>points</span></div>
      <div class="pp-dots">${g.rounds.map((_, i) => `<i class="${i < g.results.length ? `s${P.square(g.results[i].points) === "🟩" ? 4 : P.square(g.results[i].points) === "🟨" ? 3 : P.square(g.results[i].points) === "🟧" ? 2 : 1}` : i === g.i ? "cur" : ""}"></i>`).join("")}</div>
      <span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</span></div>${race.active ? race.html() : ""}`;
    if (done()) {
      const st = ctx.storage.get("stats", null);
      const rows = g.rounds.map((p, i) => `<li><span>${KIND_ICON[p.kind] || "📍"}</span><span class="nm">${esc(p.name)} <span class="muted">${esc(p.where)}</span></span><span class="km">${g.results[i].km.toLocaleString("en-US")} km</span><span class="pt">${g.results[i].points}</span></li>`).join("");
      body.innerHTML = `${head}
        <h3 class="pp-final">${tot.toLocaleString("en-US")} <small>of ${(g.rounds.length * P.MAX_POINTS).toLocaleString("en-US")}</small></h3>
        <p class="pp-squares">${g.results.map((r) => P.square(r.points)).join("")}</p>
        <ul class="pp-list">${rows}</ul>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice round</button><button class="g-btn" data-act="race-create" title="Race friends on the same eight places">Race friends</button><button class="g-btn" data-act="image" title="A PNG of the map with your eight guesses">Download image</button>
          ${g.mode === "practice" ? `<button class="g-btn" data-act="daily">Today's game</button>` : ""}</div>
        ${boardHtml()}
        ${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best.toLocaleString("en-US")} · streak ${st.streak}</p>` : ""}
        ${how()}`;
      return;
    }
    const p = g.rounds[g.i];
    if (revealing()) {
      const r = g.results[g.i];
      body.innerHTML = `${head}${clueHtml(p, g.i)}
        <div class="pp-result" role="status"><b>${verdict(r)}</b> ${r.km.toLocaleString("en-US")} km away · <b>+${r.points}</b></div>
        <button class="g-btn primary pp-next" data-act="next">${g.i + 1 < g.rounds.length ? "Next place" : "See your score"} <kbd>⏎</kbd></button>
        ${how()}`;
      body.querySelector(".pp-next")?.focus({ preventScroll: true });
      return;
    }
    body.innerHTML = `${head}${clueHtml(p, g.i)}
      <p class="pp-hint">Click the hex where it is. Within one hex (25 km) scores the full 1,000; every km beyond that costs a point.</p>
      ${how()}`;
  }
  const how = () => `<details class="pp-how"><summary>How it works</summary>
    <p>Eight real places a day, the same for everyone: metros (Census), parks, landmarks and universities, airports
    (FAA boardings), ports (USACE tonnage) and power plants or dams (EIA capacity). Names, tooltips and map layers are
    hidden while you play. Distance is between hex centres; the board takes your first finished game of the day.</p></details>`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "next": next(); break;
      case "image": mapImage(app, { box: { x0: usBox.x0 - 80, y0: usBox.y0 - 80, x1: usBox.x1 + 80, y1: usBox.y1 + 80 }, overlays: myOverlays,
        kicker: `Pinpoint · ${g.mode === "daily" ? g.key : g.mode}`, title: `${total().toLocaleString("en-US")} / ${(g.rounds.length * P.MAX_POINTS).toLocaleString("en-US")}`,
        sub: g.results.map((r) => P.square(r.points)).join("") }).then((b) => downloadBlob(b, `pinpoint-${g.key || g.seed}.png`) || ctx.toast("Could not draw the image")); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=pinpoint`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });

  // debugging handle (like app.mainline / app.founders), removed on exit
  app.pinpoint = { get g() { return g; }, guess: (c) => guessAt(c), next: () => next() };
  ctx.onCleanup(() => { delete app.pinpoint; });

  // --- start -------------------------------------------------------------------------------------------------------
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g && !revealing()) frameUS(); }, 900); ctx.onCleanup(() => clearTimeout(t)); } // after the dock has laid out
  const offPlayer = net.onPlayer?.(() => { if (g && done()) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => {
    online.avail = !!ok;
    if (ok && g && done() && g.mode === "daily") postDaily();
    else refresh();
  });

  return {
    stop() {},
    onEscape: () => true,
    param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null),
  };
}
