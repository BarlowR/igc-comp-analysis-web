#!/usr/bin/env python3
"""Cross-implementation parity test for the time-to-go logic.

The app (`src/lib/timetogo.ts` + `competition.ts`) is a port of this prototype.
On a built archive day, `map.tracks[].tau` is the app's per-fix τ and
`map.timeToGo` its day constants. Here we recompute τ from the SAME raw tracks
using the prototype's geometry + τ, fed the app's own constants, and diff them —
so any gap is a genuine logic divergence between the two implementations, not a
difference in how M / V_cc / h_fin were derived.

    python3 analysis/parity_check.py                 # all built days
    python3 analysis/parity_check.py dist/archive/chelan2026/day3.json

Must match competition.ts: FINAL_GLIDE_RATIO=7, FINAL_GLIDE_BETA=0.05,
FINAL_GLIDE_SPEED_KMH=60, smoothAlt window 7 s.
"""
import glob
import json
import sys

from progress_prototype import build_geom, remaining_series, smooth_alt, to_planar

GLIDE_RATIO = 7.0
BETA = 0.05
GLIDE_SPEED_KMH = 60.0


def tau_of(rem, h, Vcc, M, hFin):
    """τ per fix (minutes) — the exact tauSeries formula from timetogo.ts."""
    g = 1.0 / GLIDE_RATIO
    v_glide = GLIDE_SPEED_KMH / 3.6
    out = []
    for i in range(len(rem)):
        d = rem[i]
        h_need = hFin + d * g
        credit = (min(h[i], h_need) - hFin) + BETA * max(h[i] - h_need, 0.0)
        tau_credit = (d / Vcc - credit / M) / 60
        out.append(max(tau_credit, d / v_glide / 60))
    return out


def check_day(path):
    d = json.load(open(path))
    m = d["map"]
    ttg = m.get("timeToGo")
    if ttg is None or m.get("startMs") is None:
        print(f"{path}: no timeToGo/startMs — skipped")
        return None
    Vcc, M, hFin = ttg["Vcc"], ttg["M"], ttg["hFin"]
    start_ms = m["startMs"]
    task = build_geom(m["turnpoints"])

    worst = 0.0
    worst_ctx = None
    n_fix = 0
    sum_abs = 0.0
    n_cmp = 0
    for tr in m["tracks"]:
        stored = tr.get("tau")
        if not stored:
            continue
        xs, ys = [], []
        for la, lo in tr["points"]:
            px, py = to_planar(la, lo, task.lat0, task.lon0)
            xs.append(px)
            ys.append(py)
        t_s = [(ms - start_ms) / 1000.0 for ms in tr["times"]]
        h = smooth_alt(t_s, list(tr["alt"]), 7.0)
        rem = remaining_series(task, xs, ys)
        mine = tau_of(rem, h, Vcc, M, hFin)
        n_fix += len(mine)
        for i in range(min(len(mine), len(stored))):
            diff = abs(mine[i] - stored[i])
            sum_abs += diff
            n_cmp += 1
            if diff > worst:
                worst = diff
                worst_ctx = (tr["pilot"], i, round(mine[i], 3), stored[i])
    mean = sum_abs / n_cmp if n_cmp else 0.0
    tag = "OK " if worst <= 0.02 else "!! "
    print(f"{tag}{path.split('/')[-2]}/{path.split('/')[-1]:9s} fixes={n_fix:6d} "
          f"mean|Δτ|={mean:.4f}  max|Δτ|={worst:.4f} min  @ {worst_ctx}")
    return worst


def main():
    days = sys.argv[1:] or sorted(glob.glob("dist/archive/*/day*.json"))
    worst = 0.0
    for p in days:
        w = check_day(p)
        if w is not None:
            worst = max(worst, w)
    print(f"\nworst |Δτ| across all days: {worst:.4f} min "
          f"({'PARITY OK — within rounding' if worst <= 0.02 else 'DIVERGENCE — investigate'})")
    sys.exit(0 if worst <= 0.02 else 1)


if __name__ == "__main__":
    main()
