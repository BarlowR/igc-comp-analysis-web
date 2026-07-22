#!/usr/bin/env python3
"""
Time-to-go race chart from an archived competition task.

For every pilot, at each GPS fix, compute a MacCready "time-to-go at par pace":

    τ(t) = ( D_rem(t) / V_cc  −  (h(t) − h_fin) / M ) / 60      [minutes]

i.e. the glide time to the finish at par cross-country speed, plus the pilot's
altitude deficit priced in climb-minutes. Plotted against elapsed-since-start it
gives a per-pilot line whose slope reads directly:

    slope −1  = flying at par (one minute of time-to-go per minute of clock)
    steeper   = beating the day        shallower = bleeding time
    rising    = going backwards (sinking out / flying off-course)

Vertical gaps between pilots are literal time gaps ("AB is 4 min ahead of CD"),
and the axis is comparable across days and sites.

Key modelling choices:
  * D_rem = shortest optimised route from the pilot's CURRENT position through
    every un-tagged turnpoint to the End of Speed Section, re-optimised each fix.
    Anchored to the real position, so flying off-course lengthens it = a loss.
  * The timed race ends at ESS: everything routes/measures to the `type=="ESS"`
    turnpoint; the goal cylinder is only the completed-or-not flag.
  * Par speed/climb are empirical: M = median achieved climb, V_cc = optimised
    task distance ÷ median completion time. (V_cc/M is the MacCready distance
    value of a metre of height.)
  * h_fin = minimum crossing altitude (goal-ground datum). No clamp — extra
    altitude carried into ESS shows as a negative residue ("energy margin").
  * Altitude is GPS MSL, lightly smoothed (no pressure track in the data).

`--metric altitude` plots the dual, effective altitude over ESS (the glide-
computer arrival-height reading); it is exactly −(M/V_cc)·(τ·V_cc·60).

Reads dist/archive/<comp>/<day>.json. Computation is stdlib-only; plotting needs
matplotlib (no numpy).

    Run:  python3 analysis/progress_prototype.py \
              --day dist/archive/chelan-us-open-2026/day2.json --outdir analysis_out
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
from dataclasses import dataclass

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    HAVE_MPL = True
except ImportError:
    HAVE_MPL = False

R_EARTH = 6_371_000.0


def to_planar(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Equirectangular projection to local metres about (lat0, lon0); fine over a
    task-sized area and lets the route optimisation use plain plane geometry."""
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * R_EARTH
    y = math.radians(lat - lat0) * R_EARTH
    return x, y


@dataclass
class Track:
    pilot: str
    x: list[float]  # fixes in local metres
    y: list[float]
    t: list[float]  # seconds since start gate
    alt: list[float]  # m MSL
    completion_s: float | None  # None if didn't make goal


@dataclass
class Task:
    cx: list[float]  # cylinder centres, local metres (index 0 = SSS, last = ESS)
    cy: list[float]
    radius: list[float]


def load(day_path: str) -> tuple[Task, list[Track], dict]:
    d = json.load(open(day_path))
    m = d["map"]
    start_ms = m["startMs"]
    if start_ms is None:
        raise SystemExit("This task has no startMs; pick a day with a defined SSS gate.")

    tps = sorted((tp for tp in m["turnpoints"] if tp["order"] >= 1), key=lambda x: x["order"])
    # The timed race ends at the End of Speed Section: route/measure everything to
    # ESS, dropping any turnpoints after it (the goal cylinder is only a
    # completed-or-not flag, already encoded by the table's finisher list). Falls
    # back to the last turnpoint if the task has no explicit ESS.
    ess_i = next((i for i, tp in enumerate(tps) if tp["type"] == "ESS"), len(tps) - 1)
    tps = tps[: ess_i + 1]
    lat0, lon0 = tps[0]["lat"], tps[0]["lon"]
    cx, cy, radius = [], [], []
    for tp in tps:
        px, py = to_planar(tp["lat"], tp["lon"], lat0, lon0)
        cx.append(px)
        cy.append(py)
        radius.append(tp["radius"])
    task = Task(cx, cy, radius)

    hdr = d["table"]["headers"]
    ci_time = hdr.index("Completion Time (s)")
    ci_finish = hdr.index("Finish Altitude MSL (m)")
    ci_climb = hdr.index("Average Climb Rate (m/s)")

    def num(c):
        try:
            return float(c["value"])
        except (TypeError, ValueError):
            return None

    completion, finish_alt, times, climbs = {}, [], [], []
    for row in d["table"]["completed"]:
        ct = num(row[ci_time])
        completion[row[0]["text"]] = ct
        if ct:
            times.append(ct)
        fa = num(row[ci_finish])
        if fa is not None:
            finish_alt.append(fa)
    for row in d["table"]["completed"] + d["table"]["incomplete"]:
        cr = num(row[ci_climb])
        if cr:
            climbs.append(cr)
    meta = {
        # Datum = the lowest crossing altitude (≈ goal ground), so height above it
        # is the usable glide height. No clamp: a pilot who crosses ESS higher than
        # this shows a negative time-to-go residue (energy carried into the finish).
        "h_fin": min(finish_alt) if finish_alt else 0.0,
        "M": statistics.median(climbs) if climbs else 2.0,  # par climb rate (m/s)
        "median_completion": statistics.median(times) if times else 1.0,  # s, for par XC speed
    }

    tracks = []
    for tr in m["tracks"]:
        xs, ys = [], []
        for la, lo in tr["points"]:
            px, py = to_planar(la, lo, lat0, lon0)
            xs.append(px)
            ys.append(py)
        tracks.append(
            Track(tr["pilot"], xs, ys, [(ms - start_ms) / 1000.0 for ms in tr["times"]],
                  list(tr["alt"]), completion.get(tr["pilot"]))
        )
    return task, tracks, meta


