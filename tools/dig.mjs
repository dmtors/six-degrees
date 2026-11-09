// Digs and schedules the chains 6 Degrees plays: seven famous people, each
// one's article linking to the next, with the sentence that links them. Ported
// from Commonplace's BurrowGenerator.dig, kept to people, and to famous ones.
//
//   node tools/dig.mjs [--ahead 30] [--pool 20] [--minutes 0]
//
// Two files: data/chains.json is the schedule (chains with a date; all the game
// loads), data/pool.json is chains dug but not yet given a day. Each run:
//   1. checks the pool against the current rules (scheduled chains are never touched),
//   2. gives days to pool chains until the schedule reaches [ahead] days past today,
//   3. digs until the pool holds [pool] chains (or [minutes] run out), and schedules again.
// The nightly GitHub Action runs this, so there are always a month of days ready.
//
// Slow on purpose: one request at a time, a pause between them, and
// Retry-After honoured, so it never hammers the APIs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linksOf, solutionsOf, difficultyOf, FIRST_DAY } from '../js/game.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEDULE = join(ROOT, 'data', 'chains.json');
const POOL = join(ROOT, 'data', 'pool.json');
const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'SixDegrees/1.0 (https://github.com/dmtors/six-degrees; daily puzzle generator, one request at a time)';

const LENGTH = 7;
const MAX_EXPANSIONS = 28;
/** Famous enough to know: read this much a week. */
const MIN_WEEKLY = 15_000;
const MIN_ENTRANCE_WEEKLY = 20_000;
/** Links looked at from each article (the sections' first). */
const MAX_LINKS = 100;
const PAUSE_MS = 2000;
const MAX_LINKS_IN_SENTENCE = 4;
/** Orders of the five between that make a chain (either article mentioning the other): above this, it's too easy. */
const MAX_SOLUTIONS = 3;

// ---------- Who counts ----------

/** A person, by the way short descriptions are written: "American actor (born 1956)", "English singer (1946–2016)". */
const PERSON = /\((born |b\. )?(c\. ?)?\d{3,4}( ?[–-] ?(c\. )?\d{3,4})?\)|\bborn \d{4}\b/i;

/** Famous for being seen and heard: screen, stage, music, sport, media. */
const CELEBRITY = /\b(actor|actress|singer|rapper|musician|songwriter|singer-songwriter|comedian|entertainer|television|presenter|talk show|host|model|filmmaker|film director|director|producer|screenwriter|dancer|choreographer|dj|disc jockey|record producer|footballer|soccer player|basketball|tennis|golfer|boxer|wrestler|athlete|sprinter|swimmer|gymnast|quarterback|american football|baseball|ice hockey|cricketer|racing driver|skateboarder|snowboarder|skater|youtuber|streamer|influencer|media personality|personality|socialite|businessman|businesswoman|entrepreneur|chef|magician|composer|guitarist|drummer|pianist|bassist|vocalist|broadcaster|fashion designer|designer|photographer|artist|voice actor|stunt|martial artist|mixed martial|fighter|astronaut)\b/i;

/** Not who a light game should send you through. */
const NOT_CELEBRITY = /\b(politician|president|prime minister|minister|senator|governor|congressman|congresswoman|monarch|emperor|empress|king|queen|prince|princess|duke|duchess|pope|saint|bishop|cardinal|general|military|officer|soldier|criminal|convicted|murderer|serial killer|killer|terrorist|gangster|mobster|fraudster|dictator|assassin|spy|sex offender|pornographic|adult film|pornstar|porn)\b/i;

const NOT_A_STEP = /^(List of|Lists of|Index of|Outline of|Timeline of|Glossary of|History of)\b|\(disambiguation\)|^(Help|Wikipedia|File|Category|Template|Portal|Special|Talk):/;

