// The rules: ported from Commonplace's BurrowRules, with both ends of the
// chain given. Seven people, each one's article linking to the next; the five
// between come shuffled, and the player swaps them back into a chain. Any order
// that links all the way down counts: two people are linked when either one's
// article mentions the other (the digger records every such pair, and keeps
// only chains with a few solutions at most).
//
// Colours are about places, not links: green means the right person in the
// right place, so keeping your greens always leads to a solution. When there's
// more than one solution, a check is marked against the one nearest your order.

export const LENGTH = 7;
export const ATTEMPTS = 6;
/** 6 Degrees #1's day. */
export const FIRST_DAY = '2026-11-09';

/** The start and the finish are given and stay put. */
export const fixed = (place, length = LENGTH) => place === 0 || place === length - 1;

/**
 * The pairs of a chain that are linked, as a lookup: between(x, y) is the link
 * (who mentions whom, and the sentence), or undefined. Older chains without a
 * links list fall back to the dug order's own links.
 */
export function linksOf(chain) {
  const list = chain.links || chain.steps.slice(1).map((step, i) => ({ a: i, b: i + 1, from: i, via: step.via }));
  const map = new Map(list.map((l) => [`${l.a}-${l.b}`, l]));
  return (x, y) => map.get(x < y ? `${x}-${y}` : `${y}-${x}`);
}

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** Every order (ends in place) that links all the way down; the dug order first. */
export function solutionsOf(length, between) {
  const middle = Array.from({ length: length - 2 }, (_, i) => i + 1);
  return permutations(middle)
    .map((m) => [0, ...m, length - 1])
    .filter((order) => order.slice(1).every((step, i) => between(order[i], step)));
}

/** The solution sharing the most places with [order] (the first of those, on a tie). */
export function nearest(order, solutions) {
  let best = solutions[0];
  let bestScore = -1;
  for (const solution of solutions) {
    const score = solution.filter((step, place) => step === order[place]).length;
    if (score > bestScore) [best, bestScore] = [solution, score];
  }
  return best;
}

/**
 * Colours for an [order] (the step at each place), against the solution nearest it:
 * green when the person is where that solution has them, yellow when they're not
 * but are linked to someone beside them (a hint they're close), gray when neither.
 * The ends are given, so they get no colour (null). All green between is solved.
 */
export function marks(order, between, solutions) {
  const target = nearest(order, solutions);
  return order.map((step, place) => {
    if (fixed(place, order.length)) return null;
    if (target[place] === step) return 'green';
    const linked = [place - 1, place + 1].some((other) => between(step, order[other]));
    return linked ? 'yellow' : 'gray';
  });
}

/**
 * How hard a chain is, from its traps: wrong orders where five of the six links
 * connect, which look nearly done but aren't. More solutions make it easier. No
 * traps is Easy (every link there is part of the answer), up to three per solution
 * Medium, more Hard. Over the first chains that splits about a quarter, a half, a quarter.
 */
export function difficultyOf(length, between, solutions) {
  const middle = Array.from({ length: length - 2 }, (_, i) => i + 1);
  const traps = permutations(middle)
    .map((m) => [0, ...m, length - 1])
    .filter((order) => order.slice(1).filter((step, i) => between(order[i], step)).length === length - 2).length;
  const perSolution = traps / Math.max(1, solutions.length);
  return perSolution === 0 ? 'Easy' : perSolution <= 3 ? 'Medium' : 'Hard';
}

/** Whether [order] is one of the solutions. */
export const isSolution = (order, solutions) => solutions.some((s) => s.every((step, place) => step === order[place]));

/** A shuffled order for the day: the ends in place, no one where any solution has them, and so not already solved. */
export function scramble(length, random, solutions) {
  const middle = Array.from({ length: length - 2 }, (_, i) => i + 1);
  for (let tries = 0; tries < 300; tries++) {
    const order = [0, ...shuffle(middle, random), length - 1];
    const placed = solutions.some((s) => s.some((step, place) => !fixed(place, length) && step === order[place]));
    if (!placed) return order;
  }
  for (let tries = 0; tries < 300; tries++) {
    const order = [0, ...shuffle(middle, random), length - 1];
    if (!isSolution(order, solutions)) return order;
  }
  return [0, ...middle.reverse(), length - 1];
}

/** Green people stay where they are; the rest (but the ends) change places among themselves. */
export function reshuffle(order, currentMarks, random = Math.random) {
  const loose = order.map((_, place) => place).filter((place) => !fixed(place, order.length) && currentMarks[place] !== 'green');
  const moved = shuffle(loose.map((place) => order[place]), random);
  const next = order.slice();
  loose.forEach((place, i) => (next[place] = moved[i]));
  return { order: next, marks: currentMarks.map((m, place) => (loose.includes(place) ? null : m)) };
}

export function shuffle(items, random = Math.random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A seeded random number generator (mulberry32): the same day, the same puzzle for everyone. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Days since 1970 for an ISO date. */
export const epochDay = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400e3);

/** Today, as the player's own calendar has it. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day's chain: the one scheduled for [date] (each chain in the file has a
 * date, given once by the digger and never changed). Past the end of the
 * schedule, or before it, a scheduled chain is played again rather than nothing.
 */
export function chainFor(date, chains) {
  const exact = chains.find((c) => c.date === date);
  if (exact) return exact;
  const before = chains.filter((c) => c.date && c.date < date);
  const pool = before.length ? before : chains;
  const n = Math.abs(epochDay(date));
  return pool[n % pool.length];
}

/** The day's puzzle: its chain, number, links, solutions, difficulty, and the order it starts from. */
export function puzzleFor(date, chains) {
  const day = epochDay(date);
  const number = Math.max(0, day - epochDay(FIRST_DAY)) + 1;
  const chain = chainFor(date, chains);
  const between = linksOf(chain);
  const solutions = solutionsOf(chain.steps.length, between);
  return {
    date,
    number,
    steps: chain.steps,
    between,
    solutions,
    difficulty: difficultyOf(chain.steps.length, between, solutions),
    start: scramble(chain.steps.length, seeded(day * 131 + 7), solutions),
  };
}

export const solved = (progress) => progress.attempts.at(-1)?.marks.every((m) => m == null || m === 'green') === true;
export const over = (progress) => solved(progress) || progress.attempts.length >= ATTEMPTS;

/** "6 Degrees #3 · Hard · 4/6" and a row of squares per attempt (the five between), for sharing. */
export function shareText(progress, number, difficulty) {
  const score = solved(progress) ? `${progress.attempts.length}/${ATTEMPTS}` : `X/${ATTEMPTS}`;
  const rows = progress.attempts.map((a) =>
    a.marks
      .filter((m) => m != null)
      .map((m) => ({ green: '🟩', yellow: '🟨' })[m] || '⬜')
      .join(''),
  );
  return `6 Degrees #${number} · ${difficulty} · ${score}\n\n${rows.join('\n')}`;
}
