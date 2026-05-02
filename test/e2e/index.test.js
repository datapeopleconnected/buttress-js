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

import sourceMapSupport from 'source-map-support'
sourceMapSupport.install();

import './rest/core/token.test.js';
import './rest/core/user.test.js';

import './rest/schema.test.js';
import './rest/data-sharing.test.js';
import './rest/policy.test.js';

import './spr/processing.test.js';
import './spr/cache.test.js';

import './sock/realtime.test.js';

import './lambda/lambda.test.js';

