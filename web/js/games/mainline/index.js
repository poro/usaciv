// Mainline: lay freight rail across the real map, 2026→2050. Real FAF freight flows are the demand, real metro trends
// drive growth, real FEMA county rates roll the disasters. Single player against "baseline America".
//
// This file is the glue: the dock (panel.js), the map layers and overlays (view.js) and input. All game rules live in
// the pure, deterministic sim/ (state.js: apply(env, state, action)). Contract: see games/host.js.
// URL: #play=mainline~<scenario>.<seed>[.<home>]   Save: ctx.storage "save" (the whole state plus its action log,
// runlog.js, after every action). Online boards (docs/MULTIPLAYER.md) appear only when net.available().
// First-run tutorial: ctx.storage "tutorial" = the coach step (0..COACH_STEPS; COACH_STEPS = done or skipped).
// Prefs: ctx.storage "prefs" = {showDemand, trains (default on), sound (default off)}. Trains and sound are view-only.
// Versus (sim/versus.js, vspanel.js; the protocol is in docs/MULTIPLAYER.md): game.vs is set while one runs.
//   vs AI:  #play=mainline~ai.<scenario>.<seed>.<bots>.<years>[.<home>]; saved in ctx.storage "vssave" = {init, scenario,
//           home, log (entries)} and replayed on resume. The AI companies play when you end the year.
//   online: #play=mainline~vs-<CODE>; the room (a Durable Object) holds the entry log. Your own actions apply at once
//           (game.vs.pending) and are confirmed when the room echoes them; everyone else's arrive as entries.
//   game.state is always your company's state, so the map, the build tools and the panel work unchanged.
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
import { vsPickerHtml, vsLobbyHtml, vsEndHtml, vsReadyHtml, vsShareText } from "./vspanel.js";

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
  game.act = (a) => act(a); // debugging: apply an action as the dock would
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
    if (game.vs) { saveVs(); return; } // a versus game never touches the solo save
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
      vs: vsPicker(),
    });
    view.redraw();
  }

  function refresh() {
    if (game.vs && game.ui.screen === "lobby") { body.innerHTML = vsLobbyHtml(model()); view.refresh(); return; }
    if (!game.state) return;
    game.ev = S.evaluate(game.env, game.state);
    if (game.vs && game.ui.screen === "end") body.innerHTML = vsEndHtml(model());
    else if (game.ui.screen === "end") body.innerHTML = endHtml(model(), ctx.storage.get(`best:${game.env.scenario.id}`, null), boardModel());
    else {
      const scroll = body.scrollTop;
      body.innerHTML = gameHtml(model());
      body.scrollTop = scroll;
    }
    view.refresh();
  }
  const model = () => ({
    env: game.env, state: game.state, ev: game.ev, sum: game.state ? S.summary(game.env, game.state) : null, ui: game.ui, sel: game.sel, touch,
    vs: game.vs ? { ...game.vs, now: Date.now() } : null, cityName,
  });
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
    if (game.vs) return vsAction(action, { quiet });
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

  // --- versus (sim/versus.js) ---
  const clone = (a) => JSON.parse(JSON.stringify(a));
  const aiParam = (i) => `ai.${i.scenario}.${i.seed}.${i.bots}.${i.years}${i.home && i.scenario === "sandbox" ? `.${i.home}` : ""}`;
  function parseAi(p) {
    const m = /^ai\.([a-z]+)\.(\d+)\.([1-3])\.(\d+)(?:\.(\d{5}))?$/.exec(p || "");
    if (!m || !S.scenarioById(m[1]) || !S.VS_YEARS.includes(+m[4])) return null;
    return { scenario: m[1], seed: +m[2], bots: +m[3], years: +m[4], home: m[1] === "sandbox" ? m[5] || "19100" : null };
  }
  function loadVsSave() {
    const sv = ctx.storage.get("vssave", null);
    return sv && sv.init && Array.isArray(sv.log) && S.scenarioById(sv.scenario) ? sv : null;
  }
  function vsPicker() {
    const sv = loadVsSave();
    const pick = vsPickerHtml({ online: game.online.avail, player: net.player(), defaults: ctx.storage.get("vsprefs", {}) || {} });
    if (!sv || sv.over) return pick;
    const sc = S.scenarioById(sv.scenario);
    return `<button class="g-btn ml-wide" data-act="vsResume">Resume versus: ${esc(sc.name)} vs ${sv.init.players.length - 1} AI, ${sv.year}</button>${pick}`;
  }
  function vsOpts() {
    const years = Number(body.querySelector('[data-field="vsYears"]')?.value) || 10;
    const bots = Number(body.querySelector('[data-field="vsBots"]')?.value);
    const scenario = body.querySelector('input[name="ml-scn"]:checked')?.value || "texas";
    const home = scenario === "sandbox" ? body.querySelector('[data-field="home"]')?.value || "19100" : null;
    ctx.storage.set("vsprefs", { years, bots: Number.isFinite(bots) ? bots : 1 });
    return { scenario, home, years: S.VS_YEARS.includes(years) ? years : 10, bots: Number.isFinite(bots) ? bots : 1 };
  }
  /** Enter a versus game whose vs object exists (fresh, resumed or replayed from the room). */
  function enterVs(v) {
    game.vs = v;
    game.env = v.env;
    game.log = null; // no board submission for versus
    game.sel = { start: null, end: null, hover: null, plan: null };
    game.ui.highlight = null;
    game.ui.link = null;
    game.ui.tab = "open";
    game.ui.coach = null;
    game.ui.help = false;
    view.reset();
    syncVs();
    frame();
  }
  /** game.state ← my company; screen from the game's progress; redraw. */
  function syncVs() {
    const v = game.vs;
    game.vsRev = (game.vsRev || 0) + 1;
    if (!v.vs) { game.state = null; game.ui.screen = "lobby"; refresh(); return; }
    game.state = v.vs.players[v.me].state;
    if (game.ui.link && !game.state.links[game.ui.link]) game.ui.link = null;
    game.ui.screen = v.vs.over ? "end" : "game";
    refresh();
  }
  function saveVs() {
    const v = game.vs;
    if (v?.mode !== "ai" || !v.vs) return;
    ctx.storage.set("vssave", { init: v.init, scenario: v.vs.scenario, home: v.vs.home, log: v.log, year: v.vs.year, over: v.vs.over });
  }
  function beginAi(o, saved = null) {
    const env = getEnv(o.scenario, o.home);
    let init, vs, log;
    if (saved) {
      init = saved.init;
      const r = S.vsReplay(env, init, saved.log);
      if (r.error) ctx.toast(`The saved versus game stopped replaying at move ${r.at + 1}: ${r.error}`);
      vs = r.vs;
      log = saved.log.slice(0, r.at);
    } else {
      const bots = Math.max(1, Math.min(S.VS_MAX - 1, o.bots || 1));
      init = { seed: o.seed, years: o.years, players: [{ name: net.player()?.name || "Your company" }, ...Array.from({ length: bots }, (_, k) => ({ name: S.BOT_NAMES[k], bot: true }))] };
      vs = S.newVersus(env, init);
      log = [];
    }
    const bots = init.players.length - 1;
    enterVs({ mode: "ai", env, vs, me: 0, init, log, param: aiParam({ scenario: o.scenario, home: env.home?.id, seed: init.seed, bots, years: init.years }) });
    ctx.setParam(game.vs.param);
    saveVs();
  }
  /** My action in a versus game. */
  function vsAction(action, { quiet = false } = {}) {
    const v = game.vs;
    if (!v.vs || v.vs.over) return false;
    if (action.type === "endTurn") { vsEndYear(); return true; }
    if (v.mode === "online" && v.ready) { if (!quiet) ctx.toast("You're ready: press the Ready button again to keep playing this year"); return false; }
    const r = S.vsAct(game.env, v.vs, v.me, action);
    if (r.error) { if (!quiet) ctx.toast(r.error); return false; }
    v.vs = r.vs;
    if (v.mode === "ai") { v.log.push({ p: v.me, a: clone(action) }); saveVs(); }
    else { v.pending.push(clone(action)); vsSend({ t: "act", a: action }); }
    if (action.type === "build") sound.play("build");
    syncVs();
    return true;
  }
  function vsEndYear() {
    const v = game.vs;
    if (v.mode === "online") {
      vsSend({ t: "ready", on: !v.ready });
      v.ready = !v.ready; // the room's next update confirms it
      refresh();
      return;
    }
    const before = v.vs;
    let vs = v.vs;
    for (let p = 0; p < vs.players.length; p++) {
      if (!vs.players[p].bot) continue;
      for (const a of S.botActions(game.env, vs, p)) {
        const r = S.vsAct(game.env, vs, p, a);
        if (r.error) break; // cannot happen (the bot checks every action); stop this bot rather than corrupt the log
        vs = r.vs;
        v.log.push({ p, a });
      }
    }
    vs = S.vsResolve(game.env, vs);
    v.log.push({ r: 1 });
    v.vs = vs;
    saveVs();
    vsAfterYear(before);
  }
  /** Toast the year that just ended, from my company's side. */
  function vsAfterYear(before) {
    const v = game.vs;
    game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
    const r = v.vs.players[v.me].state.last;
    const won = v.vs.news.filter((n) => n.to === v.me).length, lost = v.vs.news.filter((n) => n.from === v.me).length;
    const deals = won || lost ? ` · ${won ? `+${won} contract${won === 1 ? "" : "s"}` : ""}${won && lost ? ", " : ""}${lost ? `−${lost} to rivals` : ""}` : "";
    if (r) ctx.toast(`${before.year}: +${r.revenue.toFixed(1)} cr freight, −${r.maint.toFixed(1)} upkeep${r.hits ? ` · ${r.hits} disaster${r.hits === 1 ? "" : "s"}` : ""}${deals}`);
    sound.play(r?.damaged ? "disaster" : "turn");
    syncVs();
  }

  // --- online versus rooms ---
  let vsTimer = 0;
  function vsSend(msg) {
    const ws = game.vs?.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function vsTick() {
    clearInterval(vsTimer);
    vsTimer = 0;
    if (!game.vs?.deadline || game.ui.screen !== "game") return;
    vsTimer = setInterval(() => {
      const el = body.querySelector(".ml-vs-ready");
      if (!game.vs?.deadline || !el) { clearInterval(vsTimer); vsTimer = 0; return; }
      el.innerHTML = vsReadyHtml(model());
    }, 1000);
  }
  ctx.onCleanup(() => { clearInterval(vsTimer); vsLeave({ quietly: true }); });
  async function vsCreate() {
    const o = vsOpts();
    if (!(await vsNick())) return;
    const r = await net.post("/api/ml/vs", { scenario: o.scenario, ...(o.home ? { home: o.home } : {}), years: o.years, bots: Math.min(o.bots, S.VS_MAX - 1) });
    if (!r.ok) { ctx.toast(`Could not make a room: ${r.error}`); return; }
    vsJoin(r.data.code);
  }
  /** Make sure there is an online player (the picker's or lobby's nickname field). */
  async function vsNick() {
    if (net.player()) return true;
    const name = (body.querySelector('[data-field="nick"]')?.value || game.online.nick || "").trim();
    if (!name) { ctx.toast("Pick a nickname first (2–20 letters, digits or spaces)"); body.querySelector('[data-field="nick"]')?.focus(); return false; }
    try { await net.ensurePlayer(name); return true; } catch (err) { ctx.toast(`Could not create your player: ${err.message}`); return false; }
  }
  function vsJoin(code) {
    vsLeave({ quietly: true });
    game.vs = { mode: "online", code, param: `vs-${code}`, room: null, conf: null, vs: null, pending: [], log: [], me: -1, ready: false, waiting: [], deadline: null, error: null, player: net.player(), ws: null, tries: 0, left: false, env: null, init: null };
    game.state = null;
    game.ui.screen = "lobby";
    ctx.setParam(game.vs.param);
    refresh();
    vsConnect();
  }
  async function vsConnect() {
    const v = game.vs;
    if (!v || v.left) return;
    if (!(await net.available())) { v.error = "This copy of the site has no online play."; refresh(); return; }
    if (!net.player()) { v.error = null; v.needNick = true; body.innerHTML = vsNickHtml(); return; }
    v.player = net.player();
    const ws = net.socket(`/api/ml/vs/${encodeURIComponent(v.code)}/ws`);
    v.ws = ws;
    ws.onopen = () => { v.tries = 0; };
    ws.onmessage = (e) => { if (game.vs === v) { try { vsOnMessage(v, JSON.parse(e.data)); } catch (err) { console.error("mainline versus: bad message", err); } } };
    ws.onclose = (e) => {
      if (game.vs !== v || v.left || v.ws !== ws) return;
      if (e.code === 4001) { v.error = v.room?.status === "live" ? "This game has already started, and you are not in it." : "This room is full."; v.left = true; }
      else if (v.room?.status === "done") return;
      else if (++v.tries <= 6) { v.error = "Connection lost; reconnecting…"; setTimeout(vsConnect, Math.min(8000, 800 * 2 ** v.tries)); }
      else v.error = "Lost the connection to the room. Reload to try again.";
      if (game.ui.screen === "lobby") refresh();
      else ctx.toast(v.error);
    };
  }
  const vsNickHtml = () => `<div class="ml-vs-lobby"><div class="ml-verdict">Join versus room <b class="ml-vs-code">${esc(game.vs.code)}</b></div>
    <label class="ml-vs-nick">Your nickname <input data-field="nick" maxlength="20" autocomplete="nickname" placeholder="2–20 letters"></label> <button type="button" class="linkish-open" data-open-account>Have a player? Sign in</button>
    <div class="g-row"><button class="g-btn primary" data-act="vsJoinNick">Join</button><button class="g-btn" data-act="vsLeave">Back</button></div></div>`;
  function vsInitFromRoom(v) {
    const r = v.room;
    v.env = getEnv(r.scenario, r.home);
    v.init = { seed: r.seed, years: r.years, players: r.players.map((p) => ({ name: p.name, bot: !!p.bot })) };
    v.me = r.players.findIndex((p) => p.id === v.player?.id);
  }
  /** Displayed game = the room's confirmed game + my actions it has not echoed yet. */
  function vsView(v) {
    let d = v.conf;
    const keep = [];
    for (const a of v.pending) {
      const r = S.vsAct(v.env, d, v.me, a);
      if (!r.error) { d = r.vs; keep.push(a); }
    }
    v.pending = keep;
    v.vs = d;
  }
  function vsOnMessage(v, m) {
    if (m.t === "room") {
      const prev = v.room;
      v.room = m.room;
      v.error = null;
      const r = m.room;
      if (r.status !== "lobby" && !v.env) vsInitFromRoom(v);
      const meRow = r.players[v.me];
      v.ready = !!meRow?.ready;
      v.waiting = r.players.filter((p, k) => !p.bot && p.online && !p.ready && k !== v.me).map((p) => p.name);
      v.deadline = r.deadline || null;
      if (r.status === "lobby") { game.ui.screen = "lobby"; refresh(); return; }
      if (!v.conf) { if (v.stash) { const st = v.stash; v.stash = null; vsOnMessage(v, st); } return; } // else the log follows
      if (prev?.status === "lobby") enterVs(v);
      else refresh();
      vsTick();
      return;
    }
    if (m.t === "log") {
      if (!v.room || v.room.status === "lobby") { v.stash = m; return; } // the room update that starts the game follows
      if (!v.env) vsInitFromRoom(v);
      if (v.me < 0) { v.error = "You are not seated in this game."; refresh(); return; }
      const r = S.vsReplay(v.env, v.init, m.es);
      if (r.error) { v.error = `The room's log did not replay (move ${r.at + 1}: ${r.error})`; console.error(v.error); }
      const first = !v.conf;
      v.conf = r.vs;
      v.log = m.es.slice(0, r.at);
      v.pending = [];
      vsView(v);
      if (first) enterVs(v); else syncVs();
      vsTick();
      return;
    }
    if (m.t === "entries") {
      if (!v.conf || m.i !== v.log.length) { vsSend({ t: "sync" }); return; }
      const before = v.conf;
      let resolved = false;
      for (const e of m.es) {
        const r = S.applyEntry(v.env, v.conf, e);
        if (r.error) { console.error("mainline versus: entry refused locally", e, r.error); vsSend({ t: "sync" }); return; }
        v.conf = r.vs;
        v.log.push(e);
        if (e.p === v.me && v.pending.length) v.pending.shift();
        if (e.r === 1) resolved = true;
      }
      vsView(v);
      if (resolved) { v.ready = false; vsAfterYear(before); } else syncVs();
      vsTick();
      return;
    }
    if (m.t === "reject") {
      ctx.toast(`The room refused that: ${m.error}`);
      v.pending = [];
      vsView(v);
      syncVs();
      return;
    }
    if (m.t === "error") {
      v.error = m.error;
      if (game.ui.screen === "lobby") refresh(); else ctx.toast(m.error);
    }
  }
  function vsLeave({ quietly = false } = {}) {
    const v = game.vs;
    if (!v) return;
    v.left = true;
    try { v.ws?.close(1000, "left"); } catch { /* already closed */ }
    clearInterval(vsTimer);
    vsTimer = 0;
    game.vs = null;
    game.state = null;
    game.vsRev = (game.vsRev || 0) + 1;
    view.reset();
    if (!quietly) showPicker();
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
      case "vsAi": { const o = vsOpts(); beginAi({ ...o, seed: newSeed() }); break; }
      case "vsResume": { const sv = loadVsSave(); if (sv) beginAi({ scenario: sv.scenario, home: sv.home }, sv); break; }
      case "vsAgain": { const i = game.vs?.init; if (i) beginAi({ scenario: game.env.scenario.id, home: game.env.home?.id, seed: newSeed(), bots: i.players.length - 1, years: i.years }); break; }
      case "vsCreate": vsCreate(); break;
      case "vsNewRoom": {
        const r = game.vs?.room;
        if (!r) break;
        net.post("/api/ml/vs", { scenario: r.scenario, ...(r.home ? { home: r.home } : {}), years: r.years, bots: r.bots }).then((res) => {
          if (res.ok) vsJoin(res.data.code); else ctx.toast(`Could not make a room: ${res.error}`);
        });
        break;
      }
      case "vsJoinNick": vsNick().then((ok) => { if (ok && game.vs) { game.vs.needNick = false; vsConnect(); } }); break;
      case "vsStart": vsSend({ t: "start" }); break;
      case "unready": vsEndYear(); break;
      case "vsLeave": vsLeave(); break;
      case "vsCopy": navigator.clipboard?.writeText(t.dataset.link).then(() => ctx.toast("Link copied"), () => ctx.toast("Could not copy")); break;
      case "vsShare": navigator.clipboard?.writeText(`${vsShareText(model())}\n${location.origin}${location.pathname}#play=mainline`).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy")); break;
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
  const wantAi = parseAi(ctx.param);
  const wantRoom = /^vs-([A-Za-z0-9]{6})$/.exec(ctx.param || "")?.[1]?.toUpperCase();
  if (wantRoom) vsJoin(wantRoom);
  else if (wantAi) {
    const vsv = loadVsSave();
    const same = vsv && aiParam({ scenario: vsv.scenario, home: vsv.home, seed: vsv.init.seed, bots: vsv.init.players.length - 1, years: vsv.init.years }) === aiParam(wantAi);
    beginAi(wantAi, same ? vsv : null);
  } else if (want) {
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
      const slot = body.querySelector(".ml-vs-slot");
      if (slot) slot.innerHTML = vsPicker();
    }
  });

  return {
    param: () => (game.vs ? game.vs.param : game.state && game.ui.screen !== "picker" ? formatParam({ scenario: game.env.scenario.id, seed: game.state.seed, home: game.env.home?.id }) : null),
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
