// Metro Duel: higher or lower on real metro statistics (sim/duel.js). Metro A shows its value; is B's higher or
// lower? Each right answer extends the streak and B becomes the next A. Both metros are lit on the map.
//   #play=duel            today's run (30 duels, the same for everyone; resumes after a reload)
//   #play=duel~p-<seed>   an endless practice run
// Saves (ctx.storage): "d:<key>" = today's answers, "stats" = {played, best, last, streak}, "pbest" = best practice.
// Online: the day's board (docs/MULTIPLAYER.md "Metro Duel daily"); the server replays the answers.
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as D from "./sim/duel.js";

const HL = "#7fd7ff";
const utcKey = () => new Date().toISOString().slice(0, 10);

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/duel.css");
  const body = ctx.dock("left", { width: 340, title: "Metro Duel" });
  body.classList.add("dl");
  // A lens (population, income, home value…) would give the answers away: hide the lens bar while playing.
  app.setLens?.(null);
  document.body.classList.add("g-hide-lens");
  ctx.onCleanup(() => document.body.classList.remove("g-hide-lens"));
  const pool = D.duelPool(ctx.cities);
  const byId = new Map(pool.map((c) => [c.id, c]));
  ctx.onCleanup(() => app.setHighlight?.(null));
  // City banners carry population and their tooltips other numbers: hide them and label the two metros ourselves.
  app.setCitiesHidden(true);
  ctx.onCleanup(() => { app.setCitiesHidden(false); app.invalidate?.(); });
  ctx.addOverlay({
    id: "labels", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      const d = g && cur();
      if (!d || (g.over && g.reveal < 0)) return;
      c.font = "600 13px system-ui, sans-serif";
      for (const [id, tag, col] of [[d.a, "A", "#ecd08e"], [d.b, "B", HL]]) {
        const m = byId.get(id);
        const [sx, sy] = cam.toScreen(m.x, m.y);
        const text = `${tag} · ${m.name}`;
        const w = c.measureText(text).width + 14;
        const x = Math.min(cam.w - w - 6, Math.max(6, sx - w / 2)), y = sy - 36;
        c.fillStyle = "rgba(14,18,24,.92)"; c.strokeStyle = col; c.lineWidth = 1.5;
        c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 22, 5) : c.rect(x, y, w, 22); c.fill(); c.stroke();
        c.fillStyle = "#fff6dc"; c.fillText(text, x + 7, y + 15);
      }
    },
  });

  // g = {mode, key, seed, seq, answers: [bool], over, reveal (index being shown after an answer, or -1)}
  let g = null;
  let timer = 0;
  const online = { avail: false, status: "idle", res: null, board: null, err: null };

  // Races (shared/race.js): everyone plays the same practice seed; the room scores the result.
  const race = makeRace({ ctx, game: "duel", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `streak ${p.score}` });
  function newGame(mode, seedOrKey) {
    clearTimeout(timer);
    const seq = mode === "daily" ? D.duelSequence(pool, D.dailySeed(seedOrKey), D.DAILY_DUELS) : D.duelSequence(pool, `duel-practice:${seedOrKey}`, 400);
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, seq, answers: [], over: false, reveal: -1 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved)) {
        const r = D.streakOf(seq, saved);
        if (!r.error) { g.answers = saved.slice(0, r.answered); g.over = r.over; }
      }
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    frame();
    refresh();
    if (g.over && mode === "daily") postDaily();
  }
  const streak = () => D.streakOf(g.seq, g.answers).streak;
  const cur = () => g.seq[g.answers.length - (g.reveal >= 0 ? 1 : 0)];

  function answer(higher) {
    if (!g || g.over || g.reveal >= 0 || (race.active && g.mode !== "race")) return;
    const i = g.answers.length;
    g.answers.push(higher);
    const right = g.seq[i].higher === higher;
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.answers);
    if (g.mode === "race") race.progress({ round: g.answers.length, score: D.streakOf(g.seq, g.answers).streak });
    g.reveal = i;
    refresh();
    timer = setTimeout(() => {
      g.reveal = -1;
      if (!right || g.answers.length >= g.seq.length) { endRun(); return; }
      frame();
      refresh();
    }, right ? 1100 : 1600);
  }
  function endRun() {
    g.over = true;
    if (g.mode === "race") race.finish({ answers: g.answers });
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null, days: 0 });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, streak()); ctx.storage.set("stats", st); }
      postDaily();
    } else {
      const best = ctx.storage.get("pbest", 0);
      if (streak() > best) ctx.storage.set("pbest", streak());
    }
    refresh();
  }

  // --- map: light both metros and frame them ------------------------------------------------------------------
  function frame() {
    const d = cur();
    if (!d) return;
    const a = byId.get(d.a), b = byId.get(d.b);
    const h = { cities: new Set([a.id, b.id]), cells: new Set([...(a.footprint || [a.cell]), ...(b.footprint || [b.cell])]), color: HL, dimOthers: true };
    app.setHighlight?.(h);
    const bb = app.highlightBounds?.(h);
    if (bb) fitVisible(app, body, bb.x0 - 200, bb.y0 - 200, bb.x1 + 200, bb.y1 + 200, { maxScale: 0.9 });
  }

  // --- online board --------------------------------------------------------------------------------------------
  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !g.over || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/duel/daily", { key: g.key, answers: g.answers });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/duel/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  // --- panel ---------------------------------------------------------------------------------------------------
  const cityLabel = (c) => `${esc(c.name)} <span class="muted">${esc(c.states.join("-"))}</span>`;
  function duelHtml() {
    const i = g.reveal >= 0 ? g.reveal : g.answers.length;
    const d = g.seq[i];
    const s = D.statById(d.stat), a = byId.get(d.a), b = byId.get(d.b);
    const shown = g.reveal >= 0;
    const right = shown && g.answers[i] === d.higher;
    return `<div class="dl-q">Does <b>${esc(b.name)}</b> have ${esc(s.more)} than ${esc(a.name)}?</div>
      <div class="dl-card a"><div class="dl-city">${cityLabel(a)}</div><div class="dl-val">${esc(s.fmt(s.value(a)))}</div><div class="dl-stat">${esc(s.label)}</div></div>
      <div class="dl-vs">vs</div>
      <div class="dl-card b${shown ? (right ? " right" : " wrong") : ""}"><div class="dl-city">${cityLabel(b)}</div>
        <div class="dl-val">${shown ? esc(s.fmt(s.value(b))) : "?"}</div><div class="dl-stat">${esc(s.label)}</div></div>
      ${shown ? `<p class="dl-verdict ${right ? "ok" : "bad"}" role="status">${right ? "Right!" : `No: ${esc(b.name)} is ${d.higher ? "higher" : "lower"}.`}</p>`
        : `<div class="dl-btns"><button class="g-btn primary" data-act="hi">▲ Higher <kbd>↑</kbd></button><button class="g-btn primary" data-act="lo">▼ Lower <kbd>↓</kbd></button></div>`}
      <p class="g-note">Source: ${esc(s.src)} (cities.json).</p>`;
  }
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same 30 duels for everyone today. Share your streak to compare.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first run today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me
      ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="dl-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post streak</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="dl-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.streak}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.status === "sending" ? `<p class="g-note">Checking your answers…</p>` : ""}${online.err ? `<p class="dl-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }
  const share = () => `Metro Duel ${g.mode === "daily" ? g.key : "practice"} · streak ${streak()}${g.mode === "daily" && streak() === g.seq.length ? " (perfect)" : ""}\n${"🟦".repeat(Math.min(streak(), 30))}${g.over && streak() < g.seq.length ? "🟥" : ""}`;

  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.(); // the map overlays follow the game state
    const head = `<div class="dl-head"><div class="g-stat"><b>${streak()}</b><span>streak</span></div>
      <span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)} · ${g.answers.length}/${g.seq.length}` : g.mode === "race" ? "Race" : `Practice · best ${ctx.storage.get("pbest", 0)}`}</span></div>${race.active ? race.html() : ""}`;
    if (g.over && g.reveal < 0) {
      const last = g.seq[g.answers.length - 1];
      const missed = last && g.answers.at(-1) !== last.higher ? last : null;
      const s = missed && D.statById(missed.stat);
      const st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}
        <h3 class="dl-final">${streak()} <small>${streak() === 1 ? "duel" : "duels"} in a row</small></h3>
        ${missed ? `<p class="g-note">Ended on ${esc(s.label)}: ${esc(byId.get(missed.b).name)} ${esc(s.fmt(s.value(byId.get(missed.b))))} vs ${esc(byId.get(missed.a).name)} ${esc(s.fmt(s.value(byId.get(missed.a))))}.</p>` : `<p>A perfect day: all ${g.seq.length}!</p>`}
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">${g.mode === "practice" ? "Play again" : "Practice run"}</button><button class="g-btn" data-act="race-create" title="Race friends on the same duels">Race friends</button>
          ${g.mode === "practice" ? `<button class="g-btn" data-act="daily">Today's run</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("duel") : ""}${boardHtml()}
        ${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best daily streak ${st.best}</p>` : ""}
        ${how()}`;
      return;
    }
    body.innerHTML = `${head}${duelHtml()}${how()}`;
  }
  const how = () => `<details class="dl-how"><summary>How it works</summary><p>Two real metros and one statistic from the
    Census, BEA and population estimates. Guess whether the second is higher or lower; a right answer moves you on and the
    gaps get narrower. Today's run has 30 duels and is the same for everyone; the board takes your first run.</p></details>`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "hi": answer(true); break;
      case "lo": answer(false); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=duel`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || g.over) return false;
    if (k === "ArrowUp" || k === "h") { answer(true); return true; }
    if (k === "ArrowDown" || k === "l") { answer(false); return true; }
    return false;
  });
  ctx.onCleanup(() => clearTimeout(timer));

  app.duel = { get g() { return g; }, answer: (h) => answer(h) }; // debugging handle, removed on exit
  ctx.onCleanup(() => { delete app.duel; });

  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g && !g.over) frame(); }, 900); ctx.onCleanup(() => clearTimeout(t)); } // after the dock lays out
  const offPlayer = net.onPlayer?.(() => { if (g?.over) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => {
    online.avail = !!ok;
    if (ok && g?.over && g.mode === "daily") postDaily(); else refresh();
  });

  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