# ---- altitude smoothing --------------------------------------------------


def smooth_alt(t: list[float], alt: list[float], win: float = 7.0) -> list[float]:
    """Centred moving average of altitude over a ±win/2-second window, so sensor
    noise doesn't wiggle the trace. Two-pointer, O(n) over the (time-ordered) fixes."""
    n = len(alt)
    out = [0.0] * n
    lo = hi = 0
    half = win / 2
    for i in range(n):
        while t[i] - t[lo] > half:
            lo += 1
        while hi + 1 < n and t[hi + 1] - t[i] <= half:
            hi += 1
        out[i] = sum(alt[lo : hi + 1]) / (hi - lo + 1)
    return out


# ---- optimised distance to ESS -------------------------------------------


def _unit(dx: float, dy: float) -> tuple[float, float]:
    m = math.hypot(dx, dy)
    return (dx / m, dy / m) if m > 1e-9 else (0.0, 0.0)


def optimal_remaining(px, py, task, k, warm, iters):
    """Length of the shortest route from (px, py) through cylinders k..last (ESS).

    Iteratively places each cylinder's tangent point at the angle bisector to its
    neighbours (the classic paraglider cylinder optimisation); the pilot's current
    position is the fixed start anchor, so the route — and thus its length — grows
    whenever the pilot drifts off the line to the next point. Returns (length,
    tangent_points) so the next fix can warm-start from this solution."""
    cx, cy, r = task.cx, task.cy, task.radius
    n = len(cx)
    idx = list(range(k, n))
    if warm and len(warm) == len(idx):
        tx = [p[0] for p in warm]
        ty = [p[1] for p in warm]
    else:
        tx = [cx[i] for i in idx]
        ty = [cy[i] for i in idx]
    for _ in range(iters):
        for a, i in enumerate(idx):
            if r[i] <= 0:
                continue
            bx, by = (px, py) if a == 0 else (tx[a - 1], ty[a - 1])
            if a == len(idx) - 1:  # last cylinder (ESS): aim its near edge toward the previous point
                ux, uy = _unit(bx - cx[i], by - cy[i])
            else:  # interior: bisector of directions to both neighbours
                d1 = _unit(bx - cx[i], by - cy[i])
                d2 = _unit(tx[a + 1] - cx[i], ty[a + 1] - cy[i])
                ux, uy = _unit(d1[0] + d2[0], d1[1] + d2[1])
            tx[a], ty[a] = cx[i] + r[i] * ux, cy[i] + r[i] * uy
    total = math.hypot(tx[0] - px, ty[0] - py)
    for a in range(1, len(idx)):
        total += math.hypot(tx[a] - tx[a - 1], ty[a] - ty[a - 1])
    return total, list(zip(tx, ty))


def remaining_series(task: Task, tr: Track) -> list[float]:
    """Metres still to fly to ESS (optimised route) at each fix."""
    n = len(task.cx)
    out: list[float] = []
    k = 1  # next cylinder to tag (0 = SSS start, where the task begins)
    warm = None
    for i in range(len(tr.x)):
        px, py = tr.x[i], tr.y[i]
        advanced = False
        while k < n and math.hypot(px - task.cx[k], py - task.cy[k]) <= task.radius[k]:
            k += 1
            advanced = True
        if k >= n:  # inside the ESS cylinder → speed section done
            out.append(0.0)
            warm = None
            continue
        cold = advanced or warm is None  # re-seed the optimiser when the leg set changed
        rem, warm = optimal_remaining(px, py, task, k, None if cold else warm, 200 if cold else 20)
        out.append(rem)
    return out


# ---- main ----------------------------------------------------------------


