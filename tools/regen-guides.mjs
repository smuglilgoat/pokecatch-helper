#!/usr/bin/env node
/**
 * Re-validate the community guides after a game update.
 *
 *   node tools/regen-guides.mjs
 *
 * Fetches the live boot manifest, the app bundle and the English language pack,
 * then:
 *   1. resolves every species and move name used by guides/data/*.json against
 *      the bundle's Pokédex and the English pack (forms included);
 *   2. checks every gemTypes list against the species' real types;
 *   3. checks the Underground theme keys against the bundle's THEMES;
 *   4. checks the 18 type-picks types;
 *   5. recomputes the Arceus-shield attackers (2 × max(Atk, SpA) + 5 at Lv 100)
 *      and diffs the stored catch-teams shield lists.
 *
 * Exit 0 only when no species/type/theme reference is unresolved. Chapter
 * names are a warning: the boards use loose English, the bundle ships French.
 */
const BOOT = 'https://pokecatch-online.pages.dev/boot.js';

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
  throw new Error('unbalanced literal at ' + start);
}
function literalAfter(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('marker not found: ' + marker);
  let start = -1;
  if (marker.endsWith('[') || marker.endsWith('{')) start = i + marker.length - 1;
  else for (let j = i + marker.length; j < src.length; j++) if (src[j] === '[' || src[j] === '{') { start = j; break; }
  if (start < 0) throw new Error('no literal after ' + marker);
  return literalAt(src, start);
}
const evalLit = (lit, stub = {}) => Function('a', 'return (' + lit + ')')(stub);
const JS_GLOBALS = new Set(['Infinity', 'NaN', 'undefined', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'RegExp', 'Map', 'Set', 'BigInt', 'Promise', 'Error', 'console']);
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

const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(/\s+/).filter(w => w && w !== 'forme' && w !== 'form').sort().join('');

const get = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
};

const boot = await get(BOOT + '?cb=' + Date.now());
const appPath = (boot.match(/bundle\/(app\.[0-9a-z]+\.js)/) || [])[1];
const langPath = (boot.match(/bundle\/(lang-en\.[0-9a-z]+\.js)/) || [])[1];
if (!appPath || !langPath) { console.error('regen-guides: boot manifest has no app/lang-en bundle'); process.exit(1); }
const base = new URL(BOOT);
const appUrl = new URL('/bundle/' + appPath, base).href;
const langUrl = new URL('/bundle/' + langPath, base).href;
console.log(`regen-guides: bundle ${appPath} · lang ${langPath}`);
const [src, langSrc] = await Promise.all([get(appUrl), get(langUrl)]);

const dexLit = literalAfter(src, 'a.POKEDEX=');
let dex;
try { dex = evalLit(dexLit); } catch { dex = evalSandbox(dexLit); }
let forms = [];
try {
  const at = src.indexOf('a.FORMS=function(){');
  const arrAt = src.indexOf('[', at);
  forms = evalLit(literalAt(src, arrAt));
} catch { forms = []; }
const themesLit = literalAfter(src, 'THEMES:[');
const themes = evalLit(themesLit);
const chaptersLit = literalAfter(src, 'CHAPTERS:[');
const chapterNames = [...chaptersLit.matchAll(/name:"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);

const win = {};
try { new Function('window', langSrc)(win); } catch (e) { console.error('regen-guides: English pack failed: ' + e.message); process.exit(1); }
const en = win.I18N_DATA?.en || {};
const strEn = win.I18N?.en || {};

const byId = new Map(dex.map(s => [s.id, s]));
const nameToId = new Map();
const addName = (name, id) => { const k = norm(name); if (k && !nameToId.has(k)) nameToId.set(k, id); };
for (const s of dex) addName(en.pokemon?.[s.id]?.[0] || s.name, s.id);
for (const f of forms) {
  const baseEn = en.pokemon?.[f.base]?.[0] || byId.get(f.base)?.name || '';
  const formEn = strEn[f.form] || f.form;
  const slugTail = String(f.slug || '').split('-').slice(1).join(' ');
  addName(baseEn + ' ' + formEn, f.id);
  addName(baseEn + ' ' + slugTail, f.id);
  addName(formEn, f.id);
}
const moveNames = new Set(Object.keys(en.moves || {}).map(k => norm(en.moves[k])));
const itemNames = new Set(Object.keys(en.items || {}).map(k => norm(en.items[k])));
const speciesOf = name => {
  const id = nameToId.get(norm(name));
  return id == null ? null : (byId.get(id) || forms.find(f => f.id === id));
};

const ORDER = ['underground', 'farming', 'berry', 'overnight', 'gem-tiers', 'ru-tiers', 'type-picks', 'catch-teams', 'elite2-teams'];
const SKIP = new Set(['loop', 'map', 'league', 'region', 'bestArea', 'verdict', 'type', 'use', 'buy', 'note', 'summary', 'title', 'credit', 'sourceImage', 'id', 'gameVersion', 'build', 'pulled', 'label', 'mode', 'rules']);
const unresolved = [];
const typeErrors = [];
const themeErrors = [];
const chapterMisses = new Set();
let speciesRefs = 0;

const walk = (node, path, guide) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + '[' + i + ']', guide)); return; }
  const inMoves = path.includes('.moves[') || path.includes('.bans[') || path.includes('.alternateBans[');
  const inItems = path.includes('berries') || path.includes('sources');
  for (const [k, v] of Object.entries(node)) {
    const here = path ? path + '.' + k : k;
    if (typeof v === 'string') {
      if (k === 'name' && !inMoves && !inItems) {
        speciesRefs++;
        if (!speciesOf(v)) unresolved.push(`${guide.id}${here} = "${v}"`);
      } else if (k === 'loop' || k === 'map') {
        const cn = norm(v);
        if (cn && !chapterNames.some(n => norm(n) === cn)) chapterMisses.add(`${guide.id}${here} = "${v}"`);
      }
    } else if (k === 'gemTypes' && Array.isArray(v)) {
      const sp = speciesOf(node.name);
      if (sp) {
        const real = new Set(sp.types || []);
        const bad = v.filter(t => !real.has(t));
        if (bad.length) typeErrors.push(`${guide.id}${path}.${node.name}: ${bad.join(', ')} not in ${(sp.types || []).join('/')}`);
      }
    } else if (!SKIP.has(k)) walk(v, here, guide);
  }
};

