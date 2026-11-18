// ==UserScript==
// @name         Poke'Catch Team Optimizer
// @namespace    pokecatch-helper
// @version      1.5.5
// @description  Reads the current chapter events, watches for team wipes (and where they happen), then builds an optimal team of 6 from the PC with Defense / Offense / Balanced presets.
// @author       GrumpyOwl
// @match        https://pokecatch-online.netlify.app/*
// @match        https://pokecatch-online.pages.dev/*
// @updateURL    https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      pokemondb.net
// @connect      pokeapi.co
// @connect      pokecatch-online.pages.dev
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  // one instance per page load (a second injection would fight over the same panel)
  if (window.__pcopt) return;

  /* ------------------------------------------------------------------ *
   * 0. Small helpers
   * ------------------------------------------------------------------ */
  const SAVE_KEY = 'gachamon-save-v1';
  const VERSION = '1.5.5';
  const UPDATE_URL = 'https://raw.githubusercontent.com/smuglilgoat/pokecatch-helper/main/pokecatch-team-optimizer.user.js';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => (Math.round(n * 10) / 10).toLocaleString('en-US');

  const store = {
    get(key, dflt) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, dflt);
        const raw = localStorage.getItem('pcopt:' + key);
        return raw == null ? dflt : JSON.parse(raw);
      } catch { return dflt; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(key, val);
        localStorage.setItem('pcopt:' + key, JSON.stringify(val));
      } catch { /* quota: keep the cached copy in memory only */ }
    },
  };

  // Cross-origin GET (pokemondb does not send CORS headers).
  function httpGet(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 20000,
          onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout'))
        });
      });
    }
    return fetch(url, { credentials: 'omit' }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }
  const httpGetJson = url => httpGet(url).then(t => JSON.parse(t));

  /* ------------------------------------------------------------------ *
   * 0b. Console log: every action goes through here, prefixed [pcopt],
   *     so a game update that breaks something is visible in the console
   *     (and in window.__pcopt.logs) instead of failing silently.
   * ------------------------------------------------------------------ */
  const LOG_MAX = 400;
  const logs = [];
  function log(level, action, detail) {
    const entry = { at: new Date().toISOString(), level, action, detail };
    logs.push(entry);
    if (logs.length > LOG_MAX) logs.shift();
    const line = '[pcopt] ' + action;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug : console.log;
    if (detail === undefined) fn(line); else fn(line, detail);
  }
  const logError = (action, e) => log('error', action, (e && e.message) || String(e));

  /* ------------------------------------------------------------------ *
   * 1. Game data: parsed from the bundle the page itself loaded
   * ------------------------------------------------------------------ */
  const UNOWN_IDS = [201, ...Array.from({ length: 28 }, (_, i) => 20101 + i)];

  function literalAt(src, start) {
    const open = src[start], close = open === '[' ? ']' : '}';
    let depth = 0, str = null, esc = false;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (str) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === str) str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced literal');
  }

  function literalAfter(src, marker, from = 0) {
    const i = src.indexOf(marker, from);
    if (i < 0) throw new Error('marker not found: ' + marker);
    let start = -1;
    if (marker.endsWith('[') || marker.endsWith('{')) start = i + marker.length - 1;
    else for (let j = i + marker.length; j < src.length; j++) {
      if (src[j] === '[' || src[j] === '{') { start = j; break; }
    }
    if (start < 0) throw new Error('no literal after ' + marker);
    return literalAt(src, start);
  }

  /** Every literal that follows a marker (the game extends some tables with Object.assign). */
  function literalsAfter(src, marker) {
    const out = [];
    let from = 0, at;
    while ((at = src.indexOf(marker, from)) >= 0) {
      from = at + marker.length;
      let start = -1;
      for (let j = from; j < src.length; j++) {
        if (src[j] === '[' || src[j] === '{') { start = j; break; }
      }
      if (start < 0) break;
      out.push(literalAt(src, start));
    }
    return out;
  }

  const evalLit = (lit, stub = {}) => Function('a', 'return (' + lit + ')')(stub);

  /**
   * Evaluate a data literal that reads minified variables of the bundle scope
   * (game helpers, cond constants). Unknown identifiers become door conditions.
   * Table names are rebuilt by the minifier on every game update, so the parser
   * never depends on them: it only looks at the shape of the data.
   */
  const JS_GLOBALS = new Set(['Infinity', 'NaN', 'undefined', 'Math', 'JSON', 'Object', 'Array',
    'String', 'Number', 'Boolean', 'Date', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'RegExp', 'Map', 'Set', 'BigInt', 'Promise', 'Error', 'console']);
  function evalSandbox(lit, defaults = {}) {
    const scope = new Proxy(defaults, {
      has: (t, k) => typeof k === 'string' && !JS_GLOBALS.has(k) && !(k in t),
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        return (...args) => ({ cond: { kind: 'door', key: String(args[0] ?? k) } });
      }
    });
    return new Function('__scope', 'with (__scope) { return (' + lit + '); }')(scope);
  }

  /** Notice when the repo has a newer version: the install itself stays in Tampermonkey's hands. */
  async function checkUpdate() {
    const installed = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || VERSION;
    try {
      const code = await httpGet(UPDATE_URL + '?cb=' + Date.now());
      const repo = (code.match(/@version\s+(\S+)/) || [])[1];
      if (!repo || repo === installed) { log('debug', 'update: up to date', installed); return; }
      log('info', 'update: a newer version is on GitHub', { installed, repo });
      state.update = { installed, repo };
      refreshUi();
    } catch (e) { log('debug', 'update: check failed', e.message); }
  }

  /** Every `name = <literal>` in the bundle (minified names are reused in several scopes). */
  function defLiterals(src, name, open) {
    const out = [];
    const re = new RegExp('(^|[^\\w$.])' + name + '\\s*=', 'g');
    let m;
    while ((m = re.exec(src))) {
      let at = m.index + m[0].length;
      while (/\s/.test(src[at])) at++;
      if (src[at] !== open) continue;
      try { out.push(literalAt(src, at)); } catch { /* not a plain literal */ }
    }
    return out;
  }

  /** The value the game publishes under `a.<module>` (public names survive minification). */
  function moduleNames(src, module) {
    const at = src.indexOf('a.' + module + '={');
    if (at < 0) return null;
    try {
      const table = literalAt(src, src.indexOf('{', at));
      const names = {};
      for (const m of table.matchAll(/([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)/g)) names[m[1]] = m[2];
      return names;
    } catch { return null; }
  }

  function bundleUrl() {
    const src = $$('script[src]').map(s => s.src).find(u => /\/bundle\/app\.[0-9a-f]+\.js$/.test(u));
    return src || null;
  }

  /** Extract the game's static tables from its own bundle. */
  async function parseBundle(url) {
    const t0 = Date.now();
    log('info', 'bundle: fetching', url);
    const src = await httpGet(url);
    log('debug', 'bundle: fetched', { bytes: src.length, ms: Date.now() - t0 });

    const table = (label, required, fn) => {
      try {
        const v = fn();
        if (v == null) throw new Error('not found');
        log('debug', 'bundle: table ok', { label, size: Array.isArray(v) ? v.length : Object.keys(v).length });
        return v;
      } catch (e) {
        log('error', 'bundle: table failed', { label, error: e.message });
        if (required) throw new Error('game update changed the bundle: ' + label + ' — ' + e.message);
        return null;
      }
    };
    const read = (marker, defaults) => () => {
      const lit = literalAfter(src, marker);
      try { return evalLit(lit, defaults); } catch { return evalSandbox(lit, defaults); }
    };

    const dex = table('POKEDEX', true, read('a.POKEDEX='));
    const moves = table('MOVES', true, read('a.MOVES='));
    const chart = table('TYPE_CHART', true, read('a.TYPE_CHART='));
    const evo = table('EVOLUTIONS', true, read('a.EVOLUTIONS='));
    const enc = table('ENCOUNTERS', true, read('a.ENCOUNTERS='));
    for (const lit of literalsAfter(src, 'Object.assign(a.ENCOUNTERS,')) Object.assign(enc, evalLit(lit));
    const regions = table('REGIONS', true, () => {
      const at = src.indexOf('REGIONS:[{key:');
      if (at < 0) throw new Error('marker not found');
      return evalSandbox(literalAt(src, at + 8));
    });
    const cfg = table('CONFIG', true, read('a.CONFIG='));
    const chapters = table('CHAPTERS', true, () => {
      const lit = literalAfter(src, 'CHAPTERS:[').replace(/a\.UNOWN\.ids/g, JSON.stringify(UNOWN_IDS));
      try { return evalLit(lit); } catch { return evalSandbox(lit); }
    });
    const leagueTeams = table('LEAGUE_TEAMS', false, read('a.LEAGUE_TEAMS=')) || {};
    const baseExp = table('BASE_EXP', false, read('a.BASE_EXP=')) || {};
    // the moves that can inflict a status: the learnset grading counts them as usable
    const statusMoves = table('STATUS.MOVES', false, () => {
      const anchor = src.indexOf('a.STATUS=function(){const s={');
      if (anchor < 0) throw new Error('marker not found');
      const brace = src.indexOf('{', anchor + 'a.STATUS=function(){const s='.length - 1);
      return evalLit(literalAt(src, brace));
    }) || {};
    // legend zones live in the same bundle: reading them here means one fetch, not two
    let legends = null;
    try { legends = parseLegends(src); } catch (e) { logError('bundle: legends', e); }

    // a half-read table would poison the cache and every result: refuse it
    const checks = [
      ['POKEDEX', dex.length > 500],
      ['MOVES', Object.keys(moves).length > 100],
      ['EVOLUTIONS', Object.keys(evo).length > 50],
      ['ENCOUNTERS', Object.keys(enc).length > 20],
      ['REGIONS', regions.length > 1],
      ['CHAPTERS', chapters.length > 10],
      ['CONFIG', cfg && cfg.MAX_LEVEL > 0],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([label]) => label);
    if (bad.length) throw new Error('game update changed the bundle: implausible ' + bad.join(', '));

    const species = {};
    for (const s of dex) species[s.id] = { id: s.id, name: s.name, types: s.types, stats: s.stats, learn: s.learn, captureRate: s.captureRate, legendary: s.legendary, mythical: s.mythical, baby: s.baby, unique: s.unique };

    log('info', 'bundle: parsed', {
      url: url.split('/').pop(), dex: dex.length, moves: Object.keys(moves).length,
      chapters: chapters.length, regions: regions.length, ms: Date.now() - t0,
    });
    return {
      version: url,
      species,
      moves,
      chart,
      evo,
      enc,
      chapters,
      regions,
      leagueTeams,
      baseExp,
      statusMoves,
      legends,
      cfg: {
        LEVEL_GAP: cfg.LEVEL_GAP, CRIT_MULT: cfg.CRIT_MULT, CRIT_CHANCE: cfg.CRIT_CHANCE,
        ENEMY_DAMAGE: cfg.ENEMY_DAMAGE, GYM_DAMAGE: cfg.GYM_DAMAGE, GYM_HP_MULT: cfg.GYM_HP_MULT,
        GYM_TEAM_EXP: cfg.GYM_TEAM_EXP, ENEMY_HP_PER_ALLY: cfg.ENEMY_HP_PER_ALLY,
        HP_LEVEL_SCALE: cfg.HP_LEVEL_SCALE, HP_LEVEL_MAX: cfg.HP_LEVEL_MAX, HP_BOOST: cfg.HP_BOOST,
        SHINY_STAT_BONUS: cfg.SHINY_STAT_BONUS, TYPE_EFF_MAX: cfg.TYPE_EFF_MAX, TYPE_EFF_MIN: cfg.TYPE_EFF_MIN,
        MOVE_BLACKLIST: cfg.MOVE_BLACKLIST || [], MOVE_RECHARGE: cfg.MOVE_RECHARGE || [],
        MOVE_POWER_OVERRIDES: cfg.MOVE_POWER_OVERRIDES || {},
        MULTI_HIT: cfg.MULTI_HIT || {}, MULTI_HIT_ODDS: cfg.MULTI_HIT_ODDS || [],
        MOVE_LEVELS: cfg.MOVE_LEVELS || [], MOVE_FLOOR_FROM: cfg.MOVE_FLOOR_FROM ?? 100,
        MOVE_GAP_MAX: cfg.MOVE_GAP_MAX ?? 20, MOVE_STEP: cfg.MOVE_STEP || [4, 5],
        TIME_EVOLUTIONS: cfg.TIME_EVOLUTIONS || {}, TIER_MIN: cfg.TIER_MIN || {},
        STATUS_FX: cfg.STATUS_FX || { STAT: { burn: ['atk', .75], poison: ['spa', .75], sleep: ['def', .75], freeze: ['spd', .75] }, DOT_TURNS: 5, PARA_TURNS: 3 },
        STALL_ROUNDS: cfg.STALL_ROUNDS ?? 8, MAX_ROUNDS: cfg.MAX_ROUNDS ?? 200,
        STATUS_MOVE_CHANCE: cfg.STATUS_MOVE_CHANCE ?? .3, FULL_PARA_CHANCE: cfg.FULL_PARA_CHANCE ?? .25,
        THAW_CHANCE: cfg.THAW_CHANCE ?? .2, CONFUSION_SELF_HIT: cfg.CONFUSION_SELF_HIT ?? .33,
        NIGHT_SLEEP: cfg.NIGHT_SLEEP ?? .35, DOUBLE_CHANCE: cfg.DOUBLE_CHANCE ?? .3, TRIPLE: cfg.TRIPLE || null,
        TRAINER_LEVEL_BONUS: cfg.TRAINER_LEVEL_BONUS || [0, 1], TRAINER_EVOLVED_CHANCE: cfg.TRAINER_EVOLVED_CHANCE ?? .75,
        TRAINER_ITEM_EVO_LEVEL: cfg.TRAINER_ITEM_EVO_LEVEL ?? 40,
        TYPE_POWER: cfg.TYPE_POWER || { strong: 3, weak: -3, immune: -5, exposed: -2, resists: 2 },
        XP_WINS_PER_LEVEL: cfg.XP_WINS_PER_LEVEL ?? 15, XP_ACTIVE_BONUS: cfg.XP_ACTIVE_BONUS ?? 1.1,
        XP_SCALE: cfg.XP_SCALE ?? 3, XP_BASE_REF: cfg.XP_BASE_REF ?? 60,
        XP_GROWTH_FROM: cfg.XP_GROWTH_FROM ?? 10, XP_GROWTH_EXTRA: cfg.XP_GROWTH_EXTRA ?? 1,
        CHAPTER_TIME_RATIO: cfg.CHAPTER_TIME_RATIO ?? Math.pow(cfg.PACE?.lastMin / cfg.PACE?.firstMin ?? 40, 1 / ((cfg.PACE?.chapters ?? 14) - 1)),
        REGION_XP: cfg.REGION_XP || {}, baseExp: cfg.baseExp || null,
        TRADE_FEE: cfg.ONLINE_TRADE?.FEE || [30000, 120000, 450000],
        TRADE_SHINY_FEE: cfg.ONLINE_TRADE?.SHINY_FEE ?? 5,
        ACC_CURVE: cfg.ACC_CURVE || [40, 150, 80],
        TEAM_SIZE: cfg.TEAM_SIZE, MAX_LEVEL: cfg.MAX_LEVEL, LEAGUE_CAP_MARGIN: cfg.LEAGUE_CAP_MARGIN,
        LEAGUE_DONE_CAP: cfg.LEAGUE_DONE_CAP, LEVEL_CAP_MARGIN: cfg.LEVEL_CAP_MARGIN,
        LEAGUE_BELOW: cfg.LEAGUE_TRAINERS?.below || [6, 5, 4, 3],
        LEGEND_ZONE: cfg.LEGEND_ZONE, ELITE: cfg.ELITE, RANK_STAT: cfg.UNDERGROUND?.RANK_STAT ?? 1,
        CAPTURE_BONUS: cfg.CAPTURE_BONUS, CAPTURE_MAX: cfg.CAPTURE_MAX,
        LEGENDARY_CAPTURE_RATE: cfg.LEGENDARY_CAPTURE_RATE,
        RAID: cfg.RAID || null,
        RAID_PITY: cfg.RAID?.PITY ?? 150, RAID_CATCH: cfg.RAID?.CATCH ?? null,
        BUFF_BERRIES: cfg.BUFF_BERRIES, OFFLINE_MAX_LEVELS: cfg.OFFLINE_MAX_LEVELS
      }
    };
  }

  /* --- learnAll: the exact list the game's "moves panel" shows ------- */
  function buildLearnAll(data) {
    const { species, moves, evo, cfg } = data;
    const byId = species;

    const movePower = key => {
      if (cfg.MOVE_POWER_OVERRIDES[key] != null) return cfg.MOVE_POWER_OVERRIDES[key];
      const n = moves[key]?.power || 0;
      const o = cfg.MULTI_HIT[key];
      if (o == null) return n;
      if (Array.isArray(o)) return o.reduce((a, b) => a + b, 0);
      if (o === '2-5') return n * cfg.MULTI_HIT_ODDS.reduce((a, l, f) => a + l * (f + 2), 0);
      return n * o;
    };
    const moveAcc = key => {
      const n = movePower(key);
      if (n <= 0) return moves[key]?.acc || 100;
      const [o, r, l] = cfg.ACC_CURVE;
      return 100 - (100 - l) * Math.min(1, Math.max(0, (n - o) / (r - o)));
    };

    // Family links that are not evolutions (Porygon line).
    const Q = { 137: [233], 233: [474] };
    const evolutions = JSON.parse(JSON.stringify(evo));
    for (const [t, list] of Object.entries(Q)) {
      const rest = (evolutions[t] || []).filter(e => !list.includes(e.to));
      if (rest.length) evolutions[t] = rest; else delete evolutions[t];
    }
    const PREVO = {};
    for (const [t, list] of Object.entries(evolutions))
      for (const e of list) PREVO[e.to] ??= { from: +t, ...e };
    for (const [t, list] of Object.entries(Q))
      for (const e of list) PREVO[e] ??= { from: +t, family: true };

    const evoLevel = id => {
      const p = PREVO[id];
      if (!p) return 0;
      return p.level > 1 ? p.level : Math.max(20, evoLevel(p.from) + 10);
    };
    const isRealMove = key => movePower(key) > 0 && cfg.MOVE_POWER_OVERRIDES[key] == null && !cfg.MOVE_BLACKLIST.includes(key);
    const rootSpecies = id => (PREVO[id] && byId[PREVO[id].from]) ? rootSpecies(PREVO[id].from) : id;
    // Infinity does not survive the JSON cache: rebuild the level table.
    const moveLevels = (cfg.MOVE_LEVELS || []).map(([o, l]) => [o == null ? Infinity : o, l]);
    const levelFloor = key => {
      const n = movePower(key);
      if (n < cfg.MOVE_FLOOR_FROM) return 0;
      const hit = moveLevels.find(([o]) => n <= o);
      return hit ? hit[1] : moveLevels[moveLevels.length - 1][1];
    };

    // Which root species learn each move (used to drop redundant entries).
    const learners = {};
    for (const sp of Object.values(byId))
      for (const [, key] of sp.learn) (learners[key] ??= new Set()).add(rootSpecies(sp.id));

    const learnAll = {};
    for (const sp of Object.values(byId)) {
      const weight = key => movePower(key) * (moves[key].cat === 'phys' ? sp.stats.atk : sp.stats.spa);
      const list = sp.learn.map(l => [l[0], l[1], sp.id]);
      const seen = new Set(sp.learn.map(l => l[1]));
      for (let id = sp.id, p; (p = PREVO[id]) && byId[p.from]; id = p.from)
        for (const l of byId[p.from].learn)
          if (!seen.has(l[1])) { seen.add(l[1]); list.push([l[0], l[1], p.from]); }
    const orig = new Map(list.map(l => [l, l[0]]));   // level before any re-grading

      for (let i = list.length - 1; i >= 0; i--)
        if (cfg.MOVE_RECHARGE.includes(list[i][1])) list.splice(i, 1);
      for (const l of list) if (l[0] > 0) l[0] = Math.max(l[0], levelFloor(l[1]));

      // Per-type compression: keep the strongest move of each type, re-balancing levels.
      const byType = {}, dropped = new Set();
      for (const l of list) if (isRealMove(l[1])) (byType[moves[l[1]].type] ??= []).push(l);
      for (const group of Object.values(byType)) {
        const kept = [];
        let best = 0;
        for (const l of group.filter(x => x[0] > 0).sort((a, b) => a[0] - b[0] || weight(a[1]) - weight(b[1]))) {
          if (weight(l[1]) > best) { best = weight(l[1]); kept.push(l); }
          else if (learners[l[1]].size > 1) dropped.add(l[1]);
          else {
            const at = kept.findIndex(k => weight(k[1]) > weight(l[1]));
            const pair = [...kept.slice(at), l];
            const levels = pair.map(k => k[0]).sort((a, b) => a - b);
            const ids = [...pair].sort((a, b) => weight(a[1]) - weight(b[1])).map(k => [k[1], k[2]]);
            pair.forEach((k, i) => { k[0] = levels[i]; [k[1], k[2]] = ids[i]; });
            kept.push(l);
          }
        }
        for (const l of group.filter(x => x[0] === 0).sort((a, b) => weight(a[1]) - weight(b[1]))) {
          const w = weight(l[1]);
          const at = kept.findIndex(k => weight(k[1]) > w);
          const prev = kept[(at < 0 ? kept.length : at) - 1];
          const next = at < 0 ? null : kept[at];
          l[0] = prev && next ? Math.round((prev[0] + next[0]) / 2)
            : prev ? Math.min(100, prev[0] + 5)
            : next ? Math.max(1, next[0] - 5)
            : evoLevel(l[2]);
          kept.splice(at < 0 ? kept.length : at, 0, l);
        }
      }
      for (const l of list) if (l[0] === 0) l[0] = evoLevel(l[2]);
      for (const l of list) l[0] = Math.max(l[0], levelFloor(l[1]));

      // --- the 2026-11 grading, exactly as the game does it -----------------
      // (no damaging move GAP_MAX above the previous one, then the levels of
      // each type reassigned by weight order, then every usable move
      // spaced by a per-species 4-5 step, then the gap cap again)
      const statusMoves = data.statusMoves || {};
      const usable = key => !cfg.MOVE_BLACKLIST.includes(key) && (movePower(key) > 0 || !!statusMoves[key]);
      const kept = list.filter(l => !dropped.has(l[1]));
      const damaging = kept.filter(l => movePower(l[1]) > 0 && usable(l[1]));
      let prev = 0;
      for (const l of [...damaging].sort((a, b) => a[0] - b[0] || orig.get(a) - orig.get(b) || weight(a[1]) - weight(b[1]))) {
        if (prev) l[0] = Math.min(l[0], prev + cfg.MOVE_GAP_MAX);
        prev = l[0];
      }
      for (const type of new Set(damaging.map(l => moves[l[1]].type))) {
        const group = damaging.filter(l => moves[l[1]].type === type && isRealMove(l[1]));
        const levels = group.map(l => l[0]).sort((a, b) => a - b);
        [...group].sort((a, b) => weight(a[1]) - weight(b[1]) || a[0] - b[0]).forEach((l, i) => { l[0] = levels[i]; });
      }
      const spaced = kept.filter(l => usable(l[1]))
        .sort((a, b) => a[0] - b[0] || (movePower(b[1]) > 0) - (movePower(a[1]) > 0) || weight(a[1]) - weight(b[1]));
      const [stepLo, stepHi] = cfg.MOVE_STEP || [4, 5];
      const stepOf = i => stepLo + (Math.imul(sp.id * 64 + i, 2654435761) >>> 16) % (stepHi - stepLo + 1);
      const spread = stepFn => { let p = -Infinity; return spaced.map((l, i) => p = Math.max(l[0], p + stepFn(i))); };
      let graded = [];
      for (const stepFn of [stepOf, ...Array.from({ length: stepLo }, (_, i) => () => stepLo - i)])
        if (Math.max(0, ...graded = spread(stepFn)) <= 100) break;
      spaced.forEach((l, i) => { l[0] = graded[i]; });
      let last = 0;
      spaced.forEach((l, i) => {
        if (movePower(l[1]) > 0) {
          if (last && l[0] > last + cfg.MOVE_GAP_MAX)
            l[0] = Math.max(i ? spaced[i - 1][0] + Math.min(stepLo, l[0] - spaced[i - 1][0]) : 0, last + cfg.MOVE_GAP_MAX);
          last = l[0];
        }
      });
      learnAll[sp.id] = kept.sort((a, b) => a[0] - b[0]).map(l => [l[0], l[1]]);
    }
    return { learnAll, movePower, moveAcc, PREVO };
  }

  /* --- the roaming legendaries (legend zones) and their elite versions --- */
  /**
   * The game renames every minified variable on each update (Pe→Me, b→A…),
   * so the zone list is located by its data and the elite table through the
   * public LegendZones export, never by a minified name.
   */
  function parseLegends(src) {
    const looksLikeZones = v => Array.isArray(v) && v.length > 5 && v.every(z => z && typeof z.id === 'number' && z.region);
    const names = moduleNames(src, 'LegendZones');
    let zones = null, via = '';

    // the zones array starts with Zapdos (the only `[{id:145,...` literal)
    const at = src.indexOf('=[{id:145');
    if (at >= 0) {
      try {
        const v = evalSandbox(literalAt(src, at + 1));
        if (looksLikeZones(v)) { zones = v; via = 'data'; }
      } catch (e) { log('debug', 'legends: zone literal skipped', e.message); }
    }
    // the public export: a.LegendZones = { ZONES: <minified name>, … }
    if (!zones && names?.ZONES) {
      for (const lit of defLiterals(src, names.ZONES, '[')) {
        try {
          const v = evalSandbox(lit);
          if (looksLikeZones(v)) { zones = v; via = 'ZONES export'; break; }
        } catch (e) { log('debug', 'legends: ZONES candidate skipped', e.message); }
      }
    }
    if (!zones) {
      log('error', 'legends: zone list not found in the bundle');
      return null;
    }

    // the elite multipliers: { zoneId: { tier: [hp, power] } }
    const candidates = [];
    if (names?.ELITE_K) candidates.push(...defLiterals(src, names.ELITE_K, '{'));
    const ei = src.indexOf('ELITE_K:');
    if (ei > 0) {
      const name = (src.slice(ei, ei + 80).match(/ELITE_K:\s*([A-Za-z_$][\w$]*)/) || [])[1];
      if (name) candidates.push(...defLiterals(src, name, '{'));
      const bi = src.lastIndexOf('b={', ei);
      if (bi > 0) { try { candidates.push(literalAt(src, bi + 2)); } catch { /* old layout */ } }
    }
    let elite = {};
    for (const lit of candidates) {
      try {
        const v = evalSandbox(lit);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 3) { elite = v; break; }
      } catch (e) { log('debug', 'legends: elite candidate skipped', e.message); }
    }
    log('info', 'legends: parsed', { zones: zones.length, elite: Object.keys(elite).length, via });
    return { zones, elite };
  }

  /* ------------------------------------------------------------------ *
   * 2. Type chart (pokemondb.net/type, with PokeAPI + game fallbacks)
   * ------------------------------------------------------------------ */
  function parsePokemonDbChart(html) {
    const at = html.indexOf('<table class="type-table">');
    if (at < 0) throw new Error('type table not found');
    const table = html.slice(at, html.indexOf('</table>', at));
    const chart = {};
    const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
      const cells = row.match(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g) || [];
      if (!cells.length) continue;
      const head = cells[0].match(/class="type-icon type-([a-z]+) type-cell"/);
      if (!head) continue;
      const line = {};
      for (const cell of cells.slice(1)) {
        const fx = cell.match(/type-fx-(\d+)/);
        const title = cell.match(/title="([^"]+)"/);
        if (!fx || !title) continue;
        const parts = title[1].split(' &#8594; ');
        if (parts.length !== 2) continue;
        const def = parts[1].split(' = ')[0].trim().toLowerCase();
        line[def] = { 100: 1, 200: 2, 50: 0.5, 0: 0 }[fx[1]];
      }
      chart[head[1]] = line;
    }
    if (Object.keys(chart).length < 18) throw new Error('incomplete type chart');
    return chart;
  }

  async function chartFromPokeApi() {
    const types = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
      'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
    const chart = {};
    for (const t of types) {
      const j = await httpGetJson('https://pokeapi.co/api/v2/type/' + t);
      const r = j.damage_relations, line = {};
      for (const d of types) line[d] = 1;
      for (const d of r.no_damage_to) line[d.name] = 0;
      for (const d of r.half_damage_to) line[d.name] = 0.5;
      for (const d of r.double_damage_to) line[d.name] = 2;
      chart[t] = line;
    }
    return chart;
  }

  /* ------------------------------------------------------------------ *
   * 3. Save access
   * ------------------------------------------------------------------ */
  let lastRaw = null, lastSave = null;

  function readSave() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch { return null; }
    if (!raw) return null;
    if (raw === lastRaw) return lastSave;
    let save;
    try { save = JSON.parse(raw); } catch { return null; }
    if (!save) return null;
    // packed export format: mons live in mz.m
    if (!Array.isArray(save.mons) && save.mz && Array.isArray(save.mz.m)) {
      save.mons = save.mz.m.map(m => {
        const mon = { uid: m[0], id: m[1], level: m[2], xp: m[3] };
        if (m[7]) Object.assign(mon, m[7]);
        return mon;
      });
    }
    if (!Array.isArray(save.mons)) save.mons = [];
    lastRaw = raw;
    lastSave = save;
    return save;
  }

  const monByUid = (save, uid) => save.mons.find(m => m.uid === uid) || null;

  /** Pokémon that are not in the PC (pension, underground, market, trades, other region). */
  function awayUids(save) {
    const out = new Set();
    for (const p of save.pension?.mons || []) if (p.mon) out.add(p.mon.uid);
    for (const slot of save.under?.slots || []) for (const m of slot.mons || []) out.add(m.uid);
    for (const m of save.mktOut || []) if (m) out.add(m.uid);
    if (save.tradeOut?.mon) out.add(save.tradeOut.mon.uid);
    if (save.tradeIn?.mon) out.add(save.tradeIn.mon.uid);
    if (save.link?.stash?.team) for (const u of save.link.stash.team) out.add(u);
    return out;
  }

  /** Region rule: while a region link is active, only some regions may join the team. */
  function canJoinTeam(save, mon) {
    const link = save.link;
    if (!link) return true;
    const reg = mon.reg || 'kanto';
    return link.side === 'from' ? reg !== link.to : reg === link.to;
  }

  /* ------------------------------------------------------------------ *
   * 4. Battle math (same formulas as the game)
   * ------------------------------------------------------------------ */
  function makeEngine(data, chart, learnAll) {
    const { species, moves, cfg } = data;
    const { movePower, moveAcc } = learnAll;

    const typeEff = (atkType, defTypes) => {
      let m = 1;
      for (const t of defTypes) m *= chart[atkType]?.[t] ?? 1;
      return clamp(m, cfg.TYPE_EFF_MIN, cfg.TYPE_EFF_MAX);
    };

    const statsOf = mon => {
      const sp = species[mon.id];
      if (!sp) return null;
      const lv = mon.level, b = sp.stats;
      const r = (mon.shiny ? 1 + cfg.SHINY_STAT_BONUS : 1) * (mon.statMult || 1);
      const f = k => Math.floor((Math.floor(2 * b[k] * lv / 100) + 5) * r);
      return {
        hp: Math.floor((Math.floor(2 * b.hp * lv / 100) + lv + 10) * r),
        atk: f('atk'), def: f('def'), spa: f('spa'), spd: f('spd'), spe: f('spe')
      };
    };
    const maxHp = mon => {
      const s = statsOf(mon);
      if (!s) return 0;
      const scale = Math.min(cfg.HP_LEVEL_MAX, 1 + cfg.HP_LEVEL_SCALE * mon.level / 100);
      return Math.floor(s.hp * scale * cfg.HP_BOOST * (mon.hpMult || 1));
    };

    const moveCache = new Map();

    /** Best move a mon can use against a target (the game picks it automatically). */
    const bestMove = (mon, defTypes) => {
      const key = mon.id + '|' + mon.level + '|' + (mon.shiny ? 1 : 0) + '|' + (mon.status || '') + '|' + defTypes.join(',');
      if (moveCache.has(key)) return moveCache.get(key);
      const sp = species[mon.id];
      if (!sp) return null;
      const st = statsOf(mon);
      let best = null, bestVal = -1;
      for (const [lv, key] of learnAll.learnAll[mon.id] || []) {
        if (lv > mon.level) continue;
        if (cfg.MOVE_BLACKLIST.includes(key)) continue;
        const mv = moves[key];
        if (!mv) continue;
        const power = movePower(key);
        if (power <= 0) continue;
        const phys = mv.cat === 'phys';
        const atkStat = phys ? st.atk * (mon.status === 'burn' ? 0.5 : 1) : st.spa;
        const eff = typeEff(mv.type, defTypes);
        const val = power * (moveAcc(key) / 100) * (sp.types.includes(mv.type) ? 1.5 : 1) * eff * atkStat;
        if (val > bestVal) { bestVal = val; best = { key, name: mv.name, type: mv.type, cat: mv.cat, power, acc: moveAcc(key) }; }
      }
      moveCache.set(key, best);
      return best;
    };

    /** Expected damage (average roll 0.925), game formula. */
    const damage = (att, def, mv, eff) => {
      const A = statsOf(att), D = statsOf(def);
      if (!A || !D) return 0;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? A.atk * (att.status === 'burn' ? 0.5 : 1) : A.spa;
      const defStat = phys ? D.def : D.spd;
      const sp = species[att.id];
      const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
      const x = (2 * att.level / 5 + 2) * mv.power * atkStat / Math.max(1, defStat) / 50 + 2;
      const gap = Math.pow(cfg.LEVEL_GAP, att.level - def.level);
      return Math.max(1, Math.floor(x * stab * eff * gap * 0.925));
    };

    /** Damage of one specific move (the boss uses this for its burst / counter moves). */
    const moveDamage = (att, def, mv) => {
      const A = statsOf(att), D = statsOf(def);
      if (!A || !D) return 0;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? A.atk * (att.status === 'burn' ? 0.5 : 1) : A.spa;
      const defStat = phys ? D.def : D.spd;
      const sp = species[att.id];
      const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
      const x = (2 * att.level / 5 + 2) * mv.power * atkStat / Math.max(1, defStat) / 50 + 2;
      const gap = Math.pow(cfg.LEVEL_GAP, att.level - def.level);
      return x * stab * typeEff(mv.type, def.types) * gap * (mv.acc / 100) * 0.925;
    };

    /** Strongest move a mon has against a target (the boss picks the best one it knows). */
    const bestDamage = (att, def) => {
      let best = 0;
      for (const [lv, key] of learnAll.learnAll[att.id] || []) {
        if (lv > att.level) continue;
        if (cfg.MOVE_BLACKLIST.includes(key)) continue;
        const mv = moves[key];
        if (!mv) continue;
        const power = movePower(key);
        if (power <= 0) continue;
        const d = moveDamage(att, def, { key, type: mv.type, cat: mv.cat, power, acc: moveAcc(key) });
        if (d > best) best = d;
      }
      return best;
    };

    return { typeEff, statsOf, maxHp, bestMove, damage, movePower, moveAcc, moveDamage, bestDamage };
  }

  /* ------------------------------------------------------------------ *
   * 5. Chapter events
   * ------------------------------------------------------------------ */
  const regionOf = (data, ch) => data.regions.find(r => r.key === (data.chapters[ch]?.reg || 'kanto')) || null;
  const chaptersOf = (data, key) => data.chapters.map((c, i) => i).filter(i => (data.chapters[i].reg || 'kanto') === key);

  /** Level the region's champion is expected to have in this chapter (game formula). */
  function aceOf(data, ch) {
    const c = data.chapters[ch];
    if (!c) return null;
    const region = regionOf(data, ch);
    if (!region || !region.ace) return null;
    if (c.ace != null) return c.ace;
    const before = chaptersOf(data, region.key).filter(i => i < ch && data.chapters[i].ace == null).length;
    return region.ace[0] + region.ace[1] * before + (c.aceUp || 0);
  }

  function bandOf(data, ch) {
    const c = data.chapters[ch];
    if (c.lv) return c.lv;
    const h = aceOf(data, ch);
    if (h == null) return null;
    const region = regionOf(data, ch);
    const first = chaptersOf(data, region.key)[0];
    const m = ch > first ? aceOf(data, ch - 1) : null;
    return [m ?? (region.base || 0) + 2, h - 1];
  }

  /** Level range of the n-th route of a chapter (game formula). */
  function routeBand(data, ch, index, count) {
    const q = bandOf(data, ch);
    if (!q) return null;
    const [H, Sa] = q, z = (Sa - H) / count;
    const se = Math.round(H + z * index), ya = Math.round(H + z * (index + 1));
    return [se, Math.max(se + 1, ya)];
  }

  /** The level cap of a chapter (the game's capOf). */
  function capOf(data, ch) {
    const c = data.chapters[ch];
    if (!c) return data.cfg.MAX_LEVEL;
    const margin = c.capMargin != null ? c.capMargin : (c.league ? (data.cfg.LEAGUE_CAP_MARGIN ?? 3) : 0);
    let q = (aceOf(data, ch) ?? 0) + margin;
    if (c.league && !c.steps.some(st => st.champion)) {
      const region = regionOf(data, ch);
      const league = chaptersOf(data, region.key).filter(i => data.chapters[i].league);
      if (league.length) q = Math.min(q, Math.max(...league.map(i => aceOf(data, i) ?? 0)));
    }
    return q;
  }

  /** The next gym of a region the player still has to beat (the game's nextGymOf). */
  function nextGymOf(data, regionKey, adv) {
    const unlocked = adv?.unlocked || 0;
    const badges = adv?.badges || [];
    return chaptersOf(data, regionKey).find(i =>
      i >= unlocked &&
      data.chapters[i].steps.some(st => st.kind === 'gym') &&
      !data.chapters[i].steps.some(st => st.champion && badges.includes(st.badge))
    ) ?? null;
  }

  /** The level the player may reach right now (the game's levelCap).
   *  Open regions are the travel list, the region link destination and any
   *  region whose first chapter is already unlocked. */
  function levelCap(data, save) {
    const adv = save?.adv;
    const max = data.cfg.MAX_LEVEL;
    let m = 0;
    const open = new Set(['kanto', ...(adv?.travel?.to || []), save?.link?.to].filter(Boolean));
    const firstChapter = key => data.chapters.findIndex(c => (c.reg || 'kanto') === key);
    for (const region of data.regions) {
      if (!region || !region.ace || !region.key) continue;
      if (!open.has(region.key) && !(adv?.unlocked >= firstChapter(region.key))) continue;
      const next = nextGymOf(data, region.key, adv);
      if (next != null) return Math.min(max, capOf(data, next));
      for (const ch of chaptersOf(data, region.key)) if (aceOf(data, ch) != null) m = Math.max(m, capOf(data, ch));
    }
    return Math.min(max, m ? Math.max(m, data.cfg.LEAGUE_DONE_CAP ?? 100) : max);
  }

  function chapterInfo(data, chapterIndex, save) {
    const ch = data.chapters[chapterIndex];
    if (!ch) return null;
    return {
      index: chapterIndex, name: ch.name, region: ch.reg || 'kanto', ace: aceOf(data, chapterIndex), steps: ch.steps,
      cap: levelCap(data, save)
    };
  }

  /** The league of a region: the four Elite Four members plus the champion. */
  function leagueChapters(data, chapterIndex) {
    const c = data.chapters[chapterIndex];
    if (!c?.league) return [];
    const region = regionOf(data, chapterIndex);
    if (!region) return [];
    return chaptersOf(data, region.key).filter(i => data.chapters[i].league);
  }

  /** The foes of one league member: the trainers on the way plus the member itself. */
  function leagueEnemies(data, ch) {
    const cfg = data.cfg;
    const c = data.chapters[ch];
    const gym = c.steps.find(st => st.kind === 'gym');
    const teamLevel = capOf(data, ch);      // the level the team reaches by then
    const out = [];
    const region = regionOf(data, ch);
    const sets = data.leagueTeams?.[`${region?.key}:${gym?.leader}`] || [];
    sets.forEach((set, i) => {
      const level = (aceOf(data, ch) ?? 0) - (cfg.LEAGUE_BELOW[i] ?? 0);
      for (const id of set.team || []) {
        out.push({ id, level, weight: 2, kind: 'trainer', source: set.name || gym?.leader || '?', hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1, teamLevel, chapter: ch });
      }
    });
    if (gym?.team) {
      const maxLv = Math.max(...gym.team.map(t => t[1]));
      const q = gym.ace ?? aceOf(data, ch);
      const hpMult = cfg.GYM_HP_MULT * (gym.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, gym.team.length), cfg.GYM_TEAM_EXP);
      for (const [id, lv] of gym.team) {
        out.push({
          id, level: q ? Math.round(lv * q / maxLv) : lv, weight: 3, kind: 'gym',
          source: gym.leader || gym.name, power: gym.power || 1, hpMult,
          damageMult: cfg.GYM_DAMAGE * (gym.power || 1), teamLevel, chapter: ch
        });
      }
    }
    return out;
  }

  /** Wild / trainer / gym foes of a chapter, with the levels the game uses. */
  function chapterEnemies(data, info, nodes) {
    const league = leagueChapters(data, info.index);
    if (league.length) {
      // the whole league: a wipe rewinds to the first member, so every one of them counts
      return league.flatMap(ch => leagueEnemies(data, ch));
    }
    if (nodes && nodes.length) return enemiesFromNodes(data, info, nodes);
    return enemiesFromChapter(data, info);
  }

  /** The foes of the nodes the game actually built (the live chapter). */
  function enemiesFromNodes(data, info, nodes) {
    const cfg = data.cfg;
    const out = [];
    for (const node of nodes) {
      if (node.type === 'gym' && node.gym?.team) {
        const gym = node.gym;
        const maxLv = Math.max(...gym.team.map(t => t[1]));
        const q = gym.ace ?? info.ace;
        const hpMult = cfg.GYM_HP_MULT * (gym.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, gym.team.length), cfg.GYM_TEAM_EXP);
        for (const [id, lv] of gym.team) {
          out.push({
            id, level: q ? Math.round(lv * q / maxLv) : lv, weight: 3, kind: 'gym',
            source: gym.leader || gym.name, power: gym.power || 1, hpMult,
            damageMult: cfg.GYM_DAMAGE * (gym.power || 1)
          });
        }
      } else if (node.type === 'trainer' && node.team) {
        for (const [id, lv] of node.team) {
          out.push({ id, level: lv, weight: 2, kind: 'trainer', source: node.trainer || node.name, hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1 });
        }
      } else if ((node.type === 'wild' || node.type === 'trainer') && (node.pool?.length || node.areas)) {
        const pool = new Map();
        if (node.pool?.length) {
          for (const p of node.pool) {
            const cur = pool.get(p.id) || { id: p.id, w: 0 };
            cur.w += (p.w ?? 1);
            pool.set(p.id, cur);
          }
        } else for (const area of node.areas) {
          for (const e of data.enc[area] || []) {
            const [id, min, max, pct, method] = e;
            if (pct >= 100) continue;
            const how = String(method || '');
            if (!/walk|surf|rod|static|headbutt|rock-smash/.test(how)) continue;
            let w = pct;
            if (/rod/.test(how)) w *= 0.15;
            else if (/surf/.test(how)) w *= 0.5;
            else if (/headbutt|rock-smash/.test(how)) w *= 0.25;
            const cur = pool.get(id) || { id, w: 0 };
            cur.w += w;
            pool.set(id, cur);
          }
        }
        const band = node.lv;
        for (const p of pool.values()) {
          out.push({
            id: p.id, level: band ? Math.round((band[0] + band[1]) / 2) : 0,
            weight: Math.max(0.2, p.w / 10), kind: node.type === 'trainer' ? 'trainer' : 'wild', source: node.name,
            hpMult: 1, damageMult: cfg.ENEMY_DAMAGE[node.type] ?? 1
          });
        }
      } else if (node.type === 'static' && node.id != null) {
        out.push({
          id: node.id, level: node.level ?? 100, weight: 3, kind: 'static', source: node.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.static ?? 1
        });
      }
    }
    return out;
  }

  /** The foes of a chapter, rebuilt from its static data (fallback). */
  function enemiesFromChapter(data, info) {
    const enemies = [];   // {id, level, weight, kind, source}
    const steps = info.steps;
    const cfg = data.cfg;

    for (const step of steps.filter(s => s.kind === 'gym' && s.team)) {
      const team = step.team;
      const maxLv = Math.max(...team.map(t => t[1]));
      const q = step.ace ?? info.ace;
      const hpMult = cfg.GYM_HP_MULT * (step.power || 1) * Math.pow(cfg.TEAM_SIZE / Math.max(1, team.length), cfg.GYM_TEAM_EXP);
      for (const [id, lv] of team.map(t => [t[0], q ? Math.round(t[1] * q / maxLv) : t[1]]))
        enemies.push({
          id, level: lv, weight: 3, kind: 'gym', source: step.name, power: step.power || 1,
          hpMult, damageMult: cfg.GYM_DAMAGE * (step.power || 1), teamSize: team.length
        });
    }
    for (const step of steps.filter(s => s.kind === 'trainer' && s.team)) {
      const team = step.team;
      const maxLv = Math.max(...team.map(t => t[1]));
      const q = info.ace;
      for (const [id, lv] of (step.scale ? team.map(t => [t[0], Math.round(t[1] * q / maxLv)]) : team))
        enemies.push({
          id, level: lv, weight: 2, kind: 'trainer', source: step.trainer || step.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.trainer ?? 1
        });
    }
    const routes = steps.filter(s => s.kind === 'route');
    routes.forEach((step, index) => {
      if (!step.wild) return;
      const band = step.lv || routeBand(data, info.index, index, routes.length);
      const pool = new Map();
      for (const area of step.areas || []) {
        for (const e of data.enc[area] || []) {
          const [id, min, max, pct, method] = e;
          if (pct >= 100) continue;
          const how = String(method || '');
          if (!/walk|surf|rod|static|headbutt|rock-smash/.test(how)) continue;
          let w = pct;
          if (/rod/.test(how)) w *= 0.15;
          else if (/surf/.test(how)) w *= 0.5;
          else if (/headbutt|rock-smash/.test(how)) w *= 0.25;
          const cur = pool.get(id) || { id, w: 0 };
          cur.w += w;
          pool.set(id, cur);
        }
      }
      for (const p of pool.values()) {
        const level = band ? Math.round((band[0] + band[1]) / 2) : 0;
        enemies.push({
          id: p.id, level, weight: Math.max(0.2, p.w / 10), kind: 'wild', source: step.name,
          hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.wild ?? 1
        });
      }
    });
    return enemies;
  }

  /* ------------------------------------------------------------------ *
   * 6. Optimizer
   * ------------------------------------------------------------------ */
  const KIND_WEIGHT = { wild: 1, trainer: 4, gym: 8 };

  /** The game only evolves into a species whose region dex is open. */
  function regionHas(data, save, targetId) {
    const base = targetId > 10000 ? Math.floor(targetId / 100) : targetId;
    const unlocked = save?.adv?.unlocked ?? 0;
    return (data.regions || []).some(r => r.dex
      && unlocked >= data.chapters.findIndex(c => (c.reg || 'kanto') === r.key)
      && base >= r.dex[0] && base <= r.dex[1]);
  }

  /** The game's daytime phases: morning < 10h, day 10-20h, night >= 20h (a
   *  chapter flagged `day` stays day until it is fully unlocked). */
  function daytimeMatches(data, save, key) {
    if (!key) return true;
    const adv = save?.adv;
    const ch = adv?.chapter != null ? data.chapters[adv.chapter] : null;
    const dayLocked = !!ch?.day && !(adv.unlocked > adv.chapter);
    const hour = new Date().getHours();
    const idx = dayLocked ? 1 : (hour >= 20 || hour < 8 ? 2 : hour >= 10 ? 1 : 0);
    return key === 'night' ? idx === 2 : idx !== 2;
  }

  /** The game's trade tier (captureRate, evolution depth, BST, TIER_MIN). */
  function tradeTier(data, id, cache = new Map()) {
    if (cache.has(id)) return cache.get(id);
    const sp = data.species[id];
    if (!sp) { cache.set(id, 0); return 0; }
    let o;
    const PREVO = {};
    for (const [from, list] of Object.entries(data.evo)) for (const e of list) PREVO[e.to] ??= { from: +from, ...e };
    PREVO[233] ??= { from: 137 }; PREVO[474] ??= { from: 233 };
    const prevo = x => {
      const p = PREVO[x];
      return (p && data.species[p.from] && !data.species[p.from].baby) ? p.from : null;
    };
    if (sp.unique) o = 4;
    else if (sp.legendary || sp.mythical) o = 3;
    else {
      o = sp.captureRate <= 45 ? 2 : sp.captureRate <= 120 ? 1 : 0;
      if (!sp.baby) {
        const d = prevo(id);
        const w = (data.evo[id] || []).some(e => data.species[e.to] && !data.species[e.to].legendary && !data.species[e.to].mythical);
        let depth = 0;
        for (let i = d; i != null; i = prevo(i)) depth++;
        if (d != null) o = Math.max(o, w ? 1 : depth >= 2 ? 2 : 1);
        if (d != null || !w) {
          const bst = Object.values(sp.stats || {}).reduce((a, b) => a + b, 0);
          o = Math.max(o, bst >= 500 ? 2 : bst >= 450 ? 1 : 0);
        }
        o = Math.max(o, data.cfg.TIER_MIN?.[id] ?? 0);
        if (d != null) o = Math.max(o, Math.min(2, tradeTier(data, d, cache)));
      }
    }
    cache.set(id, o);
    return o;
  }

  /** What an online trade of this mon costs (the game's fee table, no economy multiplier). */
  function tradeFee(data, mon) {
    const tier = tradeTier(data, mon.id);
    const fee = (data.cfg.TRADE_FEE || [])[Math.min(2, tier)] ?? 0;
    return Math.round(fee * (mon.shiny ? (data.cfg.TRADE_SHINY_FEE ?? 5) : 1));
  }

  /**
   * Every species the mon can become at the cap: all reachable branches, current
   * form last. Level evolutions respect the game's daytime and party gates and
   * its uid-hash pick when several branches qualify; item evolutions need the
   * item in the bag; link-cable evolutions (trades) need the trade fee in the
   * wallet. Evolutions into a closed region's dex stay out.
   */
  function evolvedBranches(data, save, mon, cap) {
    const out = [];
    const seen = new Set([mon.id]);
    const partyIds = new Set((save.team || []).map(u => monByUid(save, u)?.id).filter(Boolean));
    const walk = (id, uid, depth) => {
      if (depth > 4) return;
      const chain = data.evo[id] || [];
      // level branches: the game picks one by uid hash when several qualify
      const levelOk = chain.filter(e => e.level != null && e.level <= cap
        && daytimeMatches(data, save, data.cfg.TIME_EVOLUTIONS?.[e.to])
        && (!e.party || partyIds.has(e.party))
        && regionHas(data, save, e.to));
      const picks = levelOk.length > 1 ? [levelOk[[...uid].reduce((d, w) => d * 31 + w.charCodeAt(0) >>> 0, 7) % levelOk.length]] : levelOk;
      for (const e of picks) {
        if (seen.has(e.to) || !data.species[e.to]) continue;
        seen.add(e.to); out.push(e.to);
        walk(e.to, uid, depth + 1);
      }
      // item branches: every one you can pay for is reachable (you choose what to use)
      for (const e of chain) {
        if (e.item == null || seen.has(e.to) || !data.species[e.to]) continue;
        const owned = e.item === 'link-cable'
          ? save.money >= tradeFee(data, { id, shiny: mon.shiny })
          : (save.items?.[e.item] ?? 0) > 0;
        if (owned && regionHas(data, save, e.to) && daytimeMatches(data, save, data.cfg.TIME_EVOLUTIONS?.[e.to])) {
          seen.add(e.to); out.push(e.to);
          walk(e.to, uid, depth + 1);
        }
      }
    };
    walk(mon.id, mon.uid, 0);
    out.push(mon.id);
    return out;
  }

  /** The Pokémon that may join the team, projected at the chapter cap (evolutions included).
   *  opts.branches = false keeps one candidate per real mon (the chapter sim evolves them itself). */
  function projectCandidates(eng, data, save, level, opts = {}) {
    const away = awayUids(save);
    const cands = save.mons.filter(m => !away.has(m.uid) && data.species[m.id] && canJoinTeam(save, m));
    const branchesOf = opts.branches === false ? (c => [c.id]) : (c => evolvedBranches(data, save, c, level));
    return cands.flatMap(c => branchesOf(c).map(sid => {
      const sp = data.species[sid];
      const base = { id: sp.id, shiny: c.shiny, status: c.status, types: sp.types };
      const proj = { ...base, level };
      const hp = eng.maxHp(proj);
      // the team keeps its HP between fights: use what is left, like the game does
      const hpCur = c.hp != null ? Math.min(c.hp, hp) : hp;
      return { mon: c, base, proj, species: sp, hp, hpCur };
    }));
  }

  /** Individual metrics of every candidate against the chapter's foes. */
  function scoreCandidates(eng, data, enemies, candidates, level, fullHp = false) {
    const enemyList = enemies.map(e => {
      const types = data.species[e.id]?.types || [];
      const proj = { id: e.id, level: e.level, types };
      return {
        ...e, proj, types,
        hp: eng.maxHp(proj),
        weight: (KIND_WEIGHT[e.kind] || 1) * (e.weight || 1)
      };
    });

    const out = [];
    for (const cand of candidates) {
      const sp = data.species[cand.base?.id ?? cand.id];
      if (!sp) continue;
      const base = cand.base || { id: cand.id, shiny: cand.shiny, status: cand.status, types: sp.types };
      let dmgSum = 0, surviveSum = 0, wSum = 0, bestDmg = 0, bestMoveName = '', bestMoveKey = '', bestEff = 1;
      for (const e of enemyList) {
        // in a league the team levels up and is healed between the members
        const proj = { ...base, level: e.teamLevel ?? level };
        const hp = fullHp ? eng.maxHp(proj) : Math.min(cand.hpCur != null ? cand.hpCur : eng.maxHp(proj), eng.maxHp(proj));
        const mv = eng.bestMove(proj, e.types);
        if (!mv) continue;
        const eff = eng.typeEff(mv.type, e.types);
        const dmg = eng.damage(proj, e.proj, mv, eff) * (mv.acc / 100);
        const emv = eng.bestMove(e.proj, proj.types);
        let incoming = 0;
        if (emv) {
          const eeff = eng.typeEff(emv.type, proj.types);
          const mult = e.kind === 'gym'
            ? data.cfg.GYM_DAMAGE * (e.power || 1)
            : (data.cfg.ENEMY_DAMAGE[e.kind] ?? 1) * (e.power || 1);
          incoming = eng.damage(e.proj, proj, emv, eeff) * (emv.acc / 100) * mult;
        }
        const rounds = incoming > 0 ? hp / incoming : 99;
        dmgSum += dmg * e.weight;
        surviveSum += rounds * e.weight;
        wSum += e.weight;
        if (dmg > bestDmg) { bestDmg = dmg; bestMoveName = mv.name; bestMoveKey = mv.key; bestEff = eff; }
      }
      if (!wSum) continue;
      out.push({
        mon: cand.mon || cand, base, proj: { ...base, level }, species: sp, hp: cand.hp,
        dmg: dmgSum, survive: surviveSum,
        avgDmg: dmgSum / wSum, avgRounds: surviveSum / wSum,
        bestDmg, bestMoveName, bestMoveKey, bestEff
      });
    }
    return out;
  }

  function scoreFor(s, preset) {
    if (preset === 'defense') return s.avgRounds;
    if (preset === 'offense') return s.avgDmg;
    return Math.sqrt(Math.max(0, s.avgDmg) * Math.max(0.01, s.avgRounds));
  }

  /** One full fight: our team (in order) against one foe, the way the game chains them. */
  function simulate(team, enemy, eng, fullHp = false) {
    const ehp = enemy.hp * enemy.hpMult;
    let remaining = ehp, dealt = 0, rounds = 0, teamHp = 0, incoming = 0;
    for (const c of team) {
      const base = c.base || c.proj;
      const proj = enemy.teamLevel != null ? { ...base, level: enemy.teamLevel } : c.proj;
      const maxHp = eng.maxHp(proj);
      const hpLeft = fullHp ? maxHp : Math.min(c.hpCur != null ? c.hpCur : maxHp, maxHp);
      const mv = eng.bestMove(proj, enemy.types);
      if (!mv) continue;
      const eff = eng.typeEff(mv.type, enemy.types);
      const dmg = eng.damage(proj, enemy.proj, mv, eff) * (mv.acc / 100);
      const emv = eng.bestMove(enemy.proj, proj.types);
      let inc = 0;
      if (emv) {
        const eeff = eng.typeEff(emv.type, proj.types);
        inc = eng.damage(enemy.proj, proj, emv, eeff) * (emv.acc / 100) * enemy.damageMult;
      }
      teamHp += hpLeft;
      incoming += inc;
      const alive = inc > 0 ? hpLeft / inc : 99;
      const toKill = dmg > 0 ? remaining / dmg : 99;
      const r = Math.min(alive, toKill);
      dealt += r * dmg;
      remaining -= r * dmg;
      rounds += r;
      if (remaining <= 0) break;
    }
    const roundsDie = incoming > 0 ? teamHp / incoming : 99;
    return {
      win: remaining <= 0,
      roundsKill: remaining <= 0 ? rounds : Infinity,
      dmgDealt: dealt, roundsDie, hpLeft: Math.max(0, remaining)
    };
  }

  /** Score of a whole team against the chapter's foes. */
  /** Higher is better: how well a team wins a fight (turns to die / turns to kill). */
  function fightScore(res, preset) {
    if (preset === 'offense') return res.dmgDealt;
    if (preset === 'defense') return res.roundsDie;
    return res.roundsDie / Math.max(0.5, res.roundsKill);
  }

  function evaluateTeam(team, enemies, eng, data, preset) {
    let score = 0;
    for (const e of enemies) {
      const res = simulate(team, e, eng);
      if (preset === 'offense') score += e.weight * res.dmgDealt / Math.max(1, e.hp);
      else score += e.weight * fightScore(res, preset);
    }
    return score;
  }

  /** Greedy team builder: one Pokémon per species (the game keeps only one of each). */
  function pickTeam(scored, enemies, eng, data, preset, size = 6) {
    const pool = scored.slice()
      .sort((a, b) => scoreFor(b, preset) - scoreFor(a, preset) || b.mon.level - a.mon.level)
      .slice(0, 60);
    const chosen = [];
    const usedSpecies = new Set();
    const usedShiny = new Set();
    const usedUids = new Set();
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (chosen.includes(cand) || usedUids.has(cand.mon.uid)) continue;
        if (!cand.mon.shiny && usedSpecies.has(cand.species.id)) continue;
        if (cand.mon.shiny && usedShiny.has(cand.species.id)) continue;
        const sc = evaluateTeam(chosen.concat([cand]), enemies, eng, data, preset);
        // same score: prefer the Pokémon that is already the closest to the chapter cap
        if (sc > bestScore || (sc === bestScore && best && cand.mon.level > best.mon.level)) {
          bestScore = sc; best = cand;
        }
      }
      if (!best) break;
      chosen.push(best);
      usedSpecies.add(best.species.id);
      usedUids.add(best.mon.uid);
      if (best.mon.shiny) usedShiny.add(best.species.id);
    }
    return chosen;
  }

  /* ------------------------------------------------------------------ *
   * 6c. Chapter simulation — the game's own battle rules, ported from
   *     its bundle: move pick (OHKO / status 30% / best attack), status
   *     gates and dots, initiative, stall rule, auto-switch order, XP
   *     with mid-chapter level-ups and evolutions.
   * ------------------------------------------------------------------ */
  const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));      // the game's rand int
  const rpick = list => list[Math.floor(Math.random() * list.length)];
  const statusCap = key => {
    const sure = key === 'spore' || key === 'sacred-fire' || key === 'nuzzle' || key === 'zap-cannon' || key === 'inferno' || key === 'dynamic-punch';
    const damaging = (state.data.moves[key]?.power || 0) > 0;
    return sure ? 100 : damaging ? 30 : Math.min(state.data.moves[key]?.acc ?? 100, 70);
  };
  const statusOfMv = key => (state.data.statusMoves?.[key] || [])[0];
  const STATUS_IMMUNE = { burn: ['fire'], poison: ['poison', 'steel'], freeze: ['ice'], paralysis: [], sleep: [], confusion: [] };
  const effRaw = (atkType, defTypes) => (defTypes || []).reduce((m, t) => m * (state.chart[atkType]?.[t] ?? 1), 1);
  const canStatus = (def, status) => !(STATUS_IMMUNE[status] || []).some(t => (def.types || []).includes(t));
  const psStat = (mon, stat) => {
    const st = state.data.cfg.STATUS_FX?.STAT?.[mon.status];
    return st && st[0] === stat ? st[1] : 1;
  };
  const simStats = mon => state.engine.statsOf({ id: mon.id, level: mon.level, shiny: mon.shiny });
  const simHp = mon => Math.floor(state.engine.maxHp({ id: mon.id, level: mon.level, shiny: mon.shiny, hpMult: mon.hpMult }));
  const learnOfSim = mon => state.learnAll?.learnAll?.[mon.id] || [];
  const hitPowersOf = key => {
    const o = state.data.cfg.MULTI_HIT[key];
    const base = state.data.moves[key]?.power || 0;
    if (o == null) return null;
    if (Array.isArray(o)) return [...o];
    if (o === '2-5') {
      let w = Math.random(), hits = 2;
      for (let g = 0; g < (state.data.cfg.MULTI_HIT_ODDS || []).length && (w -= state.data.cfg.MULTI_HIT_ODDS[g]) > 0; g++) hits = g + 3;
      return Array(hits).fill(base);
    }
    return Array(o).fill(base);
  };
  const minPowerOf = key => {
    const o = state.data.cfg.MULTI_HIT[key];
    const base = state.data.moves[key]?.power || 0;
    if (o == null) return base;
    if (Array.isArray(o)) return base * o[0];
    return o === '2-5' ? 2 * base : base * o;
  };
  /** The game's damage (Ue) with the roll supplied by the caller. */
  function simDamage(att, def, mv, eff, crit, roll) {
    const A = simStats(att), D = simStats(def);
    const phys = mv.cat === 'phys';
    const atk = phys ? A.atk * psStat(att, 'atk') : A.spa * psStat(att, 'spa');
    const defv = phys ? D.def * psStat(def, 'def') : D.spd * psStat(def, 'spd');
    const sp = state.data.species[att.id];
    const stab = sp && sp.types.includes(mv.type) ? 1.5 : 1;
    const x = (2 * monLevel(att) / 5 + 2) * mv.power * atk / Math.max(1, defv) / 50 + 2;
    const gap = Math.pow(state.data.cfg.LEVEL_GAP, monLevel(att) - monLevel(def));
    return Math.max(1, Math.floor(x * stab * eff * gap * (crit ? state.data.cfg.CRIT_MULT : 1) * roll));
  }
  const monLevel = mon => mon.level;
  /** The game's ot(): an OHKO-capable move, best accuracy wins. */
  function simOhko(att, def, dMult) {
    let best = null;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level || state.data.cfg.MOVE_BLACKLIST.includes(key)) continue;
      const mv = state.data.moves[key];
      if (!mv) continue;
      const power = state.engine.movePower(key);
      if (power <= 0) continue;
      const eff = effRaw(mv.type, def.types);
      if (eff === 0) continue;
      const cand = { key, type: mv.type, cat: mv.cat, power, acc: state.engine.moveAcc(key) };
      const us = simDamage(att, def, { ...cand, power: minPowerOf(key) }, eff, false, .85);
      if (us * dMult < def.hp) continue;
      if (!best || cand.acc > best.acc || (cand.acc === best.acc && power > best.power)) best = cand;
    }
    return best;
  }
  /** The game's qa(): the status move it knows (the last qualifying one). */
  function simStatusMove(att, def) {
    let found = null;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level) continue;
      if ((state.data.moves[key]?.power || 0) > 0) continue;
      const status = statusOfMv(key);
      if (!status || !state.data.moves[key] || !canStatus(def, status)) continue;
      found = { key, status, chance: Math.min(state.data.moves[key].acc || 70, statusCap(key)) };
    }
    return found;
  }
  /** The game's Ws(): the best attack, damage summed over the living foes. */
  function simGeneric(att, foes) {
    const living = foes.filter(f => f.hp > 0);
    const sp = state.data.species[att.id];
    const st = simStats(att);
    const foeStats = living.map(f => {
      const d = simStats(f);
      return { types: f.types, def: d.def * psStat(f, 'def'), spd: d.spd * psStat(f, 'spd') };
    });
    let best = null, bestVal = 0, hasAttack = false;
    for (const [lv, key] of learnOfSim(att)) {
      if (lv > att.level || state.data.cfg.MOVE_BLACKLIST.includes(key)) continue;
      const mv = state.data.moves[key];
      if (!mv) continue;
      const power = state.engine.movePower(key);
      if (power <= 0) continue;
      hasAttack = true;
      const phys = mv.cat === 'phys';
      const atkStat = phys ? st.atk * psStat(att, 'atk') : st.spa * psStat(att, 'spa');
      const accTerm = state.engine.moveAcc(key) / 100 * (sp && sp.types.includes(mv.type) ? 1.5 : 1);
      let val = 0;
      for (const f of foeStats) val += ((2 * monLevel(att) / 5 + 2) * power * atkStat / Math.max(1, phys ? f.def : f.spd) / 50 + 2) * accTerm * effRaw(mv.type, f.types);
      if (val > bestVal) { bestVal = val; best = key; }
    }
    if (!best) return hasAttack ? { key: 'struggle', type: 'normal', cat: 'phys', power: state.engine.movePower('struggle'), acc: 100, typeless: true } : null;
    const mv = state.data.moves[best];
    return { key: best, type: mv.type, cat: mv.cat, power: state.engine.movePower(best), acc: state.engine.moveAcc(best) };
  }
  function simInflict(mon, status) {
    if (mon.status || !canStatus(mon, status)) return;
    mon.status = status;
    mon.bit = 0;
    if (status === 'sleep') mon.sleepLeft = ri(1, 3);
    if (status === 'confusion') mon.confused = ri(2, 5);
  }
  const simClear = mon => { delete mon.status; delete mon.bit; delete mon.sleepLeft; delete mon.confused; };
  /** The game's Y(): the pre-turn gates (sleep, freeze, full-para, confusion). */
  function simGate(mon) {
    if (mon.status === 'sleep') {
      if (mon.sleepLeft > 0) { mon.sleepLeft--; return true; }
      simClear(mon); return false;
    }
    if (mon.status === 'freeze') {
      if (Math.random() >= state.data.cfg.THAW_CHANCE) return true;
      simClear(mon); return false;
    }
    if (mon.status === 'paralysis') {
      mon.bit = (mon.bit || 0) + 1;
      if (Math.random() < state.data.cfg.FULL_PARA_CHANCE) return true;
    }
    if (mon.confused) {
      if (--mon.confused <= 0) delete mon.confused;
      else if (Math.random() < state.data.cfg.CONFUSION_SELF_HIT) {
        const st = simStats(mon);
        const dmg = Math.max(1, Math.floor((2 * monLevel(mon) / 5 + 2) * 40 * st.atk / Math.max(1, st.def) / 50 + 2));
        mon.hp = Math.max(0, mon.hp - dmg);
        mon._dmg = (mon._dmg || 0) + dmg;
        return true;
      }
    }
    return false;
  }
  /** The game's oe(): the dot after acting and the status expiry. */
  function simDot(mon) {
    if (mon.status === 'paralysis') {
      if ((mon.bit || 0) >= (state.data.cfg.STATUS_FX?.PARA_TURNS ?? 3)) simClear(mon);
      return;
    }
    if (mon.status !== 'burn' && mon.status !== 'poison') return;
    const dot = Math.max(1, Math.floor(simHp(mon) / 8));
    mon.hp = Math.max(0, mon.hp - dot);
    mon._dmg = (mon._dmg || 0) + dot;
    mon.bit = (mon.bit || 0) + 1;
    if ((mon.bit || 0) >= (state.data.cfg.STATUS_FX?.DOT_TURNS ?? 5) && mon.hp > 0) simClear(mon);
  }
  /** One actor's turn (the game's Ha). Returns the damage dealt. */
  function simAct(att, def, foes, dMult) {
    if (simGate(att)) return 0;
    let dealt = 0;
    const ohko = simOhko(att, def, dMult);
    const statusMv = !ohko && simStatusMove(att, def);
    const generic = simGeneric(att, foes);
    if (statusMv && (Math.random() < state.data.cfg.STATUS_MOVE_CHANCE || (generic && generic.typeless))) {
      if (Math.random() * 100 < statusMv.chance) { simInflict(def, statusMv.status); return 1; }
      return 0;
    }
    const mv = ohko || generic;
    if (!mv) return 0;
    if (Math.random() * 100 > mv.acc) return 0;
    const eff = mv.typeless ? 1 : effRaw(mv.type, def.types);
    if (eff === 0) return 0;
    const hits = hitPowersOf(mv.key);
    let dmg = 0;
    if (hits) for (const p of hits) dmg += simDamage(att, def, { ...mv, power: p }, eff, Math.random() < state.data.cfg.CRIT_CHANCE, .85 + Math.random() * .15);
    else dmg = simDamage(att, def, mv, eff, Math.random() < state.data.cfg.CRIT_CHANCE, .85 + Math.random() * .15);
    def.hp = Math.max(0, def.hp - dmg);
    if (def.hp > 0) {
      if (def.status === 'freeze' && mv.type === 'fire') simClear(def);
      const status = statusOfMv(mv.key);
      if (status && Math.random() * 100 < (state.data.statusMoves?.[mv.key]?.[1] || 0) && canStatus(def, status)) simInflict(def, status);
    }
    return dmg;
  }

  /** The game's Gt/Ks auto-switch ordering. */
  function autoScore(mon, foes) {
    const tp = state.data.cfg.TYPE_POWER;
    const myTypes = state.data.species[mon.id]?.types || [];
    let sum = 0;
    for (const foe of foes) {
      if (foe.hp <= 0) continue;
      const foeTypes = state.data.species[foe.id]?.types || foe.types || [];
      const bm = state.engine.bestMove({ id: mon.id, level: mon.level, shiny: mon.shiny }, foeTypes);
      const off = bm ? effRaw(bm.type, foeTypes) : 1;
      const def = Math.max(...foeTypes.map(t => effRaw(t, myTypes)), 1e-4);
      sum += (off === 0 ? tp.immune : off > 1 ? tp.strong : off < 1 ? tp.weak : 0)
        + (def > 1 ? tp.exposed : def < 1 ? tp.resists : 0)
        + .01 * (Math.log2(Math.max(.125, off)) - Math.log2(Math.max(.125, def)));
    }
    return sum;
  }
  /** The ordered chapter steps from the nodes the game built (heal stops + battles). */
  function chapterPlan(data, save) {
    const nodes = save?.adv?.nodes || [];
    const plan = [];
    for (const node of nodes) {
      if (node.type === 'heal') { plan.push({ kind: 'heal' }); continue; }
      if (node.type === 'wild' || node.type === 'trainer') {
        plan.push({
          kind: 'battle', type: node.type, name: node.name,
          pool: poolOfNode(node, data), lv: node.lv || null,
          team: node.team || null, size: node.size ?? null,
          index: plan.length,
        });
        continue;
      }
      if (node.type === 'gym' && node.gym?.team) {
        const gym = node.gym;
        const hpMult = data.cfg.GYM_HP_MULT * (gym.power || 1) * Math.max(1, data.cfg.TEAM_SIZE / Math.max(1, gym.team.length)) ** data.cfg.GYM_TEAM_EXP;
        const foes = gym.team.map(([id, lv]) => ({ id, level: lv, hpMult, damageMult: data.cfg.GYM_DAMAGE * (gym.power || 1) }));
        plan.push({ kind: 'battle', type: 'gym', name: gym.leader || gym.name, fixed: foes, power: gym.power || 1, index: plan.length });
        continue;
      }
      if (node.type === 'static' && node.id != null) {
        plan.push({ kind: 'battle', type: 'static', name: node.name, fixed: [{ id: node.id, level: node.level ?? 100 }], index: plan.length });
      }
      // item / other nodes pass
    }
    return plan;
  }
  /** The weighted species pool of a node (the game builds it live on some chapters). */
  function poolOfNode(node, data) {
    if (node.pool?.length) return node.pool;
    const pool = new Map();
    for (const area of node.areas || []) {
      for (const e of data.enc[area] || []) {
        const [id, min, max, pct, method] = e;
        if (pct >= 100) continue;
        const how = String(method || '');
        if (!/walk|surf|rod|static|headbutt|rock-smash/.test(how)) continue;
        let w = pct;
        if (/rod/.test(how)) w *= 0.15;
        else if (/surf/.test(how)) w *= 0.5;
        else if (/headbutt|rock-smash/.test(how)) w *= 0.25;
        const cur = pool.get(id) || { id, w: 0, min, max };
        cur.w += w;
        pool.set(id, cur);
      }
    }
    return [...pool.values()];
  }
  const rollPool = pool => {
    let total = pool.reduce((a, p) => a + (p.w || p[p.length - 1] || 1), 0);
    let r = Math.random() * total;
    for (const p of pool) {
      r -= (p.w || 1);
      if (r <= 0) return p;
    }
    return pool[pool.length - 1];
  };
  /** The foes of one battle instance (wild roll, random trainer roll, or fixed team). */
  function rollBattleFoes(step, data, save, cap) {
    const cfg = data.cfg;
    if (step.fixed) {
      return {
        foes: step.fixed.map(f => simFoe(f.id, f.level, f.hpMult ?? 1, f.damageMult ?? dmgMultOf(step.type, cfg, f.power))),
        slots: 1, dmgMult: dmgMultOf(step.type, cfg, step.power ?? 1), kind: step.type, index: step.index, xp: true,
      };
    }
    const pool = (step.pool || []).filter(p => data.species[p.id]);
    if (!pool.length) return null;
    const wildLevel = e => {
      const band = step.lv;
      if (band) return ri(band[0], band[1]);
      return e.level ?? ri(e.min ?? 30, e.max ?? 40);
    };
    if (step.type === 'wild') {
      const e = rollPool(pool);
      const level = wildLevel(e);
      const foe = simFoe(e.id, level, 1, cfg.ENEMY_DAMAGE.wild ?? 1);
      // the game: a diurnal wild can start asleep at night
      if (new Date().getHours() >= 20 && (data.cfg.NIGHT_SLEEP ?? 0) > 0) {
        const types = data.species[e.id]?.types || [];
        const dayOnly = ['sun', 'day'].some(k => (data.cfg.WEATHER?.TYPES?.[types[0]]?.key || '').includes(k));
        if (dayOnly && Math.random() < cfg.NIGHT_SLEEP) { foe.status = 'sleep'; foe.sleepLeft = ri(1, 3); }
      }
      return { foes: [foe], slots: 1, dmgMult: cfg.ENEMY_DAMAGE.wild ?? 1, kind: 'wild', index: step.index, xp: true };
    }
    // trainer: size + evolved rolls, exactly like the game's encounter builder
    const chapter = save?.adv?.chapter ?? 0;
    const regionKey = (data.chapters[chapter] || {}).reg || 'kanto';
    const first = data.chapters.findIndex(c => (c.reg || 'kanto') === regionKey);
    const size = step.size ?? 1 + ri(0, Math.min(2, Math.floor((chapter - first) / 2) + 1));
    const foes = [];
    for (let i = 0; i < size; i++) {
      const e = rollPool(pool);
      let level = Math.min(cfg.MAX_LEVEL, (data.aceOf ? 0 : 0) + (wildLevel(e) + ri(cfg.TRAINER_LEVEL_BONUS[0], cfg.TRAINER_LEVEL_BONUS[1])), cap);
      let id = e.id;
      if (level >= cfg.TRAINER_ITEM_EVO_LEVEL) {
        // item-evolved variants once high enough
        const itemEvo = (data.evo[id] || []).find(x => x.item && data.species[x.to]);
        if (itemEvo) id = itemEvo.to;
      } else if (Math.random() < cfg.TRAINER_EVOLVED_CHANCE) {
        const chain = (data.evo[id] || []).filter(x => x.level != null && x.level <= level && data.species[x.to]);
        if (chain.length) id = chain[chain.length - 1].to;
      }
      foes.push(simFoe(id, level, 1, cfg.ENEMY_DAMAGE.trainer ?? 1));
    }
    const doubles = foes.length >= 2 && Math.random() < (cfg.DOUBLE_CHANCE ?? .3);
    const slots = doubles ? 2 : 1;
    return { foes, slots, foeSlots: slots, dmgMult: cfg.ENEMY_DAMAGE.trainer ?? 1, kind: 'trainer', index: step.index, xp: true };
  }
  const dmgMultOf = (type, cfg, power) => type === 'gym'
    ? cfg.GYM_DAMAGE * (power || 1)
    : (cfg.ENEMY_DAMAGE[type] ?? 1) * (power || 1);
  const simFoe = (id, level, hpMult, damageMult) => ({ id, level, types: state.data.species[id]?.types || [], hpMult: hpMult || 1, _damageMult: damageMult || 1, hp: 0 });
  /** One run of the whole chapter. Returns the battles cleared and where it ended. */
  function runChapter(mons, plan, cap) {
    const cfg = state.data.cfg;
    let cleared = 0, battles = 0, ended = null;
    const startLevels = mons.map(m => m.level);
    for (const mon of mons) { mon.hp = mon.hpStart; simClear(mon); }
    for (const step of plan) {
      if (step.kind === 'heal') {
        for (const mon of mons) { mon.hp = simHp(mon); simClear(mon); }
        continue;
      }
      const spec = rollBattleFoes(step, state.data, readSave(), cap);
      if (!spec) continue;
      battles++;
      for (const f of spec.foes) f.hp = simHp(f);
      const res = simBattle(mons, spec);
      if (res.won) {
        cleared++;
        if (step.type === 'trainer' || step.type === 'gym') {
          // the game marks it beaten; keep going
        }
      } else {
        ended = step;
        break;
      }
    }
    return { cleared, battles, ended: ended ? ended.index : null, done: cleared === battles && battles > 0, gained: Math.max(...mons.map((m, i) => m.level - startLevels[i])) };
  }
  /** Monte-Carlo the chapter for one team. */
  function simulateChapter(cands, plan, cap, runs, onProgress) {
    const team = cands.map(c => ({
      uid: c.mon.uid, id: c.mon.id, level: c.mon.level, xp: c.mon.xp || 0, shiny: c.mon.shiny,
      reg: c.mon.reg, hpStart: simHp({ id: c.mon.id, level: c.mon.level, shiny: c.mon.shiny, hpMult: c.mon.hpMult }),
    }));
    let wins = 0, clearedSum = 0, totalBattles = 0, gainedMax = 0;
    const wipeAt = {};
    for (let i = 0; i < runs; i++) {
      const st = team.map(m => ({ ...m }));
      const res = runChapter(st, plan, cap);
      totalBattles = Math.max(totalBattles, res.battles);
      clearedSum += res.cleared;
      gainedMax = Math.max(gainedMax, res.gained || 0);
      if (res.done) wins++;
      else if (res.ended != null) wipeAt[res.ended] = (wipeAt[res.ended] || 0) + 1;
      if (onProgress && i % 4 === 0) onProgress(i + 1, runs);
    }
    return { wins, runs, rate: wins / Math.max(1, runs), avgCleared: clearedSum / Math.max(1, runs), totalBattles, wipeAt, gainedMax };
  }

  /** One battle (the game's ia/bs loop): slots, refills, stall, XP. */
  function simBattle(mons, spec) {
    const foes = spec.foes;
    const slots = Math.max(1, Math.min(spec.slots || 1, 3));
    const foeSlots = Math.max(1, Math.min(slots, 3));
    const order = mons => [...mons].sort((a, b) => autoScore(b, foes) - autoScore(a, foes));
    const queue = order(mons.filter(m => m.hp > 0));
    let active = queue.splice(0, slots);
    let foeActive = foes.slice(0, foeSlots);
    let turn = 0, calm = 0;
    const hpFrac = list => list.reduce((a, m) => a + m.hp, 0) / Math.max(1, list.reduce((a, m) => a + simHp(m), 0));
    const xpTarget = spec.xp;
    while (foeActive.some(f => f.hp > 0)) {
      if (!active.some(m => m.hp > 0)) return { won: false, at: spec.index };
      turn++;
      if (calm > state.data.cfg.STALL_ROUNDS || turn > state.data.cfg.MAX_ROUNDS) {
        if (hpFrac(active.filter(m => m.hp > 0)) > hpFrac(foes)) {
          for (const f of foes) f.hp = 0;
          if (xpTarget) awardXp(foes[foes.length - 1], active, mons, spec.kind, true);
          return { won: true, stalled: true, at: spec.index };
        }
        if (spec.kind === 'gym' || spec.kind === 'static') return { won: false, at: spec.index };
        return { won: true, fled: true, at: spec.index };   // wild/trainer: the game flees and the node passes
      }
      const actors = [
        ...active.filter(m => m.hp > 0).map(m => ({ m, ally: true })),
        ...foeActive.filter(f => f.hp > 0).map(f => ({ m: f, ally: false })),
      ].map(x => ({ ...x, spe: simStats(x.m).spe * (x.m.status === 'paralysis' ? .25 : 1) }))
        .sort((a, b) => b.spe - a.spe || Math.random() - .5);
      let lostAlly = false, foeDown = false;
      for (const { m: actor, ally } of actors) {
        if (actor.hp <= 0) continue;
        const opposing = (ally ? foeActive : active).filter(x => x.hp > 0);
        if (!opposing.length) break;
        // target: allies pick the best damage-to-hp ratio (the game's Dn), foes pick a random ally
        const target = ally
          ? (() => {
            let best = null, bestScore = -1;
            for (const f of opposing) {
              const mv = simGeneric(actor, [f]);
              if (!mv) continue;
              const eff = mv.typeless ? 1 : effRaw(mv.type, f.types);
              const score = Math.max(0, mv.power) * eff / Math.max(1, f.hp) * (.95 + Math.random() * .1);
              if (!best || score > bestScore) { best = f; bestScore = score; }
            }
            return best || opposing[0];
          })()
          : rpick(opposing);
        const dealt = simAct(actor, target, opposing.map(x => x), ally ? 1 : spec.dmgMult);
        if (dealt) calm = 0;
        const dot = (actor._dmg || 0); actor._dmg = 0;
        if (dot) calm = 0;
        simDot(actor);
        if (actor._dmg) calm = 0;
        if (target.hp <= 0 && ally) {
          if (xpTarget) awardXp(target, active, mons, spec.kind, false);
          const next = foes.find(f => f.hp > 0 && !foeActive.includes(f));
          if (next) { const idx = foeActive.indexOf(target); foeActive[idx < 0 ? 0 : idx] = next; }
          else foeDown = true;
        }
        if (actor.hp <= 0 && ally) lostAlly = true;
      }
      if (lostAlly) {
        const next = queue.find(m => m.hp > 0 && !active.includes(m));
        if (next) { const idx = active.findIndex(m => m.hp <= 0); active[idx < 0 ? 0 : idx] = next; }
      }
      calm++;
    }
    return { won: foes.every(f => f.hp <= 0), at: spec.index };
  }
  /** XP for one defeated foe, to the whole team, with mid-run level-ups. */
  function awardXp(foe, active, mons, kind, stalled) {
    const cfg = state.data.cfg;
    const base = (cfg.baseExp?.[foe.id]) || cfg.XP_BASE_REF;
    const trainerish = kind === 'trainer' || kind === 'gym';
    const share = xpLevelShare(foe.level) / cfg.XP_WINS_PER_LEVEL * Math.sqrt(base / cfg.XP_BASE_REF) * (trainerish ? 1.5 : 1);
    const cap = state.events?.cap ?? cfg.MAX_LEVEL;
    for (const mon of mons) {
      if (mon.level >= cap) continue;
      const amount = share * (active.includes(mon) ? cfg.XP_ACTIVE_BONUS : 1);
      mon.xp = (mon.xp || 0) + amount;
      let guard = 0;
      while (mon.level < cap && mon.xp >= xpForNext(mon) && guard++ < 120) {
        mon.xp -= xpForNext(mon);
        mon.level++;
      }
      // the game's pe: level evolutions with the daytime and party gates
      let evo = 0;
      while (evo++ < 4) {
        const chain = (state.data.evo[mon.id] || []).filter(e => e.level != null && mon.level >= e.level
          && daytimeMatches(state.data, readSave(), state.data.cfg.TIME_EVOLUTIONS?.[e.to])
          && (!e.party || mons.some(t => t.id === e.party)));
        const next = chain[0];
        if (!next || !state.data.species[next.to]) break;
        mon.id = next.to;
      }
    }
  }
  const xpBe = level => Math.floor(.8 * Math.pow(level, 2.4) + 10);
  function xpGrowth(level) {
    const cfg = state.data.cfg;
    const ratio = cfg.CHAPTER_TIME_RATIO || 1;
    const bands = [{ from: cfg.XP_GROWTH_FROM ?? 10, step: (state.data.regions[0]?.ace || [0, 8])[1] ?? 8 },
      ...state.data.regions.filter(r => r.base != null).map(r => ({ from: r.base, step: (r.ace || [0, 8])[1] ?? 8 }))]
      .sort((a, b) => a.from - b.from);
    let g = 1;
    for (let i = 0; i < bands.length; i++) {
      const to = Math.min(level, bands[i + 1]?.from ?? Infinity);
      if (to > bands[i].from) g *= Math.pow(Math.pow(ratio, 1 / bands[i].step) * (cfg.XP_GROWTH_EXTRA ?? 1), to - bands[i].from);
    }
    return g;
  }
  const xpForNext = mon => Math.floor(xpBe(mon.level) * xpGrowth(mon.level) * (state.data.cfg.XP_SCALE ?? 3) * (state.data.cfg.REGION_XP?.[mon.reg] ?? 1));
  function xpLevelShare(level) {   // the game's levelXp: base × the "start" factor
    const cfg = state.data.cfg;
    const ratio = cfg.CHAPTER_TIME_RATIO || 1;
    const bands = [{ from: cfg.XP_GROWTH_FROM ?? 10, step: (state.data.regions[0]?.ace || [0, 8])[1] ?? 8 },
      ...state.data.regions.filter(r => r.base != null).map(r => ({ from: r.base, step: (r.ace || [0, 8])[1] ?? 8 }))]
      .sort((a, b) => a.from - b.from);
    let g = 1;
    for (let i = 0; i < bands.length; i++) {
      const to = Math.min(level, bands[i + 1]?.from ?? Infinity);
      if (to > bands[i].from) g *= Math.pow(Math.pow(ratio, 1 / bands[i].step) * (cfg.XP_GROWTH_EXTRA ?? 1), to - bands[i].from);
    }
    const from = bands.find(b => level >= b.from);
    const back = from && bands.indexOf(from) > 0 ? Math.pow(Math.pow(ratio, 1 / from.step) * (cfg.XP_GROWTH_EXTRA ?? 1), level - from.from) : 1;
    return Math.floor(xpBe(level) * (g / (back || 1)));
  }

  /* ------------------------------------------------------------------ *
   * 6b. Legendary fights (roaming legendaries and their elite versions)
   * ------------------------------------------------------------------ */
  /** Build the boss (a legend zone) with the knobs the game uses for that fight. */
  function legendBoss(zone, tier, team, eng, data) {
    const cfg = data.cfg;
    const sp = data.species[zone.id];
    if (!sp) return null;
    const level = zone.level || 100;
    const mon = { id: zone.id, level, types: sp.types };
    const maxHp = eng.maxHp(mon);
    // the boss scales with the team (shiny and level count as "power")
    const aura = team.length
      ? Math.pow(team.reduce((a, c) => a + (c.proj.shiny ? 1 : Math.max(1, Math.min(c.proj.level, cfg.MAX_LEVEL) / cfg.MAX_LEVEL)), 0) / team.length, cfg.LEGEND_ZONE?.AURA || 1)
      : 1;
    // the game's eliteKnobs: a per-zone override wins over the shared ELITE_K table
    const inline = tier ? (zone.elite?.[zone.id]?.[tier] || zone.elite?.[tier]) : null;
    const eliteTable = tier ? (inline
      ? [inline.hp ?? 1, inline.power ?? 1]
      : (state.legends?.elite?.[zone.id]?.[tier] || [1, 1])) : null;
    const eliteHp = tier ? (cfg.ELITE?.HP?.[tier] ?? 1) : 1;
    const elitePower = tier ? (cfg.ELITE?.POWER?.[tier] ?? 1) : 1;
    const hpKnob = (zone.hp ?? cfg.LEGEND_ZONE?.HP ?? 3) * eliteHp * (eliteTable ? eliteTable[0] : 1) * (tier ? 1 : aura);
    const powerKnob = (zone.power ?? cfg.LEGEND_ZONE?.POWER ?? .5) * elitePower * (eliteTable ? eliteTable[1] : 1) * (tier ? 1 : aura * aura);
    const hp = Math.floor(maxHp * (1 + (cfg.ENEMY_HP_PER_ALLY ?? .7) * (cfg.TEAM_SIZE - 1)) * hpKnob);
    const resist = tier ? (cfg.ELITE?.RESIST?.[tier] ?? 1) : 1;
    const counter = zone.counter ? data.moves[zone.counter] : null;
    const burst = zone.burst ? data.moves[zone.burst] : null;

    const damageTo = target => {
      const main = eng.bestDamage(mon, target);
      const c = counter ? eng.moveDamage(mon, target, { type: counter.type, cat: counter.cat, power: eng.movePower(zone.counter), acc: counter.acc || 100 }) : 0;
      const b = burst ? eng.moveDamage(mon, target, { type: burst.type, cat: burst.cat, power: eng.movePower(zone.burst), acc: burst.acc || 100 }) : 0;
      const lz = cfg.LEGEND_ZONE || {};
      return (main / cfg.TEAM_SIZE + (lz.COUNTER ?? .3) * c + (cfg.TEAM_SIZE / (lz.RAGE ?? 8)) * (lz.BURST ?? 1) * b) * powerKnob;
    };

    return { zone, mon, types: sp.types, level, maxHp, hp, resist, powerKnob, damageTo, aura };
  }

  /** One legendary fight with the game's rolls (used for the win chance). */
  function legendFightOnce(team, boss, eng) {
    const alive = team.map(c => ({ c, hp: c.hpCur != null ? c.hpCur : c.hp }));
    let bossHp = boss.hp, rounds = 0;
    while (bossHp > 0 && alive.length && rounds < 400) {
      let dps = 0;
      for (const a of alive) {
        const mv = eng.bestMove(a.c.proj, boss.types);
        if (!mv) continue;
        if (Math.random() * 100 > mv.acc) continue;                    // miss
        const eff = eng.typeEff(mv.type, boss.types);
        let d = eng.damage(a.c.proj, boss.mon, mv, eff) / 0.925;        // undo the average roll
        d *= 0.85 + Math.random() * 0.15;                               // damage roll
        if (Math.random() < 1 / 24) d *= 1.5;                           // crit
        dps += d;
      }
      dps *= boss.resist;
      bossHp -= dps;
      rounds++;
      for (const a of alive) {
        const hit = boss.damageTo(a.c.proj) / 0.925;
        a.hp -= hit * (0.85 + Math.random() * 0.15);
      }
      for (let i = alive.length - 1; i >= 0; i--) if (alive[i].hp <= 0) alive.splice(i, 1);
    }
    return { win: bossHp <= 0, rounds };
  }

  /** Seconds of one fight: the game runs a round in ~2.5 s at its fast speed (measured). */
  const SEC_PER_ROUND = 2.5;
  const CAPTURE_SEC = 2.5;

  /** Victory chance, run time and the expected attempts / total time to catch the boss. */
  function legendOdds(zone, tier, team, eng, data, save, runs = 200) {
    const boss = legendBoss(zone, tier, team, eng, data);
    if (!boss || !team.length) return null;
    let wins = 0, roundsSum = 0;
    for (let i = 0; i < runs; i++) {
      const r = legendFightOnce(team, boss, eng);
      if (r.win) { wins++; roundsSum += r.rounds; }
    }
    const winChance = wins / runs;
    const rounds = wins ? roundsSum / wins : 0;

    const cfg = data.cfg;
    const sp = data.species[zone.id];
    const buffEntry = save?.buffs?.capture;
    const buff = buffEntry && buffEntry.until > Date.now()
      ? (cfg.BUFF_BERRIES?.[buffEntry.key]?.mult ?? 1) : 1;
    const rate = sp
      ? ((sp.legendary || sp.mythical) ? (cfg.LEGENDARY_CAPTURE_RATE ?? 3) : (sp.captureRate ?? 45) * (cfg.CAPTURE_BONUS ?? .6)) / 255
      : 0;
    const pCatch = Math.min((cfg.CAPTURE_MAX ?? .6) * buff, rate * buff);

    const speed = save?.adv?.speed ?? 1;
    const secPerRound = SEC_PER_ROUND * (4 / Math.max(1, speed));
    const runMs = (rounds * secPerRound + CAPTURE_SEC) * 1000;
    const q = winChance * pCatch;
    const pity = cfg.RAID_PITY ?? 150;
    // expected attempts, capped by the raid pity
    let expected = 0;
    if (q > 0) {
      for (let i = 0; i < pity; i++) expected += Math.pow(1 - q, i);
    } else expected = pity;
    const fails = q > 0 ? Math.pow(1 - q, pity) : 1;
    return {
      winChance, rounds: Math.round(rounds), pCatch, attempts: expected,
      runMs, totalMs: expected * runMs, guaranteed: fails, speed
    };
  }

  /** One legendary fight: the boss hits the whole team every round. */
  function simulateLegend(team, boss, eng) {
    const alive = team.map(c => ({ c, hp: c.hpCur != null ? c.hpCur : c.hp }));
    let bossHp = boss.hp, rounds = 0, dealt = 0;
    while (bossHp > 0 && alive.length && rounds < 400) {
      let dps = 0;
      for (const a of alive) {
        const mv = eng.bestMove(a.c.proj, boss.types);
        if (!mv) continue;
        const eff = eng.typeEff(mv.type, boss.types);
        dps += eng.damage(a.c.proj, boss.mon, mv, eff) * (mv.acc / 100);
      }
      dps *= boss.resist;
      bossHp -= dps;
      dealt += dps;
      rounds++;
      for (const a of alive) a.hp -= boss.damageTo(a.c.proj);
      for (let i = alive.length - 1; i >= 0; i--) if (alive[i].hp <= 0) alive.splice(i, 1);
    }
    const teamHp = team.reduce((a, c) => a + (c.hpCur != null ? c.hpCur : c.hp), 0);
    const perRound = team.length ? team.reduce((a, c) => a + boss.damageTo(c.proj), 0) / team.length : 0;
    return {
      win: bossHp <= 0,
      roundsKill: bossHp <= 0 ? rounds : Infinity,
      roundsDie: perRound > 0 ? teamHp / perRound : 999,
      hpLeft: Math.max(0, bossHp),
      dealt
    };
  }

  function evaluateLegendTeam(team, zone, tier, eng, data) {
    const boss = legendBoss(zone, tier, team, eng, data);
    if (!boss) return 0;
    const res = simulateLegend(team, boss, eng);
    if (state.preset === 'offense') return res.dealt / Math.max(1, boss.hp);
    return fightScore(res, state.preset);
  }

  /** Greedy team builder for one legendary boss. */
  function pickLegendTeam(cands, zone, tier, eng, data, size = 6) {
    // rank the candidates by what they actually bring against that boss
    const boss = legendBoss(zone, tier, cands.slice(0, 6), eng, data);
    const contribution = c => {
      if (!boss) return c.proj.level;
      const mv = eng.bestMove(c.proj, boss.types);
      if (!mv) return 0;
      const eff = eng.typeEff(mv.type, boss.types);
      const dps = eng.damage(c.proj, boss.mon, mv, eff) * (mv.acc / 100);
      const inc = boss.damageTo(c.proj);
      const alive = inc > 0 ? c.hp / inc : 999;
      return dps * Math.min(alive, 400);
    };
    const pool = cands.slice().sort((a, b) => contribution(b) - contribution(a)).slice(0, 80);
    const chosen = [];
    const usedSpecies = new Set();
    const usedShiny = new Set();
    const usedUids = new Set();
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (chosen.includes(cand) || usedUids.has(cand.mon.uid)) continue;
        if (!cand.proj.shiny && usedSpecies.has(cand.species.id)) continue;
        if (cand.proj.shiny && usedShiny.has(cand.species.id)) continue;
        const sc = evaluateLegendTeam(chosen.concat([cand]), zone, tier, eng, data);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      if (!best) break;
      chosen.push(best);
      usedSpecies.add(best.species.id);
      usedUids.add(best.mon.uid);
      if (best.proj.shiny) usedShiny.add(best.species.id);
    }
    return chosen;
  }

  /* ------------------------------------------------------------------ *
   * 7. Wipe watcher: remembers on which step the team falls
   * ------------------------------------------------------------------ */
  class WipeWatcher {
    constructor(onChange) {
      this.onChange = onChange;
      this.fails = store.get('fails', []) || [];
      this.running = false;
      this.timer = null;
      this.lastBattle = null;    // last battle seen (the fight can end before we poll)
      this.firstKo = null;       // step where the first team member fell
      this.lastDeaths = null;    // the game's own death counter (adv.deaths)
      this.lastTries = null;     // league/elite attempt counters (adv.league.tries, adv.zone.tries)
      this.prevState = null;     // chapter/step before the last change
    }
    start() {
      if (this.running) return;
      this.running = true;
      this.timer = setInterval(() => {
        try { this.poll(); } catch (e) { logError('watcher: poll', e); }
      }, 700);
      this.firstKo = null;
      this.lastDeaths = null;
      this.lastTries = null;
      this.prevState = null;
      log('info', 'watcher: started');
      try { this.poll(); } catch (e) { logError('watcher: poll', e); }
    }
    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      log('info', 'watcher: stopped');
    }
    poll() {
      const save = readSave();
      if (!save || !save.adv) return;
      const adv = save.adv;
      const nodeIdx = adv.node;
      const battle = adv.battle;
      if (battle) {
        this.lastBattle = {
          kind: battle.kind,
          node: nodeIdx,
          enemies: (battle.enemies || []).map(e => ({ id: e.id, level: e.level }))
        };
      }
      const team = (adv.team || save.team || []).map(u => monByUid(save, u)).filter(Boolean);
      const ko = team.filter(m => m.hp != null && m.hp <= 0);
      if (ko.length && !this.firstKo) {
        this.firstKo = { node: nodeIdx, at: Date.now(), name: (adv.nodes || [])[nodeIdx]?.name || '?' };
      }
      if (!ko.length) this.firstKo = null;

      // The game heals the team the instant it is wiped, so the "all knocked out" state
      // never lasts. The game now counts a wipe differently per mode (bundle 2026-11):
      //   adventure/league chapter: adv.deaths[chapter]++
      //   league run:               adv.league.tries++
      //   elite legend zone:        adv.zone.tries++
      const deaths = adv.deaths || {};
      const prev = this.lastDeaths;
      this.lastDeaths = { ...deaths };
      let died = null, diedCount = 0, why = 'chapter';
      if (prev) {
        for (const [ch, n] of Object.entries(deaths)) {
          const d = n - (prev[ch] || 0);
          if (d > 0) { died = Number(ch); diedCount = d; }
        }
      }
      const tries = {
        league: adv.league ? { reg: adv.league.reg, tier: adv.league.tier, n: adv.league.tries || 0 } : null,
        zone: adv.zone?.elite && adv.zone.id != null
          ? { id: adv.zone.id, tier: adv.zone.elite, n: adv.zone.tries || 0 } : null,
      };
      const prevTries = this.lastTries;
      this.lastTries = tries;
      if (!died && prevTries) {
        const L = tries.league, pL = prevTries.league;
        const Z = tries.zone, pZ = prevTries.zone;
        if (L && pL && L.reg === pL.reg && L.tier === pL.tier && L.n > pL.n) {
          died = adv.chapter; diedCount = L.n - pL.n; why = 'league';
        } else if (Z && pZ && Z.id === pZ.id && Z.tier === pZ.tier && Z.n > pZ.n) {
          died = adv.chapter; diedCount = Z.n - pZ.n; why = 'elite zone';
        }
      }
      const state = { chapter: adv.chapter, node: nodeIdx, name: (adv.nodes || [])[nodeIdx]?.name || '?' };
      if (!died) {
        this.prevState = state;
        return;
      }
      // report the step the team fell on (the last poll before the wipe)
      const before = this.prevState || state;
      const node = (adv.nodes || [])[before.node] || {};
      const b = this.lastBattle || {};
      const rec = {
        at: Date.now(),
        chapter: before.chapter,
        node: before.node,
        name: node.name || before.name || '?',
        kind: node.type || b.kind || '?',
        why,
        lv: node.lv || null,
        enemies: b.enemies || [],
        firstKo: this.firstKo,
        team: team.map(m => ({ uid: m.uid, id: m.id, level: m.level }))
      };
      // more than one wipe can slip through between two polls (background tab)
      for (let i = 0; i < Math.min(diedCount, 5); i++) this.fails.unshift(i === 0 ? rec : { ...rec, at: rec.at - i * 1000 });
      this.fails = this.fails.slice(0, 25);
      store.set('fails', this.fails);
      log('warn', 'watcher: team wipe', {
        why, chapter: rec.chapter, step: rec.name, kind: rec.kind, count: diedCount,
        enemies: rec.enemies.slice(0, 3),
      });
      this.firstKo = null;
      this.onChange && this.onChange(rec);
    }
    clear() {
      this.fails = [];
      this.wiped = false;
      this.firstKo = null;
      store.set('fails', []);
      log('info', 'watcher: wipes cleared');
      this.onChange && this.onChange(null);
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. Team editing (drag & drop, the way the game does it)
   * ------------------------------------------------------------------ */
  /** Open the Team/PC screen (resuming the game first, and waiting out a running battle). */
  async function gotoTeamScreen(tries = 60) {
    const ready = () => !!document.querySelector('#screen-team.active') && document.querySelectorAll('#team-slots .slot').length > 0;
    log('debug', 'team screen: opening');
    for (let i = 0; i < tries; i++) {
      if (ready()) { state.waiting = null; return true; }
      const cont = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'CONTINUE');
      if (cont) { log('debug', 'team screen: resuming the game'); cont.click(); await sleep(500); continue; }
      // the game refuses to switch screens while a battle runs: wait for it to end
      const save = readSave();
      if (save?.adv?.battle) { state.waiting = 'waiting for the current battle to end…'; await sleep(1000); continue; }
      const nav = document.querySelector('#side [data-screen="team"]');
      const btn = nav || [...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === 'team/pc');
      if (btn) { btn.click(); await sleep(600); }
      else await sleep(300);
    }
    state.waiting = null;
    const ok = ready();
    log(ok ? 'debug' : 'warn', 'team screen: ' + (ok ? 'open' : 'not reachable'));
    return ok;
  }

  const pcCellFor = uid => document.querySelector(`#pc-grid .pc-cell[data-uid="${uid}"]`);

  /** The PC grid is virtualised: search for the mon when it is not rendered. */
  async function findPcCell(uid, save) {
    let cell = pcCellFor(uid);
    if (cell) return cell;
    const mon = monByUid(save, uid);
    if (!mon) return null;
    const input = document.querySelector('#pc-search');
    if (!input) return null;
    input.value = displayName(mon.id);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    return pcCellFor(uid);
  }

  async function clearPcSearch() {
    const input = document.querySelector('#pc-search');
    if (!input || !input.value) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
  }

  function dragToSlot(cell, slot) {
    const cb = cell.getBoundingClientRect(), sb = slot.getBoundingClientRect();
    const cx = cb.left + cb.width / 2, cy = cb.top + cb.height / 2;
    const tx = sb.left + sb.width / 2, ty = sb.top + sb.height / 2;
    const fire = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true
    }));
    fire('pointerdown', cx, cy, cell);
    fire('pointermove', cx + 24, cy + 12, cell);
    fire('pointermove', tx, ty, document.body);
    fire('pointerup', tx, ty, document.body);
  }

  async function applyTeam(team) {
    log('info', 'apply: start', { mons: team.length });
    if (!await gotoTeamScreen()) { state.waiting = null; return { ok: false, error: 'team screen not available' }; }
    if (!readSave()) return { ok: false, error: 'no save' };
    const desired = team.slice(0, 6).map(t => t.mon.uid);
    const slotEls = () => $$('#team-slots .slot');
    if (slotEls().length < 6) return { ok: false, error: 'team slots not found' };
    let done = 0, same = 0;
    for (let i = 0; i < desired.length; i++) {
      const uid = desired[i];
      const cur = readSave();
      const teamUids = (cur.team || []).slice();
      if (teamUids[i] === uid) { same++; continue; }   // already in the right slot
      const from = teamUids.indexOf(uid);
      const slots = slotEls();
      if (!slots[i]) continue;
      // already in the team -> swap the two slots, otherwise pull it from the PC
      const cell = from >= 0 ? slots[from] : await findPcCell(uid, cur);
      if (!cell) { log('warn', 'apply: mon not found in the PC', { slot: i, uid }); await clearPcSearch(); continue; }
      dragToSlot(cell, slots[i]);
      await sleep(700);
      await clearPcSearch();
      done++;
    }
    state.waiting = null;
    log('info', 'apply: done', { placed: done, already: same, of: desired.length });
    return { ok: true, done, same };
  }

  /* ------------------------------------------------------------------ *
   * 8b. PokéAPI (pokeapi.co) cross-check and the game's moves panel
   * ------------------------------------------------------------------ */
  async function pokeApiSpecies(name) {
    const key = 'api:' + name;
    if (state.apiCache[key]) return state.apiCache[key];
    const cached = store.get(key, null);
    if (cached) { state.apiCache[key] = cached; return cached; }
    const data = await httpGetJson('https://pokeapi.co/api/v2/pokemon/' + encodeURIComponent(name));
    const out = {
      types: (data.types || []).map(t => t.type.name),
      stats: {
        hp: data.stats?.[0]?.base_stat, atk: data.stats?.[1]?.base_stat, def: data.stats?.[2]?.base_stat,
        spa: data.stats?.[3]?.base_stat, spd: data.stats?.[4]?.base_stat, spe: data.stats?.[5]?.base_stat
      },
      learn: (data.moves || [])
        .filter(m => m.move && m.move.name)
        .map(m => {
          const vg = (m.version_group_details || []).find(v => v.move_learn_method?.name === 'level-up')
            || (m.version_group_details || [])[0];
          return { key: m.move.name, level: vg?.level_learned_at ?? 0 };
        })
    };
    store.set(key, out);
    state.apiCache[key] = out;
    return out;
  }

  /** Open the game's own moves panel for a Pokémon (the authoritative learnset). */
  async function showMovesPanel(uid) {
    if (!await gotoTeamScreen()) return false;
    document.querySelector('.mvd-root .dc-x')?.click();
    document.querySelector('.modal-root .dc-x')?.click();
    await sleep(250);
    let cell = await findPcCell(uid, readSave() || { mons: [] });
    if (!cell) {
      await clearPcSearch();
      // already in the team: open its slot instead
      cell = document.querySelector(`#team-slots .slot[data-uid="${uid}"]`);
    }
    if (!cell) return false;
    cell.click();
    await sleep(600);
    const mv = document.querySelector('.modal-root .dc-move');
    if (mv) mv.click();
    await sleep(500);
    await clearPcSearch();
    return !!mv;
  }

  /* ------------------------------------------------------------------ *
   * 8b. Shiny raids: boss, DPS scores, fastest clear
   * ------------------------------------------------------------------ */
  /** The raid boss of the picker header ("Raid vs X" / FR "Raid contre X"). */
  function raidContext() {
    const head = document.querySelector('#evt-pick-head h2');
    if (!head || !state.data?.cfg?.RAID) return null;
    const txt = head.textContent.replace(/\s+/g, ' ').trim();
    if (!/^raid\b/i.test(txt) && !/raid/i.test(txt)) return null;
    const m = txt.match(/\b(?:vs|contre)\s+(.+)$/i);
    if (!m) return null;
    const id = speciesIdByName(m[1].trim());
    if (id == null || !state.data.species[id]) return null;
    return { id, name: m[1].trim() };
  }
  /** The boss as a sim mon: level 100, shiny, with the raid HP/power knobs. */
  function raidBoss(rc) {
    const cfg = state.data.cfg;
    const raid = cfg.RAID || {};
    const boss = raid.BOSS || { HP: 3.3, POWER: .7, BST_REF: 500, HP_EXP: 1.8, POWER_EXP: 1 };
    const sp = state.data.species[rc.id];
    const mon = { id: rc.id, level: raid.LEVEL ?? 100, shiny: true, types: sp.types };
    const bst = Object.values(sp.stats).reduce((a, b) => a + b, 0);
    const scale = boss.BST_REF / bst;
    const adj = boss.ADJ?.[rc.id] ?? 1;
    const hpPower = (raid.hpPower ?? boss.HP) * Math.pow(scale, boss.HP_EXP) * adj;
    const dmgMult = (raid.power ?? boss.POWER) * Math.pow(scale, boss.POWER_EXP) * adj;
    return { mon, hpPower, dmgMult, maxHp: Math.floor(state.engine.maxHp(mon) * (1 + (cfg.ENEMY_HP_PER_ALLY ?? .7) * ((cfg.RAID?.MINE ?? 2) * (1 + (cfg.RAID?.ALLIES ?? 2)) - 1)) * hpPower) };
  }
  /** Damage per round a mon puts into the raid boss (expected, accuracy-weighted). */
  function raidDps(mon, boss) {
    const mv = state.engine.bestMove(mon, boss.mon.types);
    if (!mv) return 0;
    const eff = effRaw(mv.type, boss.mon.types);
    const dmg = state.engine.damage(mon, boss.mon, mv, eff);
    const acc = state.engine.moveAcc(mv.key);
    const out = dmg * (acc / 100);
    if (!Number.isFinite(out)) log('warn', 'raid: dps NaN', { id: mon.id, level: mon.level, mv: mv.key, dmg, acc, eff, hasChart: !!state.chart, hasEngine: !!state.engine });
    return out;
  }
  const raidDpsCache = new Map();
  function raidDpsCached(mon) {
    const key = mon.uid + ':' + mon.level + ':' + (mon.shiny ? 1 : 0);
    if (!raidDpsCache.has(key)) {
      const boss = state.raidBoss;
      raidDpsCache.set(key, boss ? raidDps(mon, boss) : 0);
    }
    return raidDpsCache.get(key);
  }
  /** Annotate the raid suggestions with their DPS:
   *  - the community species cards in the picker (rp-pk, with my best copy under each),
   *  - the ally rows in the modal (their two mons summed). */
  function annotateRaidSuggestions() {
    const boss = state.raidBoss;
    if (!boss) return;
    // the community species suggestions in the picker sidebar
    document.querySelectorAll('#evt-pick .rp-pk').forEach(card => {
      if (card.querySelector('.pcopt-atk')) return;
      const img = card.querySelector('img[data-id]');
      const id = parseInt(img?.dataset.id, 10);
      if (!id || !state.data.species[id]) return;
      // my best copy of this species (the game shows it under the card)
      const save = readSave();
      const mine = save.mons.filter(m => m.id === id && canJoinTeam(save, m)).sort((a, b) => b.level - a.level)[0];
      const dps = raidDps({ id, level: Math.min(mine?.level ?? 100, 100), shiny: !!mine?.shiny }, boss);
      const tag = document.createElement('span');
      tag.className = 'pcopt-atk';
      tag.textContent = 'atk ' + (dps >= 1000 ? (dps / 1000).toFixed(1) + 'k' : Math.round(dps));
      tag.style.cssText = 'position:absolute;left:3px;top:3px;font-size:10px;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--c) 72%,#000c);color:#fff;z-index:2';
      card.style.position = 'relative';
      card.prepend(tag);
    });
    // the ally modal rows
    document.querySelectorAll('.modal-root.open .raid-pick').forEach(row => {
      if (row.querySelector('.pcopt-atk')) return;
      const mons = [...row.querySelectorAll('.rt-mon')].map(m => {
        const img = m.querySelector('img[data-id]');
        const lvTxt = m.querySelector('.rt-lv')?.textContent || '100';
        const level = parseInt((lvTxt.match(/\d+/) || [100])[0], 10) || 100;
        const id = parseInt(img?.dataset.id, 10);
        return id && state.data.species[id] ? { id, level, shiny: /shiny/.test(img?.src || '') } : null;
      }).filter(Boolean);
      if (!mons.length) return;
      const dps = mons.reduce((a, m) => a + raidDps(m, boss), 0);
      const tag = document.createElement('span');
      tag.className = 'pcopt-atk';
      tag.textContent = 'atk ' + (dps >= 1000 ? (dps / 1000).toFixed(1) + 'k' : Math.round(dps));
      tag.style.cssText = 'font-size:11px;padding:2px 6px;border-radius:5px;background:color-mix(in srgb,var(--c) 72%,#000c);color:#fff;margin-right:4px';
      row.prepend(tag);
      row.dataset.pcoptDps = String(Math.round(dps));
    });
  }
  /** The fastest clear: my best 2 picks + the 2 best allies, applied through the game's UI. */
  async function fastestClear(rc) {
    const boss = state.raidBoss;
    const save = readSave();
    const levelCap = state.data.cfg.RAID?.LEVEL ?? 100;
    // the raid picker allows every PC mon (no region link), capped at the raid level
    const mine = save.mons
      .filter(m => state.data.species[m.id])
      .map(m => {
        try {
          return { mon: m, dps: raidDps({ id: m.id, level: Math.min(m.level, levelCap), shiny: m.shiny }, boss) };
        } catch (e) {
          logError('raid: dps failed for ' + m.id, e);
          return { mon: m, dps: 0 };
        }
      })
      .sort((a, b) => b.dps - a.dps);
    // one per species (the game's rule), keep the highest-dps copy
    const seen = new Set();
    const picked = mine.filter(x => !seen.has(x.mon.id) && seen.add(x.mon.id));
    const team = picked.slice(0, 2).map(x => ({ mon: x.mon, dps: x.dps, species: state.data.species[x.mon.id], proj: { id: x.mon.id, level: x.mon.level, shiny: x.mon.shiny }, base: { id: x.mon.id }, hp: 0 }));
    const myDps = team.reduce((a, t) => a + t.dps, 0);
    log('debug', 'raid: dps check', { myDps, perMon: team.map(t => [t.mon.id, Math.round(t.dps * 10) / 10]), levels: team.map(t => t.mon.level), bossHp: boss.maxHp, hpPower: boss.hpPower, dmgMult: boss.dmgMult });
    state.evtOdds = { key: 'raid:' + rc.id, text: `team dps ${myDps >= 1000 ? (myDps / 1000).toFixed(1) + 'k' : Math.round(myDps)} · ${displayName(rc.id)} ${Math.round(boss.maxHp / Math.max(1, myDps))} rounds` };
    log('info', 'raid: fastest clear', { boss: displayName(rc.id), picks: team.map(t => displayName(t.mon.id) + ' ' + Math.round(t.dps || 0)) });
    await applyToEventPicker(team);
    // allies: walk the game's ally slots and take the best row of each modal
    const allyDps = [];
    const grpButtons = [...document.querySelectorAll('#screen-raid .rc-grp')];
    for (const grp of grpButtons.slice(1)) {
      grp.click();
      let modal = null;
      for (let i = 0; i < 20; i++) { await sleep(250); modal = document.querySelector('.modal-root.open'); if (modal?.querySelector('.raid-pick')) break; }
      if (!modal) break;
      annotateRaidSuggestions();
      await sleep(300);
      const rows = [...modal.querySelectorAll('.raid-pick')]
        .map(row => ({ row, dps: parseFloat(row.dataset.pcoptDps || '0') }))
        .sort((a, b) => b.dps - a.dps);
      if (!rows.length) break;
      allyDps.push(rows[0].dps);
      log('info', 'raid: ally picked', { dps: rows[0].dps });
      rows[0].row.click();
      await sleep(600);
      modal.querySelector('.dc-x')?.click();
      await sleep(500);
    }
    const slotDps = () => [...document.querySelectorAll('#screen-raid .rc-grp')].slice(1).reduce((sum, grp) =>
      sum + [...grp.querySelectorAll('.rt-mon')].map(m => {
        const img = m.querySelector('img[data-id]');
        const lv = parseInt(((m.querySelector('.rt-lv')?.textContent || '100').match(/\d+/) || [100])[0], 10) || 100;
        const id = parseInt(img?.dataset.id, 10);
        return id && state.data.species[id] ? { id, level: lv, shiny: /shiny/.test(img?.src || '') } : null;
      }).filter(Boolean).reduce((a, mon) => a + raidDps(mon, boss), 0), 0);
    const walkDps = allyDps.reduce((a, b) => a + b, 0);
    const allyTotal = Math.max(walkDps, slotDps());
    const total = myDps + allyTotal;
    state.evtOdds = { key: 'raid:' + rc.id, text: `team dps ${total >= 1000 ? (total / 1000).toFixed(1) + 'k' : Math.round(total)} (mine ${Math.round(myDps)} + allies ${Math.round(allyTotal)}) · ${displayName(rc.id)} ${Math.round(boss.maxHp / Math.max(1, total))} rounds to break` };
    refreshUi();
  }

  /* ------------------------------------------------------------------ *
   * 8c. Inside the game: my controls next to its own "Optimize" button
   * ------------------------------------------------------------------ */
  function speciesIdByName(name) {
    const lang = i18n();
    for (const [k, v] of Object.entries(lang?.pokemon || {})) {
      if ((Array.isArray(v) ? v[0] : v) === name) return +k;
    }
    for (const [k, sp] of Object.entries(state.data?.species || {})) {
      if (sp.name === name) return +k;
    }
    return null;
  }

  /** What the game's team picker is open for (the boss and the elite tier, from its header). */
  function pickerContext() {
    const head = document.querySelector('#evt-pick-head h2');
    if (!head || !state.legends || !state.data) return null;
    const txt = head.textContent.replace(/\s+/g, ' ').trim();
    const m = txt.match(/\b(?:contre|vs\.?)\s+(.+)$/i);
    if (!m) return null;
    const id = speciesIdByName(m[1].trim());
    if (id == null) return null;
    const zone = state.legends.zones.find(z => z.id === id);
    if (!zone) return null;
    const tier = +(((txt.match(/lite\s*(\d)/i) || [])[1]) || 0);
    return { zone, tier };
  }

  function oddsText(o) {
    if (!o) return '';
    if (o.winChance < 0.02) return `win ~0% · cannot win with this team yet`;
    return `win ${Math.max(1, Math.round(o.winChance * 100))}% · ${o.rounds} rounds ≈ ${fmtTime(o.runMs)}/run`
      + ` · catch ${(o.pCatch * 100).toFixed(1)}%/run`
      + ` · ~${o.attempts < 10 ? o.attempts.toFixed(1) : Math.round(o.attempts)} runs ≈ ${fmtTime(o.totalMs)}`
      + (o.attempts > (state.data?.cfg?.RAID_PITY ?? 150) * 0.9 ? ' (pity)' : '');
  }

  /** Drag a PC cell of the game's picker into one of its team slots. */
  async function applyToEventPicker(team) {
    const slots = $$('#evt-team .slot');
    if (!slots.length) return 0;
    const input = document.querySelector('#evt-search');
    let done = 0;
    for (let i = 0; i < Math.min(team.length, slots.length); i++) {
      const uid = team[i].mon.uid;
      const slot = $$('#evt-team .slot')[i];
      if (!slot) break;
      if (slot.dataset.uid === uid) { done++; continue; }        // already in that slot
      // already in the team -> drag its slot; otherwise pull it from the PC
      let cell = $$('#evt-team .slot').find(s => s.dataset.uid === uid)
        || document.querySelector(`#evt-pc .pc-cell[data-uid="${uid}"]`);
      if (!cell && input) {
        const mon = monByUid(readSave(), uid);
        input.value = mon ? displayName(mon.id) : '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(450);
        cell = document.querySelector(`#evt-pc .pc-cell[data-uid="${uid}"]`);
      }
      if (!cell) continue;
      dragToSlot(cell, slot);
      await sleep(600);
      done++;
    }
    if (input && input.value) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    return done;
  }

  /** Add my controls beside the game's own "Optimize" button, inside its team picker.
   *  Raids get the fastest-clear button + DPS badges; legend zones get the odds + team. */
  async function injectPickerUi() {
    const head = document.querySelector('#evt-pick-head');
    if (!head) return;
    if (!state.engine) { try { await ensureData(); } catch { return; } }
    if (!head.isConnected) return;
    const rc = raidContext();
    if (rc) {
      state.raidBoss = raidBoss(rc);
      mountRaidBox(head, rc);
      annotateRaidSuggestions();
      return;
    }
    const ctx = pickerContext();
    if (!ctx) return;
    mountLegendBox(head, ctx);
  }



  /** Put my controls in the game's Team/PC header: they optimise for the chapter being run. */
  /* ------------------------------------------------------------------ *
   * 9. UI
   * ------------------------------------------------------------------ */
  const state = {
    data: null, chart: null, chartSource: '', engine: null, learnAll: null,
    events: null, enemies: null, scored: null, team: null,
    preset: 'balanced', errors: [], busy: false, watcher: null, eligible: 0,
    apiCache: {}, info: {}, legends: null, legBoss: null, legTier: 0, legTeam: null, waiting: null,
    evtOdds: null, loading: null,
    league: false, leagueInfo: null, legOdds: null,
    segments: null, segOn: null, reuseAll: false, switching: false, selfClick: false, manual: null
  };

  const TYPE_COLORS = {
    normal: '#A8A77A', fire: '#EE8130', water: '#6390F0', electric: '#F7D02C', grass: '#7AC74C', ice: '#96D9D6',
    fighting: '#C22E28', poison: '#A33EA1', ground: '#E2BF65', flying: '#A98FF3', psychic: '#F95587', bug: '#A6B91A',
    rock: '#B6A136', ghost: '#735797', dragon: '#6F35FC', dark: '#705746', steel: '#B7B7CE', fairy: '#D685AD'
  };
  const typeColor = t => TYPE_COLORS[t] || '#888';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** Names in the language the game is running in (the bundle only ships the French ones). */
  function i18n() {
    const data = window.I18N_DATA || {};
    return Object.values(data)[0] || null;
  }
  /** The game ships an English pack even in other languages: use it for every name. */
  function englishData() {
    return (window.I18N_DATA || {}).en || null;
  }
  async function ensureEnglish() {
    if (englishData()) return true;
    const load = async url => {
      const code = await httpGet(url);
      const tag = document.createElement('script');
      tag.textContent = code;
      document.head.appendChild(tag);
      tag.remove();
      return url;
    };
    try {
      // the page may already carry the pack, else the boot manifest lists every language bundle
      const onPage = document.querySelector('script[src*="lang-en"]')?.src;
      if (onPage) await load(onPage);
      else {
        const base = bundleUrl() || location.href;
        const boot = await httpGet(new URL('/boot.js', base).href);
        const m = boot.match(/bundle\/(lang-en\.[0-9a-z]+\.js)/);
        if (!m) { log('warn', 'names: no English pack in the boot manifest'); return false; }
        await load(new URL('/bundle/' + m[1], base).href);
      }
      log('info', 'names: English pack loaded');
    } catch (e) { logError('names: English pack', e); }
    if (englishData()) { refreshUi(); return true; }
    return false;
  }
  function displayName(id) {
    const en = englishData()?.pokemon?.[id];
    const name = Array.isArray(en) ? en[0] : en;
    if (name) return name;
    const lang = i18n();
    const n = lang?.pokemon?.[id];
    return (Array.isArray(n) ? n[0] : n) || state.data?.species?.[id]?.name || ('#' + id);
  }
  function displayMove(key) {
    const en = englishData()?.moves?.[key];
    const name = Array.isArray(en) ? en[0] : en;
    if (name) return name;
    const lang = i18n();
    const n = lang?.moves?.[key];
    return (Array.isArray(n) ? n[0] : n) || state.data?.moves?.[key]?.name || key;
  }

  /** The game's own type badge (same markup as the rest of the UI). */
  const typeBadge = t => `<span class="type sm" data-type="${t}" style="--tc:${typeColor(t)};background:var(--tc)">${t}</span>`;

  function typeChips(enemies, data) {
    if (!enemies || !data) return '<span class="pcopt-mut">no data</span>';
    const counts = {};
    for (const e of enemies) {
      const types = data.species[e.id]?.types || [];
      const w = (KIND_WEIGHT[e.kind] || 1) * (e.weight || 1);
      for (const t of types) counts[t] = (counts[t] || 0) + w;
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
    return entries.map(([t, c]) => `${typeBadge(t)}<span class="pcopt-mut">${Math.round(c / total * 100)}%</span>`).join('');
  }

  function renderFails() {
    const fails = state.watcher?.fails || [];
    if (!fails.length) return '<div class="pcopt-mut">no wipe recorded yet</div>';
    return fails.map(f => {
      const foes = (f.enemies || []).map(e => `${displayName(e.id)} Lv${e.level}`).join(', ');
      return `<div class="pcopt-mon"><div><b>${esc(f.name)}</b> <span class="pcopt-mut">#${f.node} · ${esc(f.kind || '')}${f.why && f.why !== 'chapter' ? ' · ' + esc(f.why) : ''}${f.lv ? ' · Lv ' + f.lv.join('-') : ''}`
        + `${f.firstKo ? ` · 1st KO step ${f.firstKo.node}` : ''}</div><div class="pcopt-mut">${esc(foes)}</div></div>`
        + `<div class="pcopt-mut">${new Date(f.at).toLocaleTimeString()}</div></div>`;
    }).join('');
  }

  const legendZones = () => (state.legends?.zones || []);


  function legendZone() {
    const zones = legendZones().filter(z => z.region === state.legRegion);
    if (!zones.length) return null;
    const cur = zones.find(z => String(z.id) === String(state.legBoss)) || zones[0];
    state.legBoss = String(cur.id);
    return cur;
  }



  function legendInfo() {
    const zone = legendZone();
    if (!zone || !state.engine) return '';
    const save = readSave();
    const cands = save ? projectCandidates(state.engine, state.data, save, state.events?.cap ?? 100) : [];
    const boss = legendBoss(zone, state.legTier, cands, state.engine, state.data);
    if (!boss) return '';
    const dmg = cands.length ? Math.round(cands.reduce((a, c) => a + boss.damageTo(c.proj), 0) / cands.length) : 0;
    const mv = state.engine.bestMove(boss.mon, cands[0]?.proj.types || boss.types);
    return `${esc(displayName(zone.id))} · ${boss.types.join('/')} · ${Math.round(boss.hp).toLocaleString('en-US')} HP · ~${dmg} dmg/round`
      + (zone.burst ? ` · ${esc(displayMove(zone.burst))}` : '')
      + (state.legTier ? ` · elite ${state.legTier}` : '');
  }

  const fmtTime = ms => {
    if (!isFinite(ms) || ms <= 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 90) return s + 's';
    const m = s / 60;
    if (m < 90) return (Math.round(m * 10) / 10) + ' min';
    return (Math.round(m / 60 * 10) / 10) + ' h';
  };

  /** Victory chance, run time and the odds to catch the boss. */
  function legendOddsLine() {
    return oddsText(state.legOdds);
  }

  function renderLegendTeam() {
    const cap = state.events?.cap ?? state.data?.cfg?.MAX_LEVEL ?? 100;
    if (!state.legTeam) return '<div class="pcopt-mut">pick a boss and run the optimizer</div>';
    if (!state.legTeam.length) return '<div class="pcopt-mut">no candidate</div>';
    return state.legTeam.map((s, i) => {
      const sp = s.species;
      const lv = s.mon.level < s.proj.level ? `Lv${s.mon.level} → ${s.proj.level}` : `Lv${s.mon.level}`;
      const endForm = endFormAtCap(s.mon, cap);
      return `<div class="pcopt-mon"><div>${i + 1}. <b>${esc(displayName(sp.id))}</b> <span class="pcopt-mut">${lv}${s.proj.shiny ? ' ✨' : ''}</span>`
        + `<div class="pcopt-row">${sp.types.map(typeBadge).join('')}</div>`
        + `<div class="pcopt-mut">${s.hp} HP${s.proj.shiny ? ' · +10% stats' : ''}</div></div></div>`;
    }).join('');
  }

  /** The Defense / Offense / Balanced switch (same preset for both optimizers). */
  const presetSeg = () => `<div class="seg" data-presets>
    <button data-preset="defense" class="${state.preset === 'defense' ? 'on' : ''}">Defense</button>
    <button data-preset="offense" class="${state.preset === 'offense' ? 'on' : ''}">Offense</button>
    <button data-preset="balanced" class="${state.preset === 'balanced' ? 'on' : ''}">Balanced</button></div>`;

  function renderTeam() {
    const cap = state.events?.cap ?? state.data?.cfg?.MAX_LEVEL ?? 100;
    if (!state.team) return '<div class="pcopt-mut">run the optimizer to get a team</div>';
    if (!state.team.length) return '<div class="pcopt-mut">no candidate</div>';
    return state.team.map((s, i) => {
      const sp = s.species;
      const lv = s.mon.level < s.proj.level ? `Lv${s.mon.level} → ${s.proj.level}` : `Lv${s.mon.level}`;
      const endForm = endFormAtCap(s.mon, cap);
      return `<div class="pcopt-mon"><div>${i + 1}. <b>${esc(displayName(sp.id))}</b>${endForm && endForm !== sp.id ? ' → <b>' + esc(displayName(endForm)) + '</b>' : ''} <span class="pcopt-mut">${lv}${s.mon.shiny ? ' ✨' : ''}</span>`
        + `<div class="pcopt-row">${sp.types.map(typeBadge).join('')}</div>`
        + `<div class="pcopt-mut">${esc(s.bestMoveKey ? displayMove(s.bestMoveKey) : (s.bestMoveName || '—'))} · ${Math.round(s.avgDmg)} dmg · ${Math.round(s.avgRounds)} rounds${s.proj.shiny ? ' · +10% stats' : ''}</div>`
        + (s.hpCur != null && s.hpCur < s.hp ? `<div class="pcopt-mut">HP ${s.hpCur}/${s.hp}</div>` : '')
        + `<div class="pcopt-mut" data-info="${s.mon.uid}">${state.info[s.mon.uid] || ''}</div></div>`
        + `<div class="pcopt-row"><button class="btn small ghost" data-moves="${s.mon.uid}">moves</button><button class="btn small ghost" data-api="${s.mon.uid}">api</button></div></div>`;
    }).join('');
  }

  /* ---- segment teams: one team per stretch between Pokémon Centers ---- */
  /** Split the chapter plan at heal nodes (each segment starts from a healed team). */
  function segmentPlans(plan) {
    const segs = [];
    let cur = [];
    for (const step of plan) {
      if (step.kind === 'heal') {
        if (cur.length) segs.push({ plan: cur });
        cur = [];
        continue;
      }
      cur.push(step);
    }
    if (cur.length) segs.push({ plan: cur });
    return segs;
  }

  /** Prepare a team per segment and store it in the game's free team templates. */
  async function prepareSegments() {
    const save = readSave();
    if (!save?.adv || !state.data || !state.engine) return;
    const info = state.events && state.events.index != null ? state.events : chapterInfo(state.data, save.adv.chapter, save);
    if (!info) return;
    const segs = segmentPlans(chapterPlan(state.data, save));
    if (segs.length < 2) { state.errors = ['this chapter has a single segment — nothing to switch']; refreshUi(); return; }
    const slots = (save.teamSets?.list || []);
    const free = [];
    for (let i = 0; i < 5; i++) if (!slots[i] || !slots[i].length) free.push(i);
    // 'free all templates' lets the plan overwrite every template (the game has no delete)
    if (state.reuseAll) for (let i = 0; i < 5; i++) if (!free.includes(i)) free.push(i);
    if (!free.length) { state.errors = ['all team templates are used — use free all templates']; refreshUi(); return; }
    const count = Math.min(segs.length, free.length);
    state.busy = true; state.errors = []; refreshUi();
    log('info', 'segments: preparing', { segments: segs.length, prepared: count, slots: free.slice(0, count) });
    const out = [];
    try {
      if (!await gotoTeamScreen()) throw new Error('team screen not available');
      for (let i = 0; i < count; i++) {
        state.progress = { pct: (i + 0.15) / count, label: `segment ${i + 1}/${count}…` };
        updateProgress();
        const r = await searchChapterTeam(save, info, info.cap, Math.max(6000, Math.round(30000 / count)), segs[i].plan);
        if (r.error) { log('warn', 'segments: search failed', r.error); continue; }
        // pick the free template, then let applyTeam fill it (the game syncs the active set)
        // selfClick: the pick is the script's, not the player's — it must not shield the segment
        state.selfClick = true;
        try { document.querySelector(`#team-sets button[data-set="${free[i]}"]`)?.click(); }
        finally { state.selfClick = false; }
        await sleep(500);
        const applied = await applyTeam(r.team);
        await sleep(700);
        out.push({ slot: free[i], team: r.team.map(t => t.mon.uid), names: r.team.map(t => displayName(t.species.id)), res: r.res, applied: applied.done, battles: segs[i].plan.length });
        log('info', 'segments: prepared', { slot: free[i], team: r.team.map(t => displayName(t.species.id)), winRate: r.res && r.res.rate });
        state.progress = { pct: (i + 1) / count, label: `segment ${i + 1}/${count} ready` };
        updateProgress();
      }
    } catch (e) {
      logError('segments: prepare', e);
      state.errors = ['segments: ' + e.message];
    }
    state.segments = out.length ? { chapter: info.index, at: Date.now(), list: out, total: segs.length } : null;
    store.set('segments', state.segments);
    state.reuseAll = false; store.set('reuseTemplates', false);
    state.segOn = null; state.manual = null;
    state.busy = false; state.progress = null;
    refreshUi();
  }

  /** Free every template for the segment planner: the next prepare may overwrite all of them
   *  (the game itself has no delete, so this cannot empty them). */
  function freeTemplates() {
    if (state.busy) return;
    const save = readSave();
    const used = (save?.teamSets?.list || []).filter(x => x && x.length).length;
    if (used && !confirm(`The next 'prepare segments' will overwrite all ${used} filled team template(s). Continue?`)) return;
    state.segments = null; store.set('segments', null);
    state.reuseAll = true; store.set('reuseTemplates', true);
    state.segOn = null;
    log('info', 'templates: all reusable', { filled: used });
    refreshUi();
  }

  /** Manual template switch (Progress screen). The watcher leaves it alone until the next segment. */
  async function switchTemplate(slot) {
    if (state.busy) return;
    if (readSave()?.adv?.battle) { state.errors = ['a battle is running — switch after it ends']; refreshUi(); return; }
    let btn = document.querySelector(`#team-sets button[data-set="${slot}"]`);
    if (!btn) {
      if (!await gotoTeamScreen()) { state.errors = ['team screen not reachable']; refreshUi(); return; }
      await sleep(400);
      btn = document.querySelector(`#team-sets button[data-set="${slot}"]`);
    }
    if (!btn) { state.errors = ['team template ' + (slot + 1) + ' not found']; refreshUi(); return; }
    state.selfClick = true;
    btn.click();
    state.selfClick = false;
    const idx = segmentIndex(readSave());
    state.segOn = idx;
    state.manual = { idx, slot, at: Date.now() };
    log('info', 'templates: manual switch', { slot, segment: idx });
    refreshUi();
  }

  /** The current segment index of the running chapter (heal nodes split it). */
  function segmentIndex(save) {
    const adv = save?.adv;
    const nodes = adv?.nodes || [];
    if (!state.segments || adv?.chapter !== state.segments.chapter) return null;
    let idx = 0;
    for (let i = 0; i < Math.min(adv.node ?? 0, nodes.length); i++) if (nodes[i]?.type === 'heal') idx++;
    if (nodes[adv.node]?.type === 'heal') idx++;
    return idx;
  }

  /** Switch to the prepared template of the segment the run is in (never mid-battle). */
  async function switchSegment() {
    if (state.switching) return;
    const save = readSave();
    const idx = segmentIndex(save);
    if (idx == null || !state.segments?.list?.length) return;
    // a pick the player made by hand (the game's own buttons or this block) wins for its segment
    if (state.manual && state.manual.idx === idx) return;
    const target = state.segments.list[Math.min(idx, state.segments.list.length - 1)];
    if (!target) return;
    // the game reverts the template on a wipe, so keep re-asserting until the set really is active
    if (save.teamSets?.on === target.slot) { state.segOn = idx; return; }
    const btn = document.querySelector(`#team-sets button[data-set="${target.slot}"]`);
    if (!btn) return;
    state.switching = true;
    try {
      state.selfClick = true;
      btn.click();
      await sleep(400);
      state.selfClick = false;
      // the click can land on a button the game just re-rendered: only claim the segment once the set is active
      if (readSave()?.teamSets?.on !== target.slot) {
        log('warn', 'segments: switch did not take', { slot: target.slot, node: save.adv.node });
        return;
      }
      state.segOn = idx;
      log('info', 'segments: switched to template', { slot: target.slot, node: save.adv.node, segment: idx + 1 });
      refreshUi();
    } finally { state.switching = false; state.selfClick = false; }
  }

  /** The simulation progress bar: updated in place so the panel never flickers. */
  function updateProgress() {
    const bar = document.getElementById('pcopt-simbar');
    if (state.progress) {
      if (!bar) { refreshUi(); return; }
      bar.style.display = 'flex';
      const fill = bar.firstElementChild.firstElementChild;
      fill.style.width = Math.round((state.progress.pct || 0) * 100) + '%';
      bar.lastElementChild.textContent = state.progress.label || '';
    } else if (bar) bar.style.display = 'none';
  }

  /** What the mon becomes at the cap through level evolutions (display only). */
  function endFormAtCap(mon, cap) {
    let cur = mon.id;
    for (let hop = 0; hop < 4; hop++) {
      const next = (state.data.evo[cur] || []).find(e => e.level != null && e.level <= cap && state.data.species[e.to]);
      if (!next) break;
      cur = next.to;
    }
    return cur;
  }

  /* ------------------------------------------------------------------ *
   * 9b. UI — every block lives inside the game's own screens
   *     Progress: run monitor (chapter, events, wipes, status)
   *     Team/PC:  chapter optimizer + progress bar
   *     Pickers:  legendary optimizer / raid fastest clear
   * ------------------------------------------------------------------ */
  /** Shared styles for the injected blocks (the game's classes still do most of the work). */
  function ensureStyle() {
    if (document.getElementById('pcopt-style')) return;
    const st = document.createElement('style');
    st.id = 'pcopt-style';
    st.textContent = `
      .pcopt-block{margin:10px;padding:10px 14px;border-radius:12px;border:2px solid var(--line);
        background:color-mix(in srgb,var(--panel) 92%,transparent);color:var(--text)}
      #evt-pick-head .pcopt-block{flex:1 1 100%;margin:6px 0 0}
      .pcopt-block .pcopt-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .pcopt-block .pcopt-mut{color:var(--muted);font-size:13px;line-height:1.5}
      .pcopt-block .pcopt-mon{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
      .pcopt-block .pcopt-mon:last-child{border-bottom:0}
      .pcopt-block .pcopt-log{max-height:150px;overflow:auto}
      .pcopt-block .pcopt-err{color:var(--red)}
      .pcopt-block .btn.small{font-size:13px;padding:5px 10px}
      .pcopt-block .seg button{font-size:13px;padding:5px 9px}
      .pcopt-block select{font-size:13px;padding:4px 8px;max-width:100%}
      .pcopt-block .type.sm{font-size:11px}
      .pcopt-title{font-weight:700;font-size:15px;margin:0 0 6px;display:flex;justify-content:space-between;
        align-items:center;gap:8px;flex-wrap:wrap}
      .pcopt-title small{color:var(--muted);font-weight:400;font-size:11px}
    `;
    document.head.appendChild(st);
  }

  /** Create or reuse a block inside the host and rebuild it only when its signature changed. */
  function mountBlock(host, key, sig, html, bind, place = {}) {
    if (!host) return null;
    ensureStyle();
    let el = host.querySelector(`[data-pcopt="${key}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pcopt-block';
      el.dataset.pcopt = key;
      const before = place.before ? host.querySelector(place.before) : null;
      if (before) host.insertBefore(el, before);
      else if (place.prepend) host.prepend(el);
      else host.appendChild(el);
    }
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = html;
      bind(el);
    }
    return el;
  }

  const errLine = () => state.errors.length ? `<div class="pcopt-err">${state.errors.map(esc).join('<br>')}</div>` : '';
  const updateLine = () => state.update
    ? `<div class="pcopt-err">update ${esc(state.update.repo)} is on GitHub (installed ${esc(state.update.installed)}) — Tampermonkey → Check for updates</div>` : '';

  /** The Progress screen: what the game is doing right now, the wipes, the data status. */
  function mountMonitor() {
    const body = document.querySelector('#screen-map .map-body');
    if (!body) return;
    const save = readSave();
    const adv = save?.adv;
    const node = adv?.nodes?.[adv.node];
    const fails = state.watcher?.fails || [];
    const last = fails[0];
    const html = `
      <div class="pcopt-title"><span>Run monitor <small>v${VERSION}</small></span>
        <span class="pcopt-mut">${esc(state.events?.name || '')} · step ${adv?.node ?? '-'} / ${(adv?.nodes || []).length}</span></div>
      <div class="pcopt-mut">chapter ${adv?.chapter ?? '-'} · level cap ${state.events?.cap ?? '-'} · type chart: ${esc(state.chartSource || '-')}</div>
      <div class="pcopt-mut">data: ${state.data ? Object.keys(state.data.species).length + ' species · ' + (state.legends?.zones.length ?? 0) + ' legend zones' : 'not loaded'}
        · bundle ${esc((bundleUrl() || '').split('/').pop() || '-')}</div>
      ${state.leagueInfo ? `<div class="pcopt-mut">${esc(state.leagueInfo)}</div>` : ''}
      ${state.eligible ? `<div class="pcopt-mut">${state.eligible} Pokémon can join this team${save?.link ? ' (region link: ' + esc(save.link.to) + ')' : ''}</div>` : ''}
      ${state.waiting ? `<div class="pcopt-mut">${esc(state.waiting)}</div>` : ''}
      ${updateLine()}${errLine()}
      <div class="pcopt-title" style="margin-top:10px"><span>Chapter events</span>
        <span class="pcopt-mut">${state.enemies ? state.enemies.length + ' foes · ' + esc(node?.name || '') : ''}</span></div>
      ${last ? `<div class="pcopt-mut">last wipe: step ${last.node} · ${esc(last.name)} (${esc((last.enemies || []).map(e => displayName(e.id)).join(', '))})</div>` : ''}
      <div class="pcopt-row" style="margin:4px 0">${typeChips(state.enemies, state.data)}</div>
      <div class="pcopt-row">
        <button class="btn small ghost" data-act="watch">${state.watcher.running ? '● watching' : 'watch for wipes'}</button>
        <button class="btn small ghost" data-act="clear">clear log</button>
      </div>
      <div class="pcopt-log">${renderFails()}</div>`;
    const sig = JSON.stringify([adv?.chapter, adv?.node, node?.name, state.enemies?.length, fails.length, state.watcher.running,
      state.eligible, state.chartSource, state.errors, state.update?.repo, state.leagueInfo, state.waiting]);
    mountBlock(body, 'monitor', sig, html, el => {
      el.querySelector('[data-act="watch"]').onclick = () => {
        if (state.watcher.running) state.watcher.stop(); else state.watcher.start();
        refreshUi();
      };
      el.querySelector('[data-act="clear"]').onclick = () => { state.watcher.clear(); refreshUi(); };
    }, { prepend: true });
  }

  /** The Progress screen: the game's team templates, for a manual switch under the timeline. */
  function mountTemplates() {
    const host = document.querySelector('#screen-map .mp-list');
    if (!host) return;
    const save = readSave();
    const sets = save?.teamSets;
    if (!sets || !Array.isArray(sets.list)) return;
    const plan = state.segments && state.segments.chapter === save.adv?.chapter ? state.segments : null;
    const segOf = slot => plan ? plan.list.findIndex(x => x.slot === slot) : -1;
    const rows = [0, 1, 2, 3, 4].map(i => {
      const uids = sets.list[i] || [];
      const names = uids.map(u => monByUid(save, u)).filter(Boolean).map(m => displayName(m.id));
      const seg = segOf(i);
      const active = sets.on === i;
      const label = '#' + (i + 1) + (seg >= 0 ? ' · segment ' + (seg + 1) : '') + ' · ' + (names.length ? names.join(', ') : 'free');
      return `<div class="pcopt-row" style="justify-content:space-between;gap:8px;border-bottom:1px solid var(--line);padding:4px 0">`
        + `<span class="pcopt-mut" style="flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span>`
        + `<button class="btn small ${active ? '' : 'ghost'}" data-switch="${i}" ${active || !names.length ? 'disabled' : ''}>${active ? 'active' : 'use'}</button></div>`;
    }).join('');
    const cur = plan ? segmentIndex(save) : null;
    const html = `
      <div class="pcopt-title" style="margin-top:10px"><span>Team templates</span>
        <span class="pcopt-mut">${sets.on != null ? '#' + (sets.on + 1) + ' active' : 'none active'}${cur != null ? ' · segment ' + (cur + 1) + '/' + plan.total : ''}</span></div>
      ${rows}
      <div class="pcopt-mut">${plan ? `segment plan for chapter ${plan.chapter} — the watcher switches at each Pokémon Center` : 'no segment plan for this chapter — prepare it in Team/PC'}</div>
      ${state.reuseAll ? '<div class="pcopt-mut">all templates freed for the next prepare</div>' : ''}
      ${errLine()}`;
    const sig = JSON.stringify([sets.on, (sets.list || []).map(x => x && x.length), (sets.list || []).map(x => (x || []).join('.')),
      plan && plan.chapter, plan && plan.list.map(x => x.slot), cur, state.reuseAll, state.errors, state.busy]);
    mountBlock(host, 'templates', sig, html, el => {
      el.querySelectorAll('[data-switch]').forEach(b => b.onclick = () => switchTemplate(+b.dataset.switch));
    });
  }

  /** The Team/PC screen: the chapter optimizer with its progress bar and the current team. */
  function mountChapter() {
    const host = document.querySelector('#screen-team');
    if (!host || !state.data) return;
    const cap = state.events?.cap ?? state.data.cfg?.MAX_LEVEL ?? 100;
    const sim = state.sim;
    const html = `
      <div class="pcopt-title"><span>Chapter optimizer <small>v${VERSION}</small></span>
        <span class="pcopt-mut">${state.events ? 'chapter ' + state.events.index + ' · ' + esc(state.events.name) + ' · cap ' + cap : ''}</span></div>
      ${sim ? `<div class="pcopt-mut">chapter sim: win ${Math.round(sim.rate * 100)}% · clears ${sim.avgCleared}/${sim.battles} battles · ${sim.evaluated} teams in ${(sim.ms / 1000).toFixed(1)}s${Object.keys(sim.wipeAt || {}).length ? ' · wipe at step ' + Object.entries(sim.wipeAt).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([i, n]) => '#' + i + '×' + n).join(', ') : ''}</div>` : ''}
      <div class="pcopt-row" style="margin-top:6px">
        ${presetSeg()}
        <button class="btn small" data-act="run" ${state.busy ? 'disabled' : ''}>${state.busy ? 'working…' : 'simulate'}</button>
        <div id="pcopt-simbar" style="display:none;flex:1 1 160px;align-items:center;gap:6px"><div style="flex:1;height:10px;border-radius:5px;background:var(--line);overflow:hidden"><div style="height:100%;width:0%;background:var(--c);transition:width .15s"></div></div><span class="pcopt-mut" style="font-size:11px;white-space:nowrap"></span></div>
        <button class="btn small ghost" data-act="apply" ${state.team && state.team.length && !state.busy ? '' : 'disabled'}>apply to team</button>
        <button class="btn small ghost" data-act="segments" ${state.busy ? 'disabled' : ''}>prepare segments</button>
        <button class="btn small ghost" data-act="free" ${state.busy ? 'disabled' : ''}>free all templates</button>
      </div>
      ${state.segments ? `<div class="pcopt-mut">segments: ${state.segments.list.map((s, i) => '#' + (s.slot + 1) + ' ' + esc(s.names.join(', ').slice(0, 60))).join(' · ')}${state.segments.total > state.segments.list.length ? ' · ' + (state.segments.total - state.segments.list.length) + ' over the limit — use free all templates' : ''}</div>` : ''}
      ${state.reuseAll ? `<div class="pcopt-mut">all templates freed — the next prepare overwrites them</div>` : ''}
      <div data-team>${renderTeam()}</div>
      ${state.waiting ? `<div class="pcopt-mut">${esc(state.waiting)}</div>` : ''}
      ${errLine()}`;
    const sig = JSON.stringify([state.preset, state.busy, state.team && state.team.map(t => t.mon.uid + ':' + t.hpCur).join(','),
      sim && [sim.rate, sim.avgCleared, sim.evaluated, sim.ms], state.errors, state.waiting, state.events?.index, cap,
      state.segments && state.segments.list.map(s => s.slot + ':' + s.names.join('/')).join(','), state.segments && state.segments.total, state.reuseAll]);
    mountBlock(host, 'chapter', sig, html, el => {
      el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
        state.preset = b.dataset.preset;
        el.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('on', x.dataset.preset === state.preset));
        refreshUi();
      });
      el.querySelector('[data-act="run"]').onclick = () => runOptimizer();
      el.querySelector('[data-act="apply"]').onclick = () => applyTeamFromPanel();
      el.querySelector('[data-act="segments"]').onclick = () => prepareSegments();
      el.querySelector('[data-act="free"]').onclick = () => freeTemplates();
      el.querySelectorAll('[data-moves]').forEach(b => b.onclick = () => {
        b.textContent = '…';
        showMovesPanel(b.dataset.moves).then(() => { b.textContent = 'moves'; });
      });
      el.querySelectorAll('[data-api]').forEach(b => b.onclick = () => {
        const uid = b.dataset.api;
        const info = el.querySelector(`[data-info="${uid}"]`);
        if (info) info.textContent = 'asking PokéAPI…';
        compareWithPokeApi(uid, info);
      });
    }, { before: '.pc-sticky' });
  }

  /** The legendary team picker: boss info, odds, the team it computed. */
  function mountLegendBox(head, ctx) {
    state.legBoss = ctx.zone.id;
    state.legTier = ctx.tier;
    state.legRegion = ctx.zone.region;
    const key = 'legend:' + ctx.zone.id + ':' + ctx.tier;
    const html = `
      <div class="pcopt-row" style="margin-top:6px">
        ${presetSeg()}
        <button class="btn small" data-act="run" ${state.busy ? 'disabled' : ''}>✨ Optimize (mine)</button>
        <button class="btn small ghost" data-act="apply" ${state.legTeam && state.legTeam.length && !state.busy ? '' : 'disabled'}>apply to team</button>
      </div>
      <div class="pcopt-mut">${legendInfo()}</div>
      <div class="pcopt-mut">${legendOddsLine()}</div>
      <div data-team>${renderLegendTeam()}</div>
      ${errLine()}`;
    const sig = JSON.stringify([key, state.preset, state.busy,
      state.legTeam && state.legTeam.map(t => t.mon.uid).join(','),
      state.legOdds && [state.legOdds.winChance, state.legOdds.rounds, state.legOdds.pCatch, state.legOdds.attempts],
      state.errors]);
    mountBlock(head, 'legend', sig, html, el => {
      el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
        state.preset = b.dataset.preset;
        el.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('on', x.dataset.preset === state.preset));
        refreshUi();
      });
      el.querySelector('[data-act="run"]').onclick = () => runLegendOptimizer();
      el.querySelector('[data-act="apply"]').onclick = () => applyTeamFromPanel(state.legTeam);
    });
  }

  /** The raid picker: fastest clear and the total DPS line. */
  function mountRaidBox(head, rc) {
    const boss = state.raidBoss;
    const key = 'raid:' + rc.id;
    const saved = state.evtOdds?.key === key ? state.evtOdds.text : '';
    const html = `
      <div class="pcopt-row" style="margin-top:6px">
        <button class="btn small" data-act="run">⚡ Fastest clear</button>
        <span class="pcopt-mut" data-info>${esc(saved)}</span>
      </div>
      <div class="pcopt-mut">${esc(displayName(rc.id))} · ${boss ? boss.maxHp.toLocaleString('en-US') + ' HP' : ''} · ${esc((state.data.species[rc.id]?.types || []).join('/'))}</div>
      ${errLine()}`;
    const sig = JSON.stringify([key, state.busy, saved, state.errors]);
    mountBlock(head, 'raid', sig, html, el => {
      el.querySelector('[data-act="run"]').onclick = async () => {
        const btn = el.querySelector('[data-act="run"]');
        const info = el.querySelector('[data-info]');
        btn.disabled = true;
        info.textContent = 'working…';
        log('info', 'raid ui: fastest clear clicked', { boss: displayName(rc.id) });
        try {
          await fastestClear(rc);
          info.textContent = state.evtOdds?.key === key ? state.evtOdds.text : '';
          refreshUi();
        } catch (e) {
          logError('raid: fastest clear', e);
          info.textContent = 'error: ' + e.message;
        }
        btn.disabled = false;
      };
    });
  }

  /** Remove the floating panel and the old quick-optimize rows a previous version left behind. */
  function cleanupLegacy() {
    document.getElementById('pcopt-panel')?.remove();
    document.getElementById('pcopt-team-ui')?.remove();
    const oldRow = document.getElementById('pcopt-evt');
    if (oldRow && !oldRow.closest('[data-pcopt]')) oldRow.remove();
    document.querySelectorAll('#evt-pick-head .pcopt-row:not(.pcopt-block):not([data-pcopt])').forEach(el => {
      if (!el.closest('[data-pcopt]')) el.remove();
    });
  }

  /** Refresh every block that is currently on screen (cheap: signature-guarded). */
  function refreshUi() {
    try {
      cleanupLegacy();
      mountMonitor();
      mountTemplates();
      mountChapter();
      if (document.querySelector('#evt-pick-head')) injectPickerUi().catch(e => logError('picker ui: inject', e));
      else state.raidBoss = null;
    } catch (e) { logError('ui: refresh', e); }
  }

  /* ------------------------------------------------------------------ *
   * 10. Boot + actions
   * ------------------------------------------------------------------ */
  const dataLooksValid = d => !!d && d.species && Object.keys(d.species).length > 100
    && d.moves && Object.keys(d.moves).length > 50
    && Array.isArray(d.chapters) && d.chapters.length > 10;

  async function ensureData() {
    if (state.engine) return;
    if (state.loading) return state.loading;      // one fetch, however many callers
    state.loading = (async () => {
      const url = bundleUrl();
      if (!url) { state.errors = ['game bundle not loaded yet']; log('warn', 'data: the game bundle is not on the page yet'); return; }
      const cacheKey = 'bundle:v10:' + url;
      let data = store.get(cacheKey, null);
      if (data && !dataLooksValid(data)) {
        log('warn', 'data: the cached tables are invalid, parsing the bundle again');
        data = null;
      } else if (data) {
        log('info', 'data: cache hit', url.split('/').pop());
      }
      if (!data) {
        state.busy = true; refreshUi();
        try {
          data = await parseBundle(url);
          store.set(cacheKey, data);
          log('info', 'data: tables cached', url.split('/').pop());
        } catch (e) {
          logError('data: bundle parse failed', e);
          state.errors = ['bundle parse failed: ' + e.message];
          return;
        } finally {
          state.busy = false;
        }
      }
      state.data = data;
      try {
        state.learnAll = buildLearnAll(data);
      } catch (e) {
        logError('data: learnsets', e);
        state.learnAll = null;
        state.errors = state.errors.concat(['learnset error: ' + e.message]);
      }
      state.errors = state.errors.filter(e => !e.startsWith('bundle'));
      if (data.legends) state.legends = data.legends;
      else if (!state.legends) state.errors = state.errors.concat(['legend zones not found in the bundle']);

      if (!state.chart) {
        const cachedChart = store.get('chart', null);
        if (cachedChart) {
          state.chart = cachedChart.chart; state.chartSource = cachedChart.source;
          log('info', 'data: type chart from cache', state.chartSource);
        } else {
          try {
            state.chart = parsePokemonDbChart(await httpGet('https://pokemondb.net/type'));
            state.chartSource = 'pokemondb.net';
          } catch (e1) {
            log('warn', 'data: pokemondb type chart failed, trying PokeAPI', e1.message);
            try {
              state.chart = await chartFromPokeApi();
              state.chartSource = 'pokeapi.co';
            } catch (e2) {
              log('warn', 'data: PokeAPI type chart failed, using the game chart', e2.message);
              state.chart = data.chart;
              state.chartSource = 'game';
            }
          }
          store.set('chart', { chart: state.chart, source: state.chartSource });
          log('info', 'data: type chart loaded', state.chartSource);
        }
      }
      state.engine = makeEngine(data, state.chart, state.learnAll);
      log('info', 'data: engine ready', {
        species: Object.keys(data.species).length, legends: data.legends?.zones?.length ?? 0,
        chart: state.chartSource,
      });
      refreshChapter();
    })();
    try { await state.loading; } finally { state.loading = null; }
  }

  /** Read the current chapter events (foes, types, cap) without running the full optimizer. */
  function refreshChapter() {
    const save = readSave();
    if (!save || !save.adv || !state.data) return;
    const info = chapterInfo(state.data, save.adv.chapter, save);
    if (!info) return;
    state.events = info;
    const league = leagueChapters(state.data, info.index);
    state.league = league.length > 0;
    state.leagueInfo = league.length
      ? `League: ${league.map(i => (state.data.chapters[i].steps.find(st => st.kind === 'gym')?.leader) || '?').join(' → ')} · a wipe rewinds to the first`
      : null;
    state.enemies = chapterEnemies(state.data, info, save.adv.nodes).map(e => {
      const types = state.data.species[e.id]?.types || [];
      const proj = { id: e.id, level: e.level, types };
      return { ...e, proj, types, hp: state.engine ? state.engine.maxHp(proj) : 0 };
    });
    const away = awayUids(save);
    state.eligible = save.mons.filter(m => !away.has(m.uid) && state.data.species[m.id] && canJoinTeam(save, m)).length;
  }

  /** Search the chapter's best team by Monte-Carlo simulation of the whole run. */
  async function searchChapterTeam(save, info, cap, budgetMs, planOverride = null) {
    const plan = planOverride || chapterPlan(state.data, save);
    if (!plan.some(p => p.kind === 'battle')) return { error: 'no battles in this chapter' };
    const away = awayUids(save);
    const cands = projectCandidates(state.engine, state.data, save, cap, { branches: false });
    if (!cands.length) return { error: 'no candidate found in the PC' };
    // quick individual ranking to build the search pool
    const foes = chapterEnemies(state.data, info, save.adv.nodes);
    const scored = scoreCandidates(state.engine, state.data, foes, cands, cap, state.league);
    const preset = state.preset;
    scored.sort((a, b) => scoreFor(b, preset) - scoreFor(a, preset));
    const pool = scored.slice(0, 26);
    const byUid = new Map(pool.map(c => [c.mon.uid, c]));
    const evalTeam = async (team, runs) => {
      const res = simulateChapter(team, plan, cap, runs);
      await sleep(0);
      return res;
    };
    const key = team => team.map(c => c.mon.uid).sort().join('|');
    const score = res => (res.rate * 1e6) + res.avgCleared * 10;
    const deadline = Date.now() + budgetMs;
    log('debug', 'search: start', { budgetMs, cands: pool.length, planBattles: plan.filter(p => p.kind === 'battle').length });
    // seed: greedy by individual score
    const distinct = team => team.every((c, i) => team.findIndex(x => x.mon.uid === c.mon.uid) === i)
      && team.every((c, i) => team.findIndex(x => x.species.id === c.species.id) === i);
    let best = [];
    for (const c of pool) {
      if (best.length >= 6) break;
      if (best.some(x => x.mon.uid === c.mon.uid || x.species.id === c.species.id)) continue;
      best.push(c);
    }
    let bestRes = await evalTeam(best.map(c => byUid.get(c.mon.uid)), 12);
    let evaluated = 1;
    // hill climb: swap one slot at a time
    const tryTeams = [];
    while (Date.now() < deadline) {
      let improved = false;
      for (let slot = 0; slot < best.length && Date.now() < deadline; slot++) {
        for (const cand of pool) {
          if (Date.now() >= deadline) break;
          if (best.some(x => x.mon.uid === cand.mon.uid)) continue;
          const trial = best.slice();
          trial[slot] = cand;
          if (tryTeams.includes(key(trial)) || !distinct(trial)) continue;
          tryTeams.push(key(trial));
          const res = await evalTeam(trial, 10);
          evaluated++;
          if (score(res) > score(bestRes) + 1e-9) { best = trial; bestRes = res; improved = true; }
          state.progress = { pct: Math.min(.98, (Date.now() - (deadline - budgetMs)) / budgetMs), label: `simulating ${evaluated} teams…` };
          updateProgress();
        }
      }
      if (!improved) break;
    }
    // final: the top few by re-evaluation with more runs
    const finalRounds = Math.max(30, Math.floor((budgetMs / 2) / 40));
    const finalists = [best];
    for (let slot = 0; slot < best.length; slot++) {
      for (const cand of pool) {
        if (finalists.length >= 4) break;
        const trial = best.slice(); trial[slot] = cand;
        if (finalists.some(f => key(f) === key(trial)) || !distinct(trial)) continue;
        finalists.push(trial);
      }
    }
    let winner = best, winnerRes = bestRes;
    for (const t of finalists) {
      if (Date.now() > deadline + budgetMs / 3) break;
      const res = await evalTeam(t, finalRounds);
      evaluated++;
      if (score(res) > score(winnerRes)) { winner = t; winnerRes = res; }
      state.progress = { pct: Math.min(.99, .8 + .2 * evaluated / (finalists.length + 1)), label: 'final check…' };
      updateProgress();
    }
    log('debug', 'search: done', { evaluated, ms: Date.now() - (deadline - budgetMs), rate: winnerRes.rate, cleared: winnerRes.avgCleared });
    return { team: winner, res: winnerRes, plan, evaluated };
  }

  async function runOptimizer() {
    state.busy = true; state.errors = []; refreshUi();
    log('info', 'optimizer: start', { preset: state.preset });
    try {
      await ensureData();
      if (!state.data) { state.busy = false; refreshUi(); return; }
      const save = readSave();
      if (!save) { state.errors = ['no save found']; state.busy = false; refreshUi(); return; }
      const info = chapterInfo(state.data, save.adv.chapter, save);
      if (!info) { state.errors = ['chapter not found']; state.busy = false; refreshUi(); return; }
      state.events = info;
      const league = leagueChapters(state.data, info.index);
      state.league = league.length > 0;
      state.leagueInfo = league.length
        ? `League: ${league.map(i => (state.data.chapters[i].steps.find(st => st.kind === 'gym')?.leader) || '?').join(' → ')} · a wipe rewinds to the first`
        : null;
      state.enemies = chapterEnemies(state.data, info, save.adv.nodes).map(e => {
        const types = state.data.species[e.id]?.types || [];
        const proj = { id: e.id, level: e.level, types };
        return { ...e, proj, types, hp: state.engine.maxHp(proj) };
      });
      const started = Date.now();
      const out = await searchChapterTeam(save, info, info.cap, 15000);
      state.progress = null;
      if (out.error) { state.errors = [out.error]; state.busy = false; refreshUi(); return; }
      state.team = out.team;
      state.sim = { rate: out.res.rate, avgCleared: out.res.avgCleared, battles: out.res.totalBattles, wipeAt: out.res.wipeAt, ms: Date.now() - started, evaluated: out.evaluated };
      log('info', 'optimizer: done', {
        chapter: info.index, name: info.name, cap: info.cap, league: state.league,
        winRate: +(out.res.rate * 100).toFixed(1) + '%', cleared: out.res.avgCleared,
        of: out.res.totalBattles, evaluated: out.evaluated, ms: state.sim.ms,
        team: state.team.map(t => displayName(t.species.id)),
      });
    } catch (e) {
      logError('optimizer: failed', e);
      state.errors = ['optimizer error: ' + e.message];
    }
    state.progress = null;
    state.busy = false;
    refreshUi();
  }

  /** Compare the game learnset with the canonical PokéAPI one (the game is freer). */
  async function compareWithPokeApi(uid, info) {
    const save = readSave();
    const mon = save && monByUid(save, uid);
    if (!mon) return;
    const name = displayName(mon.id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    try {
      const api = await pokeApiSpecies(name);
      const game = (state.learnAll?.learnAll?.[mon.id] || []).filter(([lv]) => lv <= (state.events?.cap ?? 100));
      const apiKeys = new Set(api.learn.map(l => l.key));
      const extra = game.filter(([, key]) => !apiKeys.has(key)).map(([lv, key]) => displayMove(key) + '@' + lv);
      const same = api.types.length === (state.data.species[mon.id]?.types.length)
        && api.types.every(t => (state.data.species[mon.id]?.types || []).includes(t));
      if (info) {
        info.innerHTML = `PokéAPI: ${api.types.join('/')}${same ? '' : ' (game: ' + (state.data.species[mon.id]?.types.join('/')) + ')'}`
          + (extra.length ? `<br>${extra.length} extra moves in game: ${extra.slice(0, 6).join(', ')}${extra.length > 6 ? '…' : ''}` : '<br>same learnset');
        state.info[uid] = info.innerHTML;
      }
    } catch (e) {
      if (info) { info.textContent = 'PokéAPI: ' + e.message; state.info[uid] = info.textContent; }
    }
  }

  async function runLegendOptimizer() {
    state.busy = true; state.errors = []; refreshUi();
    log('info', 'legend optimizer: start', { region: state.legRegion, boss: state.legBoss, tier: state.legTier });
    try {
      await ensureData();
      const zone = legendZone();
      if (!zone) { state.errors = ['no boss zone']; state.busy = false; refreshUi(); return; }
      const save = readSave();
      if (!save) { state.errors = ['no save found']; state.busy = false; refreshUi(); return; }
      // the game brings the team to the zone's level (max level for an elite tier) and heals it
      const zoneLevel = state.legTier ? state.data.cfg.MAX_LEVEL : (zone.level ?? state.data.cfg.MAX_LEVEL);
      const cands = projectCandidates(state.engine, state.data, save, zoneLevel)
        .map(c => ({ ...c, hpCur: c.hp }));
      state.legTeam = pickLegendTeam(cands, zone, state.legTier, state.engine, state.data);
      state.legOdds = state.legTeam.length
        ? legendOdds(zone, state.legTier, state.legTeam, state.engine, state.data, save)
        : null;
      if (!state.legTeam.length) state.errors = ['no candidate found in the PC'];
      log('info', 'legend optimizer: done', {
        boss: displayName(zone.id), tier: state.legTier, level: zoneLevel,
        team: state.legTeam.map(t => displayName(t.species.id)),
        odds: state.legOdds && { win: state.legOdds.winChance, rounds: state.legOdds.rounds, catch: state.legOdds.pCatch },
      });
    } catch (e) {
      logError('legend optimizer: failed', e);
      state.errors = ['legend optimizer error: ' + e.message];
    }
    state.busy = false;
    refreshUi();
  }

  async function applyTeamFromPanel(team) {
    team = team || state.team;
    if (!team || !team.length) return;
    state.busy = true; refreshUi();
    log('info', 'panel: apply team', { mons: team.length });
    const res = await applyTeam(team);
    state.busy = false;
    state.waiting = null;
    if (!res.ok) { log('error', 'panel: apply failed', res.error); state.errors = ['apply failed: ' + res.error]; }
    refreshUi();
  }

  function boot() {
    log('info', 'boot', { version: VERSION, bundle: bundleUrl()?.split('/').pop() || null });
    // a prepared segment plan survives a reload (the templates live in the save)
    state.segments = store.get('segments', null);
    if (state.segments && !Array.isArray(state.segments.list)) state.segments = null;
    state.reuseAll = store.get('reuseTemplates', false) === true;
    // a previous version's floating panel / quick rows: gone, the blocks replace them
    cleanupLegacy();
    ensureEnglish().catch(e => logError('names: English pack', e));
    checkUpdate().catch(e => logError('update: check', e));
    // the game's own team picker (legend zones, raids, elite league): put my controls beside its Optimize button
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try { refreshUi(); } catch (e) { logError('ui: observer', e); }
      });
    }).observe(document.body, { childList: true, subtree: true });
    // a template picked in the game's own bar is the player's choice: the watcher leaves that segment alone
    document.addEventListener('click', e => {
      const b = e.target.closest?.('#team-sets button[data-set]');
      if (!b || state.selfClick) return;
      state.manual = { idx: segmentIndex(readSave()), slot: +b.dataset.set, at: Date.now() };
      log('info', 'templates: manual pick in the game', { slot: +b.dataset.set });
    }, true);
    state.watcher = new WipeWatcher(rec => {
      refreshUi();
      if (rec) {
        // the team fell on this step: rebuild an optimal team for the chapter
        runOptimizer();
      }
    });
    refreshUi();
    ensureData().then(() => {
      refreshUi();
      log('info', 'boot: ready', {
        species: state.data ? Object.keys(state.data.species).length : 0,
        legends: state.legends?.zones?.length ?? 0,
        errors: state.errors,
      });
    }).catch(e => logError('boot: data', e));
    // segment teams: switch the prepared template when the run reaches a Pokémon Center
    setInterval(() => { try { switchSegment(); } catch (e) { logError('segments: switch', e); } }, 700);
    // the game keeps playing in the background: keep the panel in sync
    setInterval(() => {
      if (state.busy) return;
      try { refreshChapter(); refreshUi(); } catch (e) { logError('ui: refresh', e); }
    }, 5000);
  }

  const start = () => { try { boot(); } catch (e) { logError('boot', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // exposed for tests / manual checks
  window.__pcopt = {
    state, ensureData, runOptimizer, parsePokemonDbChart, buildLearnAll, makeEngine,
    chapterEnemies, chapterInfo, readSave, scoreCandidates, pickTeam, scoreFor,
    WipeWatcher, applyTeam, bundleUrl, httpGet, canJoinTeam, showMovesPanel, pokeApiSpecies, compareWithPokeApi,
    parseLegends, legendBoss, simulateLegend, pickLegendTeam, evaluateLegendTeam, runLegendOptimizer,
    legendFightOnce, legendOdds, logs,
    projectCandidates, evolvedBranches, refreshChapter,
    chapterPlan, segmentPlans, prepareSegments, switchSegment, freeTemplates, switchTemplate, simulateChapter, searchChapterTeam, rollBattleFoes, simBattle, simAct, simOhko, simGeneric, autoScore, ensureEnglish,
    raidDps, raidBoss, annotateRaidSuggestions
  };
})();
