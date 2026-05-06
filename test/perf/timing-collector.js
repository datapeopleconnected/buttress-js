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

const timingEnabled = process.env.BJS_TIMING === '1';
const timingOutputPath = process.env.BJS_TIMING_OUTPUT || 'test/perf/current.json';
const timingRecords = [];

const percentile = (sortedValues, pct) => {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sortedValues.length) - 1;
  const safeIdx = Math.max(0, Math.min(idx, sortedValues.length - 1));
  return sortedValues[safeIdx];
};

const summariseTimings = (records) => {
  const grouped = new Map();

  records.forEach((record) => {
    const key = record.kind === 'test' ? `test::${record.scope}::${record.name}` : `${record.scope}::${record.name}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  });

  return Array.from(grouped.entries())
    .map(([key, recordsByKey]) => {
      const sorted = recordsByKey
        .map((record) => record.elapsedMs)
        .slice()
        .sort((a, b) => a - b);
      const sum = sorted.reduce((acc, value) => acc + value, 0);
      const firstRecord = recordsByKey[0];

      return {
        key,
        kind: firstRecord.kind || 'step',
        scope: firstRecord.scope,
        name: firstRecord.name,
        samples: sorted.length,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        meanMs: sum / sorted.length,
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
};

const writeTimingReport = () => {
  if (!timingEnabled || timingRecords.length === 0) return;

  const outputPath = path.resolve(timingOutputPath);
  const summary = summariseTimings(timingRecords);
  const payload = {
    metadata: {
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      expressVersion: process.env.npm_package_dependencies_express || 'unknown',
      runMode: process.env.TEST_ENV || process.env.NODE_ENV || 'unknown',
      totalRecords: timingRecords.length,
    },
    summary,
    records: timingRecords,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(`  [Perf] Wrote timing report to ${outputPath}`);
};

process.on('exit', writeTimingReport);

export const isTimingEnabled = () => timingEnabled;

export const recordTiming = ({ kind = 'step', name, scope = 'unknown', status = 'completed', elapsedMs }) => {
  if (!timingEnabled) return;
  if (!name) return;
  if (!Number.isFinite(elapsedMs)) return;

  timingRecords.push({
    kind,
    name,
    scope,
    status,
    elapsedMs,
    at: new Date().toISOString(),
  });
};
