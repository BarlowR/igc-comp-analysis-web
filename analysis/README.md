# Analysis prototypes

Throwaway Python for prototyping competition-analysis ideas before porting the
keepers into the app (`src/`). Reads the same precomputed task JSON the site
uses: `dist/archive/<comp>/<day>.json` (build it with `npm run build` if the
`dist/` copies are missing).

## `progress_prototype.py` — Time Lost race chart

Turns a day's tracklogs into a per-pilot **Time Lost at par pace** line — a
"progress vs time" view that shows *when and where* the top pilots won the race.

For every pilot, at each GPS fix:

```
τ(t) = pace · ( D_rem/V_g  +  max(0, D_rem/g − (h − h_fin)) / M ) / 60   [minutes]
```

the **two-phase model**: glide time for the whole remaining course plus climb
time for whatever height the course still needs beyond what's in hand, under
the idealisation "no distance made while climbing, no climbing on glide". The
single `max` is the physics — height owed can't be negative — and doubles as
the final-glide cap (surplus height above the slope is worth nothing). The
chart plots `L = τ + elapsed − τ_ref`: **flat = par, up = losing, down =
gaining**, and vertical gaps are literal minutes. A finisher's final L is their
minutes behind the median winner.

### Modelling choices

- **`D_rem`** — shortest optimised route from the pilot's *current position*
  through every un-tagged turnpoint to the finish, **re-optimised each fix**
  (iterative cylinder tangent-point bisector). Anchored to the real position, so
  flying off the course line lengthens it → shows as a loss.
- **Finish = ESS.** The timed race ends at the End of Speed Section, so
  everything routes/measures to the `type=="ESS"` turnpoint. The goal cylinder is
  only the completed-or-not flag (already encoded by the results table). Falls
  back to the last turnpoint if there's no explicit ESS.
- **Empirical par, no hand-set constants** — from the day's top-10 finishers:
  `M` = median achieved climb rate; `V_g` and `g` = ground speed and glide ratio
  measured over their gliding fixes (smoothed sink < −0.3 m/s in the scored
  window; `g ≡ V_g/sink`, which makes par gliding exactly neutral). Falls back
  to 60 km/h / 7:1 below 600 s of glide sample. No wing polar needed.
- **`pace`** — actual median gate→ESS duration ÷ raw model τ at the start state.
  The two-phase idealisation omits thermal drift and porpoising, so its raw
  ghost runs slow; this one measured ratio pins the ghost's total to the real
  par duration — it's what makes the par line horizontal.
- **`h_fin`** = minimum crossing altitude (≈ goal ground). *No clamp* — a pilot
  who crosses ESS higher shows a negative residue ("energy carried into the
  finish"); a pilot who crosses lowest lands on 0.
- **Altitude** is GPS MSL, lightly smoothed (`--smooth`, default 7 s). The dataset
  has no pressure track.

### Run

```bash
# one-time: create a venv and install matplotlib (numpy NOT needed)
python3 -m venv .venv-proto
.venv-proto/bin/pip install matplotlib

# render a day (writes <outdir>/time_lost.png)
.venv-proto/bin/python analysis/progress_prototype.py \
    --day dist/archive/chelan-us-open-2026/day2.json \
    --outdir analysis_out/chelan-us-open-2026_day2
```

The computation is stdlib-only, so it runs without matplotlib too (it just prints
the summary and skips the plot). ~18 s/day (per-fix route re-optimisation,
warm-started between fixes).

### Options

| flag | default | notes |
| --- | --- | --- |
| `--day` | chelan2026/day3 | path to a `dist/archive/.../<day>.json` |
| `--outdir` | `analysis_out` | output directory (gitignored) |
| `--topn` | `3` | how many top finishers to highlight |
| `--smooth` | `7.0` | altitude smoothing window (s) |

There are no model knobs: `M`, `V_g`, `g` and `pace` are all measured from the
day's own tracks (see above), matching the app.

## `parity_check.py` — TS ↔ Python cross-check

Recomputes τ from the raw tracks with this prototype's geometry and formula,
fed the app's own shipped day constants (`timeToGo`), and diffs against the
app's stored `tau` arrays. Any gap is a genuine logic divergence, not a
calibration difference. Run after `npm run build`:

```bash
python3 analysis/parity_check.py          # all built days; exits non-zero on divergence
```

Outputs and the venv are gitignored (`analysis_out/`, `.venv-proto/`).
