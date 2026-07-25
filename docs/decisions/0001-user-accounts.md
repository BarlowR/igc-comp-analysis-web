# 0001 — User accounts, annotations, and per-pilot results

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

We want three things, in this order:

1. **User accounts** — so a visitor can be a known person across devices.
2. **Annotations** — notes saved against a comp day / pilot / moment in time.
3. **Individual comparative results** — "how did *I* do against the field",
   across days and across comps.

The app today is fully static: `astro.config.mjs` is `output: 'static'`, deployed
as a Render static site. All analysis is precomputed at build by
`src/pages/archive/[comp]/[day].json.ts`, which reads the on-disk IGC/task files
and emits one results JSON per day. The browser only ever fetches that JSON
(`src/scripts/archive.ts`, `src/scripts/track3d.ts`) — no IGC is fetched at
runtime.

Two measurements that shaped the decision:

- A big comp day's results JSON is ~11 MB raw, **~2 MB gzipped over the wire**
  per view. Small days are ~250 KB.
- `dist/` is **665 MB**, dominated by the 560 MB of archived IGCs in
  `public/archive/`. They are deploy weight, not bandwidth.

### The two axes

Account data for this app is kilobytes per user. Auth scales free to ~50k users
on every option considered. What actually costs money is shipping 2 MB JSONs and
Cesium tiles. **Auth and hosting are therefore separable decisions** — pick auth
on change-complexity grounds, hosting on bandwidth grounds, and don't let one
drag the other.

## Options considered

Scale tiers: **Club** ≈ 100 accounts / 2k day-views per month (~3 GB) ·
**Regional** ≈ 1k / 20k views (~30 GB) · **National** ≈ 10k / 200k views (~300 GB).

| | A. Local-first | B. Static + Supabase | C. Astro SSR on Render | D. Cloudflare + R2 |
|---|---|---|---|---|
| Build effort | ~1 day | ~3–5 days | ~1.5–2 weeks | ~2–3 weeks |
| $/mo — Club | $0 | $0 | ~$14 | ~$5 |
| $/mo — Regional | $0 | $0 | ~$14 | ~$5 |
| $/mo — National | $0 + egress | $25 + egress | ~$14 + egress | ~$5 |
| Egress at National | +$30–90 (~200 GB over Render's free 100 GB) | same | same | **$0 — R2/Pages don't bill egress** |
| What changes here | +1 island, IndexedDB wrapper; config untouched | +`supabase-js`, 2 islands, 3 tables + RLS; config and build untouched | adapter + `output:'hybrid'`, per-route `prerender=false`, session middleware, migrations, Render static site → web service | all of C, plus republishing the archive into R2 and repointing the fetches |
| Breaks when | user opens a second device | server-side gating or private-by-default data is needed | traffic outgrows one $7 box, or 665 MB deploys get painful | nothing structural — this is the endgame shape |

Cost figures are approximate and should be re-checked against current pricing
before any of them become load-bearing.

## Decision

**Option B — stay static, add Supabase for auth + user data.**

At Club and Regional scale — where we actually are — A, B, and D all cost $0–5,
so cost is not a discriminator and the choice comes down to change complexity.
B is the only option that leaves `astro.config.mjs`, the build pipeline, and the
Render deployment completely untouched. Auth and per-user data are additive: a
client island talks to Supabase, row-level security does the access control, and
there is no server code of ours to write or secure.

### Shape

- Site stays `output: 'static'`. No adapter, no SSR, no hosting change.
- `@supabase/supabase-js` in a browser island; `PUBLIC_SUPABASE_URL` and
  `PUBLIC_SUPABASE_ANON_KEY` are baked into the client bundle, as the Cesium Ion
  token already is. Both are public by design; RLS is the security boundary.
- Tables: `profiles`, `pilot_claims`, `annotations`.

### Identity

Pilot identity in the archive is a filename convention —
`aaron_nash_2026-06-14_01.439.igc`. The **name slug is stable across comps; the
trailing number is not** (Bill Belcourt is `.4` in chelan2026 and `.3` in
chelan-us-open-2026 — it is a per-comp entry number, not a pilot ID). So
cross-comp identity cannot be inferred from the archive; an account **claims**
`(comp, pilot_slug)` pairs, and those claims are what stitch a pilot's history
together.

Claims are honour-system and non-exclusive, deliberately: any number of accounts
may claim the same pilot. A duplicate claim costs the real pilot nothing —
each account only ever sees its own claims — while exclusivity broke legitimate
cases, since two pilots can share a name slug and one person can have two
accounts (0002_shared_claims.sql). The `verified` column survives, unsettable
from the client, as a hook for organiser approval; nothing reads it.

### Per-pilot results stay static

"Individual comparative results" is a query over already-public data, so it is
precomputed at build like the day JSONs, and served at `/pilot/<slug>` with no
auth. Accounts only store *which* slug is you. This keeps the expensive
computation in the build where it already lives, and keeps Supabase holding only
genuinely user-owned data.

## Consequences

- Private/gated data is not really achievable without server rendering. If that
  becomes a requirement, it forces a re-open toward C or D.
- **Supabase free projects pause after ~a week of inactivity.** Comps are
  seasonal, so an off-season visitor may hit a cold project. This may push us to
  the $25/mo tier earlier than user counts alone would suggest.
- Egress is the number that eventually decides hosting, not accounts. Shrinking
  the day JSONs (float precision, redundant per-fix columns) pushes every cost
  threshold out ~3–4× and is worth doing before any migration.
- Cesium Ion's free tile-streaming quota is a separate ceiling on the 3D view,
  likely hit around Regional scale. Unaddressed by this decision.
