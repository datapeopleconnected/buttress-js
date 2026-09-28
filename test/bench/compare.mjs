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

// npm run bench:compare -- <base.json> <head.json>: compares two npm run bench results, scenario by scenario.

import fs from 'node:fs';
import { parseArgs } from 'node:util';

const USAGE = `Usage: npm run bench:compare -- [--threshold <pct>] <base.json> <head.json>

Marks a metric better or worse when every head round beat, or lost to, every base round, and the medians differ by
at least --threshold percent (default: 5).`;

// higherIsBetter decides which way a change counts as better.
const METRICS = [
  { key: 'rps', label: 'req/s', places: 1, higherIsBetter: true },
  { key: 'p50', label: 'p50 ms', places: 2, higherIsBetter: false },
  { key: 'p99', label: 'p99 ms', places: 2, higherIsBetter: false },
  { key: 'cpuMsPerRequest', label: 'cpu ms/req', places: 3, higherIsBetter: false },
];

const fail = (message) => {
  console.error(`bench:compare: ${message}`);
  process.exit(1);
};

const load = (file) => {
  let results;
  try {
    results = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`can't read ${file}: ${err.message}`);
  }
  if (results.tool !== 'buttress-bench') fail(`${file} isn't an npm run bench results file`);
  return results;
};

const describe = (results) => {
  const commit = results.build.git.commit?.slice(0, 8) ?? 'no git';
  const dirty = results.build.git.dirty ? ' +uncommitted' : '';
  const label = results.label ? ` "${results.label}"` : '';
  return `${commit}${dirty}${label}, ${results.createdAt.slice(0, 16).replace('T', ' ')}`;
};

const percentChange = (base, head) =>
  base === null || head === null || base === 0 ? null : ((head - base) / base) * 100;

// A change counts when it's consistent and big enough: the rounds don't overlap (every head round beat, or lost to,
// every base round) and the medians differ by at least the threshold. Anything else is left unmarked.
const verdict = (metric, b, h, thresholdPct) => {
  const base = b.rounds.map((round) => round[metric.key]).filter((value) => value !== null);
  const head = h.rounds.map((round) => round[metric.key]).filter((value) => value !== null);
  const pct = percentChange(b.median[metric.key], h.median[metric.key]);
  if (base.length < 2 || head.length < 2 || pct === null || Math.abs(pct) < thresholdPct) return '';

  const headHigher = Math.min(...head) > Math.max(...base);
  const headLower = Math.max(...head) < Math.min(...base);
  if (!headHigher && !headLower) return '';
  return headHigher === metric.higherIsBetter ? 'better' : 'worse';
};

const fmt = (value, places) => (value === null || value === undefined ? '-' : value.toFixed(places));

const fmtChange = (pct) => (pct === null ? '-' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);

let args;
try {
  args = parseArgs({ options: { threshold: { type: 'string', default: '5' } }, allowPositionals: true });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
const thresholdPct = Number(args.values.threshold);
if (args.positionals.length !== 2 || !(thresholdPct >= 0)) fail(USAGE);

const [baseFile, headFile] = args.positionals;
const base = load(baseFile);
const head = load(headFile);

console.log(`base: ${describe(base)}  (${baseFile})`);
console.log(`head: ${describe(head)}  (${headFile})`);

const differences = [
  ['settings', JSON.stringify(base.settings), JSON.stringify(head.settings)],
  ...['node', 'cpu', 'cpus', 'mongo', 'redis'].map((key) => [key, base.environment[key], head.environment[key]]),
].filter(([, a, b]) => a !== b);
for (const [what, a, b] of differences) {
  console.log(`warning: ${what} differs (${a} vs ${b}), so the comparison may not be like for like`);
}
console.log('');

const rows = [['scenario', 'metric', 'base', 'head', 'change', '']];
const names = Object.keys(base.scenarios).filter((name) => head.scenarios[name]);
for (const name of names) {
  const [b, h] = [base.scenarios[name], head.scenarios[name]];
  METRICS.forEach((metric, idx) => {
    rows.push([
      idx === 0 ? name : '',
      metric.label,
      fmt(b.median[metric.key], metric.places),
      fmt(h.median[metric.key], metric.places),
      fmtChange(percentChange(b.median[metric.key], h.median[metric.key])),
      verdict(metric, b, h, thresholdPct),
    ]);
  });
  if (b.median.errors || h.median.errors)
    rows.push(['', 'errors', String(b.median.errors), String(h.median.errors), '', '']);
}

const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
const alignRight = [false, false, true, true, true, false];
for (const row of rows) {
  console.log(
    row
      .map((cell, col) => (alignRight[col] ? cell.padStart(widths[col]) : cell.padEnd(widths[col])))
      .join('  ')
      .trimEnd(),
  );
}

const missing = [...Object.keys(base.scenarios), ...Object.keys(head.scenarios)].filter(
  (name) => !(base.scenarios[name] && head.scenarios[name]),
);
if (missing.length) console.log(`\nnot in both results: ${[...new Set(missing)].join(', ')}`);

console.log(
  `\nValues are medians across rounds. better/worse: every head round beat, or lost to, every base round, by at` +
    `\nleast ${thresholdPct}% at the median. Unmarked changes are too small or inconsistent to tell from run-to-run noise.`,
);
