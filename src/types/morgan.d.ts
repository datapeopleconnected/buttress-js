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
// The parts of morgan used here, it doesn't ship its own types.
declare module 'morgan' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  interface Morgan {
    token<Req = IncomingMessage, Res = ServerResponse>(
      name: string,
      callback: (req: Req, res: Res, arg?: string) => string | undefined,
    ): Morgan;
  }

  const morgan: Morgan;

  export default morgan;
}
