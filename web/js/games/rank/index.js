// Metro Ranking (sim/rank.js): five real metros and one statistic; put them in order, highest first. Click the
// metros (in the panel or on the map) from highest to lowest, then lock in. Five rounds a day, the same for everyone.
//   #play=rank            today's game (resumes after a reload)
//   #play=rank~p-<seed>   practice
// Saves: "d:<key>" = today's orders, "stats" = {played, best, last}. Online: the day's board (/api/rank/daily).
import { loadCss } from "../shared/css.js";
import { fitVisible } from "../shared/frame.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as R from "./sim/rank.js";

const HL = "#7fd7ff";
const LETTERS = "ABCDE";
const utcKey = () => new Date().toISOString().slice(0, 10);

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/rank.css");
  const body = ctx.dock("left", { width: 340, title: "Metro Ranking" });
  body.classList.add("rkg");
  // A lens (population, income, home value…) would give the answers away: hide the lens bar while playing.
  app.setLens?.(null);
  document.body.classList.add("g-hide-lens");
  ctx.onCleanup(() => document.body.classList.remove("g-hide-lens"));
  const pool = R.rankPool(ctx.cities);
  const byId = new Map(pool.map((c) => [c.id, c]));
  const byCell = new Map();
  for (const c of pool) for (const cell of c.footprint || [c.cell]) byCell.set(cell, c.id);
  // City banners show population and their tooltips other numbers: hide them and label the five metros ourselves.
  app.setCitiesHidden(true);
  ctx.onCleanup(() => { app.setHighlight?.(null); app.setCitiesHidden(false); app.invalidate?.(); });
  ctx.addOverlay({
    id: "labels", z: 101, space: "screen", snapshot: false,
    draw(c, cam) {
      if (!g || done()) return;
      const r = cur();
      const s = R.statById(r.stat);
      c.font = "600 13px system-ui, sans-serif";
      r.ids.forEach((id, i) => {
        const m = byId.get(id);
        const [sx, sy] = cam.toScreen(m.x, m.y);
        const placed = g.pending.indexOf(id);
        const truth = r.order.indexOf(id);
        const text = shown() ? `${truth + 1}. ${m.name} · ${s.fmt(s.value(m))}` : `${LETTERS[i]} · ${m.name}${placed >= 0 ? `  #${placed + 1}` : ""}`;
        const w = c.measureText(text).width + 14;
        const x = Math.min(cam.w - w - 6, Math.max(6, sx - w / 2)), y = sy - 34;
        const ok = shown() && g.orders[g.showing][truth] === id;
        c.fillStyle = "rgba(14,18,24,.92)";
        c.strokeStyle = shown() ? (ok ? "#6fd68a" : "#ff9c8a") : placed >= 0 ? "#ecd08e" : HL;
        c.lineWidth = 1.5;
        c.beginPath(); c.roundRect ? c.roundRect(x, y, w, 22, 5) : c.rect(x, y, w, 22); c.fill(); c.stroke();
        c.fillStyle = "#fff6dc"; c.fillText(text, x + 7, y + 15);
      });
    },
  });

  // g = {mode, key, seed, rounds, orders: [[id×5]…] (locked in), pending: [id…] (this round so far), showing (index
  // of the round being revealed, or -1)}
  let g = null;
  const online = { avail: false, status: "idle", res: null, board: null, err: null };
  const race = makeRace({ ctx, game: "rank", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `${p.score} pts` });

  function newGame(mode, seedOrKey) {
    const rounds = R.rankRounds(pool, mode === "daily" ? R.dailySeed(seedOrKey) : R.practiceSeed(seedOrKey));
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, rounds, orders: [], pending: [], showing: -1 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved)) for (let i = 0; i < saved.length && i < rounds.length && R.validOrder(rounds[i], saved[i]); i++) g.orders.push(saved[i]);
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    frame();
    refresh();
    if (done() && mode === "daily") postDaily();
  }
  const done = () => g.orders.length >= g.rounds.length && g.showing < 0;
  const shown = () => g.showing >= 0;
  const cur = () => g.rounds[shown() ? g.showing : Math.min(g.orders.length, g.rounds.length - 1)];
  const total = () => g.orders.reduce((a, o, i) => a + R.roundPoints(g.rounds[i], o), 0);
  const locked = () => !g || done() || shown() || (race.active && g.mode !== "race");

  function place(id) {
    if (locked() || !cur().ids.includes(id)) return;
    const at = g.pending.indexOf(id);
    if (at >= 0) g.pending.splice(at, 1);
    else if (g.pending.length < R.SIZE) g.pending.push(id);
    // the last metro has only one place left: fill it in
    if (g.pending.length === R.SIZE - 1) g.pending.push(cur().ids.find((x) => !g.pending.includes(x)));
    refresh();
  }
  function undo() { if (!locked() && g.pending.length) { g.pending.pop(); if (g.pending.length === R.SIZE - 1) g.pending.pop(); refresh(); } }
  function lockIn() {
    if (locked() || g.pending.length !== R.SIZE) return;
    g.showing = g.orders.length;
    g.orders.push(g.pending);
    g.pending = [];
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.orders);
    if (g.mode === "race") race.progress({ round: g.orders.length, score: total() });
    refresh();
  }
  function next() {
    if (!shown()) return;
    g.showing = -1;
    if (g.orders.length >= g.rounds.length) finish();
    else { frame(); refresh(); }
  }
  function finish() {
    const s = total();
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, s); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ orders: g.orders });
    app.setHighlight?.(null);
    refresh();
  }

  function frame() {
    if (!g || done()) return;
    const ms = cur().ids.map((id) => byId.get(id));
    const h = { cities: new Set(ms.map((m) => m.id)), cells: new Set(ms.flatMap((m) => m.footprint || [m.cell])), color: HL, dimOthers: true };
    app.setHighlight?.(h);
    const bb = app.highlightBounds?.(h);
    if (bb) fitVisible(app, body, bb.x0 - 250, bb.y0 - 250, bb.x1 + 250, bb.y1 + 250, { maxScale: 0.9 });
  }

  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !done() || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; online.err = null; refresh();
    const r = await net.post("/api/rank/daily", { key: g.key, orders: g.orders });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/rank/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  const cityLabel = (m) => `${esc(m.name)} <span class="muted">${esc(m.states.join("-"))}</span>`;
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same five rankings for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}${online.res.stored ? ` <span class="g-note">(your first game today counts)</span>` : ""}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="rk-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="rk-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.status === "sending" ? `<p class="g-note">Checking your rankings…</p>` : ""}${online.err ? `<p class="rk-err" role="alert">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }

  function roundHtml() {
    const r = cur();
    const s = R.statById(r.stat);
    if (shown()) {
      const mine = g.orders[g.showing];
      const pts = R.roundPoints(r, mine);
      return `<p class="rk-q">Ranked by <b>${esc(s.label)}</b>, highest first:</p>
        <ol class="rk-answer">${r.order.map((id, i) => {
          const m = byId.get(id);
          const yours = mine.indexOf(id);
          return `<li class="${yours === i ? "ok" : "bad"}"><span class="pos">${i + 1}</span><span class="nm">${cityLabel(m)}</span><span class="v">${esc(s.fmt(s.value(m)))}</span>${yours === i ? "" : `<span class="yours" title="where you put it">you: ${yours + 1}</span>`}</li>`;
        }).join("")}</ol>
        <p class="rk-verdict ${pts === R.MAX_ROUND ? "ok" : pts >= 70 ? "mid" : "bad"}" role="status">${pts === R.MAX_ROUND ? "Perfect order!" : `${pts / R.PAIR_POINTS} of 10 pairs in the right order`}: <b>${pts}</b> points.</p>
        <p class="g-note">Source: ${esc(s.src)} (cities.json).</p>
        <button class="g-btn primary rk-next" data-act="next">${g.orders.length < g.rounds.length ? "Next round" : "See your score"} <kbd>⏎</kbd></button>`;
    }
    const full = g.pending.length === R.SIZE;
    return `<p class="rk-q">Rank these metros by <b>${esc(s.label)}</b>, <b>highest first</b>. <span class="g-note">Click them in order (here or on the map); click again to take one back.</span></p>
      <div class="rk-opts">${r.ids.map((id, i) => {
        const m = byId.get(id);
        const at = g.pending.indexOf(id);
        return `<button class="g-btn rk-opt${at >= 0 ? " placed" : ""}" data-act="place" data-id="${esc(id)}" aria-pressed="${at >= 0}"><span class="lt">${LETTERS[i]}</span><span class="nm">${cityLabel(m)}</span><span class="slot">${at >= 0 ? `#${at + 1}` : ""}</span></button>`;
      }).join("")}</div>
      <div class="rk-order" aria-label="Your order">${Array.from({ length: R.SIZE }, (_, i) => {
        const id = g.pending[i];
        return `<span class="${id ? "f" : ""}">${i === 0 ? "▲ " : i === R.SIZE - 1 ? "▼ " : ""}${id ? esc(byId.get(id).name) : "&nbsp;"}</span>`;
      }).join("")}</div>
      <div class="g-row"><button class="g-btn primary" data-act="lock" ${full ? "" : "disabled"}>Lock in <kbd>⏎</kbd></button><button class="g-btn" data-act="undo" ${g.pending.length ? "" : "disabled"}>Undo <kbd>⌫</kbd></button></div>`;
  }

  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    app.requestDraw?.();
    const dots = g.rounds.map((r, i) => {
      if (i >= g.orders.length) return `<i class="${i === g.orders.length ? "cur" : ""}"></i>`;
      const p = R.roundPoints(r, g.orders[i]);
      return `<i class="${p === R.MAX_ROUND ? "ok" : p >= 70 ? "mid" : "bad"}" title="${p} points"></i>`;
    }).join("");
    const head = `<div class="rk-head"><span class="rk-dots">${dots}</span><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"} · ${total()} pts</span></div>${race.active ? race.html() : ""}`;
    if (done()) {
      const st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}<h3 class="rk-final">${total()} <small>of ${R.MAX_SCORE}</small></h3>
        <ul class="rk-list">${g.rounds.map((r, i) => `<li>${R.square(R.roundPoints(r, g.orders[i]))} ${esc(R.statById(r.stat).label)} <b>${R.roundPoints(r, g.orders[i])}</b></li>`).join("")}</ul>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice round</button><button class="g-btn" data-act="race-create" title="Race friends on the same five rankings">Race friends</button>${g.mode !== "daily" ? `<button class="g-btn" data-act="daily">Today's game</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("rank") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}/${R.MAX_SCORE}</p>` : ""}${how()}`;
      return;
    }
    body.innerHTML = `${head}${roundHtml()}${how()}`;
    if (shown()) body.querySelector(".rk-next")?.focus({ preventScroll: true });
  }
  const how = () => `<details class="rk-how"><summary>How it works</summary><p>Five real metros and one statistic from the
    Census, BEA and population estimates. Put them in order, highest first: every pair you order correctly is worth 10
    points (10 pairs, 100 a round). The five are always at least 8% apart, so there is one right order. Five rounds a day,
    the same for everyone; the board takes your first game.</p></details>`;
  const share = () => `Metro Ranking ${g.mode === "daily" ? g.key : "practice"} · ${total()}/${R.MAX_SCORE}\n${g.rounds.map((r, i) => R.square(R.roundPoints(r, g.orders[i]))).join("")}`;

  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "race-create") { race.create(); return; }
    if (act === "race-leave") { race.click(act, t); newGame("daily", utcKey()); return; }
    if (act.startsWith("race-")) { race.click(act, t); return; }
    switch (act) {
      case "place": place(t.dataset.id); break;
      case "undo": undo(); break;
      case "lock": lockIn(); break;
      case "next": next(); break;
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=rank`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g || done()) return false;
    if (k === "l" || k === "L") return true; // no lens switching while ranking (a lens would give it away)
    if (shown()) { if ((k === "Enter" || k === "n") && e.target?.tagName !== "BUTTON") { next(); return true; } return false; }
    if (/^[1-5]$/.test(k)) { place(cur().ids[+k - 1]); return true; }
    const li = LETTERS.indexOf(k.toUpperCase());
    if (k.length === 1 && li >= 0) { place(cur().ids[li]); return true; }
    if (k === "Backspace") { undo(); return true; }
    if (k === "Enter" && e.target?.tagName !== "BUTTON") { lockIn(); return true; }
    return false;
  });
  ctx.on("mapclick", (ev) => {
    if (!g) return true;
    if (shown()) { next(); return true; }
    const id = byCell.get(ev.cell);
    if (id) place(id);
    return true;
  });

  app.rank = { get g() { return g; }, place: (id) => place(id), lockIn: () => lockIn(), next: () => next() }; // debugging handle
  ctx.onCleanup(() => { delete app.rank; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  { const t = setTimeout(() => { if (g && !done()) frame(); }, 900); ctx.onCleanup(() => clearTimeout(t)); } // after the dock lays out
  const offPlayer = net.onPlayer?.(() => { if (g && done()) refresh(); });
  ctx.onCleanup(() => offPlayer?.());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g && done() && g.mode === "daily") postDaily(); else refresh(); });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