def _upto_finish(tr: Track) -> int:
    """Index one past the pilot's ESS crossing (scored completion time)."""
    if not tr.completion_s:
        return len(tr.t)
    i = 0
    while i < len(tr.t) and tr.t[i] <= tr.completion_s:
        i += 1
    return max(i, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default="dist/archive/chelan-us-open-2026/day2.json")
    ap.add_argument("--outdir", default="analysis_out")
    ap.add_argument("--topn", type=int, default=3)
    ap.add_argument("--smooth", type=float, default=7.0, help="altitude smoothing window (s)")
    ap.add_argument("--alt", choices=["gps"], default="gps",
                    help="altitude source (only GPS MSL is in this dataset; no pressure track)")
    ap.add_argument("--metric", choices=["time", "altitude"], default="time",
                    help="time = time-to-go at par (min); altitude = effective m over ESS")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    task, tracks, meta = load(args.day)
    task_m = optimal_remaining(task.cx[0], task.cy[0], task, 1, None, 300)[0]
    M = meta["M"]  # par climb rate (m/s)
    h_fin = meta["h_fin"]  # min crossing altitude datum (m MSL)
    V_cc = task_m / meta["median_completion"]  # par cross-country speed (m/s)
    coef = V_cc / M  # MacCready height→distance: metres of task distance per metre of height
    print(f"optimised task distance to ESS ≈ {task_m/1000:.1f} km over {len(task.cx)} waypoints")
    print(f"M (par climb) ≈ {M:.2f} m/s | V_cc (par XC) ≈ {V_cc*3.6:.1f} km/h "
          f"| V_cc/M ≈ {coef:.2f} m/m | h_fin ≈ {h_fin:.0f} m | smooth {args.smooth:.0f}s")

    finishers = sorted((t for t in tracks if t.completion_s), key=lambda t: t.completion_s)
    top = finishers[: args.topn]
    top_names = {t.pilot for t in top}
    print(f"{len(finishers)} finishers; top: " + ", ".join(f"{t.pilot} ({t.completion_s:.0f}s)" for t in top))

    # Both metrics are the same MacCready quantity in different units:
    #   time     : τ    = (D_rem/V_cc − (h − h_fin)/M) / 60   [min to go at par]
    #   altitude : h_eff = (h − h_fin) − D_rem·(M/V_cc)        [m over ESS; the
    #              glide-computer arrival-height reading, = −(M·V_cc)·τ·60]
    def series_for(tr):
        rem = remaining_series(task, tr)
        h = smooth_alt(tr.t, tr.alt, args.smooth)
        if args.metric == "altitude":
            return [(h[i] - h_fin) - rem[i] * (M / V_cc) for i in range(len(rem))]  # m
        return [(rem[i] / V_cc - (h[i] - h_fin) / M) / 60 for i in range(len(rem))]  # min

    series = {tr.pilot: series_for(tr) for tr in finishers}
    if args.metric == "altitude":
        title = f"Effective altitude over ESS = (h − h_fin) − D_rem·(M/V_cc)   (M/V_cc≈{1/coef:.3f} m/m)"
        ylabel = "effective altitude over ESS (m)   (0 = on final glide at par; end = arrival margin)"
        fname = "effective_altitude.png"
    else:
        title = "Time-to-go at par pace  τ = D_rem/V_cc − (h − h_fin)/M   (slope −1 = par; steeper = beating the day)"
        ylabel = "time-to-go at par (min)"
        fname = "time_to_go.png"

    if not HAVE_MPL:
        print(f"\nmatplotlib not installed — no plot written to {args.outdir}/.")
        return

    colors = ["#c62828", "#1565c0", "#2e7d32", "#6a1b9a"]
    fig, ax = plt.subplots(figsize=(11, 6))
    for tr in finishers:  # field in faint grey
        if tr.pilot in top_names:
            continue
        e = _upto_finish(tr)
        ax.plot([t / 60 for t in tr.t[:e]], series[tr.pilot][:e], color="#b0aca6", lw=0.6, alpha=0.5)
    for k, tr in enumerate(top):  # winners on top, coloured, with a finish dot
        e = _upto_finish(tr)
        xs = [t / 60 for t in tr.t[:e]]
        ys = series[tr.pilot][:e]
        c = colors[k % len(colors)]
        ax.plot(xs, ys, color=c, lw=1.8, label=f"{tr.pilot} ({tr.completion_s:.0f}s)")
        ax.plot(xs[-1], ys[-1], "o", color=c, ms=8, mec="white", zorder=5)
    ax.axhline(0, color="k", ls="-.", lw=1, alpha=0.5, label="ESS (0)")
    if args.metric == "time" and top:  # par reference: slope −1 from the leader's start-gate crossing
        ts = top[0].t
        gi = next((i for i in range(len(ts)) if ts[i] >= 0), 0)
        x0, y0 = ts[gi] / 60, series[top[0].pilot][gi]
        ax.plot([x0, x0 + y0], [y0, 0], color="k", ls=":", lw=1, alpha=0.55, label="par (slope −1)")
    ax.set_title(title)
    ax.set_xlabel("elapsed since start gate (min)")
    ax.set_ylabel(ylabel)
    ax.legend(loc="upper right", fontsize=8)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    path = os.path.join(args.outdir, fname)
    fig.savefig(path, dpi=130)
    plt.close(fig)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
