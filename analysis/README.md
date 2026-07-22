# Analysis prototypes

Throwaway Python for prototyping competition-analysis ideas before porting the
keepers into the app (`src/`). Reads the same precomputed task JSON the site
uses: `dist/archive/<comp>/<day>.json` (build it with `npm run build` if the
`dist/` copies are missing).

## `progress_prototype.py` — time-to-go race chart

Turns a day's tracklogs into a per-pilot **time-to-go at par pace** line — a
"progress vs time" view that shows *when and where* the top pilots won the race.

For every pilot, at each GPS fix:

```
τ(t) = ( D_rem(t) / V_cc  −  (h(t) − h_fin) / M ) / 60      [minutes]
```

glide time to the finish at par speed, plus the altitude deficit priced in
climb-minutes. Read the **slope**:

| slope | meaning |
| --- | --- |
| **−1** | flying at par (1 min of time-to-go per min of clock) |
| steeper than −1 | beating the day |
| shallower | bleeding time |
| rising | going backwards (sinking out / off-course) |

Vertical gaps are literal time gaps ("4 min ahead"), and the axis is comparable
across days and sites.

### Modelling choices

- **`D_rem`** — shortest optimised route from the pilot's *current position*
  through every un-tagged turnpoint to the finish, **re-optimised each fix**
  (iterative cylinder tangent-point bisector). Anchored to the real position, so
  flying off the course line lengthens it → shows as a loss.
- **Finish = ESS.** The timed race ends at the End of Speed Section, so
  everything routes/measures to the `type=="ESS"` turnpoint. The goal cylinder is
  only the completed-or-not flag (already encoded by the results table). Falls
  back to the last turnpoint if there's no explicit ESS.
- **Empirical par** — `M` = median achieved climb rate; `V_cc` = optimised task
  distance ÷ median completion time. `V_cc/M` is the MacCready distance value of a
  metre of height. No wing polar needed.
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

# render a day (writes <outdir>/time_to_go.png)
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
| `--day` | chelan-us-open-2026/day2 | path to a `dist/archive/.../<day>.json` |
| `--outdir` | `analysis_out` | output directory (gitignored) |
| `--topn` | `3` | how many top finishers to highlight |
| `--smooth` | `7.0` | altitude smoothing window (s) |
| `--metric` | `time` | `time` (τ in min) or `altitude` (effective m over ESS — the glide-computer arrival-height dual, `= −(M·V_cc)·τ·60`) |

Outputs and the venv are gitignored (`analysis_out/`, `.venv-proto/`).
