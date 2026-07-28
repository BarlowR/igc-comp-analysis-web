#!/usr/bin/env python3
"""
"Time lost vs par" race chart from an archived competition task — the prototype
mirror of the app pipeline (src/lib/timetogo.ts + competition.ts).

Per pilot, per fix:

  D_rem  = shortest route from the current position through the un-tagged
           turnpoint cylinders to ESS, re-optimised each fix (FAI/airscore
           `find_closest`: each turnpoint sits at the point on its cylinder
           nearest the line between neighbours, or inside if the line crosses it
           — so it's continuous across cylinder tags, no step at big cylinders).

  τ      = pace · ( D_rem/V_g  +  max(0, D_rem/g − (h − h_fin)) / M )   [seconds]
           TWO-PHASE MODEL: glide time for the whole course plus climb time for
           the height still owed, under the idealisation "no distance while
           climbing, no climbing on glide". The single max() is the physics —
           height owed can't be negative — and doubles as the final-glide cap:
           above the slope surplus height is worth nothing. At ESS (D_rem→0)
           τ→0, so arrival height doesn't leak in.

  L(t)   = τ/60 + t/60 − τ_ref                                     [minutes]
           cumulative time lost vs a par ghost. Flat = par, up = losing, down =
           gaining; the finish square is the pilot's final deficit.

Par is measured from the day's fastest PAR_N finishers (no hand-set constants):
  M     = median achieved climb rate
  V_g,g = ground speed and glide ratio over their gliding fixes (smoothed sink
          < −0.3 m/s inside the scored window); g ≡ V_g/sink, so par gliding is
          exactly neutral. Falls back to 60 km/h / 7:1 under 600 s of sample.
  pace  = actual median gate→ESS duration ÷ raw model τ at (task dist, h_ref).
          The two-phase model omits thermal drift and porpoising, so its raw
          ghost runs slow; this one measured ratio pins the ghost's total to the
          real par duration, which is what makes the par line horizontal and the
          final L a literal "minutes behind the median winner".
  τ_ref = pace-fitted τ at the reference start state ≡ that median duration.
  h_fin = min crossing altitude across all finishers.

Reads dist/archive/<comp>/<day>.json. Computation is stdlib-only; plotting needs
matplotlib (no numpy).

    Run:  python3 analysis/progress_prototype.py \
              --day dist/archive/chelan2026/day3.json --outdir analysis_out
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
PAR_N = 10  # par is measured from the fastest N finishers
TAG_MARGIN_M = 200  # a cylinder counts as reached within radius + this (downsampled
# tracks can graze a turnpoint edge a few metres outside despite the path going in)

# Glide measurement (mirrors competition.ts): classification threshold, minimum
# sample, and the fallbacks for a day too sparse to measure.
GLIDE_SINK_THRESHOLD_MPS = 0.3
MIN_GLIDE_SAMPLE_S = 600
DEFAULT_GLIDE_SPEED_KMH = 60.0
DEFAULT_GLIDE_RATIO = 7.0


def to_planar(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
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
    completion_s: float | None  # ESS crossing time, or None if didn't make goal
    finish_msl: float | None  # ESS crossing altitude
    climb: float | None  # average climb rate (m/s)
    start_after_s: float | None  # SSS crossing time, seconds after the start gate


@dataclass
class Task:
    cx: list[float]
    cy: list[float]
    r: list[float]
    lat0: float
    lon0: float
    px: list[float]  # optimised point on each cylinder
    py: list[float]
    dist_to_goal: list[float]  # optimised distance from px[i] to ESS


# ---- geometry: FAI find_closest shortest route ---------------------------


def on_circle_toward(cx, cy, r, qx, qy):
    dx, dy = qx - cx, qy - cy
    d = math.hypot(dx, dy)
    return (cx + r * dx / d, cy + r * dy / d) if d > 1e-9 else (cx + r, cy)


def _closest_on_seg_to_center(cx, cy, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    l2 = abx * abx + aby * aby
    t = max(0.0, min(1.0, ((cx - ax) * abx + (cy - ay) * aby) / l2)) if l2 > 0 else 0.0
    return ax + t * abx, ay + t * aby


def waypoint_through_cylinder(cx, cy, r, ax, ay, bx, by):
    """Point on cylinder minimising |A->t| + |t->B| (true shortest route through it),
    NOT the point closest to the A-B line. Free (on the line) when the segment already
    pierces the disk; else bracket the near-arc minimum and ternary-search it."""
    qx, qy = _closest_on_seg_to_center(cx, cy, ax, ay, bx, by)
    if math.hypot(qx - cx, qy - cy) <= r:
        return qx, qy  # segment pierces disk → free

    def f(th):
        tx, ty = cx + r * math.cos(th), cy + r * math.sin(th)
        return math.hypot(ax - tx, ay - ty) + math.hypot(tx - bx, ty - by)

    N = 16
    bi = min(range(N), key=lambda i: f(2 * math.pi * i / N))
    lo, hi = 2 * math.pi * (bi - 1) / N, 2 * math.pi * (bi + 1) / N
    for _ in range(40):
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if f(m1) < f(m2):
            hi = m2
        else:
            lo = m1
    th = (lo + hi) / 2
    return cx + r * math.cos(th), cy + r * math.sin(th)


def build_geom(turnpoints) -> Task:
    tps = sorted((tp for tp in turnpoints if tp["order"] >= 1), key=lambda x: x["order"])
    ess_i = next((i for i, tp in enumerate(tps) if tp["type"] == "ESS"), len(tps) - 1)
    route = tps[: ess_i + 1]
    lat0, lon0 = route[0]["lat"], route[0]["lon"]
    cx, cy, r = [], [], []
    for tp in route:
        px, py = to_planar(tp["lat"], tp["lon"], lat0, lon0)
        cx.append(px)
        cy.append(py)
        r.append(tp["radius"])
    n = len(cx)
    px, py = list(cx), list(cy)
    for _ in range(3):
        for i in range(n):
            if r[i] <= 0:
                px[i], py[i] = cx[i], cy[i]
                continue
            if i == 0:
                px[i], py[i] = on_circle_toward(cx[i], cy[i], r[i], px[min(1, n - 1)], py[min(1, n - 1)])
            elif i == n - 1:
                px[i], py[i] = on_circle_toward(cx[i], cy[i], r[i], px[i - 1], py[i - 1])
            else:
                px[i], py[i] = waypoint_through_cylinder(
                    cx[i], cy[i], r[i], px[i - 1], py[i - 1], px[i + 1], py[i + 1]
                )
    dist_to_goal = [0.0] * n
    for i in range(n - 2, -1, -1):
        dist_to_goal[i] = dist_to_goal[i + 1] + math.hypot(px[i + 1] - px[i], py[i + 1] - py[i])
    return Task(cx, cy, r, lat0, lon0, px, py, dist_to_goal)


def task_distance_m(task: Task) -> float:
    return task.dist_to_goal[0] if task.dist_to_goal else 0.0


def _optimal_remaining(fx, fy, task, k, warm):
    cx, cy, r = task.cx, task.cy, task.r
    n = len(cx)
    m = n - k
    if warm and len(warm) == m:
        tx = [p[0] for p in warm]
        ty = [p[1] for p in warm]
    else:
        tx = [cx[i] for i in range(k, n)]
        ty = [cy[i] for i in range(k, n)]
    for _ in range(3):
        for a in range(m):
            i = k + a
            if r[i] <= 0:
                tx[a], ty[a] = cx[i], cy[i]
                continue
            ax, ay = (fx, fy) if a == 0 else (tx[a - 1], ty[a - 1])
            if a == m - 1:
                tx[a], ty[a] = on_circle_toward(cx[i], cy[i], r[i], ax, ay)
                continue
            tx[a], ty[a] = waypoint_through_cylinder(cx[i], cy[i], r[i], ax, ay, tx[a + 1], ty[a + 1])
    total = math.hypot(tx[0] - fx, ty[0] - fy) if m > 0 else 0.0
    for a in range(1, m):
        total += math.hypot(tx[a] - tx[a - 1], ty[a] - ty[a - 1])
    return total, list(zip(tx, ty))


def remaining_series(task: Task, xs, ys) -> list[float]:
    n = len(task.cx)
    out = []
    k = 1
    warm = None
    for i in range(len(xs)):
        advanced = False
        while k < n and math.hypot(xs[i] - task.cx[k], ys[i] - task.cy[k]) <= task.r[k] + TAG_MARGIN_M:
            k += 1
            advanced = True
        if k >= n:
            out.append(0.0)
            warm = None
            continue
        total, warm = _optimal_remaining(xs[i], ys[i], task, k, None if advanced else warm)
        out.append(total)
    return out


# ---- altitude / vertical rate --------------------------------------------


def smooth_alt(t, alt, win_s=7.0):
    n = len(alt)
    out = [0.0] * n
    lo = hi = 0
    sum_ = 0.0
    half = win_s / 2
    for i in range(n):
        while t[i] - t[lo] > half:
            sum_ -= alt[lo]
            lo += 1
        while hi < n and t[hi] - t[i] <= half:
            sum_ += alt[hi]
            hi += 1
        out[i] = sum_ / (hi - lo)
    return out


# ---- load ----------------------------------------------------------------


def load(day_path: str) -> tuple[Task, list[Track]]:
    d = json.load(open(day_path))
    m = d["map"]
    start_ms = m["startMs"]
    if start_ms is None:
        raise SystemExit("This task has no startMs; pick a day with a defined SSS gate.")
    task = build_geom(m["turnpoints"])

    hdr = d["table"]["headers"]
    ci_time = hdr.index("Completion Time (s)")
    ci_climb = hdr.index("Average Climb Rate (m/s)")
    ci_finish = hdr.index("Finish Altitude MSL (m)")
    ci_start = hdr.index("Start After Gate (s)")

    def num(c):
        try:
            return float(c["value"])
        except (TypeError, ValueError):
            return None

    stat = {}  # pilot -> (completion, climb, finish_msl, start_after_s)
    for grp in ("completed", "incomplete"):
        for row in d["table"][grp]:
            name = row[0]["text"]
            comp = num(row[ci_time]) if grp == "completed" else None
            stat[name] = (comp, num(row[ci_climb]), num(row[ci_finish]), num(row[ci_start]))

    tracks = []
    for tr in m["tracks"]:
        xs, ys = [], []
        for la, lo in tr["points"]:
            px, py = to_planar(la, lo, task.lat0, task.lon0)
            xs.append(px)
            ys.append(py)
        comp, climb, finish, start_after = stat.get(tr["pilot"], (None, None, None, None))
        tracks.append(
            Track(tr["pilot"], xs, ys, [(ms - start_ms) / 1000.0 for ms in tr["times"]],
                  list(tr["alt"]), comp, finish, climb, start_after)
        )
    return task, tracks


# ---- main ----------------------------------------------------------------


def _upto_finish(tr: Track) -> int:
    if not tr.completion_s:
        return len(tr.t)
    i = 0
    while i < len(tr.t) and tr.t[i] <= tr.completion_s:
        i += 1
    return max(i, 2)


def _from_start(tr: Track) -> int:
    """First fix at/after the pilot's start-line crossing — drop the pre-start hold."""
    sa = tr.start_after_s if tr.start_after_s is not None else 0.0
    i = 0
    while i < len(tr.t) and tr.t[i] < sa:
        i += 1
    return i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default="dist/archive/chelan2026/day3.json")
    ap.add_argument("--outdir", default="analysis_out")
    ap.add_argument("--topn", type=int, default=3, help="how many leaders to highlight")
    ap.add_argument("--smooth", type=float, default=7.0, help="altitude smoothing window (s)")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    task, tracks = load(args.day)
    task_m = task_distance_m(task)
    finishers = sorted((t for t in tracks if t.completion_s), key=lambda t: t.completion_s)
    if not finishers:
        raise SystemExit("no finishers")
    par = finishers[:PAR_N]

    M = statistics.median([t.climb for t in par if t.climb]) or 2.0
    med_comp = statistics.median([t.completion_s for t in par if t.completion_s])
    Vcc = task_m / med_comp if med_comp else 0.0  # day stat only; τ derives its own pace
    finish_alts = [t.finish_msl for t in finishers if t.finish_msl is not None]
    h_fin = min(finish_alts) if finish_alts else 0.0

    # Per-finisher D_rem + smoothed height (rem is the expensive part; reused by
    # the glide measurement and by L below).
    per = {tr.pilot: (remaining_series(task, tr.x, tr.y), smooth_alt(tr.t, tr.alt, args.smooth))
           for tr in finishers}

    # Ghost anchor h_ref: fleet-median smoothed altitude at the SSS exit (all
    # tracks, like the app's buildMapData).
    exit_alts = []
    for tr in tracks:
        sa = tr.start_after_s if tr.start_after_s is not None else 0.0
        h = per[tr.pilot][1] if tr.pilot in per else smooth_alt(tr.t, tr.alt, args.smooth)
        i = 0
        while i < len(tr.t) and tr.t[i] < sa:
            i += 1
        if i < len(h):
            exit_alts.append(h[i])
    h_ref = statistics.median(exit_alts) if exit_alts else h_fin

    # Par glide pace, measured like M: over the par pilots' scored fixes, a fix
    # sinking faster than the threshold is gliding; V_g = course progress per
    # second of that, g = course metres per metre of height spent (≡ V_g/sink).
    glide_course = glide_drop = glide_time = 0.0
    for tr in par:
        rem, h = per[tr.pilot]
        sa = tr.start_after_s if tr.start_after_s is not None else 0.0
        end = tr.completion_s if tr.completion_s else float("inf")
        for i in range(1, len(tr.t)):
            if tr.t[i] < sa or tr.t[i] > end:
                continue
            dt = tr.t[i] - tr.t[i - 1]
            if dt <= 0 or dt > 30:
                continue  # track gap — rates across it mean nothing
            dh = h[i] - h[i - 1]
            if dh / dt >= -GLIDE_SINK_THRESHOLD_MPS:
                continue
            glide_course += rem[i - 1] - rem[i]
            glide_drop += -dh
            glide_time += dt
    measured = glide_time >= MIN_GLIDE_SAMPLE_S and glide_course > 0 and glide_drop > 0
    V_g = glide_course / glide_time if measured else DEFAULT_GLIDE_SPEED_KMH / 3.6
    g_ratio = glide_course / glide_drop if measured else DEFAULT_GLIDE_RATIO

    # Two-phase τ (minutes, raw): glide the course + climb the height still owed.
    def tau_raw(d, h):
        return (d / V_g + max(0.0, d / g_ratio - (h - h_fin)) / M) / 60

    # Pace fit: pin the ghost's start-state time to the actual median par
    # duration (the model omits drift + porpoising, so raw runs slow).
    tau_ref_raw = tau_raw(task_m, h_ref)
    pace = (med_comp / 60) / tau_ref_raw if tau_ref_raw > 0 and med_comp else 1.0
    tau_ref = tau_ref_raw * pace  # ≡ med_comp/60

    print(f"task {task_m/1000:.1f} km | M {M:.2f} m/s | glide {V_g*3.6:.1f} km/h at {g_ratio:.2f}:1"
          f"{' (measured)' if measured else ' (FALLBACK)'} | pace x{pace:.2f} | V_cc {Vcc*3.6:.1f} km/h "
          f"| h_fin {h_fin:.0f} | h_ref {h_ref:.0f} | tau_ref {tau_ref:.1f} min | par=top{PAR_N}")
    top = finishers[: args.topn]
    top_names = {t.pilot for t in top}
    print("top: " + ", ".join(f"{t.pilot} ({t.completion_s:.0f}s)" for t in top))

    def L_of(tr):
        rem, h = per[tr.pilot]
        L, fg = [], []
        for i in range(len(rem)):
            L.append(pace * tau_raw(rem[i], h[i]) + tr.t[i] / 60 - tau_ref)
            fg.append(h[i] > h_fin + rem[i] / g_ratio)  # above the slope = final glide
        return L, fg

    series = {tr.pilot: L_of(tr) for tr in finishers}  # pilot -> (L, in_final_glide)

    if not HAVE_MPL:
        Lf = [series[tr.pilot][0][_upto_finish(tr) - 1] for tr in finishers]
        Lf.sort()
        print(f"\nmatplotlib missing. L_finish: min {min(Lf):+.1f}  median {Lf[len(Lf)//2]:+.1f}  max {max(Lf):+.1f}")
        return

    nan = float("nan")
    colors = ["#c62828", "#1565c0", "#2e7d32", "#6a1b9a"]
    fig, ax = plt.subplots(figsize=(11, 6))
    for tr in finishers:  # field in faint grey, cut to the start-line crossing
        if tr.pilot in top_names:
            continue
        f, e = _from_start(tr), _upto_finish(tr)
        ax.plot([t / 60 for t in tr.t[f:e]], series[tr.pilot][0][f:e], color="#b0aca6", lw=0.6, alpha=0.5)
    ax.plot([], [], color="#555", lw=1.8, ls=(0, (3, 2)), label="final glide (dashed)")
    for k, tr in enumerate(top):  # leaders: solid, DASHED where above the glide slope
        f, e = _from_start(tr), _upto_finish(tr)
        L, fg = series[tr.pilot]
        xs = [t / 60 for t in tr.t[f:e]]
        ys = L[f:e]
        fgs = fg[f:e]
        c = colors[k % len(colors)]
        # A pilot enters/leaves the final-glide regime repeatedly, so split the line
        # into solid (below slope) and dashed (above slope) via NaN gaps.
        solid = [ys[i] if not fgs[i] else nan for i in range(len(ys))]
        dash = [ys[i] if fgs[i] else nan for i in range(len(ys))]
        ax.plot(xs, solid, color=c, lw=1.8, label=f"{tr.pilot} ({tr.completion_s:.0f}s)", zorder=5)
        ax.plot(xs, dash, color=c, lw=1.8, ls=(0, (3, 2)), zorder=5)
        ax.plot(xs[-1], ys[-1], "s", color=c, ms=8, mec="white", zorder=6)
    ax.axhline(0, color="k", ls="--", lw=1.2, alpha=0.5, label="par (0)")
    # "Time lost" line: L = elapsed − τ_ref (slope +1), crossing par at the par
    # finish time τ_ref. With the glide-slope cap τ(finish)=0, so every finish
    # square lands on it — vertical gap from par = minutes lost.
    xmax = ax.get_xlim()[1]
    ax.plot([tau_ref, xmax], [0.0, xmax - tau_ref], color="k", ls=":", lw=1, alpha=0.5, label="time lost (1 min/min)")
    ax.set_title("Time lost vs par  L(t) = τ + elapsed − τ_ref   (flat = par, up = losing time; two-phase τ, pace-fitted)")
    ax.set_xlabel("elapsed since start gate (min)")
    ax.set_ylabel("cumulative time lost vs par (min)")
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    path = os.path.join(args.outdir, "time_lost.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
