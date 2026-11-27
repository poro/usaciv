// Ballpark (sim/guess.js): estimate real numbers on a slider. Four metro statistics and two distances a day; the
// closer, the more points (0–100 each). The metros are lit on the map; their banners are hidden (they show population).
//   #play=guess            today's six (resume after a reload)
//   #play=guess~p-<seed>   practice
// Saves: "d:<key>" = today's guesses, "stats" = {played, best, last}. Online: the day's board (/api/guess/daily).
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as G from "./sim/guess.js";

const HL = "#7fd7ff";
const STEPS = 1000;
const utcKey = () => new Date().toISOString().slice(0, 10);

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/guess.css");
  const body = ctx.dock("left", { width: 340, title: "Ballpark" });
  body.classList.add("bp");
  const pool = G.guessPool(ctx.cities);
  const byId = new Map(pool.map((c) => [c.id, c]));
  app.setCitiesHidden(true);
  app.setLens?.(null);
  document.body.classList.add("g-hide-lens"); // a lens would give the statistics away
  ctx.onCleanup(() => { document.body.classList.remove("g-hide-lens"); app.setHighlight?.(null); app.setCitiesHidden(false); app.invalidate?.(); });

  let g = null; // {mode, key, seed, rounds, guesses: [number], showing: index revealed or -1, slider: 0..STEPS}
  const online = { avail: false, status: "idle", res: null, board: null, err: null };
  const race = makeRace({ ctx, game: "guess", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `${p.score} pts` });

  const cityIds = (q) => (q.kind === "km" ? [q.a, q.b] : [q.city]);
  ctx.addOverlay({
    id: "labels", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g || done()) return;
      const q = cur();
      const pts = cityIds(q).map((id) => { const m = byId.get(id); return [m, ...cam.toScreen(m.x, m.y)]; });
      if (q.kind === "km" && shown()) { // the distance, drawn once revealed
        c.strokeStyle = "#ffd75e"; c.lineWidth = 3; c.setLineDash([8, 6]);
        c.beginPath(); c.moveTo(pts[0][1], pts[0][2]); c.lineTo(pts[1][1], pts[1][2]); c.stroke(); c.setLineDash([]);
      }
      c.font = "600 13px system-ui, sans-serif";
      let prev = null;
      for (const [m, sx, sy] of pts) {
        const text = m.name;
        const w = c.measureText(text).width + 14;
        const x = Math.min(cam.w - w - 6, Math.max(6, sx - w / 2));
        let y = sy - 34;
        if (prev && x < prev.x + prev.w + 4 && prev.x < x + w + 4 && Math.abs(y - prev.y) < 26) y = prev.y - 26;
        prev = { x, y, w };
        c.fillStyle = "rgba(14,18,24,.92)"; c.strokeStyle = HL; c.lineWidth = 1.5;
        c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 22, 5) : c.rect(x, y, w, 22); c.fill(); c.stroke();
        c.fillStyle = "#fff6dc"; c.fillText(text, x + 7, y + 15);
      }
    },
  });

  function newGame(mode, seedOrKey) {
    const rounds = G.guessRounds(pool, mode === "daily" ? G.dailySeed(seedOrKey) : G.practiceSeed(seedOrKey));
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, rounds, guesses: [], showing: -1, slider: STEPS / 2 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved) && !G.scoreGuesses(pool, rounds, saved, { partial: true }).error) g.guesses = saved.slice(0, rounds.length);
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    frame();
    refresh();
    if (done() && mode === "daily") postDaily();
  }
  const done = () => g.guesses.length >= g.rounds.length && g.showing < 0;
  const shown = () => g.showing >= 0;
  const cur = () => g.rounds[shown() ? g.showing : Math.min(g.guesses.length, g.rounds.length - 1)];
  const total = () => g.guesses.reduce((a, v, i) => a + G.points(g.rounds[i], v), 0);
  const signed = (q) => q.kind === "stat" && G.statById(q.stat).signed;

  // slider position ↔ value (log scale, except growth), rounded to 3 significant figures
  function valueAt(q, t) {
    const [lo, hi] = G.rangeFor(pool, q);
    const v = signed(q) ? lo + ((hi - lo) * t) / STEPS : lo * (hi / lo) ** (t / STEPS);
    if (signed(q)) return Math.min(hi, Math.max(lo, Math.round(v * 1000) / 1000));
    const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 2);
    return Math.min(hi, Math.max(lo, Math.round(v / p) * p));
  }
  const fmt = (q, v) => (q.kind === "km" ? `${Math.round(v).toLocaleString("en-US")} km` : G.statById(q.stat).fmt(v));

  function lockIn() {
    if (!g || shown() || done() || (race.active && g.mode !== "race")) return;
    const q = cur();
    g.guesses.push(valueAt(q, g.slider));
    g.showing = g.guesses.length - 1;
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.guesses);
    if (g.mode === "race") race.progress({ round: g.guesses.length, score: total() });
    refresh();
  }
  function next() {
    if (!shown()) return;
    g.showing = -1;
    g.slider = STEPS / 2;
    if (g.guesses.length >= g.rounds.length) finish();
    else { frame(); refresh(); }
  }
  function finish() {
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, total()); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ guesses: g.guesses });
    app.setHighlight?.(null);
    refresh();
  }
  function frame() {
    if (!g || done()) return;
    const ms = cityIds(cur()).map((id) => byId.get(id));
    const h = { cities: new Set(ms.map((m) => m.id)), cells: new Set(ms.flatMap((m) => m.footprint || [m.cell])), color: HL, dimOthers: true };
    app.setHighlight?.(h);
    const bb = app.highlightBounds?.(h);
    const pad = cur().kind === "km" ? 300 : 900;
    if (bb) fitVisible(app, body, bb.x0 - pad, bb.y0 - pad, bb.x1 + pad, bb.y1 + pad, { maxScale: 0.9 });
  }

  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !done() || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/guess/daily", { key: g.key, guesses: g.guesses });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/guess/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same six questions for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first game today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="bp-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="bp-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.err ? `<p class="bp-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  const askHtml = (q) => {
    if (q.kind === "km") return `How far is it from <b>${esc(byId.get(q.a).name)}</b> to <b>${esc(byId.get(q.b).name)}</b>, as the crow flies?`;
    const s = G.statById(q.stat), m = byId.get(q.city);
    return `What is the <b>${esc(s.label)}</b> of the <b>${esc(m.name)}</b> metro <span class="muted">(${esc(m.states.join("-"))})</span>?`;
  };
  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.();
    const dots = g.rounds.map((q, i) => {
      if (i >= g.guesses.length) return `<i class="${i === g.guesses.length ? "cur" : ""}"></i>`;
      const p = G.points(q, g.guesses[i]);
      return `<i class="${p >= 90 ? "ok" : p >= 70 ? "mid" : p >= 40 ? "low" : "bad"}" title="${p} points"></i>`;
    }).join("");
    const head = `<div class="bp-head"><span class="bp-dots">${dots}</span><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"} · ${total()} pts</span></div>${race.active ? race.html() : ""}`;
    if (done()) {
      const st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}<h3 class="bp-final">${total()} <small>of ${G.MAX_SCORE}</small></h3>
        <ul class="bp-list">${g.rounds.map((q, i) => `<li>${G.square(G.points(q, g.guesses[i]))} ${q.kind === "km" ? `${esc(byId.get(q.a).name)}–${esc(byId.get(q.b).name)}` : `${esc(byId.get(q.city).name)}, ${esc(G.statById(q.stat).label)}`}: <b>${esc(fmt(q, q.answer))}</b> <span class="muted">(you ${esc(fmt(q, g.guesses[i]))})</span></li>`).join("")}</ul>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice round</button><button class="g-btn" data-act="race-create" title="Race friends on the same six questions">Race friends</button>${g.mode !== "daily" ? `<button class="g-btn" data-act="daily">Today's game</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("guess") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}/${G.MAX_SCORE}</p>` : ""}${how()}`;
      return;
    }
    const q = cur();
    if (shown()) {
      const v = g.guesses[g.showing], p = G.points(q, v);
      body.innerHTML = `${head}<p class="bp-q">${askHtml(q)}</p>
        <div class="bp-reveal"><div><span class="g-note">Real</span><b>${esc(fmt(q, q.answer))}</b></div><div><span class="g-note">You</span><b>${esc(fmt(q, v))}</b></div></div>
        <p class="bp-verdict ${p >= 90 ? "ok" : p >= 70 ? "mid" : "bad"}" role="status">${p >= 95 ? "Bang on!" : p >= 80 ? "Close!" : p >= 50 ? "In the ballpark." : p > 0 ? "Way off." : "Not even close."} <b>${p}</b> points.</p>
        <p class="g-note">${q.kind === "km" ? "Straight line between metro centres on the map." : `Source: ${esc(G.statById(q.stat).src)} (cities.json).`}</p>
        <button class="g-btn primary bp-next" data-act="next">${g.guesses.length < g.rounds.length ? "Next question" : "See your score"} <kbd>⏎</kbd></button>${how()}`;
      body.querySelector(".bp-next")?.focus({ preventScroll: true });
      return;
    }
    body.innerHTML = `${head}<p class="bp-q">${askHtml(q)}</p>
      <output class="bp-val" aria-live="polite">${esc(fmt(q, valueAt(q, g.slider)))}</output>
      <input class="bp-slider" type="range" min="0" max="${STEPS}" step="1" value="${g.slider}" aria-label="Your estimate">
      <div class="bp-ends g-note"><span>${esc(fmt(q, G.rangeFor(pool, q)[0]))}</span><span>${esc(fmt(q, G.rangeFor(pool, q)[1]))}</span></div>
      <button class="g-btn primary bp-lock" data-act="lock">Lock in <kbd>⏎</kbd></button>
      <p class="g-note">Drag the slider (arrow keys nudge it; Page Up/Down jump).${signed(q) ? "" : " The scale is logarithmic: each step is a percentage."}</p>${how()}`;
    const sl = body.querySelector(".bp-slider");
    sl.addEventListener("input", () => { g.slider = +sl.value; body.querySelector(".bp-val").textContent = fmt(q, valueAt(q, g.slider)); });
    sl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lockIn(); } });
  }
  const how = () => `<details class="bp-how"><summary>How it works</summary><p>Four real metro statistics (Census, BEA,
    population estimates) and two straight-line distances. Each question scores up to 100: about 92 when you are 5% off,
    falling to 0 at a question's tolerance (×3 for population, ×1.6 for income, 6 points for growth…). Six questions a day,
    the same for everyone; the board takes your first game.</p></details>`;
  const share = () => `Ballpark ${g.mode === "daily" ? g.key : "practice"} · ${total()}/${G.MAX_SCORE}\n${g.rounds.map((q, i) => G.square(G.points(q, g.guesses[i]))).join("")}`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "lock": lockIn(); break;
      case "next": next(); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=guess`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || done()) return false;
    if (k === "l" || k === "L") return true; // no lens switching (a lens would give it away)
    if (k === "Enter" && e.target?.tagName !== "BUTTON") { shown() ? next() : lockIn(); return true; }
    return false;
  });
  ctx.on("mapclick", () => { if (g && shown()) next(); return true; });

  app.guess = { get g() { return g; }, set: (t) => { g.slider = t; refresh(); }, lockIn: () => lockIn(), next: () => next(), valueAt }; // debugging handle
  ctx.onCleanup(() => { delete app.guess; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g && !done()) frame(); }, 900); ctx.onCleanup(() => clearTimeout(t)); }
  const offPlayer = net.onPlayer?.(() => { if (g && done()) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g && done() && g.mode === "daily") postDaily(); else refresh(); });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
