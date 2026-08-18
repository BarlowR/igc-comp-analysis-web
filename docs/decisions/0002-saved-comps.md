# 0002 — Saved comps and password sign-in

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

The `/analyze` page does its work in the browser and keeps nothing. Users want to keep a day's analysis in their account. They want to open it again from a different device. Sign-in was also a problem: emailed magic links are slow on each new device. That flow also depends on the email rate limits from Supabase.

0001 set the architecture: a static site, Supabase for auth and user data. RLS is the safety boundary. The two new features go into that decision with no change.

## Saved comps — what to keep

Sizes that shaped the choice: the IGC files for one day are ~5–46 MB. Gzip makes them 8–10× smaller. The results JSON is ~250 KB–11 MB (~2 MB gzipped on a large day).

- **A. Keep the cached results only** — cheap, and it opens immediately. But the results do not change after you keep them. An engine fix (for example, the SSS start-cylinder fix) does not go to a saved comp.
- **B. Keep the raw inputs only** — the results stay correct. But each open must download all tracklogs again and do the analysis again.
- **C. The two together (selected)** — the raw inputs are the source of truth. The results JSON is a cache with an `ANALYSIS_VERSION` stamp (`src/lib/competition.ts`). An open reads the cache. A cache with an old stamp gets a recompute option from the raw files. The archive uses this same model (IGC files in the repo, JSON made at build). Here we apply it for each user.
- **D. Local-first (IndexedDB)** — 0001 said no to this before: comps would not follow the user across devices.

Layout: one `saved_comps` row for each comp (metadata + IGC manifest, migration 0006). The files go into the private `saved-comps` bucket, in `<user_id>/<comp_id>/`. The manifest keeps the initial filenames, because pilot names come from the filenames (`nameFromFile`). The storage keys are only `igc/<n>.igc.gz`. Saved comps are private. A share option, if we want it after this, gets its own table (refer to 0004).

At Club/Regional scale this stays in the Supabase storage tier that costs nothing (~1 GB ≈ 200 large saved days).

### Where saved comps show

They show on the archive index, adjacent to the archived comps. The script `archive-saved.ts` adds each saved comp to the top of the tab for its type. The ✦ symbol says that the comp is the account's own. Saves of the `free` type get their own archive tab. That tab shows only for a signed-in account that has some.

### User comps

Migration 0007 adds `user_comps`: a named group that a user creates one time. `Save to your account` on `/analyze` lets the user select a comp or create a new one. A task with a `comp_id` shows in that comp's group on the archive index and on `/saved`. That agrees with how archived comps show their days. A task without one stays standalone. If the user removes a comp, its tasks stay and become standalone again.

Saved rows on the archive index show the same ◈ 3D corner link that archived day cards show. They also have a `Delete` control (✕). Archived days do not — those are not the user's own.

### 3D for saved comps

The route `/saved/3d?id=<uuid>` shows a saved comp on the globe. The page body and styles come from `components/Viewer3d.astro`. The archive route uses the same component. `track3d.ts` reads the `saved` value in the entry blob. It then gets the data from the account's storage, not from a public JSON. A `note` from this viewer uses the key (comp: `saved`, day: comp id). The account page points those `notes` at `/saved` URLs.

### `Free Flight` — the type with no task

This is the third option on the `/analyze` page. A `free` flight has no `.xctsk` at all. The task input goes away. Only tracklogs are necessary. `Competition` runs with `task = null`: the same `comp_*` stats for the full flight (`IgcFlight.buildFreeMetrics`). No gate, no goal, no turnpoints, no par/τ model. It is a `TaskKind` (`free`) with its own metric subset (`FREE_FLIGHT_SUBSET`). Distance sorts largest first, because on a `free` flight more distance is better. But `free` is not in `TASK_KINDS`: the archive does not hold one, only saved comps do. A `free` comp keeps no task file. All other parts of the record are the same.

## Password sign-in

Email + password on the same Supabase email provider. A username is for `display` only (`profiles.display_name`), not for login. We kept these parts of the first flow:

- **Magic link.** This stays because accounts from before passwords have no password. Those users sign in with the emailed link. Then they set a password (Account → `Change password`). The link costs nothing to keep.
- **Password `reset`** through `resetPasswordForEmail`. The emailed link lands on `/account`. A `PASSWORD_RECOVERY` event points at the same `Change password` `form`. If the event does not come, the user lands signed-in and that `form` is there. Thus the flow cannot stop a user.

Necessary dashboard settings: the email provider on (it was on before). Email confirmation is the project's choice — the sign-up handler permits the two options. Set the minimum password length to 8, to agree with the client-side hint.
