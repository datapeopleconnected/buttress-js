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
import { createHash } from 'node:crypto';

// Stand-ins for credentials in logs, which can be shipped and kept anywhere

/**
 * A short fingerprint of a token, which tells tokens apart in logs without showing any of it.
 */
export const tokenFingerprint = (value: unknown) => {
  if (typeof value !== 'string' || value === '') return String(value);
  return `token#${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
};

/**
 * A URL with only its protocol, host and path: no user info, query or fragment, which can carry credentials.
 */
export const redactUrl = (url: unknown) => {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[url]';
  }
};