/** Famous for the wrong reasons: not who a game should send you through. */
const BLOCKED = new Set([
  'Bill Cosby', 'Harvey Weinstein', 'Kevin Spacey', 'R. Kelly', 'O. J. Simpson', 'Sean Combs', 'Roman Polanski',
  'Jimmy Savile', 'Rolf Harris', 'Gary Glitter', 'Phil Spector', 'Danny Masterson', 'Andrew Tate', 'Jeffrey Epstein',
  'Ghislaine Maxwell', 'Marilyn Manson', 'Chris Brown', 'Oscar Pistorius', 'Rolf Harris', 'Bill Wyman',
]);

/**
 * Celebrities in the modern sense: born since 1880 (so screen, records and
 * broadcasting were theirs to be famous in). Writers count only with another
 * celebrity job alongside ("actor and writer"), since the list above leaves
 * writer, author, novelist, poet, playwright and journalist out.
 */
const EARLIEST_BIRTH = 1880;
const born = (description) => Number(description.match(/\((?:born |b\. )?(?:c\. ?)?(\d{4})/i)?.[1]) || null;

export const isCelebrity = (description) =>
  !!description &&
  PERSON.test(description) &&
  CELEBRITY.test(description) &&
  !NOT_CELEBRITY.test(description) &&
  (born(description) ?? EARLIEST_BIRTH) >= EARLIEST_BIRTH;

/** What sort of person a description says: its first two words ("american actor"). */
const kind = (description) => description?.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 2).join(' ') || null;

/** Roughly what they're famous for, so a chain can wander from screen to music to sport. */
const FIELDS = [
  ['music', /\b(singer|rapper|musician|songwriter|dj|disc jockey|record producer|composer|guitarist|drummer|pianist|bassist|vocalist|band)\b/i],
  ['sport', /\b(footballer|soccer|basketball|tennis|golfer|boxer|wrestler|athlete|sprinter|swimmer|gymnast|quarterback|american football|baseball|ice hockey|cricketer|racing driver|skateboarder|snowboarder|skater|martial|fighter)\b/i],
  ['screen', /\b(actor|actress|comedian|filmmaker|director|screenwriter|television|presenter|host|voice actor)\b/i],
];
const field = (description) => FIELDS.find(([, re]) => re.test(description || ''))?.[0] || 'other';

// ---------- Requests ----------

let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = new URL(API);
  Object.entries({ format: 'json', formatversion: '2', maxlag: '5', ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = last + PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } });
    if (response.status === 429 || response.status >= 500) {
      const after = Number(response.headers.get('retry-after')) || 10 * (attempt + 1);
      console.warn(`  ${response.status}; waiting ${after}s`);
      await sleep(after * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error?.code === 'maxlag') {
      await sleep(5000);
      continue;
    }
    if (data.error) throw new Error(data.error.info);
    return data;
  }
  throw new Error('gave up after retries');
}

/** Description, picture and last week's readers for up to 50 titles, keyed by the title asked for. */
async function pageInfo(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await api({
      action: 'query',
      titles: batch.join('|'),
      redirects: '1',
      prop: 'description|pageimages|pageviews',
      piprop: 'thumbnail',
      pithumbsize: '320',
      pilimit: '50',
      pvipdays: '7',
    });
    const q = data.query || {};
    const resolve = new Map();
    for (const t of batch) resolve.set(t, t);
    for (const n of q.normalized || []) for (const [k, v] of resolve) if (v === n.from) resolve.set(k, n.to);
    for (const r of q.redirects || []) for (const [k, v] of resolve) if (v === r.from) resolve.set(k, r.to);
    const pages = new Map((q.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
    for (const [asked, title] of resolve) {
      const page = pages.get(title);
      if (!page) continue;
      const views = Object.values(page.pageviews || {}).reduce((sum, v) => sum + (v || 0), 0);
      out.set(asked, {
        title: page.title,
        description: page.description || null,
        thumb: page.thumbnail?.source || null,
        views,
      });
    }
  }
  return out;
}

// ---------- Reading an article ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * The article's paragraphs as plain text, with where each link to another
 * article starts: the sections' paragraphs first (where a life's story goes),
 * then the opening's (mostly what the person is).
 */
const paragraphCache = new Map();
async function paragraphs(title) {
  if (!paragraphCache.has(title)) paragraphCache.set(title, await readParagraphs(title));
  return paragraphCache.get(title);
}

