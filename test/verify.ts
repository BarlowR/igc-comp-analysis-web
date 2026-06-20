// Verification harness: runs the ported analysis on the day2 dataset and emits
// the same stats shape as the Python reference, for diffing.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Competition, COMP_SUBSET } from '../src/lib/competition';

const DATA = process.argv[2];
const TASK = process.argv[3];

const comp = new Competition(readFileSync(TASK, 'utf-8'));
const files = readdirSync(DATA).filter((f) => f.endsWith('.igc')).sort();
for (const f of files) {
  comp.addPilot(readFileSync(join(DATA, f), 'utf-8'), f);
}

const out: Record<string, Record<string, unknown>> = {};
for (const p of comp.pilots) {
  const row: Record<string, unknown> = {};
  for (const col of COMP_SUBSET) {
    row[col.key] = col.key === 'name' ? p.name : p.stats[col.key];
  }
  row.completed = p.stats.completed;
  for (const lbl of ['1ms', '2ms', '3ms', '4ms', '5ms', '>5ms']) {
    row['pct_' + lbl] = p.stats[`comp_percentage_time_${lbl}_climb`];
  }
  out[p.name] = row;
}

console.log(JSON.stringify(out, null, 1));
