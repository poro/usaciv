// Mainline: lay freight rail across the real map, 2026→2050. Real FAF freight flows are the demand, real metro trends
// drive growth, real FEMA county rates roll the disasters. Single player against "baseline America".
//
// This file is the glue: the dock (panel.js), the map layers and overlays (view.js) and input. All game rules live in
// the pure, deterministic sim/ (state.js: apply(env, state, action)). Contract: see games/host.js.
// URL: #play=mainline~<scenario>.<seed>[.<home>]   Save: ctx.storage "save" (the whole state, after every action).
import { loadCss } from "../shared/css.js";
import { esc } from "../../format.js";
import * as S from "./sim/index.js";
import { makeView } from "./view.js";
import { pickerHtml, gameHtml, buildHtml, endHtml, shareText, contractText } from "./panel.js";
import { parseParam, formatParam } from "./params.js";

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
    sel: { start: null, end: null, hover: null, plan: null },
    ui: { tab: "open", showDemand: prefs.showDemand !== false, highlight: null, hover: null, link: null, help: false, screen: "picker" },
    contractTip: (id) => {
      const c = game.env?.contractById.get(id);
      if (!c) return null;
      const [head, ...rest] = contractText(game.env, c, game.ev.served.get(id)).split("\n");
      return `<b>${esc(head)}</b><br>${rest.map(esc).join("<br>")}`;
    },
  };
  let touch = false;
  const view = makeView(ctx, game);
  // debugging handle (like app.mapArt): the live game model, removed on exit
  app.mainline = game;
  ctx.onCleanup(() => { if (app.mainline === game) delete app.mainline; });

  // --- flow ---
  function valid(s) { return !!(s && s.v === 1 && S.scenarioById(s.scenario) && s.links && s.cities && s.base); }
  function newSeed() { return 1 + Math.floor(Math.random() * 99999); }
  function begin({ scenario, seed, home }, saved = null) {
    const env = getEnv(scenario, home);
    game.env = env;
    game.state = saved || S.newGame(env, { seed });
    game.sel = { start: null, end: null, hover: null, plan: null };
    game.ui.highlight = null;
    game.ui.link = null;
    game.ui.tab = "open";
    game.ui.screen = game.state.over ? "end" : "game";
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
    if (game.state) ctx.storage.set("save", game.state);
  }
  function showPicker() {
    game.ui.screen = "picker";
    game.sel = { start: null, end: null, hover: null, plan: null };
    ctx.setParam(null);
    const sv = ctx.storage.get("save", null);
    let saveEnv = null;
    try { if (valid(sv)) saveEnv = getEnv(sv.scenario, sv.home); } catch { saveEnv = null; }
    const metros = ctx.cities.filter((c) => c.metro).slice(0, 150).sort((a, b) => a.name.localeCompare(b.name));
    const last = game.state ? { scenario: game.state.scenario, home: game.state.home } : sv ? { scenario: sv.scenario, home: sv.home } : {};
    body.innerHTML = pickerHtml({
      save: sv, saveEnv, cities: metros,
      defaults: { scenario: last.scenario || "texas", home: last.home || "19100", seed: newSeed() },
    });
    view.redraw();
  }

  function refresh() {
    if (!game.state) return;
    game.ev = S.evaluate(game.env, game.state);
    if (game.ui.screen === "end") body.innerHTML = endHtml(model(), ctx.storage.get(`best:${game.env.scenario.id}`, null));
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
    if (el) el.innerHTML = buildHtml(model());
    view.redraw();
  }

  function act(action) {
    if (!game.state) return false;
    const err = S.check(game.env, game.state, action);
    if (err) { ctx.toast(err); return false; }
    const before = game.state;
    game.state = S.apply(game.env, game.state, action);
    if (action.type === "endTurn") afterTurn(before);
    if (game.ui.link && !game.state.links[game.ui.link]) game.ui.link = null;
    save();
    refresh();
    return true;
  }
  function afterTurn(before) {
    game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
    const r = game.state.last;
    const dmg = r.damaged ? `, ${r.damaged} link${r.damaged === 1 ? "" : "s"} damaged` : "";
    ctx.toast(`${before.year}: +${r.revenue.toFixed(1)} cr freight, −${r.maint.toFixed(1)} upkeep${r.hits ? ` · ${r.hits} disaster${r.hits === 1 ? "" : "s"}${dmg}` : ""}`);
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
      case "harden": if (game.ui.link) act({ type: "harden", key: game.ui.link }); break;
      case "unlink": game.ui.link = null; refresh(); break;
      case "tab": game.ui.tab = t.dataset.tab; refresh(); break;
      case "help": game.ui.help = !game.ui.help; refresh(); break;
      case "new": showPicker(); break;
      case "again": begin({ scenario: game.env.scenario.id, seed: newSeed(), home: game.env.home?.id }); break;
      case "share": {
        const txt = `${shareText(model())}\n${location.href}`;
        navigator.clipboard?.writeText(txt).then(() => ctx.toast("Result copied"), () => ctx.toast("Could not copy"));
        break;
      }
      case "reseed": {
        const inp = body.querySelector('[data-field="seed"]');
        if (inp) inp.value = newSeed();
        break;
      }
      case "resume": {
        const sv = ctx.storage.get("save", null);
        if (sv) begin({ scenario: sv.scenario, seed: sv.seed, home: sv.home }, sv);
        break;
      }
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
      ctx.storage.set("prefs", { ...prefs, showDemand: t.checked });
      view.refresh();
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

  // --- keyboard ---
  const onKey = (e) => {
    if (e.defaultPrevented || game.ui.screen !== "game") return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ((k === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) || (k === "z" && !e.metaKey && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      act({ type: "undo" });
      game.sel.plan = null;
      refreshBuild();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (k === "e" || (k === "Enter" && !(t && t.tagName === "BUTTON")))) {
      e.preventDefault();
      act({ type: "endTurn" });
    }
  };
  window.addEventListener("keydown", onKey);
  ctx.onCleanup(() => window.removeEventListener("keydown", onKey));

  // --- start: URL param, else the saved game, else the picker ---
  const want = parseParam(ctx.param);
  const sv = ctx.storage.get("save", null);
  if (want) {
    const same = valid(sv) && sv.scenario === want.scenario && sv.seed === want.seed && (want.scenario !== "sandbox" || !want.home || sv.home === want.home);
    begin(want, same ? sv : null);
  } else if (valid(sv) && !sv.over) {
    begin({ scenario: sv.scenario, seed: sv.seed, home: sv.home }, sv);
  } else showPicker();

  return {
    param: () => (game.state && game.ui.screen !== "picker" ? formatParam({ scenario: game.env.scenario.id, seed: game.state.seed, home: game.env.home?.id }) : null),
    onEscape() {
      if (game.ui.help) { game.ui.help = false; refresh(); return true; }
      if (game.sel.start != null || game.ui.link || game.ui.highlight) {
        game.ui.link = null;
        game.ui.highlight = null;
        game.sel = { start: null, end: null, hover: game.sel.hover, plan: null };
        refresh();
        return true;
      }
      return true; // Esc never drops you out of a game; use ✕ in the dock
    },
    stop() {},
  };
}
