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
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';

// run.mjs preloads this into every Node process of a test run (NODE_OPTIONS=--import), which reaches mocha's
// parallel workers and the INSTALL_MODE server that test:e2e starts through bin/app.sh.
register('./hooks.mjs', import.meta.url);

const outputDir = process.env.BJS_COVERAGE_OUTPUT;

// Instrumented modules count hits into globalThis.__coverage__, so write that out as the process ends.
process.on('exit', () => {
  if (!outputDir || !globalThis.__coverage__) return;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, `${process.pid}-${randomUUID()}.json`),
    JSON.stringify(globalThis.__coverage__),
  );
});