async function readParagraphs(title) {
  const data = await api({
    action: 'parse',
    page: title,
    redirects: '1',
    prop: 'text',
    disableeditsection: '1',
    disablelimitreport: '1',
    disabletoc: '1',
  });
  let html = data.parse.text;
  html = html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/g, '')
    .replace(/<sup[^>]*class="[^"]*noprint[^"]*"[\s\S]*?<\/sup>/g, '')
    .replace(/<table[\s\S]*?<\/table>/g, '');
  const firstHeading = html.search(/<h2|<div class="mw-heading/);
  const found = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const lead = firstHeading < 0 || m.index < firstHeading;
    const links = [];
    let text = '';
    const parts = m[1].split(/(<a\b[^>]*>[\s\S]*?<\/a>)/);
    for (const part of parts) {
      const a = part.match(/^<a\b([^>]*)>([\s\S]*?)<\/a>$/);
      const shown = decode(part.replace(/<[^>]+>/g, ''));
      if (a) {
        const href = a[1].match(/href="\/wiki\/([^"#]+)/);
        if (href && !/class="[^"]*new/.test(a[1])) links.push({ at: text.length, target: decodeURIComponent(href[1]).replace(/_/g, ' ') });
      }
      text += shown;
    }
    text = text.replace(/\s+/g, ' ');
    if (text.trim().length > 40) found.push({ lead, text, links });
  }
  return [...found.filter((p) => !p.lead), ...found.filter((p) => p.lead)];
}

