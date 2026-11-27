// Lens Detective (sim/lens.js): which data lens is colouring the map? The lens name, its legend and every tooltip are
// hidden; you get the colours, the real country under them and four choices. Six rounds a day, the same for everyone.
//   #play=lens            today's game (resumes after a reload)
//   #play=lens~p-<seed>   practice
// Saves: "d:<key>" = today's picks, "stats" = {played, best, last}. Online: the day's board (/api/lens/daily).
import { loadCss } from "../shared/css.js";
import { makeRace } from "../shared/race.js";
import { net } from "../shared/net.js";
import { nextDailyHtml } from "../shared/nextdaily.js";
import { esc } from "../../format.js";
import * as L from "./sim/lens.js";

const utcKey = () => new Date().toISOString().slice(0, 10);

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/lens.css");
  const body = ctx.dock("left", { width: 330, title: "Lens Detective" });
  body.classList.add("ld");
  const lensFile = ctx.data.lenses || (await ctx.loadData("lenses").catch(() => null));
  const pool = L.lensPool(lensFile);
  const byId = new Map((lensFile?.lenses || []).map((l) => [l.id, l]));
  // Hide everything that names the lens: the lens dock and legend (CSS), and tooltips (they print the value's name).
  document.body.classList.add("ld-hide-lens");
  app.setCitiesHidden(true);
  app.setLensSecret?.(true);
  ctx.onCleanup(() => { app.setLensSecret?.(false); document.body.classList.remove("ld-hide-lens"); app.setCitiesHidden(false); app.setLens?.(null); app.invalidate?.(); });

  let g = null; // {mode, key, seed, rounds, picks: [id]}
  const online = { avail: false, status: "idle", res: null, board: null, err: null };

  // Races (shared/race.js): everyone plays the same practice seed; the room scores the picks.
  const race = makeRace({ ctx, game: "lens", onLive: (seed) => newGame("race", seed), onChange: () => refresh(), label: (p) => `${p.score}/${p.round || 0}` });
  function newGame(mode, seedOrKey) {
    const rounds = L.lensRounds(pool, mode === "daily" ? L.dailySeed(seedOrKey) : `lens-practice:${seedOrKey}`);
    g = { mode, key: mode === "daily" ? seedOrKey : null, seed: mode === "daily" ? null : seedOrKey, rounds, picks: [], showing: -1 };
    if (mode === "daily") {
      const saved = ctx.storage.get(`d:${seedOrKey}`, null);
      if (Array.isArray(saved)) g.picks = saved.filter((id, i) => rounds[i]?.options.includes(id)).slice(0, rounds.length);
    }
    online.status = "idle"; online.res = null; online.board = null; online.err = null;
    ctx.setParam(mode === "daily" ? null : mode === "race" ? `race-${race.code}` : `p-${seedOrKey}`);
    showLens();
    app.home?.();
    refresh();
    if (done() && mode === "daily") postDaily();
  }
  const done = () => g.picks.length >= g.rounds.length && g.showing < 0;
  const cur = () => g.rounds[Math.min(g.showing >= 0 ? g.showing : g.picks.length, g.rounds.length - 1)];
  function showLens() { if (!done()) app.setLens?.(cur().answer); else app.setLens?.(null); }

  function pick(id) {
    if (!g || g.showing >= 0 || g.picks.length >= g.rounds.length || (race.active && g.mode !== "race")) return;
    g.showing = g.picks.length;
    g.picks.push(id);
    if (g.mode === "daily") ctx.storage.set(`d:${g.key}`, g.picks);
    if (g.mode === "race") race.progress({ round: g.picks.length, score: g.picks.filter((x, i) => x === g.rounds[i].answer).length });
    refresh();
  }
  function next() {
    if (g.showing < 0) return;
    g.showing = -1;
    if (g.picks.length >= g.rounds.length) finish();
    else { showLens(); refresh(); }
  }
  function finish() {
    const s = L.scoreLens(g.rounds, g.picks).score;
    if (g.mode === "daily") {
      const st = ctx.storage.get("stats", { played: 0, best: 0, last: null });
      if (st.last !== g.key) { st.played++; st.last = g.key; st.best = Math.max(st.best, s); ctx.storage.set("stats", st); }
      postDaily();
    }
    if (g.mode === "race") race.finish({ picks: g.picks });
    showLens();
    refresh();
  }

  async function postDaily({ nick = null } = {}) {
    if (!online.avail || g.mode !== "daily" || !done() || online.status === "sending") return;
    if (!net.player()) {
      if (!nick) { await loadBoard(); return; }
      try { await net.ensurePlayer(nick); } catch (err) { online.err = err.message; refresh(); return; }
    }
    const mine = g;
    online.status = "sending"; refresh();
    const r = await net.post("/api/lens/daily", { key: g.key, picks: g.picks });
    if (g !== mine) return;
    if (r.ok) { online.res = r.data; online.status = "done"; } else { online.status = "error"; online.err = r.error; }
    await loadBoard();
  }
  async function loadBoard() {
    const mine = g;
    const r = await net.get(`/api/lens/daily/${g.key}?limit=10`);
    if (g !== mine) return;
    online.board = r.ok ? r.data : null;
    refresh();
  }

  const nameOf = (id) => byId.get(id)?.name || id;
  function boardHtml() {
    if (g.mode !== "daily") return "";
    if (!online.avail) return `<p class="g-note">The same six lenses for everyone today.</p>`;
    const b = online.board, me = net.player();
    const res = online.res ? `<p>On today's board: <b>#${online.res.rank}</b> of ${online.res.total}.</p>` : "";
    const post = !online.res && online.status !== "sending" ? (me ? `<button class="g-btn primary" data-act="post">Post as ${esc(me.name)}</button>`
      : `<div class="g-row"><label class="ld-nick">Nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label><button class="g-btn primary" data-act="post">Post score</button></div>
         <p class="g-note"><button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button></p>`) : "";
    const rows = b?.top?.length ? `<ol class="ld-top">${b.top.map((r) => `<li><span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score}/6</span></li>`).join("")}</ol><p class="g-note">${b.total} player${b.total === 1 ? "" : "s"} today.</p>` : b ? `<p class="g-note">Nobody has posted today yet.</p>` : "";
    return `<div class="g-section">Today's board</div>${res}${online.err ? `<p class="ld-err">${esc(online.err)}</p>` : ""}${post}${rows}`;
  }
  function refresh() {
    if (race.active && g?.mode !== "race") { body.innerHTML = race.html() + how(); return; } // the lobby
    if (!g) return;
    const dots = g.rounds.map((r, i) => `<i class="${i < g.picks.length ? (g.picks[i] === r.answer ? "ok" : "bad") : i === g.picks.length ? "cur" : ""}"></i>`).join("");
    const head = `<div class="ld-head"><span class="ld-dots">${dots}</span><span class="g-note">${g.mode === "daily" ? `Daily ${esc(g.key)}` : g.mode === "race" ? "Race" : "Practice"}</span></div>${race.active ? race.html() : ""}`;
    if (done()) {
      const sc = L.scoreLens(g.rounds, g.picks);
      const st = ctx.storage.get("stats", null);
      body.innerHTML = `${head}<h3 class="ld-final">${sc.score} <small>of ${g.rounds.length}</small></h3>
        <ul class="ld-list">${g.rounds.map((r, i) => `<li class="${sc.results[i] ? "ok" : "bad"}">${sc.results[i] ? "✓" : "✗"} <b>${esc(nameOf(r.answer))}</b>${sc.results[i] ? "" : ` <span class="muted">(you said ${esc(nameOf(g.picks[i]))})</span>`}</li>`).join("")}</ul>
        <div class="g-row"><button class="g-btn primary" data-act="share">Copy result</button><button class="g-btn" data-act="practice">Practice round</button><button class="g-btn" data-act="race-create" title="Race friends on the same six lenses">Race friends</button>${g.mode === "practice" ? `<button class="g-btn" data-act="daily">Today's game</button>` : ""}</div>
        ${g.mode === "daily" ? nextDailyHtml("lens") : ""}${boardHtml()}${st && g.mode === "daily" ? `<p class="g-note">Days played ${st.played} · best ${st.best}/6</p>` : ""}${how()}`;
      return;
    }
    const r = cur();
    const shown = g.showing >= 0;
    const lens = byId.get(r.answer);
    body.innerHTML = `${head}<p class="ld-q">Which lens is colouring the map? <span class="g-note">Bright and dark ends: high and low (or the reverse).</span></p>
      <div class="ld-opts">${r.options.map((id) => {
        const cls = !shown ? "" : id === r.answer ? " right" : id === g.picks[g.showing] ? " wrong" : " dim";
        return `<button class="g-btn ld-opt${cls}" data-act="pick" data-id="${esc(id)}" ${shown ? "disabled" : ""}>${esc(byId.get(id)?.emoji || "")} ${esc(nameOf(id))}</button>`;
      }).join("")}</div>
      ${shown ? `<p class="ld-verdict ${g.picks[g.showing] === r.answer ? "ok" : "bad"}" role="status">${g.picks[g.showing] === r.answer ? "Right!" : `It was ${esc(nameOf(r.answer))}.`}</p>
        <p class="g-note">${esc(lens?.name || "")}: ${esc(lens?.unit || "")}. ${esc((lens?.description || "").split(". ")[0])}.</p>
        <button class="g-btn primary ld-next" data-act="next">${g.picks.length < g.rounds.length ? "Next lens" : "See your score"} <kbd>⏎</kbd></button>` : ""}${how()}`;
    if (shown) body.querySelector(".ld-next")?.focus({ preventScroll: true });
  }
  const how = () => `<details class="ld-how"><summary>How it works</summary><p>Each round colours every hex by one of the
    site's data lenses (Census ACS, USDA/NLCD land cover, religion census, FEMA declarations and more). Its name and
    legend are hidden. One decoy usually comes from the same family, so read the pattern: cities, coasts, the Black Belt,
    the Mormon corridor, the Corn Belt…</p></details>`;
  const share = () => `Lens Detective ${g.mode === "daily" ? g.key : "practice"} · ${L.scoreLens(g.rounds, g.picks).score}/6\n${g.rounds.map((r, i) => (g.picks[i] === r.answer ? "🟩" : "🟥")).join("")}`;

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
      case "share": navigator.clipboard?.writeText(`${share()}\n${location.origin}${location.pathname}#play=lens`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
      case "practice": newGame("practice", Math.random().toString(36).slice(2, 8)); break;
      case "daily": newGame("daily", utcKey()); break;
      case "post": postDaily({ nick: body.querySelector('[data-field="nick"]')?.value?.trim() || null }); break;
    }
  });
  ctx.onKey((e, k) => {
    if (!g) return false;
    if (g.showing >= 0 && (k === "Enter" || k === "n") && e.target?.tagName !== "BUTTON") { next(); return true; }
    if (g.showing < 0 && /^[1-4]$/.test(k) && !done()) { pick(cur().options[+k - 1]); return true; }
    return false;
  });
  ctx.on("mapclick", () => true); // the map is just for looking

  app.lensgame = { get g() { return g; }, pick: (id) => pick(id), next: () => next() }; // debugging handle
  ctx.onCleanup(() => { delete app.lensgame; });
  const pm = /^p-([a-z0-9]{1,12})$/.exec(ctx.param || "");
  const rc = /^race-([A-Za-z0-9]{6})$/.exec(ctx.param || "");
  if (rc) race.join(rc[1].toUpperCase());
  else newGame(pm ? "practice" : "daily", pm ? pm[1] : utcKey());
  net.available().then((ok) => { online.avail = !!ok; if (ok && g && done() && g.mode === "daily") postDaily(); else refresh(); });
  return { stop() {}, onEscape: () => true, param: () => (race.active ? `race-${race.code}` : g?.mode === "practice" ? `p-${g.seed}` : null) };
}
