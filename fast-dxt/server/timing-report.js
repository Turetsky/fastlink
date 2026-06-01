#!/usr/bin/env node
// Summarize /tmp/fastlink-timing.jsonl written by handleCall's logTiming.
// Usage: node timing-report.js            (whole log)
//        node timing-report.js 30         (last 30 calls = one flow)
// Shows per-tool dur + the gap BETWEEN calls (Opus round-trip/think time), and
// the headline ratio: time Opus spent thinking vs time actions actually took.
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LOG = join(tmpdir(), 'fastlink-timing.jsonl');
const tail = parseInt(process.argv[2] || '0', 10);

let rows;
try {
  rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
} catch {
  console.error(`No timing log at ${LOG} yet — run a flow first.`);
  process.exit(1);
}
if (tail > 0) rows = rows.slice(-tail);

let totalGap = 0, totalDur = 0;
const byTool = {};
console.log('  gapMs  durMs  tool');
console.log('  -----  -----  ----');
for (const r of rows) {
  const gap = r.gapMs ?? 0;
  totalGap += gap;
  totalDur += r.durMs;
  const b = (byTool[r.name] ||= { n: 0, dur: 0, gap: 0 });
  b.n++; b.dur += r.durMs; b.gap += gap;
  console.log(`  ${String(gap).padStart(5)}  ${String(r.durMs).padStart(5)}  ${r.name}`);
}

console.log('\n  Per-tool totals (durMs / calls):');
for (const [name, b] of Object.entries(byTool).sort((a, c) => c[1].dur - a[1].dur)) {
  console.log(`    ${name.padEnd(20)} ${String(b.dur).padStart(6)}ms  (${b.n}x, avg ${Math.round(b.dur / b.n)}ms)`);
}

const wall = totalGap + totalDur;
const pct = (x) => wall ? `${Math.round((x / wall) * 100)}%` : '0%';
console.log('\n  ============================================');
console.log(`  Opus round-trips (gap): ${totalGap}ms  ${pct(totalGap)}`);
console.log(`  Actions (dur):          ${totalDur}ms  ${pct(totalDur)}`);
console.log(`  Wall clock:             ${wall}ms`);
console.log('  ============================================');
console.log(totalGap > totalDur
  ? '  → Round-trips dominate. Collapsing Opus turns (fast_do) is the win.'
  : '  → Actions dominate. Optimize the slowest tool above, not round-trips.');
