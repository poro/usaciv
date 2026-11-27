// State Shapes (sim/shapes.js): a state's outline on the hex grid, alone in the panel; pick its name from four.
// The map is covered while you choose (it would give the shape away) and shows the state at the reveal. Later
// rounds turn the shape. Eight rounds a day, the same for everyone.
//   #play=shapes            today's game (resumes after a reload)
//   #play=shapes~p-<seed>   practice
// Saves: "d:<key>" = today's picks, "stats" = {played, best, last}. Online: the day's board (/api/shapes/daily).
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as S from "./sim/shapes.js";

const utcKey = () => new Date().toISOString().slice(0, 10);
const TURN_WORD = ["", "turned 60°", "turned 120°", "upside down", "turned 240°", "turned 300°"];

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/shapes.css");
  const body = ctx.dock("left", { width: 330, title: "State Shapes" });
  body.classList.add("sh");
  const world = ctx.data.world;
  const cols = world.grid.cols;
  const pool = S.shapePool(world);
  const byAbbr = new Map(pool.map((s) => [s.abbr, s]));
  // Tooltips name the state under the pointer: hide them (with the city banners) while playing.
  app.setCitiesHidden(true);
  ctx.onCleanup(() => { app.setHighlight?.(null); app.setCitiesHidden(false); app.invalidate?.(); });
  // Cover the map while a shape is up: with every border on show, matching the outline would be too easy.
  ctx.addOverlay({
    id: "cover", z: 100, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g || done() || shown()) return;
      c.fillStyle = "rgba(9,13,19,.94)";
      c.fillRect(0, 0, cam.w, cam.h);
      c.fillStyle = "rgba(236,208,142,.35)";
      c.font = "italic 15px Georgia, serif";
      c.textAlign = "center";
      c.fillText("The map comes back when you answer", cam.w / 2 + 160, cam.h / 2);
      c.textAlign = "start";
    },
  });

  let g = null; // {mode, key, seed, rounds, picks: [abbr], showing: index being revealed or -1}
  const online = { avail: false, status: "idle", res: null, board: null, err: null };
  const race = makeRace({ ctx, game: "shapes", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `${p.score}/${p.round || 0}` });

  function newGame(mode, seedOrKey) {
    const rounds = S.shapeRounds(pool, mode === "daily" ? S.dailySeed(seedOrKey) : S.practiceSeed(seedOrKey));
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, rounds, picks: [], showing: -1 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved)) g.picks = saved.filter((a, i) => rounds[i]?.options.includes(a)).slice(0, rounds.length);
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    app.setHighlight?.(null);
    refresh();
    if (done()) showAll();
    if (done() && mode === "daily") postDaily();
  }
  const done = () => g.picks.length >= g.rounds.length && g.showing < 0;
  const shown = () => g.showing >= 0;
  const cur = () => g.rounds[shown() ? g.showing : Math.min(g.picks.length, g.rounds.length - 1)];
  const score = () => g.picks.filter((a, i) => a === g.rounds[i].answer).length;

  function pick(abbr) {
    if (!g || shown() || g.picks.length >= g.rounds.length || (race.active && g.mode !== "race")) return;
    g.showing = g.picks.length;
    g.picks.push(abbr);
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.picks);
    if (g.mode === "race") race.progress({ round: g.picks.length, score: score() });
    showOnMap(cur().answer);
    refresh();
  }
  function next() {
    if (!shown()) return;
    g.showing = -1;
    app.setHighlight?.(null);
    if (g.picks.length >= g.rounds.length) finish();
    else refresh();
  }
  function finish() {
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, score()); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ picks: g.picks });
    showAll();
    refresh();
  }
  // The end screen: the day's eight states lit together.
  function showAll() {
    const h = { cells: new Set(g.rounds.flatMap((r) => byAbbr.get(r.answer).cells)), color: "#ecd08e", dimOthers: true };
    app.setHighlight?.(h);
    const bb = app.highlightBounds?.(h);
    if (bb) fitVisible(app, body, bb.x0 - 150, bb.y0 - 150, bb.x1 + 150, bb.y1 + 150, { maxScale: 0.7 });
  }
  function showOnMap(abbr) {
    const s = byAbbr.get(abbr);
    const h = { cells: new Set(s.cells), color: "#ecd08e", dimOthers: true };
    app.setHighlight?.(h);
    const bb = app.highlightBounds?.(h);
    if (bb) fitVisible(app, body, bb.x0 - 300, bb.y0 - 300, bb.x1 + 300, bb.y1 + 300, { maxScale: 0.7 });
  }

  // The silhouette, drawn into the panel's canvas.
  function draw(canvas, abbr, turn) {
    const s = byAbbr.get(abbr);
    const sil = S.silhouette(s.cells, cols, turn);
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 300, H = canvas.clientHeight || 230;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const k = Math.min((W - 24) / sil.w, (H - 24) / sil.h);
    const ox = (W - sil.w * k) / 2, oy = (H - sil.h * k) / 2;
    const hex = (x, y, r) => {
      c.beginPath();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); }
      c.closePath();
    };
    c.fillStyle = "#c9a45c"; c.strokeStyle = "#e9cf91"; c.lineWidth = Math.max(0.5, k * 0.08);
    for (const [x, y] of sil.pts) { hex(ox + x * k, oy + y * k, k * 1.02); c.fill(); }
    for (const [x, y] of sil.pts) { hex(ox + x * k, oy + y * k, k); c.stroke(); }
  }

  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !done() || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/shapes/daily", { key: g.key, picks: g.picks });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/shapes/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  const nameOf = (a) => byAbbr.get(a)?.name || a;
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same eight states for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first game today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="sh-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="sh-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}/${S.ROUNDS}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.err ? `<p class="sh-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.();
    const dots = g.rounds.map((r, i) => `<i class="${i < g.picks.length ? (g.picks[i] === r.answer ? "ok" : "bad") : i === g.picks.length ? "cur" : ""}"></i>`).join("");
    const head = `<div class="sh-head"><span class="sh-dots">${dots}</span><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</span></div>${race.active ? race.html() : ""}`;
    if (done()) {
      const st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}<h3 class="sh-final">${score()} <small>of ${S.ROUNDS}</small></h3>
        <ul class="sh-list">${g.rounds.map((r, i) => `<li class="${g.picks[i] === r.answer ? "ok" : "bad"}">${g.picks[i] === r.answer ? "✓" : "✗"} <b>${esc(nameOf(r.answer))}</b>${r.turn ? ` <span class="muted">(${TURN_WORD[r.turn]})</span>` : ""}${g.picks[i] === r.answer ? "" : ` <span class="muted">you said ${esc(nameOf(g.picks[i]))}</span>`}</li>`).join("")}</ul>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice round</button><button class="g-btn" data-act="race-create" title="Race friends on the same eight shapes">Race friends</button>${g.mode !== "daily" ? `<button class="g-btn" data-act="daily">Today's game</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("shapes") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}/${S.ROUNDS}</p>` : ""}${how()}`;
      return;
    }
    const r = cur();
    const right = shown() && g.picks[g.showing] === r.answer;
    body.innerHTML = `${head}<p class="sh-q">Which state is this?${r.turn ? ` <span class="sh-turn">${TURN_WORD[r.turn]}</span>` : ""}</p>
      <canvas class="sh-canvas" aria-label="A state's outline on the hex grid${r.turn ? `, ${TURN_WORD[r.turn]}` : ""}"></canvas>
      <div class="sh-opts">${r.options.map((a, i) => {
        const cls = !shown() ? "" : a === r.answer ? " right" : a === g.picks[g.showing] ? " wrong" : " dim";
        return `<button class="g-btn sh-opt${cls}" data-act="pick" data-id="${esc(a)}" ${shown() ? "disabled" : ""}><kbd>${i + 1}</kbd> ${esc(nameOf(a))}</button>`;
      }).join("")}</div>
      ${shown() ? `<p class="sh-verdict ${right ? "ok" : "bad"}" role="status">${right ? "Right!" : `It was ${esc(nameOf(r.answer))}.`} <span class="g-note">${byAbbr.get(r.answer).cells.length} hexes on the map.</span></p>
        <button class="g-btn primary sh-next" data-act="next">${g.picks.length < g.rounds.length ? "Next shape" : "See your score"} <kbd>⏎</kbd></button>` : ""}${how()}`;
    draw(body.querySelector(".sh-canvas"), r.answer, r.turn);
    if (shown()) body.querySelector(".sh-next")?.focus({ preventScroll: true });
  }
  const how = () => `<details class="sh-how"><summary>How it works</summary><p>Each round shows one state as the map draws it:
    its 25 km hexes (Census state boundaries), scaled to fit. Rounds ${S.UPRIGHT + 1}–${S.FREE_TURNS} show it upside down, the last two turned any way. The four
    choices are close to it in size. The map stays covered until you answer, then shows where it is. Eight rounds a day,
    the same for everyone; the board takes your first game.</p></details>`;
  const share = () => `State Shapes ${g.mode === "daily" ? g.key : "practice"} · ${score()}/${S.ROUNDS}\n${g.rounds.map((r, i) => (g.picks[i] === r.answer ? "🟩" : "🟥")).join("")}`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "pick": pick(t.dataset.id); break;
      case "next": next(); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=shapes`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || done()) return false;
    if (shown() && (k === "Enter" || k === "n") && e.target?.tagName !== "BUTTON") { next(); return true; }
    if (!shown() && /^[1-4]$/.test(k)) { pick(cur().options[+k - 1]); return true; }
    return false;
  });
  ctx.on("mapclick", () => { if (g && shown()) next(); return true; });
  const onResize = () => { if (g && !done()) { const cv = body.querySelector(".sh-canvas"); if (cv) draw(cv, cur().answer, cur().turn); } };
  window.addEventListener("resize", onResize);
  ctx.onCleanup(() => window.removeEventListener("resize", onResize));

  app.shapes = { get g() { return g; }, pick: (a) => pick(a), next: () => next() }; // debugging handle
  ctx.onCleanup(() => { delete app.shapes; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g && done()) showAll(); }, 900); ctx.onCleanup(() => clearTimeout(t)); } // after the dock lays out
  const offPlayer = net.onPlayer?.(() => { if (g && done()) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g && done() && g.mode === "daily") postDaily(); else refresh(); });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