/** The sentence of [text] around [at], as written. */
function sentenceAt(text, at) {
  // Not after an initial or a title ("D. W. Griffith", "Dr. Dre").
  const ends = [...text.matchAll(/(?<![\s.][A-Z]\.|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|No)\.)(?<=[.!?])\s+(?=[A-Z0-9"“(])/g)].map((x) => [x.index, x.index + x[0].length]);
  const before = ends.filter(([, e]) => e <= at).pop();
  const after = ends.find(([s]) => s >= at);
  return text.slice(before ? before[1] : 0, after ? after[0] : text.length).trim();
}

/** The famous people [title]'s article leads to, each with the sentence that links them. */
async function waysOn(title) {
  const linking = new Map();
  for (const p of await paragraphs(title)) {
    const sentences = p.links.map(({ at }) => sentenceAt(p.text, at));
    p.links.forEach(({ target }, i) => {
      if (linking.has(target) || NOT_A_STEP.test(target)) return;
      // A roll call ("winners included A, B, C and D") says little about how two people met.
      if (sentences.filter((x) => x === sentences[i]).length > MAX_LINKS_IN_SENTENCE) return;
      linking.set(target, sentences[i]);
    });
  }
  const targets = [...linking.keys()].slice(0, MAX_LINKS);
  if (!targets.length) return [];
  const info = await pageInfo(targets);
  const seen = new Set();
  const ways = [];
  for (const target of targets) {
    const page = info.get(target);
    if (!page || page.title === title || seen.has(page.title) || BLOCKED.has(page.title)) continue;
    if (page.views < MIN_WEEKLY || !isCelebrity(page.description)) continue;
    const via = linking.get(target);
    if (via.length < 25 || via.length > 420) continue;
    seen.add(page.title);
    ways.push({ title: page.title, description: page.description, thumb: page.thumb, via });
  }
  return ways;
}

// ---------- Digging ----------

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often each person is already in a chain (scheduled or pooled): the digger steers away from the regulars. */
const appearances = new Map();
const countIn = (chains) => chains.forEach((c) => c.steps.forEach((s) => appearances.set(s.title, (appearances.get(s.title) || 0) + 1)));

/**
 * One with a picture when there are a few (rows look like someone), someone not
 * already in two or more chains when it can (so new chains bring new faces), and
 * a different kind of person when it can.
 */
function choose(options, here, random) {
  if (!options.length) return null;
  let pool = options.filter((o) => o.thumb);
  if (pool.length < 3) pool = options;
  const fresh = pool.filter((o) => (appearances.get(o.title) || 0) < 2);
  if (fresh.length >= 2) pool = fresh;
  const varied = pool.filter((o) => kind(o.description) !== kind(here.description));
  if (varied.length >= 2) pool = varied;
  // Half the time, cross into another field when there's a way to.
  const crossing = pool.filter((o) => field(o.description) !== field(here.description));
  if (crossing.length && random() < 0.5) pool = crossing;
  return pool[Math.floor(random() * pool.length)];
}

const ways = new Map();

// ---------- Every link among the seven ----------

/** Each title's other names (its redirects), so a link written either way counts. */
async function aliases(titles) {
  const names = new Map(titles.map((t) => [t, new Set([t])]));
  let cont = {};
  do {
    const data = await api({ action: 'query', titles: titles.join('|'), prop: 'redirects', rdlimit: 'max', rdnamespace: '0', ...cont });
    for (const p of data.query.pages) for (const r of p.redirects || []) names.get(p.title)?.add(r.title);
    cont = data.continue || null;
  } while (cont);
  return names;
}

/**
 * Which of a chain's people are linked, and how: for every pair where one's
 * paragraphs link to the other, the sentence that does (from the first article
 * that has one). [{a, b, from, via}], a < b as places in the chain.
 */
async function linksAmong(steps) {
  const titles = steps.map((s) => s.title);
  const names = await aliases(titles);
  const owner = new Map();
  titles.forEach((t, i) => names.get(t).forEach((n) => owner.set(n, i)));
  const found = new Map();
  for (const [from, title] of titles.entries()) {
    for (const p of await paragraphs(title)) {
      const sentences = p.links.map(({ at }) => sentenceAt(p.text, at));
      p.links.forEach(({ target }, i) => {
        const to = owner.get(target);
        if (to == null || to === from) return;
        const [a, b] = from < to ? [from, to] : [to, from];
        const key = `${a}-${b}`;
        const via = sentences[i];
        if (via.length < 25 || via.length > 420) return;
        // The chain's own link (its step's sentence) wins; then the first one found.
        if (!found.has(key)) found.set(key, { a, b, from, via });
      });
    }
  }
  // Keep the dug links exactly as the chain has them.
  steps.forEach((step, i) => {
    if (i > 0 && step.via) found.set(`${i - 1}-${i}`, { a: i - 1, b: i, from: i - 1, via: step.via });
  });
  return [...found.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** How many orders of the people between the ends make a chain of links. */
function solutions(length, links) {
  const linked = new Set(links.map((l) => `${l.a}-${l.b}`));
  const ok = (x, y) => linked.has(x < y ? `${x}-${y}` : `${y}-${x}`);
  const middle = Array.from({ length: length - 2 }, (_, i) => i + 1);
  return permutations(middle).filter((m) => {
    const order = [0, ...m, length - 1];
    return order.slice(1).every((step, i) => ok(order[i], step));
  }).length;
}

/** A chain with its links, or null when too many orders would solve it. */
async function finish(steps) {
  const links = await linksAmong(steps);
  const count = solutions(steps.length, links);
  if (count > MAX_SOLUTIONS) {
    console.log(`  ${count} orders solve it: too easy (${steps.map((s) => s.title).join(' → ')})`);
    return null;
  }
  return { steps, links, solutions: count };
}

async function dig(entrance, random) {
  const path = [{ title: entrance.title, description: entrance.description, thumb: entrance.thumb }];
  const tried = new Map();
  const triedAt = (n) => tried.get(n) || tried.set(n, new Set()).get(n);
  for (let i = 0; i < MAX_EXPANSIONS; i++) {
    if (path.length === LENGTH) return path;
    const here = path[path.length - 1];
    if (!ways.has(here.title)) {
      try {
        ways.set(here.title, await waysOn(here.title));
      } catch (e) {
        console.warn(`  couldn't read ${here.title}: ${e.message}`);
        ways.set(here.title, []);
      }
    }
    const seen = new Set(path.map((s) => s.title));
    const options = ways.get(here.title).filter((o) => !seen.has(o.title) && !triedAt(path.length).has(o.title));
    const next = choose(options, here, random);
    if (!next) {
      if (path.length === 1) return null;
      tried.delete(path.length);
      triedAt(path.length - 1).add(path.pop().title);
    } else {
      triedAt(path.length).add(next.title);
      path.push(next);
    }
  }
  return path.length === LENGTH ? path : null;
}

const LISTS = ['Entertainers, directors, producers, and screenwriters', 'Artists, musicians, and composers', 'Sports figures'];

/**
 * Entrances: famous people to dig from. A fresh sample of the vital-articles
 * people each run (seeded by the day, so it works through the lists over time),
 * plus everyone already in a chain: they're known to be famous and linked.
 */
async function entrances(known, seed) {
  let titles = [];
  for (const list of LISTS) {
    let cont = {};
    do {
      const data = await api({
        action: 'query',
        titles: `Wikipedia:Vital articles/Level/5/People/${list}`,
        redirects: '1',
        prop: 'links',
        plnamespace: '0',
        pllimit: 'max',
        ...cont,
      });
      for (const p of data.query.pages) for (const l of p.links || []) titles.push(l.title);
      cont = data.continue || null;
    } while (cont);
  }
  const pick = seeded(seed);
  titles = titles.filter((t) => !NOT_A_STEP.test(t)).sort(() => pick() - 0.5).slice(0, 600);
  const fromLists = [...(await pageInfo(titles)).values()].filter(
    (p) => p.views >= MIN_ENTRANCE_WEEKLY && isCelebrity(p.description) && !BLOCKED.has(p.title),
  );
  const fromChains = [...known.values()].filter((p) => isCelebrity(p.description) && !BLOCKED.has(p.title));
  const all = new Map([...fromChains, ...fromLists].map((p) => [p.title, p]));
  return [...all.values()].sort(() => pick() - 0.5);
}

// ---------- Scheduling ----------

const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY);

/** Nobody plays twice within this many days. */
const PERSON_GAP = 7;
/** Nor does a chain share this many people with any chain of the last SIMILAR_WINDOW days (no near-repeats). */
const MAX_SHARED = 3;
const SIMILAR_WINDOW = 90;

const difficulty = (chain) => {
  const between = linksOf(chain);
  return difficultyOf(chain.steps.length, between, solutionsOf(chain.steps.length, between));
};
const ends = (chain) => `${chain.steps[0].title}|${chain.steps.at(-1).title}`;

/**
 * The best pool chain for [date]: nobody in it played in the last PERSON_GAP
 * days, fewer than MAX_SHARED people in common with any chain of the last
 * SIMILAR_WINDOW days, a start-and-finish pair never used before, and (when there's a choice)
 * not the same difficulty as the day before. Null when none fits.
 */
function pickFor(date, schedule, pool) {
  const recent = new Set(
    schedule.filter((c) => c.date < date && c.date >= addDays(date, -PERSON_GAP)).flatMap((c) => c.steps.map((s) => s.title)),
  );
  const usedEnds = new Set(schedule.map(ends));
  const lately = schedule.filter((c) => c.date < date && c.date >= addDays(date, -SIMILAR_WINDOW)).map((c) => new Set(c.steps.map((s) => s.title)));
  const tooAlike = (c) => lately.some((other) => c.steps.filter((s) => other.has(s.title)).length >= MAX_SHARED);
  const fits = pool.filter((c) => !usedEnds.has(ends(c)) && c.steps.every((s) => !recent.has(s.title)) && !tooAlike(c));
  if (!fits.length) return null;
  const yesterday = schedule.find((c) => c.date === addDays(date, -1));
  const varied = yesterday ? fits.filter((c) => difficulty(c) !== difficulty(yesterday)) : fits;
  return (varied.length ? varied : fits)[0];
}

/** Days for pool chains, from the day after the schedule's last up to [until]. */
function extend(schedule, pool, until) {
  let added = 0;
  let next = schedule.length ? addDays(schedule.at(-1).date, 1) : FIRST_DAY;
  while (next <= until) {
    const chain = pickFor(next, schedule, pool);
    if (!chain) break;
    pool.splice(pool.indexOf(chain), 1);
    schedule.push({ date: next, ...chain });
    console.log(`SCHEDULED ${next} (${difficulty(chain)}): ${chain.steps.map((s) => s.title).join(' → ')}`);
    added++;
    next = addDays(next, 1);
  }
  return added;
}

// ---------- The run ----------

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const AHEAD = flag('ahead', 30);
const POOL_SIZE = flag('pool', 20);
const MINUTES = flag('minutes', 0);
const deadline = MINUTES ? Date.now() + MINUTES * 60e3 : Infinity;

const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};
let schedule = read(SCHEDULE);
let pool = read(POOL);
const save = () => {
  mkdirSync(dirname(SCHEDULE), { recursive: true });
  schedule.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 1));
  writeFileSync(POOL, JSON.stringify(pool, null, 1));
};

// From before there was a schedule: chains without dates keep their order and get days from #1 on.
if (schedule.some((c) => !c.date)) {
  const dated = schedule.filter((c) => c.date);
  let next = dated.length ? addDays(dated.at(-1).date, 1) : FIRST_DAY;
  schedule = [
    ...dated,
    ...schedule.filter((c) => !c.date).map((c) => {
      const chain = { date: next, ...c };
      next = addDays(next, 1);
      return chain;
    }),
  ];
  console.log(`gave dates to the first ${schedule.length} chains, through ${schedule.at(-1).date}`);
  save();
}

// 1. The pool against the current rules (a scheduled day is never changed).
const kept = [];
for (const chain of pool) {
  const out = chain.steps.find((step) => !isCelebrity(step.description) || BLOCKED.has(step.title));
  if (out) {
    console.log(`  dropped from pool: ${out.title} (${out.description})`);
    continue;
  }
  const done = chain.links ? chain : await finish(chain.steps).catch(() => chain);
  if (done) kept.push(done);
}
pool = kept;

// 2. Days from the pool.
const today = iso(Date.now());
const until = addDays(today, AHEAD);
extend(schedule, pool, until);
save();

// 3. Dig until the pool is full again (and the schedule reaches [until]).
const short = () => !schedule.length || schedule.at(-1).date < until;
if (pool.length < POOL_SIZE || short()) {
  const known = new Map(
    [...schedule, ...pool].flatMap((c) => c.steps).map((s) => [s.title, { title: s.title, description: s.description, thumb: s.thumb }]),
  );
  const used = new Set([...schedule, ...pool].map((c) => c.steps[0].title));
  const daySeed = Math.floor(Date.now() / DAY);
  countIn([...schedule, ...pool]);
  const starts = (await entrances(known, daySeed)).filter((e) => !used.has(e.title));
  console.log(`entrances: ${starts.length}; pool ${pool.length}/${POOL_SIZE}; schedule through ${schedule.at(-1)?.date}`);
  for (const [i, entrance] of starts.entries()) {
    if ((pool.length >= POOL_SIZE && !short()) || Date.now() > deadline) break;
    console.log(`digging from ${entrance.title}…`);
    const path = await dig(entrance, seeded(daySeed * 1000 + i));
    if (!path) continue;
    const chain = await finish(path);
    if (!chain) continue;
    pool.push(chain);
    countIn([chain]);
    console.log(`DUG (${chain.solutions} solution${chain.solutions === 1 ? '' : 's'}, ${difficulty(chain)}): ${path.map((s) => s.title).join(' → ')}`);
    extend(schedule, pool, until);
    save();
  }
}
save();
const ahead = schedule.length ? Math.round((Date.parse(schedule.at(-1).date) - Date.parse(today)) / DAY) : 0;
console.log(`DONE: schedule through ${schedule.at(-1)?.date} (${ahead} days ahead), pool ${pool.length}`);
if (ahead < 7) {
  console.error(`WARNING: only ${ahead} days scheduled ahead`);
  process.exitCode = 1;
}