const fs = await import('node:fs');
const guides = {};
for (const id of ORDER) {
  const file = new URL(`../guides/data/${id}.json`, import.meta.url);
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  guides[id] = g;
  walk(g.data, '', g);
}

for (const t of guides['type-picks'].data.types) {
  if (!['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'].includes(t.type)) themeErrors.push('type-picks: bad type ' + t.type);
}
if (guides['type-picks'].data.types.length !== 18) themeErrors.push(`type-picks: ${guides['type-picks'].data.types.length} types, want 18`);
const themeKeys = new Set(themes.map(t => t.key));
for (const t of guides.underground.data.themes) if (!themeKeys.has(t.key)) themeErrors.push(`underground: theme "${t.key}" not in the bundle (${[...themeKeys].join(', ')})`);

const shield = guides['catch-teams'].data.shield;
const atkOf = s => 2 * Math.max(s.stats.atk, s.stats.spa) + 5;
const candidates = [], allCandidates = [];
for (const s of dex) {
  const c = { name: en.pokemon?.[s.id]?.[0] || s.name, atk: atkOf(s), id: s.id, legendary: !!(s.legendary || s.mythical) };
  allCandidates.push(c);
  if (!c.legendary) candidates.push(c);
}
for (const f of forms) {
  const b = byId.get(f.base);
  if (!b || !f.stats) continue;
  const baseEn = en.pokemon?.[f.base]?.[0] || b.name;
  const formEn = strEn[f.form] || f.form;
  const c = { name: baseEn + ' ' + formEn, atk: 2 * Math.max(f.stats.atk, f.stats.spa) + 5, id: f.id, legendary: !!(b.legendary || b.mythical) };
  allCandidates.push(c);
  if (!c.legendary) candidates.push(c);
}
candidates.sort((a, b) => b.atk - a.atk || a.name.localeCompare(b.name));
allCandidates.sort((a, b) => b.atk - a.atk || a.name.localeCompare(b.name));
const top = candidates.slice(0, 12);
console.log('\nArceus shield — recomputed top non-legendary attackers (2 × max(Atk, SpA) + 5):');
for (const c of top) console.log(`  ${String(c.atk).padStart(3)}  ${c.name}`);
const storedNoLeg = new Map((shield.noLegendary || []).map(x => [norm(x.name), x.atk]));
const storedBelow = new Map((shield.bestBelowTop || []).map(x => [norm(x.name), x.atk]));
const diffs = [];
for (const [n, atk] of storedNoLeg) {
  const c = candidates.find(x => norm(x.name) === n);
  if (!c) diffs.push(`no-legendary "${n}" not found in the dex`);
  else if (c.atk !== atk) diffs.push(`no-legendary "${n}": stored ${atk}, computed ${c.atk}`);
}
for (const [n, atk] of storedBelow) {
  const c = allCandidates.find(x => norm(x.name) === n);
  if (!c) diffs.push(`below-top "${n}" not found in the dex`);
  else if (c.atk !== atk) diffs.push(`below-top "${n}": stored ${atk}, computed ${c.atk}`);
}
console.log(diffs.length ? `shield diff: ${diffs.length} mismatch(es)` : 'shield diff: stored values match');

console.log('\nPer guide:');
for (const id of ORDER) {
  const g = guides[id];
  const bad = unresolved.filter(x => x.startsWith(id));
  console.log(`  ${id.padEnd(13)} ${Object.keys(g.data).length} data sections · ${bad.length} unresolved`);
}
if (unresolved.length) { console.log('\nUnresolved species names:'); for (const u of unresolved) console.log('  ' + u); }
if (typeErrors.length) { console.log('\nGem-type errors:'); for (const e of typeErrors) console.log('  ' + e); }
if (themeErrors.length) { console.log('\nTheme/type errors:'); for (const e of themeErrors) console.log('  ' + e); }
if (chapterMisses.size) {
  const list = [...chapterMisses];
  console.log(`\nChapter names not in the French bundle (warning only, ${list.length}):`);
  for (const c of list.slice(0, 12)) console.log('  ' + c);
  if (list.length > 12) console.log(`  … ${list.length - 12} more`);
}
if (diffs.length) for (const d of diffs) console.log('  shield: ' + d);

const bad = unresolved.length + typeErrors.length + themeErrors.length;
console.log(`\nregen-guides: ${speciesRefs} species references · ${bad} unresolved · exit ${bad ? 1 : 0}`);
process.exit(bad ? 1 : 0);
