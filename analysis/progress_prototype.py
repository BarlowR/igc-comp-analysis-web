#!/usr/bin/env python3
"""
"Time lost vs par" race chart from an archived competition task — the prototype
mirror of the app pipeline (src/lib/timetogo.ts + competition.ts), plus the
final-glide regime shift we're validating before deploying it.

Per pilot, per fix:

  D_rem  = shortest route from the current position through the un-tagged
           turnpoint cylinders to ESS, re-optimised each fix (FAI/airscore
           `find_closest`: each turnpoint sits at the point on its cylinder
           nearest the line between neighbours, or inside if the line crosses it
           — so it's continuous across cylinder tags, no step at big cylinders).

  τ      = max( D_rem/V_cc − credit/M ,  D_rem/V_glide )           [seconds]
           GLIDE-SLOPE HEIGHT CAP: height is credited at 1/M only up to the amount
           needed to glide to goal (h_need = h_fin + D_rem·g, g = 1/glide-ratio);
           surplus above the slope is discounted by beta (default 0 = worthless).
           Below the slope this is the plain MacCready term (unchanged). Nearer the
           slope the credit would drive τ toward D_rem/V_g with the MacCready-inverted
           V_g = V_cc·M/(M − g·V_cc) — which diverges at paraglider glide ratios — so τ
           is FLOORED at the physical pure-glide time D_rem/V_glide (V_glide =
           --glide-speed, default 60 km/h). Surplus altitude stops counting and τ can't
           dive below the glide time. At ESS (D_rem→0) both terms →0, so arrival height
           no longer leaks in and same-time finishers land together.

  L(t)   = τ/60 + t/60 − τ_ref                                     [minutes]
           cumulative time lost vs a par ghost. Flat = par, up = losing, down =
           gaining; the finish square is the pilot's final deficit.

Par is measured from the day's fastest PAR_N finishers:
  M     = median achieved climb          V_cc = optimised task dist ÷ median completion
  τ_ref = median over the par group of [completion − finish-altitude residue],
          i.e. the median of their L=0 points, so the leaders sit on L = 0.
  V_glide = physical final-glide ground-speed cap (--glide-speed, default 60 km/h);
          floors τ so on-slope credit can't imply a superhuman glide.
  h_fin = min crossing altitude (cancels in L; kept for the raw τ).

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
    ap.add_argument("--glide", type=float, default=7.0, help="final-glide ratio (e.g. 7.0 = 7:1); gradient g = 1/ratio")
    ap.add_argument("--glide-speed", type=float, default=60.0, help="physical final-glide ground-speed cap (km/h); floors tau at D_rem/this")
    ap.add_argument("--beta", type=float, default=0.0, help="surplus-height discount above glide slope [0,1]")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    g = 1.0 / args.glide
    V_glide = args.glide_speed / 3.6  # m/s
    beta = max(0.0, min(1.0, args.beta))
    if args.beta > 0.3:
        print(f"warning: beta={args.beta} > 0.3 is not meaningful (clamped to [0,1])")

    task, tracks = load(args.day)
    task_m = task_distance_m(task)
    finishers = sorted((t for t in tracks if t.completion_s), key=lambda t: t.completion_s)
    if not finishers:
        raise SystemExit("no finishers")
    par = finishers[:PAR_N]

    M = statistics.median([t.climb for t in par if t.climb]) or 2.0
    med_comp = statistics.median([t.completion_s for t in par if t.completion_s])
    Vcc = task_m / med_comp if med_comp else 0.0
    finish_alts = [t.finish_msl for t in finishers if t.finish_msl is not None]
    h_fin = min(finish_alts) if finish_alts else 0.0
    tau_ref = statistics.median(
        [t.completion_s / 60 - (t.finish_msl - h_fin) / M / 60 for t in par if t.completion_s and t.finish_msl is not None]
    )
    # MacCready-inverted glide speed the credit WOULD imply on the slope. Physical for
    # sailplanes; for paraglider glide ratios (g≈1/7) the denominator collapses so it
    # runs to 60-180 km/h or diverges — hence the V_glide floor caps the actual credit.
    Vg_mc = Vcc * M / (M - g * Vcc) if M - g * Vcc > 0 else float("inf")
    print(f"task {task_m/1000:.1f} km | M {M:.2f} m/s | V_cc {Vcc*3.6:.1f} km/h | glide {args.glide:.1f}:1 "
          f"(V_g,mc {Vg_mc*3.6:.0f} km/h capped at {args.glide_speed:.0f}) | beta {beta:.2f} "
          f"| h_fin {h_fin:.0f} | tau_ref {tau_ref:.1f} min | par=top{PAR_N}")
    top = finishers[: args.topn]
    top_names = {t.pilot for t in top}
    print("top: " + ", ".join(f"{t.pilot} ({t.completion_s:.0f}s)" for t in top))

    # Glide-slope height cap on the MacCready height credit, floored at a physical glide.
    #   Below slope (h <= h_need): credit = h - h_fin, so τ = D_rem/V_cc - (h-h_fin)/M,
    #     identical to plain MacCready — mid-race traces are bit-for-bit unchanged (the
    #     floor never binds here since V_glide > V_cc).
    #   Approaching/above slope, beta = 0: credit -> D_rem*g would collapse τ to
    #     D_rem/V_g with the MacCready-inverted V_g = V_cc*M/(M - g*V_cc). For paraglider
    #     glide ratios that V_g is 60-180 km/h or diverges, so we FLOOR τ at the physical
    #     pure-glide time D_rem/V_glide (V_glide = --glide-speed, default 60 km/h). Surplus
    #     height is worth nothing; climbing after glide is made shows on L as ~1 min/min lost.
    #   h_need shrinks with D_rem, so deviating off-line drops you back below the slope
    #     and full credit is automatically restored.
    def L_of(tr):
        rem = remaining_series(task, tr.x, tr.y)
        h = smooth_alt(tr.t, tr.alt, args.smooth)
        L, fg = [], []
        for i in range(len(rem)):
            h_need = h_fin + rem[i] * g
            credit = (min(h[i], h_need) - h_fin) + beta * max(h[i] - h_need, 0.0)
            tau_credit = (rem[i] / Vcc - credit / M) / 60  # minutes
            tau = max(tau_credit, rem[i] / V_glide / 60)  # floor at physical glide time
            L.append(tau + tr.t[i] / 60 - tau_ref)
            fg.append(h[i] > h_need)  # above the glide slope = in the final-glide region
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
    ax.set_title("Time lost vs par  L(t) = τ + elapsed − τ_ref   (flat = par, up = losing time; glide-slope height cap on τ)")
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
