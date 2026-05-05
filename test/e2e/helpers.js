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

export const runStep = async (name, fn, scope = 'Setup') => {
  const start = Date.now();
  console.log(`  [${scope}] Working on ${name}`);
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    console.log(`  [${scope}] ${name} completed (${elapsed}ms)`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    throw new Error(`${scope} failed at "${name}" after ${elapsed}ms: ${err?.message || err}`);
  }
};
