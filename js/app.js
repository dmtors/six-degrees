// The page: today's chain, swapping, checking, the reveal, sharing. Progress
// is kept in this browser (per day), so a reload carries on where you were.

import { ATTEMPTS, fixed, marks, reshuffle, puzzleFor, today, solved, over, shareText, nearest } from './game.js';

const $ = (id) => document.getElementById(id);
const ARTICLE = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const OPEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 7H3v10h10v-5h2v7H1V5h7z"/><path d="M19.001 2 19 8h-2V4.415l-9 9L6.586 12l9-8.999L12 3V1h6.001z"/></svg>';
const PERSON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 11a6 6 0 016 6v2H2v-2a6 6 0 016-6z"/><circle cx="10" cy="5" r="4"/></svg>';

let puzzle;
let progress;
let selected = null;
let showAnswer = false;

// ---------- Saving ----------

const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
// v2: colours by place. Games saved under the old link colours start over.
const saveKey = () => `six-degrees:v2:${puzzle.date}`;
const save = () => storage.set(saveKey(), { first: puzzle.steps[0].title, ...progress });

// ---------- Starting ----------

/** ?day=2026-11-12 plays another day's chain (handy for testing); otherwise today's. */
function chosenDay() {
  const day = new URLSearchParams(location.search).get('day');
  return /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : today();
}

async function start() {
  let chains;
  try {
    const response = await fetch('data/chains.json');
    chains = await response.json();
  } catch {
    chains = [];
  }
  if (!chains.length) {
    $('prompt').textContent = 'No chains yet. Dig some with tools/dig.mjs.';
    $('controls').hidden = true;
    return;
  }
  puzzle = puzzleFor(chosenDay(), chains);
  // ?reset starts the day's chain over (for testing), then drops itself from the address.
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) {
    try {
      localStorage.removeItem(saveKey());
    } catch {}
    params.delete('reset');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  const saved = storage.get(saveKey());
  progress =
    saved && saved.first === puzzle.steps[0].title && saved.order?.length === puzzle.steps.length
      ? { order: saved.order, marks: saved.marks, attempts: saved.attempts || [] }
      : { order: puzzle.start, marks: puzzle.start.map(() => null), attempts: [] };

  const date = new Date(`${puzzle.date}T12:00:00`);
  $('difficulty').textContent = puzzle.difficulty;
  $('difficulty').title = {
    Easy: 'Easy: every link here is part of the answer',
    Medium: 'Medium: a few wrong orders look nearly right',
    Hard: 'Hard: many wrong orders look nearly right',
  }[puzzle.difficulty];
  $('meta').textContent = ` · #${puzzle.number} · ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  buildChain();
  revealedChange = true; // no slide on the first layout
  render();
  if (!storage.get('six-degrees:welcomed')) {
    storage.set('six-degrees:welcomed', true);
    $('help').showModal();
  }
}

// ---------- The chain ----------

const shortName = (title) => title.replace(/ \([^)]*\)$/, '');

/** A link that opens the article with the sentence highlighted (where browsers support text fragments). */
function quoteLink(title, sentence) {
  const words = sentence.split(/\s+/);
  const piece = (w) => encodeURIComponent(w.join(' ')).replace(/-/g, '%2D').replace(/,/g, '%2C');
  const fragment = words.length > 10 ? `${piece(words.slice(0, 5))},${piece(words.slice(-4))}` : piece(words);
  return `${ARTICLE(title)}#:~:text=${fragment}`;
}

/** The quote, with the person it leads to in bold: their full name if it's there, else their surname. */
function quoteWithName(el, sentence, name) {
  const surname = name.split(' ').at(-1);
  let at = sentence.indexOf(name);
  let length = name.length;
  if (at < 0 && surname.length > 2) {
    at = sentence.indexOf(surname);
    length = surname.length;
  }
  const bold = document.createElement('b');
  if (at < 0) {
    el.textContent = `“${sentence}”`;
    return;
  }
  bold.textContent = sentence.slice(at, at + length);
  el.append(`“${sentence.slice(0, at)}`, bold, `${sentence.slice(at + length)}”`);
}

