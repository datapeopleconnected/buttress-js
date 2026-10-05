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
import { fileURLToPath } from 'node:url';

export const DIST_DIR = fileURLToPath(new URL('../../dist/', import.meta.url));
const TYPES_DIR = `${DIST_DIR}types/`;

// dist/types only holds type-only output, so there is nothing to execute there.
export const shouldInstrument = (filename) =>
  filename.startsWith(DIST_DIR) && !filename.startsWith(TYPES_DIR) && filename.endsWith('.js');

let instrumenter = null;

// Shared by the loader hook and the zero-hit baseline in run.mjs: both must instrument with the same options,
// otherwise their coverage objects won't line up when merged. Loaded lazily so Node processes that never touch
// dist/ (npm itself, for one) don't pay for Babel.
export const instrumentFile = async (filename, code) => {
  if (!instrumenter) {
    const { createInstrumenter } = await import('istanbul-lib-instrument');
    instrumenter = createInstrumenter({ esModules: true, compact: true });
  }

  // tsc's source map lets the report remap counts from dist/*.js back onto src/*.ts.
  const mapFile = `${filename}.map`;
  const inputSourceMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : undefined;

  const instrumented = instrumenter.instrumentSync(code, filename, inputSourceMap);
  return { code: instrumented, fileCoverage: instrumenter.lastFileCoverage() };
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:') || result.source == null) return result;

  const filename = fileURLToPath(url);
  if (!shouldInstrument(filename)) return result;

  const { code } = await instrumentFile(filename, Buffer.from(result.source).toString('utf8'));
  return { ...result, source: code };
}
