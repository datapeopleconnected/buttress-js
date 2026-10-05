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
import { Request } from 'express';

import Logging from '../helpers/logging.js';
import { tokenFingerprint } from '../helpers/redact.js';
import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';

export class RoutesTokens {
  // Every token, by value
  private _byValue = new Map<string, Token>();

  // The load that's running, and the one queued to run after it
  private _loading: Promise<void> | null = null;
  private _reloadQueued: Promise<void> | null = null;

  // Counts loads started, so a token looked up on its own isn't added to a cache that was reloaded meanwhile
  private _generation = 0;

  /**
   * Loads every token into the cache. A call made while a load runs gets one more load after it, as the running one
   * may have read the collection before the change the caller is reacting to. Calls made meanwhile share that load.
   * @return {Promise}
   */
  loadTokens(): Promise<void> {
    if (!this._loading) {
      this._loading = this._load().finally(() => {
        this._loading = null;
      });
      return this._loading;
    }

    if (!this._reloadQueued) {
      this._reloadQueued = this._loading.then(() => {
        this._reloadQueued = null;
        return this.loadTokens();
      });
    }
    return this._reloadQueued;
  }

  async _load() {
    this._generation++;
    const byValue = new Map<string, Token>();
    const rxsToken = await Model.getCoreModel(TokenSchemaModel).findAll();

    for await (const token of rxsToken as AsyncIterable<Token>) {
      byValue.set(token.value, token);
    }

    this._byValue = byValue;
  }

  get tokens(): Token[] {
    return [...this._byValue.values()];
  }

  set tokens(value: Token[]) {
    this._byValue = new Map(value.map((token) => [token.value, token]));
  }

  _lookupToken(tokens: Token[], value: string): Token | null {
    const token = tokens.filter((t) => t.value === value);
    return token.length === 0 ? null : token[0];
  }

  async _getProvidedToken(req: Request): Promise<Token> {
    let tokenValue: string | undefined = req.headers['authorization'];
    if (tokenValue) tokenValue = tokenValue.replace('Bearer ', '');

    Logging.logSilly(`_getProvidedToken:start ${tokenFingerprint(tokenValue)}`, req.context.id);

    if (!tokenValue) {
      Logging.logTimer(
        `_getProvidedToken:end-missing-token`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );
      throw Helpers.Errors.unauthorised('missing_token', 'A token is required');
    }

    const token = await this._getToken(req, tokenValue);
    if (token === null) {
      Logging.logTimer(
        `_getProvidedToken:end-cant-find-token`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );
      throw Helpers.Errors.unauthorised('invalid_token', 'The token is not valid');
    }

    return token;
  }

  async _getToken(req: Request, value: string): Promise<Token | null> {
    Logging.logTimer('_getToken:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    // Only a string is looked up, so the value can't be read as query operators
    if (typeof value !== 'string' || value === '') return null;

    const cached = this._byValue.get(value);
    if (cached) {
      Logging.logTimer('_getToken:end-cache', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      return cached;
    }

    // A token made since the cache was loaded is looked up on its own, rather than by reloading every token
    const generation = this._generation;
    const token = await Model.getCoreModel(TokenSchemaModel).findOne({ value });
    if (token && generation === this._generation) this._byValue.set(value, token);

    Logging.logTimer('_getToken:end-lookup', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    return token;
  }
}

export default RoutesTokens;
