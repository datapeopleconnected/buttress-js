/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

const readArg = (name, fallback) => {
  const idx = args.findIndex((arg) => arg === `--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
};

const baselinePath = path.resolve(readArg('baseline', 'test/perf/baseline.json'));
const currentPath = path.resolve(readArg('current', 'test/perf/current.json'));
const warnPct = Number(readArg('warn-pct', '20'));
const failPct = Number(readArg('fail-pct', '35'));
const minAbsMs = Number(readArg('min-abs-ms', '50'));

const loadReport = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing report file: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
};

const toMap = (report) => {
  const summary = Array.isArray(report.summary) ? report.summary : [];
  return new Map(summary.map((item) => [item.key, item]));
};

const formatMs = (value) => `${value.toFixed(2)}ms`;
const formatPct = (value) => `${value.toFixed(2)}%`;

const baseline = loadReport(baselinePath);
const current = loadReport(currentPath);

const baselineMap = toMap(baseline);
const currentMap = toMap(current);

const keys = Array.from(new Set([...baselineMap.keys(), ...currentMap.keys()])).sort((a, b) => a.localeCompare(b));

const rows = [];
let warnCount = 0;
let failCount = 0;

for (const key of keys) {
  const base = baselineMap.get(key);
  const curr = currentMap.get(key);

  if (!base || !curr) {
    rows.push({
      key,
      status: 'INFO',
      message: !base ? 'missing in baseline' : 'missing in current',
    });
    continue;
  }

  const deltaMs = curr.medianMs - base.medianMs;
  const deltaPct = base.medianMs === 0 ? 0 : (deltaMs / base.medianMs) * 100;

  let status = 'OK';
  if (deltaMs > 0 && Math.abs(deltaMs) >= minAbsMs && deltaPct >= failPct) {
    status = 'FAIL';
    failCount += 1;
  } else if (deltaMs > 0 && Math.abs(deltaMs) >= minAbsMs && deltaPct >= warnPct) {
    status = 'WARN';
    warnCount += 1;
  }

  rows.push({
    key,
    status,
    kind: key.startsWith('test::') ? 'test' : 'step',
    baselineMedian: base.medianMs,
    currentMedian: curr.medianMs,
    deltaMs,
    deltaPct,
    baselineP95: base.p95Ms,
    currentP95: curr.p95Ms,
  });
}

const buildRollup = (entries) => {
  const valid = entries.filter((row) => !row.message);
  const baselineTotal = valid.reduce((acc, row) => acc + row.baselineMedian, 0);
  const currentTotal = valid.reduce((acc, row) => acc + row.currentMedian, 0);
  const deltaTotal = currentTotal - baselineTotal;
  const deltaPctTotal = baselineTotal === 0 ? 0 : (deltaTotal / baselineTotal) * 100;
  const fasterCount = valid.filter((row) => row.deltaMs < 0).length;
  const slowerCount = valid.filter((row) => row.deltaMs > 0).length;
  const unchangedCount = valid.filter((row) => row.deltaMs === 0).length;

  return {
    measuredKeys: valid.length,
    baselineTotal,
    currentTotal,
    deltaTotal,
    deltaPctTotal,
    fasterCount,
    slowerCount,
    unchangedCount,
  };
};

const printRollup = (title, rollup) => {
  const direction = rollup.deltaTotal >= 0 ? '+' : '';
  console.log(title);
  console.log(`  keys measured: ${rollup.measuredKeys}`);
  console.log(`  baseline total median: ${formatMs(rollup.baselineTotal)}`);
  console.log(`  current total median:  ${formatMs(rollup.currentTotal)}`);
  console.log(`  total delta: ${direction}${formatMs(rollup.deltaTotal)} (${direction}${formatPct(rollup.deltaPctTotal)})`);
  console.log(
    `  key changes: ${rollup.fasterCount} faster, ${rollup.slowerCount} slower, ${rollup.unchangedCount} unchanged`,
  );
};

const overallRollup = buildRollup(rows);
const stepRollup = buildRollup(rows.filter((row) => row.kind === 'step'));
const testRollup = buildRollup(rows.filter((row) => row.kind === 'test'));

console.log('Performance comparison');
console.log(`Baseline: ${baselinePath}`);
console.log(`Current:  ${currentPath}`);
console.log(`Thresholds: warn=${warnPct}% fail=${failPct}% minAbs=${minAbsMs}ms`);
console.log('');

for (const row of rows) {
  if (row.message) {
    console.log(`[${row.status}] ${row.key} (${row.message})`);
    continue;
  }

  const direction = row.deltaMs >= 0 ? '+' : '';
  console.log(
    `[${row.status}] ${row.key} | median ${formatMs(row.baselineMedian)} -> ${formatMs(row.currentMedian)} ` +
      `(${direction}${formatMs(row.deltaMs)}, ${direction}${formatPct(row.deltaPct)}) | ` +
      `p95 ${formatMs(row.baselineP95)} -> ${formatMs(row.currentP95)}`,
  );
}

console.log('');
console.log(`Summary: ${rows.length} keys, ${warnCount} warnings, ${failCount} failures`);
console.log('');
printRollup('Overall timing breakdown', overallRollup);
console.log('');
printRollup('Step timing breakdown', stepRollup);
console.log('');
printRollup('Test timing breakdown', testRollup);

if (failCount > 0) {
  process.exit(1);
}
