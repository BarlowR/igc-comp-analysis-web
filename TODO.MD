- [x] Move archive analysis to build time and only save results for later display
    - Archived days now precompute {table, climb, map} once at build via the
      endpoint src/pages/archive/[comp]/[day].json.ts (reads the on-disk
      IGC/task files). The client fetches that JSON and renders directly —
      no IGC download, no client-side analysis. Day 2 went from ~60 MB of
      IGCs + full re-analysis to a ~2 MB-gzipped results.json. The IGC/xctsk
      files stay in the archive dir (read only at build). Upload page still
      runs the live client-side analysis via runAnalysis.


- [X] Improve mobile display

- [X] Make line colors (map and thermal plot) easier to map to pilot.
    - Each pilot now keeps one stable color, shared across the map and both
      climb charts. Still no on-map labels (hover a track for the name).

- [x] Use the same color for a pilot for both thermal chart and map

- [x] show deselected pilots in the background on both plots as grey lines

- [x] Add single pilot selection highlight

- [x] Add altitude plot below the map (doubles as the time scrubber)
    - Canvas altitude-vs-time plot under the map, sharing its time axis, pilot
      colours and selection. Grey full profiles for everyone (cached); selected
      pilots get the same comet fade up to the cursor, with dots and a vertical
      time line. Drag the plot to scrub (play/pause button alongside the clock).
- [x] Add time scrubber to map
    - Drives the day in lockstep with the altitude plot (play/pause sweeps it in
      ~30s). Every pilot keeps a full grey route line + a position dot (grey, or
      coloured when selected); selected pilots also get a solid coloured trail
      from launch to their dot. A pinned pilot is drawn on top across the map,
      altitude plot and climb-rate chart.
- [x] Truncate display tracks to [start gate − 15 min, end]
    - End = goal-cylinder crossing (final turnpoint) if the pilot reached goal,
      else landing (last fix). The scored `completed` flag only reaches ESS, so
      we walk the final glide on into the goal cylinder. Stats still run over the
      full flight; only the map/altitude tracks are cut. Tracks that end before
      the start gate (flew and landed pre-task) are dropped from the plots.

- [x] Show optimized task line, not cylinder connections
    - The map now draws the shortest route that touches each turnpoint cylinder
      (the scored "optimized task") as the dashed line, instead of straight legs
      through the cylinder centres. `optimizeTaskRoute` in src/lib/math.ts relaxes
      a point on each circle to minimise total path length, working in a local
      equirectangular (metres) projection. A leading TAKEOFF is dropped so the
      route starts at the SSS cylinder. Cylinders + centre dots are unchanged. 



- [ ] Hike and Fly Tasks

- [ ] User accounts with annotations
      Decision + options in docs/decisions/0001-user-accounts.md: stay static,
      add Supabase for auth and user data. Doing it in three passes.

  - [x] 1. Accounts — passwordless email sign-in, profile, display name.
        src/lib/supabase.ts (lazy client + a localStorage session peek so the
        nav chip costs 0.4 KB instead of pulling the 209 KB SDK onto every
        page), src/pages/account.astro + src/scripts/account.ts, nav chip in
        Base.astro. Schema in supabase/migrations/0001_accounts.sql — RLS is
        the whole security boundary, since the browser talks to Postgres
        directly. Builds with accounts off when the env vars are blank.
  - [ ] 2. Annotations — notes against (comp, day, pilot, time), public or
        private, hung off the existing scrubber.
  - [ ] 3. Individual comparative results — /pilot/<slug> precomputed at build
        like the day JSONs (it's a query over public data, so it needs no
        auth). Accounts only store which slug is you, via pilot_claims. Needs
        a roster picker: pilot names are dirty ("casey gerstle", "(Bruno)
        Subarno.1177.131", one blank) and the per-comp entry number is not
        stable across comps, so identity can't be inferred — see
        src/lib/pilots.ts.