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
  - [x] 2. Link flights to the account — the account page lists the tasks you
        flew. src/pages/pilots.json.ts builds an archive-wide roster (294
        pilots / 11 days / 21 KB) by reading only the first 8 KB of each IGC
        for its HFPLTPILOT header, so it costs ~190 ms rather than re-reading
        560 MB. Search your name, claim it, and pilot_claims rows are written
        per comp. This is the only way the history joins up: Bill Belcourt is
        entry .4 in chelan2026 and .3 in chelan-us-open-2026, and the names
        themselves are dirty ("casey gerstle", "(Bruno) Subarno.1177.131",
        one blank) — see src/lib/pilots.ts.
  - [x] 2b. The 3D view requires an account — the reason to sign up.
        src/scripts/gate3d.ts is what the 3D page imports now; it checks the
        session and only then dynamically imports track3d.ts, so a signed-out
        visitor gets a sign-in wall for ~4 KB instead of the 4.1 MB Cesium
        chunk plus the day JSON. The "View in 3D" pill on the day page picks
        up a "· sign in" note when signed out (nav-account.ts, which already
        reads the session on every page). Sign-in returns you to the viewer:
        the gate links to /account?next=<path>, and account.ts parks that path
        in localStorage while the magic-link email is out, since the link
        comes back on a bare /account — possibly in a different tab. Only
        same-origin paths are honoured. It's a UI gate, not a security
        boundary — the day JSON stays public, see the decision doc.

  - [x] 3. Annotations — notes against (comp, day, pilot_key, time_ms), in the
        3D viewer. Private to the account that wrote them; link-sharing is
        wanted but explicitly deferred (see below).
        Display is "pin + panel": a numbered chip on the track at the annotated
        fix, the text in the right-hand dock, and a pennant on the altitude
        scrubber's time axis. Click a pin to focus its row; click a row to seek
        the playhead, show that pilot and pin them, which hands the follow-cam
        over so the camera flies to the moment. Pins hide with their pilot's
        track.
        Placing one is a single button — "＋ Add note here" takes the pinned
        pilot at the playhead. The moment stays adjustable: an open composer
        rides the playhead (AnnotationLayer.onFrame, called from track3d's
        frame), so scrubbing and saving moves the note. Opening an edit seeks
        to the note first, or composing against a playhead parked elsewhere
        would silently move it on save.
        Anchored to time, never a fix index: the tracks are
        downsampled, so an index moves on re-export and a timestamp doesn't.
        src/lib/annotations.ts + src/scripts/annotations3d.ts, schema in
        0004_annotations.sql. mountTimeline now returns a {seek, setMarkers}
        handle, and the altitude plot takes a getMarkers callback — the only
        changes to shared 2D/3D code. Ticks are on the Altitude plot only; the
        Time Lost plot doesn't draw them yet.
  - [x] 3c. Two resizable, collapsible docks in the 3D viewer — pilots left,
        notes right, globe between them. src/scripts/dock3d.ts: each dock drags
        by its map-facing edge and collapses to a 28 px rail carrying a sideways
        title, with the width and collapsed state persisted per side like the
        chart dock's height. Column widths are CSS custom properties on
        .viewer3d, so a drag is one style write and the map's 1fr absorbs the
        rest. Two things worth remembering: Cesium only re-reads its canvas size
        on a window resize, so the docks dispatch a synthetic one — coalesced to
        one per animation frame, because each costs a WebGL realloc AND an
        altitude-plot rebuild over every pilot's profile, which locks the main
        thread up if fired per pointermove. Narrow windows start both collapsed.
        The account link lives in the notes dock's bar, since the viewer is
        fixed to the viewport and covers the site nav.

  - [x] 3d. "Your flights" links into the 3D view — a "◈ 3D" link on every
        claimed task, plus a right-aligned "N notes" pill that only appears on
        tasks this account has actually annotated. The pill points at
        /3d#notes, and dock3d.ts opens the notes dock when it sees that hash,
        so arriving from here never lands on a collapsed rail (it overrides for
        that visit without rewriting the stored preference). Counts come from
        one countMyAnnotationsByDay() query for the whole account rather than
        one per task, run after the list paints so the static roster never
        waits on Supabase — and swallowed on failure, since an unmigrated
        project shouldn't break "your flights".
  
  - [x] Fix mobile view

  - [ ] 3b. Share a day's notes by link. Wanted, deliberately not built yet, and
        nothing speculative was added to the schema for it: a share is a
        property of a *set* of notes, and the set already has a natural key —
        (user_id, comp, day). So it lands as its own `annotation_shares` table
        plus a `security definer` reader function taking the token, rather than
        a column on `annotations` or a select policy widened to anon. Sketched
        in full at the tail of 0004_annotations.sql. The client render path is
        already written so a note need not belong to the reader.

  - [ ] 4. Individual comparative results — /pilot/<slug> precomputed at build
        like the day JSONs (a query over public data, so no auth needed); the
        claims from step 2 are what say which slug is you.

  Claims come in two scopes (0003_day_claims.sql): a name claim covers every
  task a pilot flew in a comp, and a one-off claim covers a single task — for
  borrowed or shared trackers, where the result is yours but the name on it
  isn't. The one-off control lives in the pinned pilot's breakdown panel on the
  day page, and your own claimed result is pinned automatically on load. Claims are honour-system and shared by choice
  (0002_shared_claims.sql): a duplicate claim costs the real pilot nothing, and
  exclusivity broke legitimate cases (two pilots sharing a name slug, one
  person with two accounts).

  - [x] Add 3D button to the archive links

  - [x] Add 3d link to user account flights 