// Which Metro? A daily data puzzle: name the metro from its workforce, way of life, industries, size and place.
// Contract: games/host.js (start(ctx) → session). Pure logic lives in ./sim/ (unit-tested in tests/js).
//
// Map etiquette while a round is open: no highlight, no fly-to, no banners and no hover tooltips
// (app.setCitiesHidden) and map clicks swallowed, so nothing on the map points at the answer. When a round ends the answer's footprint is outlined and framed and its banner comes back.
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
import { guessHint } from "./sim/hint.js";

const HL_COLOR = "#ecd08e";

export async function start(ctx) {
  const { app } = ctx;
  loadCss(ctx, "css/games/whichMetro.css");
  const dockBody = ctx.dock("left", { width: 400 });
  dockBody.classList.add("wm");
  // A polite live region outside the re-rendered part, so screen readers hear new clues and round results.
  dockBody.innerHTML = `<div class="sr-only wm-live" aria-live="polite" aria-atomic="true"></div><div class="wm-main"><p class="wm-loading">Gathering the clues…</p></div>`;
  const live = dockBody.querySelector(".wm-live");
  const body = dockBody.querySelector(".wm-main");
  const say = (msg) => { live.textContent = ""; setTimeout(() => { live.textContent = msg; }, 60); };

  // --- map etiquette (restored on exit) ----------------------------------------------------------------------
  const st = app.state || {};
  const prevFocus = st.bannerFocus ?? null;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (app.state) app.state.bannerFocus = prevFocus;
    app.setCitiesHidden?.(false);
    app.setHighlight?.(null);
    app.requestDraw?.();
  };
  ctx.onCleanup(restore);
  // No answer on screen: while no city is in focus, banners and hover tooltips are hidden outright
  // (app.setCitiesHidden); once a round ends only the answer's banner is at full strength.
  const softenBanners = (ids) => {
    if (!app.state) return;
    app.state.bannerFocus = new Set(ids || []);
    app.setCitiesHidden?.(!ids || ids.length === 0);
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
  let today = ctx.todayKey();
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
  let view = "intro"; // intro | play | summary | help
  let helpBack = null; // the view "help" returns to
  let countdown = 0;   // interval id of the summary's next-puzzle countdown
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
    // First time ever (and not already reading the rules on the intro): show How to play once.
    if (view === "play" && !ctx.storage.get("seenHelp")) { helpBack = "play"; view = "help"; }
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
    const before = currentRound(game), beforeIdx = game.idx;
    game = next;
    persist();
    if (game.done) view = "summary";
    ui = { q: "", matches: [], active: -1, listOpen: false };
    render();
    announce(before, beforeIdx);
    return true;
  }

  // What changed, for the live region.
  function announce(before, beforeIdx) {
    if (view === "summary") { say(`Game over. You scored ${totalScore(game)} of ${MAX_SCORE}.`); return; }
    const r = currentRound(game);
    if (game.idx !== beforeIdx) { say(`Round ${game.idx + 1} of ${ROUNDS}. Clue 1: ${cluesFor(r.answer).clues[0].title}.`); return; }
    const last = r.steps[r.steps.length - 1];
    let pre = "";
    if (last?.t === "miss") {
      const g = ctx.cityById.get(last.id);
      pre = `Not ${g ? g.name : "that one"}. ${guessHint(g, ctx.cityById.get(r.answer)).text}. `;
    }
    if (r.done) {
      const c = ctx.cityById.get(r.answer);
      say(`${pre}${r.solved ? "Correct" : "Out of clues"}: ${c.name}. ${roundPoints(r)} points.`);
    } else if (before && r.clues > before.clues) {
      say(`${pre}Clue ${r.clues} of ${MAX_CLUES}: ${cluesFor(r.answer).clues[r.clues - 1].title}.`);
    }
  }

  // --- rendering ---------------------------------------------------------------------------------------------
  function render() {
    if (view !== "summary" && countdown) { clearInterval(countdown); countdown = 0; }
    if (view === "intro") renderIntro();
    else if (view === "help") renderHelp();
    else if (view === "summary") renderSummary();
    else renderPlay();
    syncMap();
  }

  const RULES = `
        <ol class="wm-rules">
          <li>Each round hides one of the ${pool.length} most populous US metros. You start with one clue: real public data, no names.</li>
          <li>Clues go from vague to specific: <b>who works here</b>, <b>how people live</b>, <b>size and wealth</b>, <b>what the economy does</b>, then <b>where it is</b>.</li>
          <li>Guess any city. A wrong guess (or <i>Next clue</i>) uncovers the next clue, and tells you how far off you were and which way.</li>
          <li>Points: <b>5</b> on the first clue down to <b>1</b> on the last, <b>0</b> if you miss. Five rounds, best score ${MAX_SCORE}.</li>
        </ol>`;

  function renderHelp() {
    body.innerHTML = `
      <section class="wm-hero wm-help" aria-labelledby="wm-help-title">
        <div class="wm-kicker">How to play</div>
        <h3 class="wm-title" id="wm-help-title">Name the metro from its numbers</h3>
        ${RULES}
        <p class="g-note wm-keys">Keys: <kbd>Enter</kbd> guesses (or moves on), <kbd>Shift</kbd>+<kbd>Enter</kbd> or <kbd>N</kbd> next clue, <kbd>/</kbd> jumps to the guess box, <kbd>?</kbd> this help.</p>
        <div class="g-row"><button class="g-btn primary wm-big" data-act="help-ok" type="button">Got it</button></div>
      </section>`;
    body.querySelector("[data-act=help-ok]")?.focus({ preventScroll: true });
  }

  function openHelp() {
    if (view === "help") return;
    helpBack = view;
    view = "help";
    render();
  }

  function closeHelp() {
    ctx.storage.set("seenHelp", true);
    view = helpBack || "play";
    helpBack = null;
    render();
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
        ${RULES}
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
          <span class="wm-stake" title="Points for a correct guess now">${stake} pt${stake === 1 ? "" : "s"}<span class="sr-only"> for a correct guess now</span></span></div>
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
          <button class="wm-helpbtn" data-act="help" type="button" aria-label="How to play" title="How to play (?)">?</button>
        </div>
        ${wrong.length ? `<ul class="wm-wrong" aria-label="Wrong guesses">${wrong.map((c) => missChip(c, city)).join("")}</ul>` : ""}`;
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
          ${wrong.length ? `<ul class="wm-wrong" aria-label="Your wrong guesses">${wrong.map((c) => missChip(c, city)).join("")}</ul>` : ""}
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

  // A wrong guess: the city, and how far off it was / which way to go (never the answer's name).
  function missChip(g, answer) {
    const h = guessHint(g, answer);
    const dist = h.km != null
      ? `<span class="wm-hint" aria-hidden="true">${h.km.toLocaleString("en-US")} km <b>${h.arrow}</b></span>`
      : `<span class="wm-hint" aria-hidden="true">far</span>`;
    return `<li class="wm-chip-x" title="${esc(h.text)}"><span class="wm-xn">✗ ${esc(cityLabel(g))}</span>${dist}<span class="sr-only">: ${esc(h.text)}</span></li>`;
  }

  function clueHtml(c, k, fresh, bonus) {
    const head = `<header><span class="wm-num" aria-hidden="true">${k + 1}</span><h4 id="wm-clue-${k}"><span class="sr-only">Clue ${k + 1}: </span>${esc(c.title)}</h4>${bonus ? `<span class="wm-tag">unused</span>` : ""}</header>`;
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
    return `<section class="wm-clue${fresh ? " fresh" : ""}${bonus ? " bonus" : ""}" aria-labelledby="wm-clue-${k}">${head}${inner}<p class="wm-src">${esc(c.source)}</p></section>`;
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

  // Time left until the next daily puzzle (local midnight), "4:05:09".
  function untilMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const t = Math.max(0, Math.floor((next - now) / 1000));
    const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  function startCountdown() {
    const el = body.querySelector(".wm-count");
    if (!el) return;
    const tick = () => {
      if (!body.contains(el)) { clearInterval(countdown); countdown = 0; return; }
      if (ctx.todayKey() !== today) {
        el.closest(".wm-next").innerHTML = `<span>A new puzzle is out.</span> <button class="g-btn primary" data-act="fresh" type="button">Play it</button>`;
        clearInterval(countdown); countdown = 0;
        return;
      }
      el.textContent = untilMidnight();
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  function recapHtml(r, k) {
    const c = ctx.cityById.get(r.answer);
    const pts = roundPoints(r);
    const how = r.solved ? (r.clues === 1 ? "on the first clue" : `on clue ${r.clues}`) : "missed";
    const wrong = r.steps.filter((st) => st.t === "miss").map((st) => ctx.cityById.get(st.id)).filter(Boolean);
    return `<li class="wm-rc ${r.solved ? "ok" : "miss"}">
        <div class="wm-rc-head"><span class="wm-an" aria-hidden="true">${k + 1}</span>
          <b class="wm-rc-name">${esc(cityLabel(c))}</b>
          <span class="wm-ap" aria-label="${pts} points">+${pts}</span></div>
        <div class="wm-rc-line"><span class="wm-squares" aria-hidden="true">${roundSquares(r)}</span><span class="wm-rc-how">${how}</span>
          <button class="g-btn wm-cv" data-cv="${esc(c.id)}" type="button" title="Leave the game and open the City View for ${esc(c.name)}">City View</button></div>
        <p class="wm-why"><b>Why:</b> ${esc(cluesFor(r.answer).why.text)}</p>
        ${wrong.length ? `<ul class="wm-wrong" aria-label="Wrong guesses">${wrong.map((g) => missChip(g, c)).join("")}</ul>` : ""}
      </li>`;
  }

  function renderSummary() {
    const score = totalScore(game);
    const text = shareText(game, shareUrl());
    const verdict = score >= 22 ? "Atlas-grade." : score >= 16 ? "Sharp eye for data." : score >= 10 ? "Solid reading." : score >= 5 ? "The numbers fought back." : "Tough one. Try a practice round.";
    const solved = game.rounds.filter((r) => r.solved).length;
    const firsts = game.rounds.filter((r) => roundPoints(r) === MAX_CLUES).length;
    body.innerHTML = `
      ${pipsHtml()}
      <div class="wm-final">
        <div class="wm-kicker">${modeLine()}</div>
        <div class="wm-big-score">${score}<small>/${MAX_SCORE}</small></div>
        <p class="wm-verdict-line">${verdict}</p>
        <p class="g-note">${solved} of ${ROUNDS} metros named${firsts ? ` · ${firsts} on the first clue` : ""}</p>
        <pre class="wm-share" aria-label="Share text">${esc(text)}</pre>
        <div class="g-row"><button class="g-btn primary" data-act="share" type="button">Copy result</button></div>
        <div class="wm-next" role="timer" aria-live="off">Next daily puzzle in <b class="wm-count">${untilMidnight()}</b></div>
      </div>
      <h3 class="g-section">Round by round</h3>
      <ol class="wm-answers">${game.rounds.map(recapHtml).join("")}</ol>
      ${meta.mode === "daily" ? statsHtml() : ""}
      <div class="g-row wm-more">
        <button class="g-btn" data-act="practice" type="button">${meta.mode === "practice" ? "Another practice puzzle" : "Practice puzzle"}</button>
        ${meta.mode !== "daily" ? `<button class="g-btn" data-act="today" type="button">Today's puzzle</button>` : ""}
        <button class="g-btn" data-act="help" type="button">How to play</button>
      </div>
      <p class="g-note">Practice puzzles do not count toward stats. Today's result stays here: the daily puzzle can be played once.</p>`;
    body.querySelector("[data-act=share]")?.focus({ preventScroll: true });
    startCountdown();
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
  // Phones: the dock is a bottom sheet, but app.visibleArea() assumes it starts at 45% of the height. This returns
  // the extra bottom padding (css px, negative when the sheet is shorter) that makes fitBounds use the real sheet.
  function sheetExtra() {
    if (!app.isMobile?.() || !app.visibleArea) return 0;
    const sheet = dockBody.closest(".app-dock");
    const top = sheet?.getBoundingClientRect().top;
    if (!(top > 0) || !(top < innerHeight)) return 0;
    return app.visibleArea().y1 - top;
  }

  function frameCells(cells, ids, { pad = 220, maxScale = 0.55 } = {}) {
    const h = { cells: new Set(cells), cities: new Set(ids), color: HL_COLOR, dimOthers: true };
    app.setHighlight?.(h);
    const b = app.highlightBounds?.(h);
    if (b && app.fitBounds) app.fitBounds(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, { maxScale, padBottom: 24 + sheetExtra() });
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
    if (!app.isMobile?.()) {
      app.fitBounds(land.x0, land.y0, land.x1, land.y1, { padTop: 40, padBottom: 50, padLeft: 16, padRight: 16 });
      return;
    }
    // Phones: frame the land in the band between the top bar and the real top of the sheet. The camera keeps its
    // centre inside the world, so the land can only rise so far: with the centre at the world's bottom edge the
    // south coast sits a little above mid-screen. whichMetro.css therefore keeps this game's sheet just under half
    // the screen, so the whole country always clears it (with the stock 55% sheet Texas and Florida were cut off).
    const R = grid.R || 0;
    const extra = sheetExtra();
    app.fitBounds(land.x0 - R, land.y0 - R, land.x1 + R, land.y1 + R, { padTop: 8, padBottom: 8 + extra, padLeft: 8, padRight: 8 });
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
    if (a === "start") { ctx.storage.set("seenHelp", true); view = "play"; render(); say(`Round 1 of ${ROUNDS}. Clue 1: ${cluesFor(currentRound(game).answer).clues[0].title}.`); }
    else if (a === "help") openHelp();
    else if (a === "help-ok") closeHelp();
    else if (a === "skip") act(reveal(game));
    else if (a === "next") act(nextRound(game));
    else if (a === "practice") load({ mode: "practice", key: null, seed: newPracticeSeed() });
    else if (a === "today") load({ mode: "daily", key: today, seed: null });
    else if (a === "fresh") { today = ctx.todayKey(); load({ mode: "daily", key: today, seed: null }); }
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

  // Game keys while no field has focus (ctx.onKey skips typing, modifiers and Esc). Enter on a focused button is
  // left to the button itself.
  ctx.onKey((e, k) => {
    if (!game) return false;
    const onControl = e.target?.closest?.("button, a, summary, [role=option]");
    if (k === "?" ) { if (view === "help") closeHelp(); else openHelp(); return true; }
    if (view === "help") {
      if (k === "Enter" && !onControl) { closeHelp(); return true; }
      return false;
    }
    if (view === "intro") {
      if (k === "Enter" && !onControl) { body.querySelector("[data-act=start]")?.click(); return true; }
      return false;
    }
    if (view !== "play") return false;
    const r = currentRound(game);
    if (!r.done) {
      if (k === "/" || k === "g") { body.querySelector(".wm-input")?.focus(); return true; }
      if (k === "n" || (k === "Enter" && e.shiftKey)) { act(reveal(game)); return true; }
      return false;
    }
    if ((k === "Enter" && !onControl) || k === "n" || (k === " " && !onControl)) { act(nextRound(game)); return true; }
    return false;
  });
  ctx.onCleanup(() => { if (countdown) clearInterval(countdown); countdown = 0; });

  // Re-frame when the sheet changes height (the stylesheet arriving, a rotation, the phone's URL bar).
  const sheetEl = dockBody.closest(".app-dock");
  if (sheetEl && typeof ResizeObserver === "function") {
    let lastH = 0, timer = 0;
    const ro = new ResizeObserver(() => {
      const hgt = Math.round(sheetEl.getBoundingClientRect().height);
      if (!app.isMobile?.() || Math.abs(hgt - lastH) < 8) { lastH = hgt; return; }
      lastH = hgt;
      clearTimeout(timer);
      timer = setTimeout(() => { if (game) { framedRound = -1; syncMap(); } }, 120);
    });
    ro.observe(sheetEl);
    ctx.onCleanup(() => { ro.disconnect(); clearTimeout(timer); });
  }

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
