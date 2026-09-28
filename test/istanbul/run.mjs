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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import libSourceMaps from 'istanbul-lib-source-maps';
import reports from 'istanbul-reports';

import { DIST_DIR, instrumentFile, shouldInstrument } from './hooks.mjs';

// Runs the unit and/or e2e suites with dist/ instrumented by Istanbul, then reports coverage of src/*.ts.
// c8 (npm run coverage / coverage:unit) reads high: it counts licence headers, comments and types as covered
// lines, and only counts branches inside functions that actually ran. Istanbul's totals are fixed.
//
//   npm run coverage:istanbul            # unit + e2e
//   npm run coverage:istanbul -- unit    # a single suite
//
// The e2e suite runs exactly as `npm run test:e2e` does: it needs MongoDB + Redis, and it drops the test
// database and flushes Redis before it starts.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT_DIR = path.join(ROOT, 'coverage/istanbul');
const RAW_DIR = path.join(REPORT_DIR, 'raw');
const SUITES = ['unit', 'e2e'];
const METRICS = ['statements', 'branches', 'functions', 'lines'];

const suites = process.argv.length > 2 ? process.argv.slice(2) : SUITES;
if (suites.some((suite) => !SUITES.includes(suite))) {
  console.error(`Usage: node test/istanbul/run.mjs [${SUITES.join('|')}]...`);
  process.exit(1);
}

if (!fs.existsSync(DIST_DIR)) {
  console.error(`No build found at ${DIST_DIR}. Run 'npm run build' first.`);
  process.exit(1);
}

fs.rmSync(REPORT_DIR, { recursive: true, force: true });

const registerHook = `--import=${new URL('./register.mjs', import.meta.url).href}`;
const failedSuites = [];
for (const suite of suites) {
  const { status } = spawnSync('npm', ['run', `test:${suite}`], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, registerHook].filter(Boolean).join(' '),
      BJS_COVERAGE_OUTPUT: path.join(RAW_DIR, suite),
      // Instrumented code runs slower, so default to the timeouts CI uses.
      MOCHA_UNIT_TIMEOUT: process.env.MOCHA_UNIT_TIMEOUT ?? '10000',
      MOCHA_E2E_TIMEOUT: process.env.MOCHA_E2E_TIMEOUT ?? '20000',
    },
  });
  if (status !== 0) failedSuites.push(suite);
}

// A zero-hit entry for every compiled file, so modules that no test ever imports still count as missed.
const baseline = [];
for (const file of fs.readdirSync(DIST_DIR, { recursive: true })) {
  const filename = path.join(DIST_DIR, file);
  if (!shouldInstrument(filename)) continue;

  const { fileCoverage } = await instrumentFile(filename, fs.readFileSync(filename, 'utf8'));
  baseline.push(fileCoverage);
}

const readRawCoverage = (suite) => {
  const dir = path.join(RAW_DIR, suite);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
};

const coverageFor = async (suiteNames) => {
  const map = libCoverage.createCoverageMap({});
  // Merging adds hits into the stored object, so every map gets its own copy of the baseline.
  baseline.forEach((fileCoverage) => map.addFileCoverage(structuredClone(fileCoverage)));
  suiteNames.flatMap(readRawCoverage).forEach((raw) => map.merge(raw));

  return libSourceMaps.createSourceMapStore().transformCoverage(map);
};

const formatMetric = ({ pct, covered, total }) =>
  `${pct.toFixed(2).padStart(6)}% ${`(${covered}/${total})`.padEnd(13)}`;
const printRow = (label, map) => {
  const summary = map.getCoverageSummary();
  console.log(`${label.padEnd(14)}${METRICS.map((metric) => formatMetric(summary[metric])).join('')}`);
};

console.log(`\nCoverage of src/ (Istanbul)\n${''.padEnd(14)}${METRICS.map((metric) => metric.padEnd(21)).join('')}`);
if (suites.length > 1) {
  for (const suite of suites) printRow(suite, await coverageFor([suite]));
}
const combined = await coverageFor(suites);
printRow(suites.join(' + '), combined);

const context = libReport.createContext({ dir: REPORT_DIR, coverageMap: combined, defaultSummarizer: 'nested' });
reports.create('lcov', { projectRoot: ROOT }).execute(context);
reports.create('json-summary').execute(context);
fs.rmSync(RAW_DIR, { recursive: true, force: true });

console.log(`\nHTML report: ${path.relative(process.cwd(), path.join(REPORT_DIR, 'lcov-report/index.html'))}`);

if (failedSuites.length) {
  console.error(`\nTests failed in: ${failedSuites.join(', ')}. Coverage is from an incomplete run and will read low.`);
  process.exitCode = 1;
}
