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

import { ALIASES, matchQuery, toMongoQuery } from './operators.js';
import Sugar from '../helpers/sugar.js';

/**
 * The policy language's criteria, `{<@op>: <operand>}`, as policy selection and conditions test them on a value. A
 * criterion holds for a value as a query's would for a field holding it, through the operator registry: values
 * compared exactly and within their type, a list matched by its items too, null for a value that isn't there (D-32).
 */

// Each value read as a date, text as Sugar reads it (en-GB, so '31/01/2042', and '09:00' for today at 9); undefined if
// one can't be
const asDates = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const dates = value.map(asDates);
    return dates.includes(undefined) ? undefined : dates;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined;
  const date = Sugar.Date.create(value);
  return Sugar.Date.isValid(date) ? date : undefined;
};

/**
 * Whether `value OP operand` holds. The date operators read both sides as dates, as the policy language always has,
 * and fail when one can't be. An operator
 * the registry doesn't know fails, as does a pattern that isn't one.
 * @param {unknown} value - what a query would read from the field
 * @param {string} operator - `@op` or `$op`
 * @param {unknown} operand
 * @return {boolean}
 */
export function matchCriterion(value: unknown, operator: string, operand: unknown): boolean {
  const alias = ALIASES[operator];
  if (!alias) return false;

  if (alias.date) {
    [value, operand] = [asDates(value), asDates(operand)];
    if (value === undefined || operand === undefined) return false;
  }

  try {
    return matchQuery(toMongoQuery({ value: { [operator]: operand } }), { value });
  } catch (_err) {
    // A $regex whose pattern isn't one
    return false;
  }
}
