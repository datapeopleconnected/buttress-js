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

// Mocha root hooks for npm run test:federation: install and start both stacks before the suites, and stop them and
// clear their data after. Logs stay in each stack's work folder, which is kept when a test fails or
// FEDERATION_KEEP=1, and named at the end.

import fs from 'node:fs';

import { stacks } from './stacks.mjs';

let failed = false;

export const mochaHooks = {
  async beforeAll() {
    this.timeout(180000);
    const all = Object.values(stacks);
    for (const stack of all) await stack.clearData();
    for (const stack of all) stack.install();
    await Promise.all(all.map((stack) => stack.start()));
  },

  afterEach() {
    if (this.currentTest?.state === 'failed') failed = true;
  },

  async afterAll() {
    this.timeout(120000);
    const all = Object.values(stacks);
    await Promise.all(all.map((stack) => stack.stop()));
    for (const stack of all) await stack.clearData();

    const keep = failed || process.env.FEDERATION_KEEP === '1';
    for (const stack of all) {
      if (keep) console.log(`federation: ${stack.code} logs are in ${stack.logDir}`);
      else fs.rmSync(stack.workDir, { recursive: true, force: true });
    }
  },
};
