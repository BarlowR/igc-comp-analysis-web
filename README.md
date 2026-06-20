# Competition Flight Analysis — Web

A standalone, static web app that reproduces the `comp_analysis.py` tooling
([igc-tools](../igc-tools)) entirely in the browser. Upload an XContest task
file and a set of pilot IGC tracklogs to get the competition stats table and
climb-rate distribution charts. No server, no upload — all parsing and analysis
runs client-side.

## Usage

```bash
npm install
npm run dev      # local dev server
npm run build    # static site -> dist/
npm run preview  # serve the built site
```

Open the page, choose a `.xctsk` task file and one or more `.igc` files, then
click **Analyze flights**.

## How it works

The Python pipeline was ported to TypeScript, column-for-column:

| Python                | TypeScript                |
| --------------------- | ------------------------- |
| `utils/math_utils.py` | `src/lib/math.ts`         |
| `xctsk_lib.py`        | `src/lib/xctsk.ts`        |
| `igc_lib.py`          | `src/lib/igc.ts`          |
| `comp_analysis.py`    | `src/lib/competition.ts`  |

The pandas/numpy DataFrame operations are reimplemented as plain array
operations (`diff(periods)`, `cumsum`, `.where`, `.clip`, NaN-aware masks) so
the results match the reference tool to floating-point precision.

`src/scripts/app.ts` is the browser island that reads the files, runs the
analysis, renders the styled stats table, and draws the climb-rate charts with
Chart.js. The dashed vertical lines mark each pilot's average climb rate.

## Verifying against the Python tool

`test/verify.ts` runs the ported analysis over a directory of IGC files and
prints the stats as JSON, for diffing against the Python output:

```bash
npx esbuild test/verify.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs
node /tmp/verify.mjs <igc_dir> <task.xctsk>
```
