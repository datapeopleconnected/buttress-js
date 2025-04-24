/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import ActiveCompanies from './active-companies.json' with { type: 'json' };
import AdminAccess from './admin-access.json' with { type: 'json' };
import CompaniesInfo from './companies-info.json' with { type: 'json' };
import CompaniesName from './companies-name.json' with { type: 'json' };
import OverrideAccess from './override-access.json' with { type: 'json' };
import Projection1 from './projection-1.json' with { type: 'json' };
import Projection2 from './projection-2.json' with { type: 'json' };
import PT11 from './pt1-1.json' with { type: 'json' };
import Query1 from './query-1.json' with { type: 'json' };
import Query2 from './query-2.json' with { type: 'json' };
import PolicySelectionBasic from './policy-selection-basic.json' with { type: 'json' };
import PolicySelectionArray from './policy-selection-array.json' with { type: 'json' };
import SummerWorkingDate from './summer-working-date.json' with { type: 'json' };
import SummerWorkingHour from './summer-working-hour.json' with { type: 'json' };
import WorkingDate from './working-date.json' with { type: 'json' };
import WorkingHour from './working-hour.json' with { type: 'json' };

import EnvStaticValueQuery from './env-static-value-query.json' with { type: 'json' };
import EnvDateCondition from './env-date-condition.json' with { type: 'json' };
import EnvEntityCondition from './env-entity-condition.json' with { type: 'json' };
import EnvUserCondition from './env-user-condition.json' with { type: 'json' };
import EnvUserQuery from './env-user-query.json' with { type: 'json' };

import LambdaTestAccess from './lambda-test-access.json' with { type: 'json' };

export default {
  'active-companies': ActiveCompanies,
  'admin-access': AdminAccess,
  'companies-info': CompaniesInfo,
  'companies-name': CompaniesName,
  'override-access': OverrideAccess,
  'projection-1': Projection1,
  'projection-2': Projection2,
  'pt1-1': PT11,
  'query-1': Query1,
  'query-2': Query2,
  'policy-selection-basic': PolicySelectionBasic,
  'policy-selection-array': PolicySelectionArray,
  'summer-working-date': SummerWorkingDate,
  'summer-working-hour': SummerWorkingHour,
  'working-date': WorkingDate,
  'working-hour': WorkingHour,
  'env-static-value-query': EnvStaticValueQuery,
  'env-date-condition': EnvDateCondition,
  'env-entity-condition': EnvEntityCondition,
  'env-user-condition': EnvUserCondition,
  'env-user-query': EnvUserQuery,
  'lambda-test-access': LambdaTestAccess,
};;