// Which Metro? A daily data puzzle: name the metro from its workforce, way of life, industries, size and place.
// Contract: games/host.js (start(ctx) → session). Pure logic lives in ./sim/ (unit-tested in tests/js).
//
// Map etiquette while a round is open: no highlight, no fly-to, every banner softened (app.state.bannerFocus = an
// empty Set, so no yield rows or city-type tabs either) and map clicks swallowed, so nothing on the map points at
// the answer. When a round ends the answer's footprint is outlined and framed and its banner comes back.
import { loadCss } from "../shared/css.js";
import { esc } from "../../format.js";
import {
  ROUNDS, MAX_CLUES, buildPool, dailyAnswers, practiceAnswers, parseParam, puzzleNumber, newPracticeSeed,
} from "./sim/puzzle.js";
import { buildClues, whyLine } from "./sim/clues.js";
import {
  newGame, reveal, guess, nextRound, currentRound, roundPoints, pointsAtStake, totalScore, roundSquares, shareText,
  emptyStats, updateStats, liveStreak, distBuckets, validSave, MAX_SCORE,
} from "./sim/game.js";
import { buildIndex, matchCities, cityLabel } from "./sim/search.js";

const HL_COLOR = "#ecd08e";

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/whichMetro.css");
  const body = ctx.dock("left", { width: 400 });
  body.classList.add("wm");
  body.innerHTML = `<p class="wm-loading">Gathering the clues…</p>`;

  // --- map etiquette (restored on exit) ----------------------------------------------------------------------
  const st = app.state || {};
  const prevFocus = st.bannerFocus ?? null;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (app.state) app.state.bannerFocus = prevFocus;
    app.setHighlight?.(null);
    app.requestDraw?.();
  };
  ctx.onCleanup(restore);
  const softenBanners = (ids) => {
    if (!app.state) return;
    app.state.bannerFocus = new Set(ids || []);
    app.requestDraw?.();
  };
  softenBanners([]);
  app.setHighlight?.(null);

  const [citizens, districts] = await Promise.all([
    ctx.loadData("citizens").catch(() => null),
    ctx.loadData("districts").catch(() => null),
  ]);
  if (restored) return { stop: restore };

  const pool = buildPool(ctx.cities);
  const index = buildIndex(ctx.cities);
  const data = { citizens, districts, nation: ctx.data.nation, pool };
  const today = ctx.todayKey();
  const clueCache = new Map();
  const cluesFor = (id) => {
    if (!clueCache.has(id)) {
      const c = ctx.cityById.get(id);
      clueCache.set(id, { clues: buildClues(c, data), why: whyLine(c, data) });
    }
    return clueCache.get(id);
  };

  // --- state -------------------------------------------------------------------------------------------------
  let meta = null;   // {mode, key, seed}
  let game = null;
  let view = "intro"; // intro | play | summary
  let stats = { ...emptyStats(), ...(ctx.storage.get("stats") || {}) };
  let ui = { q: "", matches: [], active: -1, listOpen: false };
  let framedRound = -1;

  const paramOf = (m) => (m.mode === "practice" ? `practice-${m.seed}` : m.key);
  const saveKey = (m) => (m.mode === "practice" ? "practice" : `game:${m.key}`);
  const shareUrl = () => `${location.origin}${location.pathname}#play=${encodeURIComponent(ctx.game.id)}~${encodeURIComponent(paramOf(meta))}`;

  function load(m) {
    meta = m;
    const answers = m.mode === "practice" ? practiceAnswers(pool, m.seed) : dailyAnswers(pool, m.key);
    const saved = ctx.storage.get(saveKey(m));
    const same = saved && (m.mode !== "practice" || saved.seed === m.seed);
    game = same && validSave(saved, answers)
      ? saved
      : newGame({ mode: m.mode, key: m.key, seed: m.seed, number: m.key ? puzzleNumber(m.key) : null, answers });
    framedRound = -1;
    ctx.setParam(paramOf(m));
    const started = game.idx > 0 || game.rounds[0].steps.length > 0;
    view = game.done ? "summary" : started || m.mode === "practice" ? "play" : "intro";
    render();
  }

  function persist() {
    ctx.storage.set(saveKey(meta), game);
    if (meta.mode === "daily" && game.rounds.every((r) => r.done)) {
      const perfect = game.rounds.filter((r) => roundPoints(r) === MAX_CLUES).length;
      stats = updateStats(stats, meta.key, totalScore(game), perfect);
      ctx.storage.set("stats", stats);
    }
  }

  function act(next) {
    if (next === game) return false;
    game = next;
    persist();
    if (game.done) view = "summary";
    ui = { q: "", matches: [], active: -1, listOpen: false };
    render();
    return true;
  }

  // --- rendering ---------------------------------------------------------------------------------------------
  function render() {
    if (view === "intro") renderIntro();
    else if (view === "summary") renderSummary();
    else renderPlay();
    syncMap();
  }

  function modeLine() {
    if (meta.mode === "practice") return `Practice puzzle <code>${esc(meta.seed)}</code>`;
    if (meta.mode === "archive") return `Puzzle #${puzzleNumber(meta.key)} · ${esc(meta.key)} <span class="wm-tag">archive, not scored in stats</span>`;
    return `Puzzle #${puzzleNumber(meta.key)} · ${esc(meta.key)}`;
  }

  function renderIntro() {
    body.innerHTML = `
      <div class="wm-hero">
        <div class="wm-kicker">${modeLine()}</div>
        <h3 class="wm-title">Name the metro from its numbers</h3>
        <p>Five American metros, drawn from the ${pool.length} most populous. Each starts with one clue: real public data, no names.</p>
        <ol class="wm-rules">
          <li><b>Who works here</b>, then <b>how people live</b>, <b>what the economy does</b>, <b>size and wealth</b>, and finally <b>where it is</b>.</li>
          <li>Guess any city. A wrong guess or <i>Next clue</i> uncovers the next clue.</li>
          <li>Points: <b>5</b> on the first clue down to <b>1</b> on the last, <b>0</b> if you miss. Best score ${MAX_SCORE}.</li>
        </ol>
        <div class="g-row"><button class="g-btn primary wm-big" data-act="start" type="button">${meta.mode === "daily" ? "Play today's puzzle" : "Start"}</button>
          ${meta.mode !== "practice" ? `<button class="g-btn" data-act="practice" type="button">Practice</button>` : ""}</div>
      </div>
      ${stats.played ? statsHtml() : ""}
      <p class="g-note">Data: ACS 2025 1-year (Census), BLS QCEW 2025, BEA GDP 2024. A new puzzle every day at local midnight.</p>`;
    body.querySelector("[data-act=start]")?.focus();
  }

  function pipsHtml() {
    return `<div class="wm-pips" aria-label="Rounds">${game.rounds.map((r, k) => {
      const cls = r.done ? (r.solved ? "ok" : "miss") : k === game.idx ? "now" : "";
      const t = r.done ? `${roundPoints(r)}` : k === game.idx ? "•" : "";
      return `<span class="wm-pip ${cls}" title="Round ${k + 1}${r.done ? `: ${roundPoints(r)} pts` : ""}">${t}</span>`;
    }).join("")}<span class="wm-score">${totalScore(game)}<small>/${MAX_SCORE}</small></span></div>`;
  }

  function renderPlay() {
    const r = currentRound(game);
    const { clues, why } = cluesFor(r.answer);
    const city = ctx.cityById.get(r.answer);
    const wrong = r.steps.filter((s) => s.t === "miss").map((s) => ctx.cityById.get(s.id)).filter(Boolean);
    const shown = r.done ? MAX_CLUES : r.clues;
    let top;
    if (!r.done) {
      const stake = pointsAtStake(r);
      top = `
        <div class="wm-status"><span>Round <b>${game.idx + 1}</b> of ${ROUNDS} · clue <b>${r.clues}</b> of ${MAX_CLUES}</span>
          <span class="wm-stake" title="Points for a correct guess now">${stake} pt${stake === 1 ? "" : "s"}</span></div>
        <div class="wm-cluebar" aria-hidden="true">${Array.from({ length: MAX_CLUES }, (_, k) => `<i class="${k < r.clues ? "on" : ""}"></i>`).join("")}</div>
        <form class="wm-guess" autocomplete="off">
          <div class="wm-combo">
            <input class="wm-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wm-list"
              aria-label="Your guess: type a city" placeholder="Type a city…" spellcheck="false" autocapitalize="words" enterkeyhint="go">
            <ul id="wm-list" class="wm-list" role="listbox" hidden></ul>
          </div>
          <button class="g-btn primary" type="submit">Guess</button>
        </form>
        <div class="wm-actions">
          <button class="g-btn wm-skip" data-act="skip" type="button">${r.clues < MAX_CLUES ? `Next clue <small>−1 pt</small>` : "Give up"}</button>
          <span class="g-note wm-keys">Enter guesses · Shift+Enter ${r.clues < MAX_CLUES ? "next clue" : "gives up"}</span>
        </div>
        ${wrong.length ? `<div class="wm-wrong">${wrong.map((c) => `<span class="wm-chip-x">✗ ${esc(cityLabel(c))}</span>`).join("")}</div>` : ""}`;
    } else {
      const pts = roundPoints(r);
      const last = game.idx >= game.rounds.length - 1;
      top = `
        <div class="wm-reveal ${r.solved ? "ok" : "miss"}">
          <div class="wm-reveal-head"><span class="wm-verdict">${r.solved ? (pts === MAX_CLUES ? "First clue!" : "Got it") : "Missed"}</span>
            <span class="wm-pts">+${pts}</span></div>
          <div class="wm-answer">${esc(city.name)}<small>${esc(city.full.replace(/ (Metro|Micro)politan Statistical Area$| (Metro|Micro) Area$/, ""))}</small></div>
          <div class="wm-squares" aria-label="Your steps">${roundSquares(r)}</div>
          <p class="wm-why"><b>Why:</b> ${esc(why.text)}</p>
          ${wrong.length ? `<p class="g-note">Your guesses: ${wrong.map((c) => esc(cityLabel(c))).join(", ")}</p>` : ""}
          <div class="g-row"><button class="g-btn primary wm-big" data-act="next" type="button">${last ? "See results" : "Next round"} <small>⏎</small></button></div>
        </div>`;
    }
    const list = [];
    for (let k = shown - 1; k >= 0; k--) list.push(clueHtml(clues[k], k, !r.done && k === r.clues - 1, r.done && k >= r.clues));
    body.innerHTML = `${pipsHtml()}${top}<div class="wm-clues">${list.join("")}</div>`;
    if (!r.done) {
      const input = body.querySelector(".wm-input");
      wireCombo(input);
      if (!matchMedia("(pointer: coarse)").matches) input.focus({ preventScroll: true });
    } else {
      body.querySelector("[data-act=next]")?.focus({ preventScroll: true });
    }
  }

  function clueHtml(c, k, fresh, bonus) {
    const head = `<header><span class="wm-num">${k + 1}</span><h4>${esc(c.title)}</h4>${bonus ? `<span class="wm-tag">unused</span>` : ""}</header>`;
    let inner = c.lead ? `<p class="wm-lead">${esc(c.lead)}</p>` : "";
    if (c.bars?.length) {
      const max = Math.max(0.05, ...c.bars.map((b) => Math.max(b.share, b.national)));
      inner += `<div class="wm-bars">${c.bars.map((b) => {
        const dir = b.share >= 0.01 && b.ratio >= 1.2 ? "up" : b.national >= 0.01 && b.ratio <= 0.83 ? "down" : "";
        return `<div class="wm-bar ${dir}"><span class="wm-bl">${esc(b.label)}</span>
          <span class="wm-track"><span class="wm-fill" style="width:${((b.share / max) * 100).toFixed(1)}%"></span>
          <span class="wm-tick" style="left:${((b.national / max) * 100).toFixed(1)}%" title="US ${(b.national * 100).toFixed(1)}%"></span></span>
          <span class="wm-bv">${(b.share * 100).toFixed(1)}%${dir ? `<i class="wm-dir ${dir}" aria-label="${dir === "up" ? "above" : "below"} the US share"></i>` : ""}</span></div>`;
      }).join("")}</div>`;
    }
    const chipsHtml = () => (c.chips?.length ? `${c.chipsTitle ? `<div class="wm-sub">${esc(c.chipsTitle)}</div>` : ""}<div class="wm-chips">${c.chips.map((ch) => `
        <div class="wm-chip" ${ch.color ? `style="--chip:${esc(ch.color)}"` : ""}><b>${esc(ch.label)}</b><span>${esc(ch.value)}</span>${ch.note ? `<small>${esc(ch.note)}</small>` : ""}</div>`).join("")}</div>` : "");
    const factsHtml = () => (c.facts?.length ? `${c.factsTitle ? `<div class="wm-sub">${esc(c.factsTitle)}</div>` : ""}<dl class="wm-facts">${c.facts.map((f) => `
        <div class="wm-fact"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}${f.dir ? `<i class="wm-dir ${f.dir}"></i>` : ""}${f.note ? `<small>${esc(f.note)}</small>` : ""}</dd></div>`).join("")}</dl>` : "");
    inner += c.factsFirst ? factsHtml() + chipsHtml() : chipsHtml() + factsHtml();
    return `<section class="wm-clue${fresh ? " fresh" : ""}${bonus ? " bonus" : ""}">${head}${inner}<p class="wm-src">${esc(c.source)}</p></section>`;
  }

  // --- the guess box (an ARIA combobox) -----------------------------------------------------------------------
  function wireCombo(input) {
    const list = body.querySelector("#wm-list");
    const form = body.querySelector(".wm-guess");
    const r = currentRound(game);
    const tried = new Set(r.steps.filter((s) => s.t === "miss").map((s) => s.id));
    const paint = () => {
      list.hidden = !ui.listOpen || !ui.matches.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
      list.innerHTML = ui.matches.map((m, k) => `<li role="option" id="wm-opt-${k}" data-id="${esc(m.id)}" aria-selected="${k === ui.active}"
        class="${k === ui.active ? "on" : ""}${tried.has(m.id) ? " tried" : ""}">${esc(m.label)}<small>${tried.has(m.id) ? "already tried" : esc(m.sub)}</small></li>`).join("");
      if (ui.active >= 0) input.setAttribute("aria-activedescendant", `wm-opt-${ui.active}`);
      else input.removeAttribute("aria-activedescendant");
      list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    };
    const update = () => {
      ui.q = input.value;
      ui.matches = matchCities(index, ui.q, 8);
      ui.active = ui.matches.length ? 0 : -1;
      ui.listOpen = true;
      paint();
    };
    const submit = (id) => {
      if (!id) {
        if (ui.q.trim()) ctx.toast("No city by that name. Pick one from the list.");
        return;
      }
      if (tried.has(id)) { ctx.toast("You already tried that one."); return; }
      act(guess(game, id));
    };
    input.addEventListener("input", update);
    input.addEventListener("focus", () => { if (input.value) { ui.listOpen = true; paint(); } });
    input.addEventListener("blur", () => setTimeout(() => { ui.listOpen = false; if (body.contains(list)) paint(); }, 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!ui.matches.length) return;
        e.preventDefault();
        ui.listOpen = true;
        const n = ui.matches.length;
        ui.active = (ui.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        paint();
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        act(reveal(game));
      } else if (e.key === "Escape" && ui.listOpen && ui.matches.length) {
        e.preventDefault(); // keeps the app's Esc away
        ui.listOpen = false;
        paint();
      } else if (e.key === "Tab" && ui.listOpen && ui.active >= 0 && ui.matches[ui.active] && !e.shiftKey) {
        e.preventDefault(); // complete the name
        input.value = ui.matches[ui.active].label;
        ui.q = input.value;
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const m = ui.matches[ui.active] || (ui.q.trim() ? matchCities(index, ui.q, 1)[0] : null);
      submit(m?.id);
    });
    list.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener("click", (e) => {
      const li = e.target.closest("[data-id]");
      if (li) submit(li.dataset.id);
    });
    if (ui.q) { input.value = ui.q; paint(); }
  }

  // --- results -----------------------------------------------------------------------------------------------
  function statsHtml() {
    const b = distBuckets(stats);
    const max = Math.max(1, ...b.map((x) => x.count));
    const mine = meta.mode === "daily" && game?.rounds.every((r) => r.done) ? totalScore(game) : null;
    const avg = stats.played ? (stats.total / stats.played).toFixed(1) : "–";
    return `<div class="g-section">Your daily stats</div>
      <div class="wm-stats">
        <div class="g-stat"><b>${stats.played}</b><span>Played</span></div>
        <div class="g-stat"><b>${liveStreak(stats, today)}</b><span>Streak</span></div>
        <div class="g-stat"><b>${stats.maxStreak}</b><span>Best streak</span></div>
        <div class="g-stat"><b>${stats.best}</b><span>Best score</span></div>
        <div class="g-stat"><b>${avg}</b><span>Average</span></div>
      </div>
      <div class="wm-dist" aria-label="Score distribution">${b.map((x) => `
        <div class="wm-drow${mine != null && mine >= x.lo && mine <= x.hi ? " mine" : ""}"><span>${x.label}</span>
          <span class="wm-dbar"><i style="width:${Math.max(x.count ? 8 : 0, (x.count / max) * 100).toFixed(0)}%"></i></span><b>${x.count}</b></div>`).join("")}</div>`;
  }

  function untilMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const m = Math.max(1, Math.round((next - now) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }

  function renderSummary() {
    const score = totalScore(game);
    const text = shareText(game, shareUrl());
    const verdict = score >= 22 ? "Atlas-grade." : score >= 16 ? "Sharp eye for data." : score >= 10 ? "Solid reading." : score >= 5 ? "The numbers fought back." : "Tough one. Try a practice round.";
    body.innerHTML = `
      ${pipsHtml()}
      <div class="wm-final">
        <div class="wm-kicker">${modeLine()}</div>
        <div class="wm-big-score">${score}<small>/${MAX_SCORE}</small></div>
        <p class="wm-verdict-line">${verdict}</p>
        <pre class="wm-share" aria-label="Share text">${esc(text)}</pre>
        <div class="g-row"><button class="g-btn primary" data-act="share" type="button">Copy result</button>
          ${meta.mode === "daily" ? `<span class="g-note">Next puzzle in ${untilMidnight()}</span>` : ""}</div>
      </div>
      <div class="g-section">The answers</div>
      <ul class="wm-answers">${game.rounds.map((r, k) => {
        const c = ctx.cityById.get(r.answer);
        return `<li><span class="wm-an">${k + 1}</span><span class="wm-at"><b>${esc(cityLabel(c))}</b><small>${esc(cluesFor(r.answer).why.text)}</small></span>
          <span class="wm-ap">${roundPoints(r)}</span>
          <button class="g-btn wm-cv" data-cv="${esc(c.id)}" type="button" title="Leave the game and open the City View for ${esc(c.name)}">City View</button></li>`;
      }).join("")}</ul>
      ${meta.mode === "daily" ? statsHtml() : ""}
      <div class="g-row wm-more">
        <button class="g-btn" data-act="practice" type="button">${meta.mode === "practice" ? "Another practice puzzle" : "Practice puzzle"}</button>
        ${meta.mode !== "daily" ? `<button class="g-btn" data-act="today" type="button">Today's puzzle</button>` : ""}
      </div>
      <p class="g-note">Practice puzzles do not count toward stats. Today's result stays here: the daily puzzle can be played once.</p>`;
    body.querySelector("[data-act=share]")?.focus({ preventScroll: true });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // --- map ---------------------------------------------------------------------------------------------------
  function frameCells(cells, ids, { pad = 220, maxScale = 0.55 } = {}) {
    const h = { cells: new Set(cells), cities: new Set(ids), color: HL_COLOR, dimOthers: true };
    app.setHighlight?.(h);
    const b = app.highlightBounds?.(h);
    if (b && app.fitBounds) app.fitBounds(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, { maxScale });
  }

  // Name plates for revealed answers, drawn under their city (a small metro may have no banner at this zoom).
  let plates = [];
  const PLATE_FONT = '600 13px "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
  ctx.addOverlay({
    id: "answers", z: 110, space: "screen",
    draw(g, cam) {
      if (!plates.length) return;
      const grid = app.w?.grid;
      if (!grid) return;
      const R = grid.R * cam.scale;
      g.font = PLATE_FONT;
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (const c of plates) {
        if (c.cell == null) continue;
        const [sx, sy] = cam.toScreen(grid.cx(c.cell), grid.cy(c.cell));
        if (sx < -100 || sy < -60 || sx > cam.w + 100 || sy > cam.h + 60) continue;
        const text = c.name;
        const w = Math.ceil(g.measureText(text).width) + 18, h = 20;
        const x = Math.round(sx - w / 2), y = Math.round(sy + Math.max(7, R * 0.55) + 6);
        g.beginPath();
        g.moveTo(sx - 5, y); g.lineTo(sx, y - 5); g.lineTo(sx + 5, y);
        if (g.roundRect) g.roundRect(x, y, w, h, 4); else g.rect(x, y, w, h);
        g.fillStyle = "rgba(16, 25, 35, 0.94)";
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = HL_COLOR;
        g.stroke();
        g.fillStyle = HL_COLOR;
        g.fillText(text, sx, y + h / 2 + 0.5);
      }
    },
  });
  // The whole country inside the area the dock leaves (app.home() frames the full screen).
  let land = null;
  function showCountry() {
    const grid = app.w?.grid, owner = ctx.data.world?.owner;
    if (!grid || !owner || !app.fitBounds) return app.home?.();
    if (!land) {
      land = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] < 0) continue;
        const x = grid.cx(i), y = grid.cy(i);
        if (x < land.x0) land.x0 = x; if (x > land.x1) land.x1 = x;
        if (y < land.y0) land.y0 = y; if (y > land.y1) land.y1 = y;
      }
    }
    app.fitBounds(land.x0, land.y0, land.x1, land.y1, { padTop: 40, padBottom: 50, padLeft: 16, padRight: 16 });
  }
  const setPlates = (list) => { plates = list; app.requestDraw?.(); };

  function syncMap() {
    if (view === "intro") {
      app.setHighlight?.(null);
      softenBanners([]);
      setPlates([]);
      if (framedRound !== "intro") { framedRound = "intro"; showCountry(); }
      return;
    }
    if (view === "summary") {
      const cities = game.rounds.map((r) => ctx.cityById.get(r.answer)).filter(Boolean);
      softenBanners(cities.map((c) => c.id));
      setPlates(cities);
      if (framedRound !== "summary") {
        framedRound = "summary";
        app.setHighlight?.({ cells: new Set(cities.flatMap((c) => c.footprint || [c.cell])), cities: new Set(cities.map((c) => c.id)), color: HL_COLOR });
        showCountry();
      }
      return;
    }
    const r = currentRound(game);
    const key = `${game.idx}:${r.done ? "done" : "open"}`;
    if (!r.done) {
      app.setHighlight?.(null);
      softenBanners([]);
      setPlates([]);
      if (framedRound !== key) { framedRound = key; showCountry(); }
    } else {
      const c = ctx.cityById.get(r.answer);
      softenBanners([c.id]);
      setPlates([c]);
      if (framedRound !== key) { framedRound = key; frameCells(c.footprint?.length ? c.footprint : [c.cell], [c.id]); }
    }
  }

  function openCityView(id) {
    const c = ctx.cityById.get(id);
    if (!c) return;
    ctx.exit();
    // The host's exit runs synchronously; open the City View once the mode switch has settled.
    setTimeout(() => {
      if (app.cityView?.open) app.cityView.open(c);
      else app.selectCity?.(c);
    }, 0);
  }

  // --- events ------------------------------------------------------------------------------------------------
  body.addEventListener("click", async (e) => {
    const cv = e.target.closest("[data-cv]");
    if (cv) return openCityView(cv.dataset.cv);
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "start") { view = "play"; render(); }
    else if (a === "skip") act(reveal(game));
    else if (a === "next") act(nextRound(game));
    else if (a === "practice") load({ mode: "practice", key: null, seed: newPracticeSeed() });
    else if (a === "today") load({ mode: "daily", key: today, seed: null });
    else if (a === "share") {
      const ok = await copy(shareText(game, shareUrl()));
      ctx.toast(ok ? "Result copied: paste it anywhere." : "Could not copy: select the text above instead.");
      b.textContent = ok ? "Copied ✓" : "Copy result";
    }
  });

  // No map click may select a city mid-game (its panel would name it). On the results, an answer's hexes open it.
  ctx.on("mapclick", (ev) => {
    if (view === "summary" && ev?.city && game.answers.includes(ev.city.id)) openCityView(ev.city.id);
    return true;
  });

  load(parseParam(ctx.param, today));

  return {
    stop: restore,
    onEscape() {
      if (ui.listOpen) { ui.listOpen = false; if (view === "play") render(); }
      return true; // Esc never drops the game; use ✕
    },
    param: () => (meta ? paramOf(meta) : null),
  };
}
