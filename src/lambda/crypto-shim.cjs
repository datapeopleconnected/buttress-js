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

// What a lambda gets for require('crypto') and require('node:crypto'). It's the browser polyfill, which lacks
// randomUUID, and whose random bytes come from a global `crypto` that the isolate doesn't have until the lambda bridge
// gives it one (lambda-helpers/isolate-bridge.ts). Packages a lambda bundles use these, @buttress/api for a uuid
// property's default among them.
const polyfill = require('crypto-browserify');

module.exports = Object.assign({}, polyfill, {
  randomUUID: () => globalThis.crypto.randomUUID(),
  getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
  randomBytes: (size) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size))),
});
