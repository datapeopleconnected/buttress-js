/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

const ActiveCompanies = require('./active-companies.json');
const AdminAccess = require('./admin-access.json');
const CompaniesInfo = require('./companies-info.json');
const CompaniesName = require('./companies-name.json');
const OverrideAccess = require('./override-access.json');
const Projection1 = require('./projection-1.json');
const Projection2 = require('./projection-2.json');
const PT11 = require('./pt1-1.json');
const PT12 = require('./pt1-2.json');
const Query1 = require('./query-1.json');
const Query2 = require('./query-2.json');
const SummerWorkingDate = require('./summer-working-date.json');
const SummerWorkingHour = require('./summer-working-hour.json');
const WorkingDate = require('./working-date.json');
const WorkingHour = require('./working-hour.json');

module.exports = {
  'active-companies': ActiveCompanies,
  'admin-access': AdminAccess,
  'companies-info': CompaniesInfo,
  'companies-name': CompaniesName,
  'override-access': OverrideAccess,
  'projection-1': Projection1,
  'projection-2': Projection2,
  'pt1-1': PT11,
  'pt1-2': PT12,
  'query-1': Query1,
  'query-2': Query2,
  'summer-working-date': SummerWorkingDate,
  'summer-working-hour': SummerWorkingHour,
  'working-date': WorkingDate,
  'working-hour': WorkingHour,
};