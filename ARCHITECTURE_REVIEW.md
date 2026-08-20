# Architecture inspection

- **Date:** 2026-08-19
- **Scope:** all code at commit `e87a08e` (`Notebooks` branch)
- **Full version:** https://claude.ai/code/artifact/41e6641e-32e6-4c20-bfdd-df2b20a53414
- **Work done:** sections 1 to 4. Section 1 is migration `0010` plus small
  code changes. Section 4 made `lib/dom.ts`, `lib/db.ts`,
  `lib/account-gate.ts`, and `lib/links.ts`. Section 3 divided `analysis.ts`
  into `lib/replay.ts`, `scripts/map-leaflet.ts`, `scripts/tables.ts`, and
  `scripts/climb-chart.ts`. The 3D pages get 330 KB less JS and CSS. One
  `Results` type is in `competition.ts`. Section 2 added
  `lib/results-codec.ts`, `map.route`, and `timeToGo.par`. The largest
  `day.json` decreased from 11.7 MB to 3.8 MB. Only section 5 stays open.

The architecture is correct for the features we have. Static builds for the
archive, plus Supabase for each user's data, is the correct division. A
replatform is not necessary. The problems sit at the edges:

- two very large modules
- a `day.json` that is too large
- six data modules that do not agree
- some `RLS` rules that are not there
- a heavy repository

## Good parts — keep these

- One path calculates all results: `Competition.buildResults()` supplies the build,
  `/analyze`, and the saved-comp `Recompute`.
- The three-tier session read (`hasStoredSession` → `readCachedSession` → SDK)
  keeps `supabase-js` off most pages.
- Cesium, `supabase-js`, and `saved-comps` load late, only where necessary.
- All code obeys the no-`innerHTML` rule.
- The decision records (`docs/decisions/`) are good. Continue them.

## 1. Defects — do these first

- All persons can read `pilot_claims` (`0001_accounts.sql:85`). The comments
  in `0002_shared_claims.sql` and `claims.ts` say the opposite. Make one of
  the two correct. Migration `0009` removed the public `profiles` table, so a
  visitor cannot connect a claim to a name.
- The `notebook_notes` `UPDATE` policy does not do the notebook-ownership test
  that `INSERT` does (`0008_notebooks.sql:66-76`). A `note` can move into a
  different account's notebook. `0007_user_comps.sql:52-73` shows the correct
  test.
- `deleteComp()` (`saved-comps.ts:284`) does not remove the annotations with
  `comp='saved'`. The annotations then have no parent. The account page shows
  raw UUIDs for them.
- You cannot apply a migration two times. `create policy` stops with an error
  on a second run (`0001`–`0006`, `0008`). Apply the `drop policy if exists` +
  `create` order from `0007`.
- `claims.ts:52` makes a PostgREST filter from text pieces. Replace it with
  builder methods.
- `gate3d` accepts an old session that the SDK can `refresh`.
  `annotations3d.ts:102` refuses the same session. That user gets the globe
  without the notes panel. Make the two tests agree.
- `init()` in `account.ts` has no catch on the `prefillFromCache()` path. If
  the SDK import stops, the page shows no error and does not change.
- No table has a server-side `updated_at` `trigger`. Each client writes its
  own clock. Add one `trigger` function.

## 2. `day.json` is too large

A large day's `day.json` is 11.5 MB, and ~98% is `map`. Decrease it to ~3 MB:

- Limit coordinates to 7 decimals and `alt` to 1 m.
- Write only the deltas for `times`. At this time they are absolute epoch ms
  for each fix.
- Put `finalGlide` (1 MB of JSON booleans) in a bitmask.
- Remove the fields that no client reads: `MapTrack.completed`,
  `timeToGo.Vcc/hFin/dTask/hRef`.
- Put the optimized route and the par line in `day.json`. The client
  calculates the two again, with different algorithms (`math.ts:146` vs
  `timetogo.ts:135`, and `analysis.ts:1245` vs `competition.ts:441`). The two
  algorithms can disagree.

A smaller `day.json` also removes the 12 MB main-thread `JSON.parse` and the
double-rAF code in `archive.ts:44`.

## 3. Module structure

- `analysis.ts` (2474 lines) is seven modules in one file. Divide it into
  `lib/replay.ts` (selection, `positionAt`, `altAt`, the timeline, the canvas
  plots — no Leaflet, no Chart.js), `map-leaflet.ts`, `tables.ts`, and
  `climb-chart.ts`. The only connection is three module-level `let`s
  (`analysis.ts:85-101`).
- The 3D pages then do not include the 337 KB of Chart.js + Leaflet (+ CSS)
  that they do not run.
- `track3d.ts` contains the 2D per-frame logic a second time
  (`track3d.ts:702/251/175` vs `analysis.ts:840/503/511`). The same constants
  live in the two files. Make one `trailUpTo` and one `renderStyle`.
- Make one `Results` type in `competition.ts`. Remove the copy in
  `analysis.ts:45`.
- Remove these: `vite-plugin-cesium`, the `nameFromFile` re-export,
  `pilot_claims.verified`.

## 4. Make one copy

- The code has six copies of `el()`, three of `$()`, five of `setStatus` (in
  three different forms), and four of `describe(err)`. Put them in
  `lib/dom.ts`.
- Put `requireUid()` (two copies), one `select` function, and
  `isUniqueViolation()` in `lib/db.ts`.
- Make one `gateAccountPage()`. `saved.ts` and `notebooks.ts` have the same
  30-line `init()`.
- Make `lib/links.ts`. The deep-link URLs connect all features, but the three
  hash prefixes `#note=`, `#notes`, and `#note-` live in six files, with
  three different parsers. Put the link rules in one module, with tests.

## 5. Heavy data and operations

- 1.1 GB of IGC files live in git (`.git` is 319 MB). Move them to LFS, a
  data repository, or object storage.
- The build calculates all 43 days again each time, but the days do not
  change. Calculate `day.json` at `npm run archive` time. The build then only
  copies files. An `ANALYSIS_VERSION` change gets its own re-run script.
- Add a CI flow that runs `npm test` + `tsc --noEmit` + `astro build`. First
  add `@types/node`. `tsc` found a defect on this branch.
- `copy-cesium-assets.mjs:22` exits 0 when there is no source. A build
  without `prebuild` then gets a `404` for each Cesium worker. Make it stop
  the build with an error.
- The 3D basemap gets tiles directly from `tile.openstreetmap.org`. The OSM
  policy does not let sites do that. Change the default basemap.
- `deleteComp` lists a maximum of 1000 objects. More objects stay in storage.
  There is no limit for each user's uploads. If only some of the uploads happen,
  data can stay in storage with no report.

## Order of work

1. Section 1 — one migration plus small code changes.
2. Section 4 — only moves code. The output does not change.
3. Section 3 — divide `analysis.ts` before more code goes into it.
4. Section 2 — add a version to the encoder. Then build the archive again.
5. Section 5 — the data and build work. Do it while the archive is small.
