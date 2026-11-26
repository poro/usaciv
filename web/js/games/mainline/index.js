// Mainline: lay freight rail across the real map, 2026→2050. Real FAF freight flows are the demand, real metro trends
// drive growth, real FEMA county rates roll the disasters. Single player against "baseline America".
//
// This file is the glue: the dock (panel.js), the map layers and overlays (view.js) and input. All game rules live in
// the pure, deterministic sim/ (state.js: apply(env, state, action)). Contract: see games/host.js.
// URL: #play=mainline~<scenario>.<seed>[.<home>]   Save: ctx.storage "save" (the whole state plus its action log,
// runlog.js, after every action). Online boards (docs/MULTIPLAYER.md) appear only when net.available().
// First-run tutorial: ctx.storage "tutorial" = the coach step (0..COACH_STEPS; COACH_STEPS = done or skipped).
// Prefs: ctx.storage "prefs" = {showDemand, trains (default on), sound (default off)}. Trains and sound are view-only.
import { loadCss } from "../shared/css.js";
import { esc } from "../../format.js";
import * as S from "./sim/index.js";
import { makeView } from "./view.js";
import { pickerHtml, gameHtml, buildHtml, endHtml, shareText, contractText, COACH_STEPS, boardsHtml } from "./panel.js";
import { record, packSave, unpackSave } from "./runlog.js";
import { verifyRun } from "./sim/verify.js";
import { net } from "../shared/net.js";
import { parseParam, formatParam } from "./params.js";
import { shareImage } from "./share.js";
import { makeSound } from "./sound.js";

const envCache = new Map();

