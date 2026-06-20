# Session Context — comp_analysis → web port

This file captures the context of the Claude Code session that created this
project, so work can continue from this directory.

## Original request

> Translate the `comp_analysis` tooling into a standalone web page with a task
> and IGC upload. First make a plan. Use Astro.

Follow-up clarifications from the user:

- **IGC upload mode:** multi-file picker for `.igc` files, plus a *separate*
  upload control for the task `.xctsk` file.
- **Output style:** modernize the UI (keep the same data/analysis, but render a
  styled HTML table and cleaner charts — not a 1:1 Plotly clone).
- **Location:** the webapp must live in its **own top-level folder**
  (`/Users/rbarlow/Documents/igc-comp-analysis-web`), *not* nested inside the
  `igc-tools` Python repo. (The user rejected an initial attempt to scaffold it
  under `igc-tools/web/`.)

## Source material (the Python tooling being ported)

Lives in `/Users/rbarlow/Documents/igc-tools`:

- `utils/math_utils.py` — `haversine`, `build_direction_heading_fields`,
  `three_point_normalizer`, `clip`.
- `xctsk_lib.py` — parses XContest `.xctsk` task files (plain JSON): turnpoints
  (radius, type TAKEOFF/SSS/ESS, lat/lon/name), `sss.timeGates`, goal.
- `igc_lib.py` — `igclog` class: IGC B-record parsing, outlier filtering,
  per-fix metrics (vertical speed over 1/5/20/30s windows, distance, glide vs
  climb vs stopped categorization), cumulative metrics, the **competition
  window** (filter from SSS start gate to GOAL, track turnpoint-cylinder
  progress), and a `stats` dict.
- `comp_analysis.py` — `CompetitionFlight`: loads many pilots against one task,
  builds the color-graded stats table (`COMP_SUBSET` defines columns, labels,
  and gradient direction) and the climb-rate distribution plot, split into
  "Completed Task" / "Did Not Complete Task" groups.

Sample data used for verification: `igc-tools/day2/` (11 IGC files +
`task_2026-06-17.xctsk`).

## What was built (this project)

Static, client-side-only Astro + TypeScript app. No backend — all parsing and
analysis runs in the browser.

| Python                | TypeScript                |
| --------------------- | ------------------------- |
| `utils/math_utils.py` | `src/lib/math.ts`         |
| `xctsk_lib.py`        | `src/lib/xctsk.ts`        |
| `igc_lib.py`          | `src/lib/igc.ts`          |
| `comp_analysis.py`    | `src/lib/competition.ts`  |

- `src/pages/index.astro` — page shell + modern dark UI styling. Separate task
  upload + multi-file IGC picker + Analyze button.
- `src/scripts/app.ts` — browser island: reads files, runs `Competition`,
  renders the styled HTML stats table and Chart.js climb-rate charts (dashed
  vertical lines = each pilot's average climb rate).
- `test/verify.ts` — Node verification harness (see below).

### Porting approach / key implementation notes

- pandas/numpy DataFrames are reimplemented as **column arrays** (`number[]`,
  with `NaN` standing in for pandas NaN). Helpers in `math.ts` mirror
  `diff(periods)`, `shift`, `cumsum` (skipna), `clip`, `where`, boolean masks
  (NaN compares to false), `nanmean`.
- **Critical faithfulness detail:** the Python competition window *copies* the
  already-computed full-flight per-fix columns and then *filters* by time — it
  does **not** recompute them. So the first ~30 rows of the comp window keep
  deltas/distances referencing positions *before* the start gate. The port
  replicates this by **slicing** the full-flight columns (`sliceColumns` in
  `igc.ts`), then only recomputing cumulative metrics over the window. An
  earlier version that recomputed per-fix columns on the filtered window
  produced small diffs in `comp_total_distance`, `comp_total_time_gliding_s`,
  and `comp_percentage_time_climbing_on_glide_s` — fixed by switching to slice.
- Turnpoint progress: SSS advances on cylinder **exit**, regular turnpoints on
  **entry**; task is COMPLETED when reaching the ESS (second-to-last turnpoint).
- `COMP_SUBSET` gradient logic ported exactly: `shade=230`, green channel for
  `*_positive` metrics, red for `*_negative`, normalized per column over the
  group; "most_*" inverts the normalized value. `comp_total_meters_climbed` and
  `comp_thermal_meters_climbed` have `None` gradient in the Python source, so
  they render as plain/uncolored cells here too (preserved intentionally).

### Decisions / defaults chosen

- Vanilla TS island (no React/Vue) + **Chart.js** for charts (modern look,
  legend toggling, custom plugin draws the avg-climb-rate vertical lines).
- Kept the Python's uncolored `comp_total_meters_climbed` /
  `comp_thermal_meters_climbed` quirk rather than "fixing" it. Open question:
  user may want those colored later.

## Verification status — PASSED

Ported output diffed against a Python reference run over `igc-tools/day2/`
(11 pilots). **All 19 checked metrics match to floating-point machine
precision** (worst relative diff ~1e-15), with identical `completed` and
`completion_time` values and zero structural problems.

Re-run the verification:

```bash
# Python reference (run from igc-tools/, requires its deps): writes /tmp/py_ref.json
# (see the inline script used in-session, or comp.save_stats_csv)

# JS side:
cd /Users/rbarlow/Documents/igc-comp-analysis-web
npx esbuild test/verify.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs
node /tmp/verify.mjs /Users/rbarlow/Documents/igc-tools/day2 \
  /Users/rbarlow/Documents/igc-tools/day2/task_2026-06-17.xctsk
```

## Build / run

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output -> dist/
npm run preview
```

Build and a dev-server smoke test both pass.

## Possible next steps (not done)

- Visual/manual QA in a real browser (table gradients, chart legend toggling).
- Optionally color the two currently-plain "meters climbed" columns.
- Add a map/track view, or per-pilot drill-down (the Python lib also has KML
  export and additional metrics not surfaced in the comp table).
- Drag-and-drop upload; remember/restore last task; CSV export of the table.
