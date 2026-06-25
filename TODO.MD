- [x] Move archive analysis to build time and only save results for later display
    - Archived days now precompute {table, climb, map} once at build via the
      endpoint src/pages/archive/[comp]/[day].json.ts (reads the on-disk
      IGC/task files). The client fetches that JSON and renders directly —
      no IGC download, no client-side analysis. Day 2 went from ~60 MB of
      IGCs + full re-analysis to a ~2 MB-gzipped results.json. The IGC/xctsk
      files stay in the archive dir (read only at build). Upload page still
      runs the live client-side analysis via runAnalysis.


- [ ] Improve mobile display
    - [ ] Make hover labels for map lines easier to trigger on mobile and desktop (line thickness?)

- [ ] Make line colors (map and thermal plot) easier to map to pilot.
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

- [ ] Show optimized task line, not cylinder connections 