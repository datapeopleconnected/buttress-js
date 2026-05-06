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

import { recordTiming } from '../perf/timing-collector.js';

export const runStep = async (name, fn, scope = 'Setup') => {
  const start = process.hrtime.bigint();
  console.log(`  [${scope}] Working on ${name}`);

  const getElapsedMs = () => Number(process.hrtime.bigint() - start) / 1_000_000;

  const recordStep = (status, elapsedMs) =>
    recordTiming({
      kind: 'step',
      name,
      scope,
      status,
      elapsedMs,
    });

  try {
    const result = await fn();
    const elapsedMs = getElapsedMs();
    recordStep('completed', elapsedMs);
    console.log(`  [${scope}] ${name} completed (${elapsedMs.toFixed(2)}ms)`);
    return result;
  } catch (err) {
    const elapsedMs = getElapsedMs();
    recordStep('errored', elapsedMs);
    console.log(`  [${scope}] ${name} errored (${elapsedMs.toFixed(2)}ms)`);
    throw err;
  }
};
