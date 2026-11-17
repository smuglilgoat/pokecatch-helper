// ==UserScript==
// @name         Poke'Catch Team Optimizer
// @namespace    pokecatch-helper
// @version      1.1.0
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
    for (const s of dex) species[s.id] = { id: s.id, name: s.name, types: s.types, stats: s.stats, learn: s.learn, captureRate: s.captureRate, legendary: s.legendary, mythical: s.mythical };

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
        ACC_CURVE: cfg.ACC_CURVE || [40, 150, 80],
        TEAM_SIZE: cfg.TEAM_SIZE, MAX_LEVEL: cfg.MAX_LEVEL, LEAGUE_CAP_MARGIN: cfg.LEAGUE_CAP_MARGIN,
        LEAGUE_DONE_CAP: cfg.LEAGUE_DONE_CAP, LEVEL_CAP_MARGIN: cfg.LEVEL_CAP_MARGIN,
        LEAGUE_BELOW: cfg.LEAGUE_TRAINERS?.below || [6, 5, 4, 3],
        LEGEND_ZONE: cfg.LEGEND_ZONE, ELITE: cfg.ELITE, RANK_STAT: cfg.UNDERGROUND?.RANK_STAT ?? 1,
        CAPTURE_BONUS: cfg.CAPTURE_BONUS, CAPTURE_MAX: cfg.CAPTURE_MAX,
        LEGENDARY_CAPTURE_RATE: cfg.LEGENDARY_CAPTURE_RATE,
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

  /** The level the player may reach right now (the game's levelCap). */
  function levelCap(data, adv) {
    const max = data.cfg.MAX_LEVEL;
    let m = 0;
    const open = new Set(['kanto', ...(adv?.travel?.to || [])]);
    for (const region of data.regions) {
      if (!region || !region.ace || !region.key || !open.has(region.key)) continue;
      const next = nextGymOf(data, region.key, adv);
      if (next != null) return Math.min(max, capOf(data, next));
      for (const ch of chaptersOf(data, region.key)) if (aceOf(data, ch) != null) m = Math.max(m, capOf(data, ch));
    }
    return Math.min(max, m ? Math.max(m, data.cfg.LEAGUE_DONE_CAP ?? 100) : max);
  }

  function chapterInfo(data, chapterIndex, adv) {
    const ch = data.chapters[chapterIndex];
    if (!ch) return null;
    return {
      index: chapterIndex, name: ch.name, region: ch.reg || 'kanto', ace: aceOf(data, chapterIndex), steps: ch.steps,
      cap: levelCap(data, adv)
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
      } else if (node.type === 'wild' && node.areas) {
        const pool = new Map();
        for (const area of node.areas) {
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
            weight: Math.max(0.2, p.w / 10), kind: 'wild', source: node.name,
            hpMult: 1, damageMult: cfg.ENEMY_DAMAGE.wild ?? 1
          });
        }
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

  /** The Pokémon that may join the team, projected at the chapter cap. */
  function projectCandidates(eng, data, save, level) {
    const away = awayUids(save);
    const cands = save.mons.filter(m => !away.has(m.uid) && data.species[m.id] && canJoinTeam(save, m));
    return cands.map(c => {
      const sp = data.species[c.id];
      const base = { id: c.id, shiny: c.shiny, status: c.status, types: sp.types };
      const proj = { ...base, level };
      const hp = eng.maxHp(proj);
      // the team keeps its HP between fights: use what is left, like the game does
      const hpCur = c.hp != null ? Math.min(c.hp, hp) : hp;
      return { mon: c, base, proj, species: sp, hp, hpCur };
    });
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
      const sp = data.species[cand.id];
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
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (chosen.includes(cand)) continue;
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
      if (best.mon.shiny) usedShiny.add(best.species.id);
    }
    return chosen;
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
    while (chosen.length < size) {
      let best = null, bestScore = -Infinity;
      for (const cand of pool) {
        if (chosen.includes(cand)) continue;
        if (!cand.proj.shiny && usedSpecies.has(cand.species.id)) continue;
        if (cand.proj.shiny && usedShiny.has(cand.species.id)) continue;
        const sc = evaluateLegendTeam(chosen.concat([cand]), zone, tier, eng, data);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      if (!best) break;
      chosen.push(best);
      usedSpecies.add(best.species.id);
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

  /** Add my controls beside the game's own "Optimize" button, inside its team picker. */
  async function injectPickerUi() {
    const head = document.querySelector('#evt-pick-head');
    if (!head || head.querySelector('#pcopt-evt')) return;
    if (!state.engine) { try { await ensureData(); } catch { return; } }
    if (!head.isConnected || head.querySelector('#pcopt-evt')) return;
    const ctx = pickerContext();
    if (!ctx) return;
    const box = document.createElement('div');
    box.id = 'pcopt-evt';
    box.className = 'pcopt-row';
    box.style.marginLeft = '8px';
    const ctxKey = 'zone:' + ctx.zone.id + ':' + ctx.tier;
    const saved = state.evtOdds && state.evtOdds.key === ctxKey ? state.evtOdds.text : '';
    box.innerHTML = `${presetSeg()}
      <button class="btn small" id="pcopt-evt-run">✨ Optimize (mine)</button>
      <span class="pcopt-mut" id="pcopt-evt-info">${esc(saved)}</span>`;
    head.appendChild(box);
    log('info', 'picker ui: injected', { boss: displayName(ctx.zone.id), tier: ctx.tier });
    box.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      state.preset = b.dataset.preset;
      box.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('on', x.dataset.preset === state.preset));
      log('info', 'picker ui: preset', state.preset);
    });
    const run = async () => {
      const btn = box.querySelector('#pcopt-evt-run');
      const info = box.querySelector('#pcopt-evt-info');
      btn.disabled = true;
      info.textContent = 'working…';
      log('info', 'picker ui: optimize clicked', { boss: displayName(ctx.zone.id), tier: ctx.tier });
      try {
        await ensureData();
        const { zone, tier } = ctx;
        const save = readSave();
        const zoneLevel = tier ? state.data.cfg.MAX_LEVEL : (zone.level ?? state.data.cfg.MAX_LEVEL);
        const cands = projectCandidates(state.engine, state.data, save, zoneLevel)
          .map(c => ({ ...c, hpCur: c.hp }));
        const team = pickLegendTeam(cands, zone, tier, state.engine, state.data);
        const o = legendOdds(zone, tier, team, state.engine, state.data, save);
        state.evtOdds = { key: 'zone:' + zone.id + ':' + tier, text: oddsText(o) };
        info.textContent = state.evtOdds.text;
        const placed = await applyToEventPicker(team);
        log('info', 'picker ui: team applied', { placed, of: team.length, odds: state.evtOdds.text });
        // the game re-renders the head when the team changes: put my line back
        setTimeout(() => {
          const again = document.querySelector('#pcopt-evt-info');
          if (again && !again.textContent) again.textContent = state.evtOdds.text;
        }, 900);
      } catch (e) {
        logError('picker ui: optimize failed', e);
        info.textContent = 'error: ' + e.message;
      }
      btn.disabled = false;
    };
    box.querySelector('#pcopt-evt-run').onclick = run;
  }

  /** One line on what the chapter optimizer is aiming at. */
  function teamUiInfo() {
    if (!state.events) return '';
    const foes = state.enemies ? state.enemies.length + ' foes · ' : '';
    return `Chapter ${state.events.index} ${state.events.name} · ${state.league ? 'league · ' : ''}${foes}cap ${state.events.cap}`;
  }

  /** Put my controls in the game's Team/PC header: they optimise for the chapter being run. */
  async function injectTeamUi() {
    const head = document.querySelector('#screen-team .team-panel .map-head');
    if (!head || head.querySelector('#pcopt-team-ui')) return;
    if (!state.engine) { try { await ensureData(); } catch { return; } }
    if (!head.isConnected || head.querySelector('#pcopt-team-ui')) return;
    refreshChapter();
    const box = document.createElement('div');
    box.id = 'pcopt-team-ui';
    box.className = 'pcopt-row';
    box.style.flexBasis = '100%';
    box.style.marginTop = '4px';
    box.innerHTML = `${presetSeg()}
      <button class="btn small" id="pcopt-team-run">✨ Optimize (mine)</button>
      <span class="pcopt-mut" id="pcopt-team-info">${esc(teamUiInfo())}</span>`;
    head.appendChild(box);
    log('info', 'team ui: injected', { info: teamUiInfo() });
    box.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      state.preset = b.dataset.preset;
      box.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('on', x.dataset.preset === state.preset));
      log('info', 'team ui: preset', state.preset);
    });
    box.querySelector('#pcopt-team-run').onclick = async () => {
      const btn = box.querySelector('#pcopt-team-run');
      const info = box.querySelector('#pcopt-team-info');
      btn.disabled = true;
      info.textContent = 'working…';
      log('info', 'team ui: optimize clicked', { chapter: state.events?.index });
      const tick = setInterval(() => { if (state.waiting) info.textContent = state.waiting; }, 400);
      try {
        await runOptimizer();
        if (!state.team || !state.team.length) { info.textContent = 'no candidate found'; }
        else {
          const res = await applyTeam(state.team);
          info.textContent = res.ok
            ? teamUiInfo() + (res.done ? ` · applied ${res.done}/${state.team.length}` : ' · team already in place')
            : 'could not use the team screen: ' + res.error;
          log('info', 'team ui: result', { ok: res.ok, done: res.done, same: res.same });
        }
      } catch (e) {
        logError('team ui: optimize failed', e);
        info.textContent = 'error: ' + e.message;
      }
      clearInterval(tick);
      state.waiting = null;
      btn.disabled = false;
    };
  }

  /* ------------------------------------------------------------------ *
   * 9. UI
   * ------------------------------------------------------------------ */
  const state = {
    data: null, chart: null, chartSource: '', engine: null, learnAll: null,
    events: null, enemies: null, scored: null, team: null,
    preset: 'balanced', errors: [], busy: false, watcher: null, eligible: 0,
    apiCache: {}, info: {}, legends: null, legBoss: null, legTier: 0, legTeam: null, collapsed: false, waiting: null,
    evtOdds: null, loading: null,
    interacting: false, lastSig: null, width: store.get('panelWidth', 344), league: false, leagueInfo: null, legOdds: null
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
  function displayName(id) {
    const lang = i18n();
    const n = lang?.pokemon?.[id];
    const name = Array.isArray(n) ? n[0] : n;
    return name || state.data?.species?.[id]?.name || ('#' + id);
  }
  function displayMove(key) {
    const lang = i18n();
    const n = lang?.moves?.[key];
    const name = Array.isArray(n) ? n[0] : n;
    return name || state.data?.moves?.[key]?.name || key;
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
  const legendRegions = () => [...new Set(legendZones().map(z => z.region))];

  function legendRegionOptions() {
    const cur = state.legRegion || state.events?.region || legendRegions()[0] || 'kanto';
    state.legRegion = cur;
    return legendRegions().map(r => `<option value="${r}" ${r === cur ? 'selected' : ''}>${r}</option>`).join('');
  }

  function legendZone() {
    const zones = legendZones().filter(z => z.region === state.legRegion);
    if (!zones.length) return null;
    const cur = zones.find(z => String(z.id) === String(state.legBoss)) || zones[0];
    state.legBoss = String(cur.id);
    return cur;
  }

  function legendBossOptions() {
    const zones = legendZones().filter(z => z.region === state.legRegion);
    return zones.map(z => `<option value="${z.id}" ${String(z.id) === String(state.legBoss) ? 'selected' : ''}>${esc(displayName(z.id))}${z.title ? ' · ' + esc(z.title) : ''}</option>`).join('');
  }

  function legendTierOptions() {
    const zone = legendZone();
    if (!zone) return '';
    const tiers = Object.keys(state.legends?.elite?.[zone.id] || {}).map(Number).sort();
    return `<option value="0" ${state.legTier === 0 ? 'selected' : ''}>normal</option>`
      + tiers.map(t => `<option value="${t}" ${state.legTier === t ? 'selected' : ''}>elite ${t}</option>`).join('');
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
    if (!state.legTeam) return '<div class="pcopt-mut">pick a boss and run the optimizer</div>';
    if (!state.legTeam.length) return '<div class="pcopt-mut">no candidate</div>';
    return state.legTeam.map((s, i) => {
      const sp = s.species;
      const lv = s.mon.level < s.proj.level ? `Lv${s.mon.level} → ${s.proj.level}` : `Lv${s.mon.level}`;
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
    if (!state.team) return '<div class="pcopt-mut">run the optimizer to get a team</div>';
    if (!state.team.length) return '<div class="pcopt-mut">no candidate</div>';
    return state.team.map((s, i) => {
      const sp = s.species;
      const lv = s.mon.level < s.proj.level ? `Lv${s.mon.level} → ${s.proj.level}` : `Lv${s.mon.level}`;
      return `<div class="pcopt-mon"><div>${i + 1}. <b>${esc(displayName(sp.id))}</b> <span class="pcopt-mut">${lv}${s.mon.shiny ? ' ✨' : ''}</span>`
        + `<div class="pcopt-row">${sp.types.map(typeBadge).join('')}</div>`
        + `<div class="pcopt-mut">${esc(s.bestMoveKey ? displayMove(s.bestMoveKey) : (s.bestMoveName || '—'))} · ${Math.round(s.avgDmg)} dmg · ${Math.round(s.avgRounds)} rounds${s.proj.shiny ? ' · +10% stats' : ''}</div>`
        + (s.hpCur != null && s.hpCur < s.hp ? `<div class="pcopt-mut">HP ${s.hpCur}/${s.hp}</div>` : '')
        + `<div class="pcopt-mut" data-info="${s.mon.uid}">${state.info[s.mon.uid] || ''}</div></div>`
        + `<div class="pcopt-row"><button class="btn small ghost" data-moves="${s.mon.uid}">moves</button><button class="btn small ghost" data-api="${s.mon.uid}">api</button></div></div>`;
    }).join('');
  }

  /** Only rebuild the panel when something actually changed (the game ticks every second). */
  function panelSignature() {
    const adv = readSave()?.adv;
    const sig = {
      ch: adv?.chapter, node: adv?.node, step: adv?.nodes?.[adv.node]?.name,
      foes: state.enemies?.length, elig: state.eligible, preset: state.preset,
      team: (state.team || []).map(t => t.mon.uid + ':' + t.hpCur).join(','),
      leg: (state.legTeam || []).map(t => t.mon.uid).join(','),
      boss: state.legBoss, region: state.legRegion, tier: state.legTier,
      odds: state.legOdds ? [state.legOdds.winChance, state.legOdds.rounds, state.legOdds.attempts, state.legOdds.totalMs].join('|') : '',
      fails: state.watcher?.fails.length, busy: state.busy,
      errors: state.errors.join('|'), waiting: state.waiting,
      data: state.data ? Object.keys(state.data.species).length : 0,
      legends: state.legends?.zones.length ?? 0,
      info: Object.keys(state.info).map(k => k + ':' + state.info[k]).join(',')
    };
    return JSON.stringify(sig);
  }

  function renderPanelInner(force = false) {
    let p = document.getElementById('pcopt-panel');
    if (!p) {
      p = document.createElement('div');
      p.id = 'pcopt-panel';
      document.body.appendChild(p);
    }
    const sig = panelSignature();
    // do not rebuild while the user is playing with the panel
    const active = document.activeElement;
    const busy = state.interacting || (active && p.contains(active) && /^(SELECT|INPUT|TEXTAREA)$/.test(active.tagName));
    if (!force && (busy || sig === state.lastSig)) return;
    state.lastSig = sig;
    log('debug', 'panel: render', JSON.parse(sig));
    const save = readSave();
    const adv = save?.adv;
    const node = adv?.nodes?.[adv.node];
    const scroll = p.scrollTop;

    // the panel is built from the game's own classes and CSS variables, so it follows its theme
    p.className = 'map-region';
    p.style.setProperty('--c', '#3b6fe0');
    p.innerHTML = `
      <style>
        #pcopt-panel{position:fixed;right:10px;bottom:10px;z-index:45;width:var(--pcopt-w,344px);max-height:min(76vh,720px);
          overflow:auto;box-shadow:0 10px 28px #00000073;background:var(--panel);color:var(--text)}
        #pcopt-panel .pcopt-resize{position:absolute;top:0;left:0;width:10px;height:100%;cursor:ew-resize;z-index:3}
        #pcopt-panel .pcopt-resize:after{content:'';position:absolute;top:50%;left:3px;width:4px;height:34px;margin-top:-17px;
          border-radius:3px;background:var(--line);opacity:.8}
        #pcopt-panel .map-head{position:sticky;top:0;z-index:2;
          background:linear-gradient(90deg,color-mix(in srgb,var(--c) 40%,var(--panel)),var(--panel))}
        #pcopt-panel .map-head h2{font-size:17px}
        #pcopt-panel section{padding:10px 14px;border-bottom:2px solid var(--line)}
        #pcopt-panel section:last-child{border-bottom:0}
        #pcopt-panel .pcopt-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
        #pcopt-panel .pcopt-mut{color:var(--muted);font-size:13px;line-height:1.5}
        #pcopt-panel .pcopt-mon{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)}
        #pcopt-panel .pcopt-mon:last-child{border-bottom:0}
        #pcopt-panel .pcopt-log{max-height:150px;overflow:auto}
        #pcopt-panel .pcopt-err{color:var(--red)}
        #pcopt-panel .btn.small{font-size:13px;padding:5px 10px}
        #pcopt-panel .seg button{font-size:13px;padding:5px 9px}
        #pcopt-panel select{font-size:13px;padding:4px 8px;max-width:100%}
        #pcopt-panel .type.sm{font-size:11px}
        @media (max-width:640px){#pcopt-panel{width:calc(100vw - 16px);right:8px;bottom:64px}}
      </style>
      <div class="map-head"><h2>Team Optimizer</h2>
        <button class="btn small ghost" id="pcopt-toggle" aria-label="Collapse">–</button></div>
      <div id="pcopt-body"></div>
      <div class="pcopt-resize" id="pcopt-resize" title="Drag to widen"></div>`;

    const body = $('#pcopt-body', p);
    const toggle = $('#pcopt-toggle', p);
    p.style.setProperty('--pcopt-w', state.width + 'px');
    p.onpointerdown = () => { state.interacting = true; };
    p.onpointerup = p.onpointercancel = () => { state.interacting = false; };
    // drag the right edge to widen the panel
    const grip = $('#pcopt-resize', p);
    if (grip && !grip.dataset.wired) {
      grip.dataset.wired = '1';
      grip.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        grip.setPointerCapture(ev.pointerId);
        const move = e => {
          // the panel is pinned to the right: its left edge follows the pointer
          const w = clamp(Math.round(innerWidth - 10 - e.clientX), 260, Math.min(900, innerWidth - 20));
          state.width = w;
          p.style.setProperty('--pcopt-w', w + 'px');
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          store.set('panelWidth', state.width);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
      });
    }
    toggle.textContent = state.collapsed ? '+' : '–';
    body.style.display = state.collapsed ? 'none' : '';
    toggle.onclick = () => {
      state.collapsed = body.style.display !== 'none';
      body.style.display = state.collapsed ? 'none' : '';
      toggle.textContent = state.collapsed ? '+' : '–';
    };
    p.scrollTop = scroll;

    body.innerHTML = `
      <section>
        <div class="pcopt-row"><b>Chapter ${adv?.chapter ?? '-'}</b><span class="pcopt-mut">${esc(state.events?.name || '')}</span></div>
        <div class="pcopt-mut">step ${adv?.node ?? '-'} / ${(adv?.nodes || []).length} · ${esc(node?.name || '-')}${node?.lv ? ' · Lv ' + node.lv.join('-') : ''}</div>
        <div class="pcopt-mut">level cap ${state.events?.cap ?? '-'} · type chart: ${esc(state.chartSource || '-')}</div>
        <div class="pcopt-mut">data: ${state.data ? Object.keys(state.data.species).length + ' species · ' + (state.legends?.zones.length ?? 0) + ' legend zones' : 'not loaded'}
          · bundle ${esc((bundleUrl() || '').split('/').pop() || '-')}</div>
        ${state.leagueInfo ? `<div class="pcopt-mut">${esc(state.leagueInfo)}</div>` : ''}
        ${state.eligible ? `<div class="pcopt-mut">${state.eligible} Pokémon can join this team${save?.link ? ' (region link: ' + esc(save.link.to) + ')' : ''}</div>` : ''}
        ${state.waiting ? `<div class="pcopt-mut">${esc(state.waiting)}</div>` : ''}
        ${state.errors.length ? `<div class="pcopt-err">${state.errors.map(esc).join('<br>')}</div>` : ''}
      </section>

      <section>
        <div class="pcopt-row"><b>Chapter events</b><span class="pcopt-mut">${state.enemies ? state.enemies.length + ' foes' : ''}</span></div>
        ${state.watcher.fails[0] ? `<div class="pcopt-mut">last wipe: step ${state.watcher.fails[0].node} · ${esc(state.watcher.fails[0].name)} (${esc((state.watcher.fails[0].enemies || []).map(e => displayName(e.id)).join(', '))})</div>` : ''}
        <div class="pcopt-row" style="margin:4px 0">${typeChips(state.enemies, state.data)}</div>
        <div class="pcopt-row">
          <button class="btn small ghost" id="pcopt-watch">${state.watcher.running ? '● watching' : 'watch for wipes'}</button>
          <button class="btn small ghost" id="pcopt-clear">clear log</button>
        </div>
        <div class="pcopt-log">${renderFails()}</div>
      </section>

      <section>
        <div class="pcopt-row"><b>Legendary fight</b><span class="pcopt-mut">${state.legends ? state.legends.zones.length + ' boss zones' : 'loading…'}</span></div>
        <div class="pcopt-row">
          <select id="pcopt-leg-region">${legendRegionOptions()}</select>
          <select id="pcopt-leg-boss">${legendBossOptions()}</select>
          <select id="pcopt-leg-tier">${legendTierOptions()}</select>
          ${presetSeg()}
        </div>
        <div class="pcopt-mut" id="pcopt-leg-info">${legendInfo()}</div>
        <div class="pcopt-mut" id="pcopt-leg-odds">${legendOddsLine()}</div>
        <div class="pcopt-row" style="margin-top:6px">
          <button class="btn small" id="pcopt-leg-run" ${state.busy ? 'disabled' : ''}>optimize for this boss</button>
          <button class="btn small ghost" id="pcopt-leg-apply" ${state.legTeam && state.legTeam.length && !state.busy ? '' : 'disabled'}>apply to team</button>
        </div>
        <div id="pcopt-leg-team">${renderLegendTeam()}</div>
      </section>

      <section>
        <div class="pcopt-row" style="margin-top:8px">
          ${presetSeg()}
          <button class="btn small" id="pcopt-run" ${state.busy ? 'disabled' : ''}>${state.busy ? 'working…' : 'optimize'}</button>
          <button class="btn small ghost" id="pcopt-apply" ${state.team && state.team.length && !state.busy ? '' : 'disabled'}>apply to team</button>
        </div>
        <div id="pcopt-team">${renderTeam()}</div>
      </section>`;

    body.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      state.preset = b.dataset.preset;
      if (state.scored) state.team = pickTeam(state.scored, state.enemies, state.engine, state.data, state.preset, 6, state.league);
      const zone = legendZone();
      if (zone && state.legTeam) {
        const save = readSave();
        const cands = save ? projectCandidates(state.engine, state.data, save, state.events?.cap ?? 100) : [];
        state.legTeam = pickLegendTeam(cands, zone, state.legTier, state.engine, state.data);
      }
      renderPanel(true);
    });
    const regionSel = $('#pcopt-leg-region', body);
    if (regionSel) regionSel.onchange = () => {
      state.legRegion = regionSel.value;
      state.legBoss = null;
      state.legTier = 0;
      renderPanel();
    };
    const bossSel = $('#pcopt-leg-boss', body);
    if (bossSel) bossSel.onchange = () => {
      state.legBoss = bossSel.value;
      state.legTier = 0;
      renderPanel();
    };
    const tierSel = $('#pcopt-leg-tier', body);
    if (tierSel) tierSel.onchange = () => { state.legTier = +tierSel.value; renderPanel(); };
    $('#pcopt-leg-run', body).onclick = () => runLegendOptimizer();
    $('#pcopt-leg-apply', body).onclick = () => applyTeamFromPanel(state.legTeam);
    body.querySelectorAll('[data-moves]').forEach(b => b.onclick = () => {
      b.textContent = '…';
      showMovesPanel(b.dataset.moves).then(() => { b.textContent = 'moves'; });
    });
    body.querySelectorAll('[data-api]').forEach(b => b.onclick = () => {
      const uid = b.dataset.api;
      const info = body.querySelector(`[data-info="${uid}"]`);
      if (info) info.textContent = 'asking PokéAPI…';
      compareWithPokeApi(uid, info);
    });
    $('#pcopt-run', body).onclick = () => runOptimizer();
    $('#pcopt-apply', body).onclick = () => applyTeamFromPanel();
    $('#pcopt-watch', body).onclick = () => {
      if (state.watcher.running) state.watcher.stop(); else state.watcher.start();
      renderPanel();
    };
    $('#pcopt-clear', body).onclick = () => { state.watcher.clear(); renderPanel(); };
  }

  /** The panel must never take the script down: a render error is logged, the rest keeps running. */
  function renderPanel(force = false) {
    try { renderPanelInner(force); } catch (e) { logError('panel: render failed', e); }
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
      const cacheKey = 'bundle:v6:' + url;
      let data = store.get(cacheKey, null);
      if (data && !dataLooksValid(data)) {
        log('warn', 'data: the cached tables are invalid, parsing the bundle again');
        data = null;
      } else if (data) {
        log('info', 'data: cache hit', url.split('/').pop());
      }
      if (!data) {
        state.busy = true; renderPanel();
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
    const info = chapterInfo(state.data, save.adv.chapter, save.adv);
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

  async function runOptimizer() {
    state.busy = true; state.errors = []; renderPanel();
    log('info', 'optimizer: start', { preset: state.preset });
    try {
      await ensureData();
      if (!state.data) { state.busy = false; renderPanel(); return; }
      const save = readSave();
      if (!save) { state.errors = ['no save found']; state.busy = false; renderPanel(); return; }
      const info = chapterInfo(state.data, save.adv.chapter, save.adv);
      if (!info) { state.errors = ['chapter not found']; state.busy = false; renderPanel(); return; }
      state.events = info;
      const league = leagueChapters(state.data, info.index);
      state.league = league.length > 0;
      state.leagueInfo = league.length
        ? `League: ${league.map(i => (state.data.chapters[i].steps.find(st => st.kind === 'gym')?.leader) || '?').join(' → ')} · a wipe rewinds to the first`
        : null;
      state.enemies = chapterEnemies(state.data, info, save.adv.nodes);
      const away = awayUids(save);
      const candidates = save.mons.filter(m => !away.has(m.uid) && state.data.species[m.id] && canJoinTeam(save, m));
      state.eligible = candidates.length;
      state.scored = scoreCandidates(state.engine, state.data, state.enemies, candidates, info.cap, state.league);
      state.enemies = state.enemies.map(e => {
        const types = state.data.species[e.id]?.types || [];
        const proj = { id: e.id, level: e.level, types };
        return { ...e, proj, types, hp: state.engine.maxHp(proj) };
      });
      state.team = pickTeam(state.scored, state.enemies, state.engine, state.data, state.preset, 6, state.league);
      if (!state.team.length) state.errors = ['no candidate found in the PC'];
      log('info', 'optimizer: done', {
        chapter: info.index, name: info.name, cap: info.cap, foes: state.enemies.length,
        eligible: state.eligible, league: state.league,
        team: state.team.map(t => displayName(t.species.id)),
      });
    } catch (e) {
      logError('optimizer: failed', e);
      state.errors = ['optimizer error: ' + e.message];
    }
    state.busy = false;
    renderPanel();
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
    state.busy = true; state.errors = []; renderPanel();
    log('info', 'legend optimizer: start', { region: state.legRegion, boss: state.legBoss, tier: state.legTier });
    try {
      await ensureData();
      const zone = legendZone();
      if (!zone) { state.errors = ['no boss zone']; state.busy = false; renderPanel(); return; }
      const save = readSave();
      if (!save) { state.errors = ['no save found']; state.busy = false; renderPanel(); return; }
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
    renderPanel();
  }

  async function applyTeamFromPanel(team) {
    team = team || state.team;
    if (!team || !team.length) return;
    state.busy = true; renderPanel();
    log('info', 'panel: apply team', { mons: team.length });
    const res = await applyTeam(team);
    state.busy = false;
    state.waiting = null;
    if (!res.ok) { log('error', 'panel: apply failed', res.error); state.errors = ['apply failed: ' + res.error]; }
    renderPanel();
  }

  function boot() {
    log('info', 'boot', { version: '1.1.0', bundle: bundleUrl()?.split('/').pop() || null });
    // the game's own team picker (legend zones, raids, elite league): put my controls beside its Optimize button
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try {
          if (document.querySelector('#evt-pick-head')) injectPickerUi().catch(e => logError('picker ui: inject', e));
          if (document.querySelector('#screen-team .team-panel .map-head')) injectTeamUi().catch(e => logError('team ui: inject', e));
        } catch (e) { logError('ui: observer', e); }
      });
    }).observe(document.body, { childList: true, subtree: true });
    state.watcher = new WipeWatcher(rec => {
      renderPanel();
      if (rec) {
        // the team fell on this step: rebuild an optimal team for the chapter
        runOptimizer();
      }
    });
    renderPanel();
    ensureData().then(() => {
      renderPanel();
      log('info', 'boot: ready', {
        species: state.data ? Object.keys(state.data.species).length : 0,
        legends: state.legends?.zones?.length ?? 0,
        errors: state.errors,
      });
    }).catch(e => logError('boot: data', e));
    // the game keeps playing in the background: keep the panel in sync
    setInterval(() => {
      if (state.busy) return;
      try { refreshChapter(); renderPanel(); } catch (e) { logError('panel: refresh', e); }
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
    projectCandidates, refreshChapter
  };
})();
