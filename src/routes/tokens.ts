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
import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';
import TokenSchemaModel from '../model/core/token.js';

export class RoutesTokens {
  private _tokens: any[] = [];

  async loadTokens() {
    const tokens: any[] = [];
    const rxsToken = await Model.getCoreModel(TokenSchemaModel).findAll();

    for await (const token of rxsToken) {
      tokens.push(token);
    }

    this._tokens = tokens;
  }

  get tokens(): any[] {
    return this._tokens;
  }

  set tokens(value: any[]) {
    this._tokens = value;
  }

  _lookupToken(tokens: any[], value: string): any {
    const token = tokens.filter((t) => t.value === value);
    return token.length === 0 ? null : token[0];
  }

  async _getProvidedToken(req: any): Promise<any> {
    let tokenValue: string | undefined = req.headers['authorization'];
    if (tokenValue) tokenValue = tokenValue.replace('Bearer ', '');

    Logging.logSilly(`_getProvidedToken:start ${tokenValue}`, req.id);

    if (!tokenValue) {
      Logging.logTimer(`_getProvidedToken:end-missing-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      throw new Helpers.Errors.RequestError(401, 'missing_token');
    }

    const token = await this._getToken(req, tokenValue);
    if (token === null) {
      Logging.logTimer(`_getProvidedToken:end-cant-find-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      throw new Helpers.Errors.RequestError(401, 'invalid_token');
    }

    return token;
  }

  async _getToken(req: any, value: string): Promise<any> {
    Logging.logTimer('_getToken:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    let token = null;

    if (this._tokens.length > 0) {
      token = this._lookupToken(this._tokens, value);
      if (token) {
        Logging.logTimer('_getToken:end-cache', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
        return token;
      }
    }

    await this.loadTokens();

    token = this._lookupToken(this._tokens, value);
    Logging.logTimer('_getToken:end-lookup', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    return token;
  }
}

export default RoutesTokens;