/**
 * The sentence that links two people next to each other, in whichever of their
 * articles has it, with the other one's name in bold.
 */
function showLink(figure, upper, lower) {
  const link = puzzle.between(upper, lower);
  figure.textContent = '';
  if (!link?.via) return false;
  const owner = puzzle.steps[link.from];
  const other = puzzle.steps[link.from === upper ? lower : upper];
  const quote = document.createElement('blockquote');
  quoteWithName(quote, link.via, shortName(other.title));
  const caption = document.createElement('figcaption');
  const a = document.createElement('a');
  a.target = '_blank';
  a.rel = 'noopener';
  a.href = quoteLink(owner.title, link.via);
  a.textContent = `From ${shortName(owner.title)}’s article`;
  caption.append(a);
  figure.append(quote, caption);
  return true;
}

/** One list item per person, made once; render() moves and colours them. */
function buildChain() {
  const list = $('chain');
  list.textContent = '';
  puzzle.steps.forEach((step, index) => {
    const item = document.createElement('li');
    item.className = 'person';
    item.dataset.step = index;

    // The sentence linking this person to the one above, filled in once it's out (see showLink).
    const via = document.createElement('figure');
    via.className = 'via';
    via.hidden = true;

    // The card: the person (tap to pick or swap), and beside them a link to their article.
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <button type="button" class="pick">
        <span class="face">${step.thumb ? `<img alt="" loading="lazy" referrerpolicy="no-referrer">` : PERSON}</span>
        <span class="who">
          <span class="name"></span>
          <span class="desc"></span>
        </span>
      </button>
      <a class="open" target="_blank" rel="noopener">${OPEN}</a>`;
    if (step.thumb) card.querySelector('img').src = step.thumb;
    card.querySelector('.name').textContent = shortName(step.title);
    card.querySelector('.desc').textContent = step.description || '';
    const open = card.querySelector('.open');
    open.href = ARTICLE(step.title);
    open.title = `Read about ${shortName(step.title)} (opens in a new tab)`;
    open.setAttribute('aria-label', open.title);
    card.querySelector('.pick').addEventListener('click', (e) => tap(index, e.detail === 0));

    item.append(via, card);
    list.append(item);
  });
}

/** The order on screen: the answer when it's shown, otherwise the player's. */
/** Out of tries, the answer shown is the solution nearest the last try. */
const shownOrder = () => (showAnswer ? nearest(progress.order, puzzle.solutions) : progress.order);
const shownMarks = () => (showAnswer ? puzzle.steps.map((_, place) => (fixed(place, puzzle.steps.length) ? null : 'green')) : progress.marks);

function render() {
  const done = over(progress);
  const won = solved(progress);
  const revealed = won || showAnswer;
  const order = shownOrder();
  const colours = shownMarks();
  const list = $('chain');
  const items = new Map([...list.children].map((el) => [+el.dataset.step, el]));

  // Move the people into place, sliding from where they were.
  const before = new Map([...items].map(([i, el]) => [i, el.getBoundingClientRect().top]));
  order.forEach((step, place) => {
    const item = items.get(step);
    list.append(item);
    const card = item.querySelector('.card');
    const end = fixed(place, order.length);
    const figure = item.querySelector('.via');
    figure.hidden = !(revealed && place > 0 && showLink(figure, order[place - 1], step));
    const movable = !done && !end;
    card.className = `card${colours[place] ? ` ${colours[place]}` : ''}${selected === place ? ' selected' : ''}${end ? ' end' : ''}${movable ? ' movable' : ''}`;
    const pick = card.querySelector('.pick');
    pick.setAttribute('aria-pressed', selected === place ? 'true' : 'false');
    const name = shortName(puzzle.steps[step].title);
    const state = colours[place] ? `, ${colours[place]}` : '';
    const role = place === 0 ? ', the start' : place === order.length - 1 ? ', the finish' : '';
    pick.setAttribute('aria-label', movable ? `${name}${state}. Tap to ${selected == null ? 'pick' : 'swap'}.` : `${name}${role}${state}`);
    pick.disabled = !movable;
  });
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const [i, el] of items) {
      const dy = before.get(i) - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && !revealedChange) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  revealedChange = false;

  list.classList.toggle('choosing', selected != null);
  list.classList.toggle('over', done);

  // Tries: which one this is, how many are left, and how each used one went.
  const used = progress.attempts.length;
  const left = ATTEMPTS - used;
  $('try-now').textContent = done ? (won ? `Solved on try ${used}` : 'Out of tries') : `Try ${used + 1} of ${ATTEMPTS}`;
  $('try-now').classList.toggle('last', !done && left === 1);
  $('submit').textContent = 'Check';
  $('prompt').textContent = done
    ? won
      ? 'The chain, in order.'
      : showAnswer
        ? 'The chain, in order.'
        : 'Out of tries.'
    : selected == null
      ? `Link ${shortName(puzzle.steps[0].title)} to ${shortName(puzzle.steps.at(-1).title)}.`
      : 'Now tap someone to swap with.';

  $('controls').hidden = done;
  $('submit').disabled = sameAsLast();
  $('outcome').hidden = !done;
  if (done) {
    $('verdict').textContent = won
      ? progress.attempts.length === 1
        ? 'First try. Six degrees, no wrong turns.'
        : `Linked in ${progress.attempts.length} tries.`
      : 'So close. That was a tricky one.';
    $('answer').hidden = won;
    $('answer').textContent = showAnswer ? 'Hide the chain' : 'Show the chain';
    $('history').innerHTML = progress.attempts
      .map((a) => `<div class="row">${a.marks.filter((m) => m != null).map((m) => `<span class="${m}"></span>`).join('')}</div>`)
      .join('');
    $('next').textContent = untilNext();
  }
}
let revealedChange = false;

const sameAsLast = () => {
  const last = progress.attempts.at(-1)?.order;
  return !!last && last.every((s, i) => s === progress.order[i]);
};

// ---------- Playing ----------

function tap(step, fromKeyboard = false) {
  if (over(progress)) return;
  const place = progress.order.indexOf(step);
  if (fixed(place, progress.order.length)) return;
  if (selected == null) selected = place;
  else if (selected === place) selected = null;
  else {
    swap(selected, place);
    selected = null;
  }
  render();
  // From the keyboard, keep focus on the card just used (it may have moved).
  if (fromKeyboard) $('chain').querySelector(`[data-step="${step}"] .pick`)?.focus({ preventScroll: true });
}

function swap(a, b) {
  const order = progress.order.slice();
  [order[a], order[b]] = [order[b], order[a]];
  const m = progress.marks.slice();
  m[a] = null;
  m[b] = null;
  progress = { ...progress, order, marks: m };
  save();
}

$('shuffle').addEventListener('click', () => {
  selected = null;
  progress = { ...progress, ...reshuffle(progress.order, progress.marks) };
  save();
  render();
});

$('submit').addEventListener('click', () => {
  if (sameAsLast()) return;
  selected = null;
  const m = marks(progress.order, puzzle.between, puzzle.solutions);
  progress = { ...progress, marks: m, attempts: [...progress.attempts, { order: progress.order.slice(), marks: m }] };
  save();
  revealedChange = solved(progress);
  render();
  if (solved(progress)) $('outcome').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('answer').addEventListener('click', () => {
  showAnswer = !showAnswer;
  revealedChange = true;
  render();
});

$('share').addEventListener('click', async () => {
  const text = shareText(progress, puzzle.number, puzzle.difficulty);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied your result');
  } catch {
    toast('Couldn’t copy');
  }
});

$('open-help').addEventListener('click', () => $('help').showModal());
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) $('help').close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected != null) {
    selected = null;
    render();
  }
});

/** "Next chain in 5h 12m": it changes at midnight. */
function untilNext() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const minutes = Math.max(1, Math.round((midnight - now) / 60000));
  return `Next chain in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
setInterval(() => {
  if (progress && over(progress)) $('next').textContent = untilNext();
}, 30000);

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('shown'), 2200);
}

start();