export async function start(ctx) {
  loadCss(ctx, "css/games/mainline.css");
  const app = ctx.app;
  const body = ctx.dock("left", { width: 380, title: "Mainline" });
  body.classList.add("ml");
  body.innerHTML = `<p class="muted">Loading freight flows, rail and disaster records…</p>`;

  const [trade, infrastructure, disasters] = await Promise.all(["trade", "infrastructure", "disasters"].map((n) => ctx.loadData(n)));
  if (!trade || !infrastructure || !disasters) {
    body.innerHTML = `<p>Mainline needs trade.json, infrastructure.json and disasters.json, and at least one is missing.</p>`;
    return {};
  }
  const data = { world: ctx.data.world, cities: ctx.cities, trade, infrastructure, disasters };
  const getEnv = (scenario, home) => {
    const key = `${scenario}:${scenario === "sandbox" ? home : ""}`;
    if (!envCache.has(key)) envCache.set(key, S.makeEnv(data, scenario, { home, hexmap: ctx.hexmap }));
    return envCache.get(key);
  };

  // --- session state ---
  const prefs = ctx.storage.get("prefs", {}) || {};
  const game = {
    env: null, state: null, ev: null,
    log: null, // the action log since newGame (runlog.js); null for a save from before logs
    online: { avail: false, status: "idle", error: null, result: null, board: null, nick: "" },
    sel: { start: null, end: null, hover: null, plan: null },
    ui: { tab: "open", showDemand: prefs.showDemand !== false, trains: prefs.trains !== false, sound: prefs.sound === true, motion: true,
      highlight: null, hover: null, link: null, help: false, screen: "picker", coach: null },
    contractTip: (id) => {
      const c = game.env?.contractById.get(id);
      if (!c) return null;
      const [head, ...rest] = contractText(game.env, c, game.ev.served.get(id)).split("\n");
      return `<b>${esc(head)}</b><br>${rest.map(esc).join("<br>")}`;
    },
  };
  let touch = false;
  const view = makeView(ctx, game);
  game.ui.motion = view.motionOk();
  // sound: off by default; a remembered "on" creates no AudioContext until the player's first build or End turn
  const sound = makeSound();
  sound.setOn(game.ui.sound, { gesture: false });
  ctx.onCleanup(() => sound.close());
  const setPref = (k, v) => { prefs[k] = v; ctx.storage.set("prefs", prefs); };
  // debugging handle (like app.mapArt): the live game model, removed on exit
  app.mainline = game;
  ctx.onCleanup(() => { if (app.mainline === game) delete app.mainline; });

  // --- flow ---
  /** A usable save {state (migrated to the current version), log}, or null. */
  function loadSave() {
    const sv = unpackSave(ctx.storage.get("save", null));
    return sv && S.scenarioById(sv.state.scenario) ? sv : null;
  }
  function newSeed() { return 1 + Math.floor(Math.random() * 99999); }
  function begin({ scenario, seed, home }, saved = null) {
    const env = getEnv(scenario, home);
    game.env = env;
    game.state = saved?.state || S.newGame(env, { seed });
    game.log = saved ? saved.log : [];
    game.online = { ...game.online, status: "idle", error: null, result: null, board: null };
    game.sel = { start: null, end: null, hover: null, plan: null };
    game.ui.highlight = null;
    game.ui.link = null;
    game.ui.tab = "open";
    game.ui.screen = game.state.over ? "end" : "game";
    // first game: the three-step coach (replayable from How to play) instead of the full rules
    const step = coachStep();
    game.ui.coach = game.ui.screen === "game" && step < COACH_STEPS ? step : null;
    game.ui.help = game.ui.screen === "game" && game.ui.coach == null && !ctx.storage.get("seenHow", false);
    view.reset();
    ctx.setParam(formatParam({ scenario, seed: game.state.seed, home: env.home?.id }));
    save();
    refresh();
    frame();
  }
  function frame() {
    const e = game.env?.ext;
    if (!e || !app.fitBounds) return;
    const pad = 60;
    app.fitBounds(e.x0 - pad, e.y0 - pad, e.x1 + pad, e.y1 + pad, { padTop: 30, padBottom: 30 });
  }
  function save() {
    if (game.state) ctx.storage.set("save", packSave(game.state, game.log));
  }
  function showPicker() {
    game.ui.screen = "picker";
    game.sel = { start: null, end: null, hover: null, plan: null };
    ctx.setParam(null);
    const sv = loadSave()?.state;
    let saveEnv = null;
    try { if (sv) saveEnv = getEnv(sv.scenario, sv.home); } catch { saveEnv = null; }
    const metros = ctx.cities.filter((c) => c.metro).slice(0, 150).sort((a, b) => a.name.localeCompare(b.name));
    const last = game.state ? { scenario: game.state.scenario, home: game.state.home } : sv ? { scenario: sv.scenario, home: sv.home } : {};
    body.innerHTML = pickerHtml({
      save: sv, saveEnv, cities: metros,
      defaults: { scenario: last.scenario || "texas", home: last.home || "19100", seed: newSeed() },
      online: game.online.avail,
    });
    view.redraw();
  }

  function refresh() {
    if (!game.state) return;
    game.ev = S.evaluate(game.env, game.state);
    if (game.ui.screen === "end") body.innerHTML = endHtml(model(), ctx.storage.get(`best:${game.env.scenario.id}`, null), boardModel());
    else {
      const scroll = body.scrollTop;
      body.innerHTML = gameHtml(model());
      body.scrollTop = scroll;
    }
    view.refresh();
  }
  const model = () => ({ env: game.env, state: game.state, ev: game.ev, sum: S.summary(game.env, game.state), ui: game.ui, sel: game.sel, touch });
  function refreshBuild() {
    const el = body.querySelector("#ml-build");
    if (el) {
      el.innerHTML = buildHtml(model());
      // phones: the first tap previews; make sure its Build / Cancel buttons are in view even if the list was scrolled
      if (touch && game.sel.end != null) el.scrollIntoView?.({ block: "nearest" });
    }
    view.redraw();
  }

  function act(action, { quiet = false } = {}) {
    if (!game.state) return false;
    const before = game.state;
    const servedBefore = game.ev?.served.size ?? 0;
    const r = record(game.env, game.state, game.log, action);
    if (r.error) { if (!quiet) ctx.toast(r.error); return false; }
    game.state = r.state;
    if (action.type === "endTurn") afterTurn(before);
    else if (action.type === "build") sound.play("build");
    if (game.ui.link && !game.state.links[game.ui.link]) game.ui.link = null;
    save();
    refresh();
    coachAfter(action, servedBefore);
    return true;
  }

  // --- tutorial (three coach steps; each moves on when you do the thing, or with Next) ---
  function coachStep() {
    const v = ctx.storage.get("tutorial", 0);
    return Number.isInteger(v) && v >= 0 ? Math.min(v, COACH_STEPS) : 0;
  }
  function setCoach(step) {
    ctx.storage.set("tutorial", step);
    if (step >= COACH_STEPS) ctx.storage.set("seenHow", true); // done or skipped: no full rules popping up next game
    game.ui.coach = step < COACH_STEPS && game.ui.screen === "game" ? step : null;
    refresh();
  }
  function coachAfter(action, servedBefore) {
    const k = game.ui.coach;
    if (k == null) return;
    if (k === 0 && action.type === "build") setCoach(1);
    else if (k === 1 && action.type === "build" && game.ev.served.size > servedBefore) setCoach(2);
    else if (k === 2 && action.type === "endTurn") setCoach(COACH_STEPS);
  }
  function afterTurn(before) {
    game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
    const r = game.state.last;
    const dmg = r.damaged ? `, ${r.damaged} link${r.damaged === 1 ? "" : "s"} damaged` : "";
    const debt = r.interest ? `, −${r.interest.toFixed(1)} interest` : "";
    ctx.toast(`${before.year}: +${r.revenue.toFixed(1)} cr freight, −${r.maint.toFixed(1)} upkeep${debt}${r.hits ? ` · ${r.hits} disaster${r.hits === 1 ? "" : "s"}${dmg}` : ""}`);
    sound.play(r.damaged ? "disaster" : "turn");
    if (game.state.over) {
      game.ui.screen = "end";
      const sum = S.summary(game.env, game.state);
      const key = `best:${game.env.scenario.id}`;
      const best = ctx.storage.get(key, null);
      if (best == null || sum.score > best) ctx.storage.set(key, sum.score);
    }
  }

  // --- building ---
  function setPlan(to) {
    const { sel } = game;
    sel.plan = sel.start != null && to != null && to >= 0 && to !== sel.start ? S.plan(game.env, game.state, sel.start, to) : null;
  }
  function cancelBuild() {
    game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
    refreshBuild();
  }
  function build() {
    const pl = game.sel.plan;
    if (!pl?.path) return;
    const end = pl.path[pl.path.length - 1];
    if (act({ type: "build", path: pl.path })) {
      // keep laying from where this stretch ended
      game.sel = { start: end, end: null, hover: game.sel.hover, plan: null };
      refreshBuild();
    }
  }

  ctx.on("hover", (h) => {
    if (game.ui.screen !== "game") return;
    const cell = h?.cell ?? -1;
    game.sel.hover = cell >= 0 ? cell : null;
    if (game.sel.start != null && game.sel.end == null) {
      setPlan(game.sel.hover);
      refreshBuild();
    } else view.redraw();
  });

  ctx.on("mapclick", (ev) => {
    if (game.ui.screen !== "game" || !game.state) return true; // the picker and end screen own the map: no city panels
    touch = ev.pointerType && ev.pointerType !== "mouse";
    const { sel } = game;
    const cell = ev.cell;
    if (sel.start == null) {
      if (ev.layer === "mainline:links" && ev.item?.key) {
        game.ui.link = ev.item.key;
        if (cell >= 0 && game.env.inRegion(cell)) sel.start = cell;
        refresh();
        return true;
      }
      if (cell < 0) return true;
      if (!game.env.inRegion(cell)) { ctx.toast("That hex is outside this scenario's region"); return true; }
      sel.start = cell;
      sel.end = null;
      sel.plan = null;
      refreshBuild();
      return true;
    }
    if (cell < 0 || cell === sel.start) { cancelBuild(); return true; }
    if (touch && sel.end !== cell) {
      // phones: first tap previews (no hover), a second tap on the same hex or the Build button confirms
      sel.end = cell;
      setPlan(cell);
      refreshBuild();
      return true;
    }
    setPlan(cell);
    if (sel.plan?.error) { ctx.toast(sel.plan.error); refreshBuild(); return true; }
    build();
    return true;
  });

  // --- dock clicks ---
  body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    const li = e.target.closest("[data-contract]");
    if (!t && li) {
      const id = li.dataset.contract;
      game.ui.highlight = game.ui.highlight === id ? null : id;
      const c = game.env.contractById.get(id);
      if (game.ui.highlight && c && app.fitBounds) {
        const g = ctx.hexmap.grid;
        const xs = [...c.a.cells, ...c.b.cells].map((x) => g.cx(x)), ys = [...c.a.cells, ...c.b.cells].map((x) => g.cy(x));
        const pad = 80;
        app.fitBounds(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad, { maxScale: 6 });
      }
      refresh();
      return;
    }
    if (!t) return;
    const a = t.dataset.act;
    switch (a) {
      case "end": act({ type: "endTurn" }); break;
      case "undo": act({ type: "undo" }); game.sel.plan = null; refreshBuild(); break;
      case "build": build(); break;
      case "cancel": cancelBuild(); break;
      case "repairAll": act({ type: "repairAll" }); break;
      case "repair": if (game.ui.link) act({ type: "repair", key: game.ui.link }); break;
      case "harden": if (game.ui.link) act({ type: "harden", key: game.ui.link, ...(t.dataset.hz ? { hz: t.dataset.hz } : {}) }); break;
      case "double": if (game.ui.link) act({ type: "double", key: game.ui.link }); break;
      case "hub": act({ type: "hub", city: t.dataset.city }); break;
      case "express": act({ type: "express", id: t.dataset.id }); break;
      case "closeExpress": act({ type: "closeExpress", id: t.dataset.id }); break;
      case "dtroute": {
        // double-track every single-track link left on the contract's route, one action each (undo takes them back one by one)
        const sv = game.ev.served.get(t.dataset.id);
        let n = 0;
        for (const key of sv?.keys || []) if (act({ type: "double", key }, { quiet: true })) n++;
        if (!n) ctx.toast("Nothing to double-track here (damaged links need repair first)");
        break;
      }
      case "coachNext": setCoach((game.ui.coach ?? 0) + 1); break;
      case "coachSkip": setCoach(COACH_STEPS); break;
      case "coachReplay": game.ui.help = false; ctx.storage.set("seenHow", true); setCoach(0); body.scrollTop = 0; break;
      case "unlink": game.ui.link = null; refresh(); break;
      case "tab": game.ui.tab = t.dataset.tab; refresh(); break;
      case "help": toggleHelp(); break;
      case "new": showPicker(); break;
      case "again": begin({ scenario: game.env.scenario.id, seed: newSeed(), home: game.env.home?.id }); break;
      case "share": {
        const txt = `${shareText(model())}\n${location.href}`;
        navigator.clipboard?.writeText(txt).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy"));
        break;
      }
      case "image": downloadImage(); break;
      case "reseed": {
        const inp = body.querySelector('[data-field="seed"]');
        if (inp) inp.value = newSeed();
        break;
      }
      case "resume": {
        const sv = loadSave();
        if (sv) begin({ scenario: sv.state.scenario, seed: sv.state.seed, home: sv.state.home }, sv);
        break;
      }
      case "boards": showBoards(); break;
      case "boardsBack": showPicker(); break;
      case "start": {
        const scenario = body.querySelector('input[name="ml-scn"]:checked')?.value || "texas";
        const seed = Math.max(0, Number.parseInt(body.querySelector('[data-field="seed"]')?.value, 10) || newSeed());
        const home = scenario === "sandbox" ? body.querySelector('[data-field="home"]')?.value || "19100" : null;
        begin({ scenario, seed, home });
        break;
      }
    }
  });
  body.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches('[data-act="demand"]')) {
      game.ui.showDemand = t.checked;
      setPref("showDemand", t.checked);
      view.refresh();
    } else if (t.matches('[data-act="trains"]')) {
      game.ui.trains = t.checked;
      setPref("trains", t.checked);
      view.syncTrains();
    } else if (t.matches('[data-act="sound"]')) {
      game.ui.sound = t.checked;
      setPref("sound", t.checked);
      sound.setOn(t.checked); // this change event is the user gesture that lets the AudioContext start
      if (t.checked) sound.play("build");
    } else if (t.matches('input[name="ml-scn"]')) {
      for (const l of body.querySelectorAll(".ml-scn")) l.classList.toggle("on", l.contains(t));
      const h = body.querySelector(".ml-home");
      if (h) h.hidden = t.value !== "sandbox";
    }
  });
  body.addEventListener("mouseover", (e) => {
    const li = e.target.closest("[data-contract]");
    const id = li?.dataset.contract || null;
    if (game.ui.screen !== "game" || id === game.ui.hover) return;
    game.ui.hover = id;
    view.redraw();
  });
  body.addEventListener("mouseleave", () => {
    if (game.ui.hover) { game.ui.hover = null; view.redraw(); }
  });

  function toggleHelp(on = !game.ui.help) {
    game.ui.help = on;
    if (!on) ctx.storage.set("seenHow", true);
    refresh();
    if (on) body.scrollTop = 0;
  }

  // --- share image ---
  async function downloadImage() {
    if (!game.state || !app.cam || !app.w) { ctx.toast("The map can't be drawn here"); return; }
    try {
      const blob = await shareImage(ctx, game, model());
      if (!blob) throw new Error("no image");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mainline-${game.env.scenario.id}${game.env.scenario.id === "sandbox" ? `-${game.env.home?.id}` : ""}-${game.state.seed}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) {
      console.error("mainline: share image failed", err);
      ctx.toast("Could not draw the image");
    }
  }

  // --- online boards ---
  let stopped = false;
  const cityName = (id) => ctx.cityById?.get(id)?.name || id;
  function boardModel() {
    if (!game.online.avail || !game.state?.over) return null;
    const o = game.online;
    return { ...o, scenario: game.env.scenario, hasLog: Array.isArray(game.log), player: net.player(), cityName };
  }
  async function submitRun() {
    const o = game.online;
    if (o.status === "sending" || !Array.isArray(game.log) || !game.state?.over) return;
    const env = game.env, state = game.state, log = game.log;
    const nickEl = body.querySelector('[data-field="nick"]');
    if (nickEl) o.nick = nickEl.value;
    o.status = "sending";
    o.error = null;
    refresh();
    const failed = (msg) => {
      if (game.state !== state) return; // a new game started meanwhile
      o.status = "idle";
      o.error = msg;
      refresh();
    };
    if (!net.player()) {
      const name = (o.nick || "").trim();
      if (!name) return failed("Pick a nickname first (2–20 letters, digits or spaces).");
      try { await net.ensurePlayer(name); } catch (err) { return failed(`Could not create your player: ${err.message}`); }
    }
    // replay locally first: a log that does not reproduce this game would only be refused by the server
    const run = { scenario: env.scenario.id, seed: state.seed, home: env.scenario.id === "sandbox" ? env.home?.id ?? null : null, log };
    const local = verifyRun(data, run);
    if (!local.ok || local.hash !== S.stateHash(state)) {
      return failed(`This game's move log does not replay${local.ok ? " to the same result" : `: ${local.error}`}, so it can't be submitted.`);
    }
    const r = await net.post("/api/ml/run", run);
    if (!r.ok) return failed(`The server refused the run: ${r.error}`);
    const b = await net.get(`/api/ml/board/${encodeURIComponent(env.scenario.id)}?limit=10`);
    if (game.state !== state) return;
    o.status = "done";
    o.result = r.data;
    o.board = b.ok ? b.data : null;
    o.error = b.ok ? null : `Your run is in, but the board did not load: ${b.error}`;
    refresh();
  }
  async function showBoards() {
    game.ui.screen = "picker";
    body.innerHTML = boardsHtml({ boards: null, cityName });
    const res = await Promise.all(S.SCENARIOS.map((sc) => net.get(`/api/ml/board/${sc.id}?limit=5`)));
    if (stopped || !body.querySelector(".ml-boards")) return; // left the view meanwhile
    const boards = Object.fromEntries(S.SCENARIOS.map((sc, k) => [sc.id, res[k].ok ? res[k].data : { error: `Could not load: ${res[k].error}` }]));
    body.innerHTML = boardsHtml({ boards, cityName });
  }
  body.addEventListener("submit", (e) => {
    if (!e.target.matches('[data-form="submit"]')) return;
    e.preventDefault();
    submitRun();
  });
  body.addEventListener("input", (e) => {
    if (e.target.matches('[data-field="nick"]')) game.online.nick = e.target.value;
  });

  // --- keyboard (ctx.onKey: runs before the map's own shortcuts, skipped while typing or with Ctrl/Cmd/Alt) ---
  ctx.onKey((e, k) => {
    if (game.ui.screen !== "game" || !game.state) return false;
    if (k === "z") {
      act({ type: "undo" });
      game.sel.plan = null;
      refreshBuild();
      return true;
    }
    if (k === "e" || (k === "Enter" && e.target?.tagName !== "BUTTON")) {
      act({ type: "endTurn" });
      return true;
    }
    if (k === "h" || k === "?") { toggleHelp(); return true; }
    return false;
  });

  // --- start: URL param, else the saved game, else the picker ---
  const want = parseParam(ctx.param);
  const svAll = loadSave();
  const sv = svAll?.state;
  if (want) {
    const same = sv && sv.scenario === want.scenario && sv.seed === want.seed && (want.scenario !== "sandbox" || !want.home || sv.home === want.home);
    begin(want, same ? svAll : null);
  } else if (sv && !sv.over) {
    begin({ scenario: sv.scenario, seed: sv.seed, home: sv.home }, svAll);
  } else showPicker();

  // online boards: only when this site has the backend (never on the static dev server)
  net.available().then((ok) => {
    if (!ok || stopped) return;
    game.online.avail = true;
    if (game.ui.screen === "end") refresh();
    else if (game.ui.screen === "picker") {
      const link = body.querySelector(".ml-boards-link");
      if (link) link.hidden = false;
    }
  });

  return {
    param: () => (game.state && game.ui.screen !== "picker" ? formatParam({ scenario: game.env.scenario.id, seed: game.state.seed, home: game.env.home?.id }) : null),
    onEscape() {
      if (game.ui.help) { toggleHelp(false); return true; }
      if (game.sel.start != null || game.ui.link || game.ui.highlight) {
        game.ui.link = null;
        game.ui.highlight = null;
        game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
        refresh();
        return true;
      }
      return true; // Esc never drops you out of a game; use ✕ in the dock
    },
    stop() { stopped = true; },
  };
}
