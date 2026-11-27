// Which Metro? A daily data puzzle: name the metro from its workforce, way of life, industries, size and place.
// Contract: games/host.js (start(ctx) → session). Pure logic lives in ./sim/ (unit-tested in tests/js).
//
// Map etiquette while a round is open: no highlight, no fly-to, no banners and no hover tooltips
// (app.setCitiesHidden) and map clicks swallowed, so nothing on the map points at the answer. When a round ends the
// answer's footprint is outlined and framed, and the game's own overlay labels the answer and each wrong guess (with
// its distance), since a small metro's banner may be culled at that zoom.
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
import { net } from "../shared/net.js";
import { parseRaceParam, raceParam } from "./online.js";
import { createOnline } from "./onlineUi.js";
import { nextDailyHtml } from "../shared/nextdaily.js";

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

  // Touch screens leave the guess box unfocused after each guess, so the soft keyboard drops away. An iPad with a
  // hardware keyboard is "pointer: coarse" too, so the box is refocused when the last input was a physical key:
  // those name their key in KeyboardEvent.code ("Enter", "KeyA"), while soft keyboards leave it empty (and send
  // keyCode 229 on Android). A tap resets it.
  let hardKeys = false;
  const onKeyIn = (e) => { if (e.code && e.keyCode !== 229 && !e.isComposing) hardKeys = true; };
  const onPointerIn = (e) => { if (e.pointerType !== "mouse") hardKeys = false; };
  document.addEventListener("keydown", onKeyIn, true);
  document.addEventListener("pointerdown", onPointerIn, true);
  ctx.onCleanup(() => {
    document.removeEventListener("keydown", onKeyIn, true);
    document.removeEventListener("pointerdown", onPointerIn, true);
  });

  // --- state -------------------------------------------------------------------------------------------------
  let meta = null;   // {mode, key, seed} (+ code for a race)
  let game = null;
  let view = "intro"; // intro | play | summary | help | race (lobby) | board (today's leaderboard)
  let helpBack = null; // the view "help" returns to
  let countdown = 0;   // interval id of the summary's next-puzzle countdown
  let stats = { ...emptyStats(), ...(ctx.storage.get("stats") || {}) };
  let ui = { q: "", matches: [], active: -1, listOpen: false };
  let framedRound = -1;

  const paramOf = (m) => (m.mode === "race" ? raceParam(m.code) : m.mode === "practice" ? `practice-${m.seed}` : m.key);
  // A race keeps its own save ("race"), never the daily's, and never touches the stats (persist).
  const saveKey = (m) => (m.mode === "race" ? "race" : m.mode === "practice" ? "practice" : `game:${m.key}`);
  const shareUrl = () => `${location.origin}${location.pathname}#play=${encodeURIComponent(ctx.game.id)}~${encodeURIComponent(paramOf(meta))}`;

  // Online play (leaderboard, races). Inert until net.available() says the backend is there.
  const online = createOnline({
    ctx, net, body,
    hooks: {
      view: () => view,
      setView: (v) => { view = v; },
      render: () => render(),
      meta: () => meta,
      game: () => game,
      today: () => today,
      startRace,
      leaveToDaily: () => load({ mode: "daily", key: today, seed: null }),
      get rules() { return RULES; }, // read at render time (RULES is defined further down)
      copy: (t) => copy(t),
    },
  });
  ctx.onCleanup(() => online.stop());

  function load(m) {
    online.leaveRace();
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

  // A live race: everyone plays practiceAnswers(pool, room.seed). A reload resumes the saved run of this room.
  function startRace(room, code) {
    const m = { mode: "race", key: null, seed: String(room.seed), code };
    meta = m;
    const answers = practiceAnswers(pool, m.seed);
    const saved = ctx.storage.get(saveKey(m));
    game = saved && saved.code === code && saved.seed === m.seed && validSave(saved, answers)
      ? saved
      : { ...newGame({ mode: "race", key: null, seed: m.seed, number: null, answers }), code };
    framedRound = -1;
    ui = { q: "", matches: [], active: -1, listOpen: false };
    ctx.storage.set("seenHelp", true); // the lobby showed the rules
    view = game.done ? "summary" : "play";
    render();
    if (view === "play") say(`The race is on. Round ${game.idx + 1} of ${ROUNDS}.`);
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
    online.afterAct(game);
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
    online.wrapRender(() => {
      if (view === "intro") renderIntro();
      else if (view === "help") renderHelp();
      else if (view === "summary") renderSummary();
      else if (view === "race") online.renderRaceView();
      else if (view === "board") online.renderBoardView();
      else renderPlay();
    });
    syncMap();
    online.afterRender(view);
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
    if (meta.mode === "race") return `Race <code>${esc(meta.code)}</code> <span class="wm-tag">not scored in stats</span>`;
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
      ${online.slot("intro")}
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
      // .wm-top holds the controls (sticky in landscape, see whichMetro.css); the wrong guesses stay out of it so
      // the sticky part keeps a fixed height.
      top = `
        <div class="wm-top">${pipsHtml()}
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
        </div></div>
        ${wrong.length ? `<ul class="wm-wrong" aria-label="Wrong guesses">${wrong.map((c) => missChip(c, city)).join("")}</ul>` : ""}`;
    } else {
      const pts = roundPoints(r);
      const last = game.idx >= game.rounds.length - 1;
      top = `${pipsHtml()}
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
    body.innerHTML = `${meta.mode === "race" ? online.slot("strip") : ""}${top}<div class="wm-clues">${list.join("")}</div>`;
    if (!r.done) {
      const input = body.querySelector(".wm-input");
      wireCombo(input);
      if (hardKeys || !matchMedia("(pointer: coarse)").matches) input.focus({ preventScroll: true });
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

  // A race's results: the server's standings first, then the usual round-by-round recap. No share text (the race
  // has no puzzle number), no daily countdown and no stats.
  function renderRaceSummary() {
    const score = totalScore(game);
    body.innerHTML = `
      ${pipsHtml()}
      <div class="wm-final">
        <div class="wm-kicker">${modeLine()}</div>
        <div class="wm-big-score">${score}<small>/${MAX_SCORE}</small></div>
      </div>
      ${online.slot("raceres")}
      <h3 class="g-section">Round by round</h3>
      <ol class="wm-answers">${game.rounds.map(recapHtml).join("")}</ol>
      <div class="g-row wm-more">
        <button class="g-btn primary" data-act="race-new" type="button">New race</button>
        <button class="g-btn" data-act="today" type="button">Today's puzzle</button>
        <button class="g-btn" data-act="practice" type="button">Practice puzzle</button>
      </div>`;
  }

  function renderSummary() {
    if (meta.mode === "race") return renderRaceSummary();
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
        ${meta.mode === "daily" ? nextDailyHtml("whichMetro") : ""}
      </div>
      ${online.slot("board")}
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

  // Frames the answer's cells; `near` (world points) are wrong guesses close enough to share the view.
  function frameCells(cells, ids, { pad = 220, maxScale = 0.55, near = [] } = {}) {
    const h = { cells: new Set(cells), cities: new Set(ids), color: HL_COLOR, dimOthers: true };
    app.setHighlight?.(h);
    const b = app.highlightBounds?.(h);
    if (!b || !app.fitBounds) return;
    let { x0, y0, x1, y1 } = b;
    for (const [x, y] of near) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    app.fitBounds(x0 - pad, y0 - pad, x1 + pad, y1 + pad, { maxScale, padBottom: 24 + sheetExtra() });
  }

  // --- map labels ----------------------------------------------------------------------------------------------
  // While a round is open the map names nothing. At the reveal (and on the results) the game draws its own labels,
  // since the engine's banner for a small metro may be culled at the reveal's zoom: a gold plate under each answer,
  // and for each wrong guess a red plate with its distance chip, joined to the answer by a dashed line. They are
  // drawn in screen space, so they keep their size at any zoom; a guess off the screen gets its plate at the edge
  // where its line leaves the view. Plates dodge each other. Cleared when the next round opens (syncMap).
  let marks = { answers: [], misses: [] }; // answers: [city]; misses: [{city, hint, answer}]
  const setMarks = (answers = [], misses = []) => { marks = { answers, misses }; app.requestDraw?.(); };
  const NEAR_KM = 600; // wrong guesses this close are framed with the answer; farther ones sit at the view's edge
  const NAME_FONT = '600 13px "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
  const CHIP_FONT = "600 11px system-ui, -apple-system, \"Segoe UI\", sans-serif";
  const MISS = { stroke: "rgba(208, 103, 79, 0.95)", line: "rgba(236, 150, 124, 0.85)", text: "#f6d6cc", chip: "#fff1d6" };
  const PLATE_BG = "rgba(16, 25, 35, 0.94)";
  const PLATE_H = 20;

  const overlaps = (r, placed) => placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
  const clampRect = (r, A) => ({ ...r, x: Math.max(A.x0, Math.min(A.x1 - r.w, r.x)), y: Math.max(A.y0, Math.min(A.y1 - r.h, r.y)) });
  // The first candidate rect (clamped to the view) that overlaps no placed plate, else the first one.
  function placeRect(cands, A, placed) {
    const rs = cands.map((r) => clampRect(r, A));
    const r = rs.find((q) => !overlaps(q, placed)) || rs[0];
    placed.push({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 });
    return r;
  }
  // Where segment p→q leaves rect A (Liang-Barsky): the last point of it inside A, or null when it misses A.
  function exitPoint(p, q, A) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    let t0 = 0, t1 = 1;
    const P = [-dx, dx, -dy, dy], Q = [p[0] - A.x0, A.x1 - p[0], p[1] - A.y0, A.y1 - p[1]];
    for (let i = 0; i < 4; i++) {
      if (P[i] === 0) { if (Q[i] < 0) return null; continue; }
      const t = Q[i] / P[i];
      if (P[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [p[0] + t1 * dx, p[1] + t1 * dy];
  }
  function plateBox(g, r, stroke) {
    g.beginPath();
    if (g.roundRect) g.roundRect(r.x, r.y, r.w, r.h, 4); else g.rect(r.x, r.y, r.w, r.h);
    g.fillStyle = PLATE_BG;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = stroke;
    g.stroke();
  }

  ctx.addOverlay({
    id: "answers", z: 110, space: "screen",
    draw(g, cam) {
      if (!marks.answers.length && !marks.misses.length) return;
      const grid = app.w?.grid;
      if (!grid) return;
      const R = grid.R * cam.scale;
      const va = app.visibleArea?.() || { x0: 0, y0: 0, x1: cam.w, y1: cam.h };
      const A = { x0: Math.max(0, va.x0) + 8, y0: Math.max(0, va.y0) + 8, x1: Math.min(cam.w, va.x1) - 8, y1: Math.min(cam.h, va.y1) - 8 };
      if (A.x1 - A.x0 < 60 || A.y1 - A.y0 < 40) return;
      const at = (c) => (c?.cell == null ? null : cam.toScreen(grid.cx(c.cell), grid.cy(c.cell)));
      const drop = Math.max(7, R * 0.55) + 6; // from a city's centre to the top of its plate
      const placed = [];
      g.textBaseline = "middle";

      // 1. Where each wrong guess goes: its own spot when in view, else the edge where its line leaves the view.
      const misses = [];
      for (const m of marks.misses) {
        const q = at(m.city);
        if (!q) continue;
        const p = m.hint.km != null ? at(m.answer) : null; // no line to or from an inset state
        const inView = q[0] >= A.x0 && q[0] <= A.x1 && q[1] >= A.y0 && q[1] <= A.y1;
        const end = inView ? q : p ? exitPoint(p, q, A) : null;
        if (!end) continue;
        misses.push({ m, p, q, end, inView });
      }
      // 2. Dashed lines under everything else.
      g.save();
      g.setLineDash([5, 4]);
      g.lineWidth = 1.5;
      g.strokeStyle = MISS.line;
      for (const x of misses) {
        if (!x.p) continue;
        g.beginPath(); g.moveTo(x.p[0], x.p[1]); g.lineTo(x.end[0], x.end[1]); g.stroke();
      }
      g.restore();
      // 3. Answer plates first (they win any overlap), each with a notch pointing up at its city.
      g.font = NAME_FONT;
      g.textAlign = "center";
      for (const c of marks.answers) {
        const s = at(c);
        if (!s || s[0] < -100 || s[1] < -60 || s[0] > cam.w + 100 || s[1] > cam.h + 60) continue;
        placed.push({ x: s[0] - 7, y: s[1] - 7, w: 14, h: 14 }); // keep the city itself clear
        const w = Math.ceil(g.measureText(c.name).width) + 18;
        const r = placeRect([
          { x: Math.round(s[0] - w / 2), y: Math.round(s[1] + drop), w, h: PLATE_H },
          { x: Math.round(s[0] - w / 2), y: Math.round(s[1] - drop - PLATE_H), w, h: PLATE_H },
        ], A, placed);
        plateBox(g, r, HL_COLOR);
        if (r.y > s[1] && Math.abs(r.x + r.w / 2 - s[0]) < r.w / 2 - 6) { // notch when the plate sits right under it
          g.beginPath(); g.moveTo(s[0] - 5, r.y); g.lineTo(s[0], r.y - 5); g.lineTo(s[0] + 5, r.y); g.closePath();
          g.fillStyle = HL_COLOR; g.fill();
        }
        g.fillStyle = HL_COLOR;
        g.fillText(c.name, r.x + r.w / 2, r.y + PLATE_H / 2 + 0.5);
      }
      // 4. Wrong guesses: a dot on the city, then "✗ Name  [1,200 km ↘]".
      for (const x of misses) {
        const { m, end } = x;
        if (x.inView) {
          g.beginPath(); g.arc(end[0], end[1], 4, 0, Math.PI * 2);
          g.fillStyle = MISS.stroke; g.fill();
          g.lineWidth = 1.5; g.strokeStyle = PLATE_BG; g.stroke();
          placed.push({ x: end[0] - 6, y: end[1] - 6, w: 12, h: 12 });
        }
        const name = `✗ ${m.city.name}`;
        const chip = m.hint.km != null ? `${m.hint.km.toLocaleString("en-US")} km ${m.hint.arrow}` : "far";
        g.font = NAME_FONT;
        const nw = Math.ceil(g.measureText(name).width);
        g.font = CHIP_FONT;
        const cw = Math.ceil(g.measureText(chip).width) + 12;
        const w = nw + cw + 22, h = PLATE_H, [ex, ey] = end;
        const cands = x.inView
          ? [
            { x: Math.round(ex - w / 2), y: Math.round(ey + 10), w, h },
            { x: Math.round(ex - w / 2), y: Math.round(ey - 10 - h), w, h },
            { x: Math.round(ex + 10), y: Math.round(ey - h / 2), w, h },
            { x: Math.round(ex - 10 - w), y: Math.round(ey - h / 2), w, h },
            { x: Math.round(ex - w / 2), y: Math.round(ey + 10 + h + 6), w, h },
            { x: Math.round(ex - w / 2), y: Math.round(ey - 10 - 2 * h - 6), w, h },
          ]
          // At the edge: centred on the exit point, then slid back along the line toward the answer.
          : [0, 26, 52, 78, 104].map((d) => {
            const len = Math.hypot(ex - x.p[0], ey - x.p[1]) || 1;
            const cx = ex + ((x.p[0] - ex) / len) * d, cy = ey + ((x.p[1] - ey) / len) * d;
            return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
          });
        const r = placeRect(cands, A, placed);
        plateBox(g, r, MISS.stroke);
        g.textAlign = "left";
        g.font = NAME_FONT;
        g.fillStyle = MISS.text;
        g.fillText(name, r.x + 9, r.y + h / 2 + 0.5);
        const chx = r.x + 9 + nw + 6;
        g.beginPath();
        if (g.roundRect) g.roundRect(chx, r.y + 3, cw, h - 6, 7); else g.rect(chx, r.y + 3, cw, h - 6);
        g.fillStyle = "rgba(0, 0, 0, 0.45)";
        g.fill();
        g.font = CHIP_FONT;
        g.fillStyle = MISS.chip;
        g.fillText(chip, chx + 6, r.y + h / 2 + 0.5);
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

  function syncMap() {
    if (view === "intro" || view === "race" || view === "board" || !game) {
      app.setHighlight?.(null);
      softenBanners([]);
      setMarks();
      if (framedRound !== "intro") { framedRound = "intro"; showCountry(); }
      return;
    }
    if (view === "summary") {
      const cities = game.rounds.map((r) => ctx.cityById.get(r.answer)).filter(Boolean);
      softenBanners(cities.map((c) => c.id));
      setMarks(cities);
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
      setMarks();
      if (framedRound !== key) { framedRound = key; showCountry(); }
    } else {
      const c = ctx.cityById.get(r.answer);
      const misses = r.steps.filter((s) => s.t === "miss").map((s) => ctx.cityById.get(s.id)).filter(Boolean)
        .map((g) => ({ city: g, hint: guessHint(g, c), answer: c }));
      softenBanners([c.id]);
      setMarks([c], misses);
      if (framedRound !== key) {
        framedRound = key;
        const grid = app.w?.grid;
        const near = grid ? misses.filter((m) => m.city.cell != null && m.hint.km != null && m.hint.km <= NEAR_KM)
          .map((m) => [grid.cx(m.city.cell), grid.cy(m.city.cell)]) : [];
        frameCells(c.footprint?.length ? c.footprint : [c.cell], [c.id], { near });
      }
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
    if (online.onClick(a, b)) return;
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

  // The nickname form (the guess form has its own listener).
  body.addEventListener("submit", (e) => {
    if (online.onSubmit(e.target)) e.preventDefault();
  });

  // No map click may select a city mid-game (its panel would name it). On the results, an answer's hexes open it.
  ctx.on("mapclick", (ev) => {
    if (view === "summary" && ev?.city && game?.answers.includes(ev.city.id)) openCityView(ev.city.id);
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
    if (view === "race" || view === "board") return false;
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

  // "race-<CODE>" is handled here, before the normal param (sim/puzzle.js's parseParam stays as pinned).
  const raceCode = parseRaceParam(ctx.param);
  if (raceCode) online.joinRace(raceCode);
  else load(parseParam(ctx.param, today));
  online.init(); // shows the online parts once /api/health answers; nothing changes when it does not

  return {
    stop: restore,
    onEscape() {
      if (online.escape()) return true;
      if (ui.listOpen) { ui.listOpen = false; if (view === "play") render(); }
      return true; // Esc never drops the game; use ✕
    },
    param: () => (online.raceCode ? raceParam(online.raceCode) : meta ? paramOf(meta) : null),
  };
}
