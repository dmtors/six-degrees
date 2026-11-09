# 6 Degrees

A daily chain of seven famous people, each one's Wikipedia article linking to
the next: a co-star, a bandmate, a spouse, a rival. Two people are linked when
either one's article has a link to the other's in a paragraph of its main text
(redirects included). A plain mention without a link doesn't count, and nor do
links in tables, lists, info boxes or captions. The first and last are
given; put the five in between back in order by swapping two at a time. Six
tries.

Any order that links all the way down counts. Colours are about places:

- **Green**: right person, right place
- **Yellow**: wrong place, but linked to someone beside them
- **Gray**: wrong place, and linked to neither neighbour

The ends are given and never coloured. When a chain has more than one
solution, each check is marked against the solution sharing the most places
with your order (ties go to the dug order), so every green comes from one
solution: keeping your greens always leads to a win, and Shuffle leaves them
in place. Out of tries, "Show the chain" shows that nearest solution.

Each chain is rated **Easy**, **Medium** or **Hard** (shown in the header,
and in the share text) from its traps: wrong orders where five of the
six links connect. Traps per solution: none is Easy, up to 3 Medium, more Hard.
It's worked out from the chain's links in the page (`difficultyOf`), so it
needs nothing extra in the data.

Once the chain is out, each link shows the sentence that connects the pair, as
the article above has it, linking to that spot in the article.

Ported from Burrow in the Commonplace Android app (`core/game/Burrow*.kt`,
`ui/play/BurrowScreen.kt`), kept to people, and famous ones. Two changes from
Burrow: both ends are fixed (from someone to someone, in six degrees), and the
chains are celebrities only.

## Run

Plain HTML, CSS and ES modules, no build step.

```bash
python3 serve.py   # port 5182, caching off
```

`?day=2026-11-12` plays another day's chain (for testing; past the schedule, an old chain). Progress is saved
per day in `localStorage`; `?reset` starts the day over.

## Daily puzzles

Live at <https://dmtors.github.io/six-degrees/>. Every chain has a date, given
once and never changed: `data/chains.json` is the schedule, and the game plays
the chain dated today (the player's own date). Chains dug but not yet given a
day wait in `data/pool.json`, which isn't published.

A GitHub Action (`.github/workflows/daily.yml`) runs every night at 04:23 UTC:

1. checks the pool against the current rules (scheduled days are never touched),
2. gives days to pool chains until the schedule reaches 30 days past today,
3. digs until the pool holds 20 chains again (up to 75 minutes), scheduling as it goes,
4. commits the data and publishes the site to GitHub Pages.

So a month of days is always ready, and a few failed nights change nothing. If
the schedule gets within a week of its end, the dig step fails on purpose so
GitHub emails you. Past the end, the game replays an old chain rather than
breaking. A push to `main` publishes too; run it by hand from the Actions tab.

Scheduling keeps days varied: nobody plays twice within 7 days, no chain shares
3 or more people with a chain from the last 90 days, a start-and-finish pair is
never used twice, and the difficulty changes from the day before when it can.
While digging, it steers away from people already in two or more chains.

```bash
node tools/dig.mjs --ahead 30 --pool 20 --minutes 0   # what the Action runs (0 = no time limit)
```

## Chains

The chains come with the site, dug ahead of time, so a day's puzzle needs no
API calls (photos load from Wikimedia's image servers).

It starts from famous people (a fresh sample of the Level 5 vital-articles
entertainers, musicians and sports figures each night, plus everyone already in
a chain), reads each article's paragraphs, and follows links to other famous
people: described as a person with a screen/music/sport/media occupation (not
famous only for writing), born since 1880, read at least 15,000 times a week,
not a politician, royal or criminal. Half the time it crosses fields (actor to
singer to athlete) when it can. Dead ends step back and try another way.

For each chain it then records every pair of the seven that are linked
(either article's paragraphs mentioning the other, redirects included), with
the sentence. Any order that links all the way down solves the puzzle, and
the reveal quotes whichever link sits between each pair. Chains with more
than 3 solving orders are dropped as too easy; the rest keep their count in
`solutions`.

It's deliberately slow: one request every 2 seconds, honouring `Retry-After`,
with the repo's URL as the contact in its User-Agent.

## Files

- `js/game.js`: the rules (colours, scramble, daily pick, difficulty, share text)
- `js/app.js`: the page, swapping, saving, the reveal
- `tools/dig.mjs`: digs and schedules chains (Node 18+)
- `data/chains.json`: the schedule, one chain per day
- `data/pool.json`: chains dug but not yet given a day
- `.github/workflows/daily.yml`: the nightly dig, schedule and publish
