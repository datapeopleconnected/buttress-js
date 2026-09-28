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

import cluster from 'node:cluster';

import winston from 'winston';

import Config from './config.js';

/**
 *
 * @type {{ERR: string, WARN: string, INFO: string, VERBOSE: string, DEBUG: string, SILLY: string, DEFAULT: string}}
 */
const LogLevel = {
  ERR: 'error',
  WARN: 'warn',
  INFO: 'info',
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  SILLY: 'silly',
  DEFAULT: 'info',
};

const Constants = {
  LogLevel: LogLevel,
};

/**
 * Anything with the elapsed-time getters of `Helpers.Timer`.
 */
interface LogTimer {
  readonly interval: number;
  readonly lapTime: number;
}

interface LogLine {
  level: string;
  message: unknown;
}

class Logging {
  private _prefixes: {
    app: string;
    parts: string[];
    string: string;
  };
  promises: LoggingPromise;

  logger?: winston.Logger;

  private _captureOutput = false;
  private _captureOutputBuffer: LogLine[] = [];

  constructor() {
    this._prefixes = {
      app: 'APP',
      parts: [],
      string: '',
    };
    this.promises = new LoggingPromise(this);
  }

  get Constants() {
    return Constants;
  }

  get LogLevel() {
    return LogLevel;
  }

  newInstance() {
    return new Logging();
  }

  setLogApp(extra?: string | string[]) {
    this._prefixes.parts = [this._prefixes.app];
    this._prefixes.parts.push(cluster.isWorker ? `${cluster.worker?.id}` : 'MAIN');

    if (extra) this._prefixes.parts = this._prefixes.parts.concat(Array.isArray(extra) ? extra : [extra]);

    this._prefixes.string = this._prefixes.parts.join('][');
  }

  init(logApp: string) {
    this._prefixes.app = logApp;
    this.setLogApp();

    // winston.remove(winston.transports.Console);
    this.logger = winston.createLogger({
      level: Config.logging.level || 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.printf((info) => {
          if (info.stack) {
            return `${info.timestamp} [${this._prefixes.string}] ${info.level}: ${info.message}\n${info.stack}`;
          }

          return `${info.timestamp} [${this._prefixes.string}] ${info.level}: ${info.message}`;
        }),
      ),
      transports: [new winston.transports.Console()],
    });
  }

  captureOutput(mode = false) {
    if (mode) {
      // Setup structure
      this.clean();
    }

    this._captureOutput = mode;
  }
  flush() {
    this._captureOutputBuffer.forEach((line) => {
      if (!this.logger) {
        console.log(line);
        return;
      }

      this.logger.log(line as winston.LogEntry);
    });
  }
  clean() {
    this._captureOutputBuffer = [];
  }

  startupMessage() {
    console.log(`***`);
    console.log(` * Buttress - The federated real-time open data platform`);
    console.log(` * Copyright (C) 2016-2026 Data People Connected LTD.`);
    console.log(` * <https://www.dpc-ltd.com/>`);
    console.log(` *`);
    console.log(` * Buttress is free software: you can redistribute it and/or modify it under the`);
    console.log(` * terms of the GNU Affero General Public Licence as published by the Free Software`);
    console.log(` * Foundation, either version 3 of the Licence, or (at your option) any later version.`);
    console.log(` * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;`);
    console.log(` * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.`);
    console.log(` * See the GNU Affero General Public Licence for more details.`);
    console.log(` * You should have received a copy of the GNU Affero General Public Licence along with`);
    console.log(` * this program. If not, see <http://www.gnu.org/licenses/>.`);
    console.log(`***`);
  }

  /**
   *
   * @param {string} log - log entry
   * @param {string} level - level to log at
   * @param {string} id - id
   * @private
   */
  _log(log: unknown, level: string, id?: string) {
    const line: LogLine = {
      level: level,
      message: id ? `[${id}] ${log}` : log,
    };

    if (this._captureOutput) {
      this._captureOutputBuffer.push(line);
      return;
    }

    if (!this.logger) {
      console.log(`[${level}] ${log}`);
      return;
    }

    this.logger.log(line as winston.LogEntry);
  }

  setLogLevel(level: string) {
    if (!this.logger) return;

    this.logger.level = level;
    // _logLevel = level;
  }

  get level() {
    if (!this.logger) return;
    return this.logger.level;
  }

  /**
   * @param {string} log - Text to log
   * @param {string} level - level to log at
   * @param {string} id - id
   */
  log(log: unknown, level?: string, id?: string) {
    level = level || LogLevel.DEFAULT;
    this._log(log, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {string} id - id
   */
  logVerbose(log: unknown, id?: string) {
    this.log(log, LogLevel.VERBOSE, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {string} id - id
   */
  logInfo(log: unknown, id?: string) {
    this.log(log, LogLevel.INFO, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {string} id - id
   */
  logDebug(log: unknown, id?: string) {
    this.log(log, LogLevel.DEBUG, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {string} id - id
   */
  logSilly(log: unknown, id?: string) {
    this.log(log, LogLevel.SILLY, id);
  }

  /**
   * @param {string} warn - warning to log
   * @param {string} id - id
   */
  logWarn(warn: unknown, id?: string) {
    this._log(warn, LogLevel.WARN, id);
  }
  /**
   * @param {string} err - error object to log
   * @param {string} id - id
   */
  logError(err: unknown, id?: string) {
    const errLike = err as { stack?: unknown; message?: unknown } | null | undefined;
    if (errLike && errLike.stack && errLike.message) {
      this._log(errLike.message, LogLevel.ERR, id);
      this._log(errLike.stack, LogLevel.ERR, id);
    } else {
      this._log(err, LogLevel.ERR, id);
    }
  }

  /**
   * @param {string} log - Text to log
   * @param {string} level - level to log at
   * @param {string} id - id
   */
  logObject(log: unknown, level?: string, id?: string) {
    level = level || LogLevel.DEFAULT;
    if (!this.logger?.isLevelEnabled(level)) return;

    this._log(JSON.stringify(log, null, 2), level, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {Object} timer - Object with an 'interval' property
   * @param {string} level - level to log at
   * @param {string} id - id
   */
  logTimer(log: unknown, timer: LogTimer | undefined, level?: string, id?: string) {
    level = level || LogLevel.INFO;
    if (!timer) {
      this._log(log, level, id);
      return;
    }
    this._log(`[${timer.interval.toFixed(6)}s][${timer.lapTime.toFixed(6)}s] ${log}`, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {Object} timer - Object with an 'interval' property
   * @param {string} time - time above which to log the exception
   * @param {string} id - id
   */
  logTimerException(log: unknown, timer: LogTimer, time: number, id?: string) {
    const level = LogLevel.ERR;
    if (timer.interval > time) {
      this._log(
        `[${timer.interval.toFixed(6)}s][${timer.lapTime.toFixed(6)}s] ${log} ${timer.interval.toFixed(3)}s > ${time}s`,
        level,
        id,
      );
    }
  }

  get Promise() {
    return this.promises;
  }
}

class LoggingPromise {
  logging: Logging;

  constructor(logging: Logging) {
    this.logging = logging;
  }

  /**
   * @param {string} log - Text to log
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  log(log: unknown, level?: string, id?: string) {
    level = level || LogLevel.DEFAULT;
    return <T>(res: T) => {
      this.logging.log(`${log}: ${res}`, level, id);
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {*} val - value to test `res` against
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logIf(log: unknown, val: unknown, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T>(res: T) => {
      if (val === res) {
        this.logging.log(`${log}: ${res}`, level);
      }
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {*} val - value to test `res` against
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logIfNot(log: unknown, val: unknown, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T>(res: T) => {
      if (val !== res) {
        this.logging.log(`${log}: ${res}`, level);
      }
      return res;
    };
  }

  /**
   * PROPERTY LOGGING
   */

  /**
   * @param {string} log - Text to log
   * @param {string} prop - Name of the `res` property to log
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logProp(log: unknown, prop: string, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T extends object>(res: T) => {
      this.logging.log(`${log}: ${res[prop as keyof T]}`, level);
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {string} prop - Name of the `res` property to log
   * @param {*} val - value to test `res` against
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logPropIf(log: unknown, prop: string, val: unknown, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T extends object>(res: T) => {
      if (val === res[prop as keyof T]) {
        this.logging.log(`${log}: ${res[prop as keyof T]}`, level);
      }
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {string} prop - Name of the `res` property to log
   * @param {*} val - value to test `res` against
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logPropIfNot(log: unknown, prop: string, val: unknown, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T extends object>(res: T) => {
      if (val !== res[prop as keyof T]) {
        this.logging.log(`${log}: ${res[prop as keyof T]}`, level);
      }
      return res;
    };
  }

  /**
   * ARRAY LOGGING
   */

  /**
   * @param {string} log - Text to log
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logArray(log: unknown, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T>(res: T[]) => {
      this.logging.log(`${log}: ${res.length}`, level);
      res.forEach((r) => {
        this.logging.log(r, level);
      });
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {string} prop - Name of the `res[]` property to log
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logArrayProp(log: unknown, prop: string, level?: string) {
    level = level || LogLevel.DEFAULT;
    return <T extends object>(res: T[]) => {
      this.logging.log(`${log}: ${res.length}`, level);
      res.forEach((r) => {
        this.logging.log(r[prop as keyof T]);
      });
      return res;
    };
  }

  /**
   * @return {function(*)} - returns a function for chaining into a promise
   */
  logError() {
    const level = LogLevel.ERR;
    return <T extends Error>(err: T) => {
      this.logging.log(err.message, level);
      this.logging.log(err.stack, level);
      return err;
    };
  }

  /**
   * @param {string} log - Text to log
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logInfo(log: unknown, id?: string) {
    const level = LogLevel.INFO;
    return this.log(log, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logVerbose(log: unknown, id?: string) {
    const level = LogLevel.VERBOSE;
    return this.log(log, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logDebug(log: unknown, id?: string) {
    const level = LogLevel.DEBUG;
    return this.log(log, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logSilly(log: unknown, id?: string) {
    const level = LogLevel.SILLY;
    return this.log(log, level, id);
  }

  /**
   * @param {string} log - Text to log
   * @param {Object} timer - Object with an 'interval' property
   * @param {string} level - level to log at
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logTimer(log: unknown, timer: LogTimer | undefined, level?: string, id?: string) {
    return <T>(res: T) => {
      this.logging.logTimer(log, timer, level, id);
      return res;
    };
  }

  /**
   * @param {string} log - Text to log
   * @param {Object} timer - Object with an 'interval' property
   * @param {string} time - time above which to log the exception
   * @return {function(*)} - returns a function for chaining into a promise
   * @param {string} id - id
   */
  logTimerException(log: unknown, timer: LogTimer, time: number, id?: string) {
    return <T>(res: T) => {
      this.logging.logTimerException(log, timer, time, id);

      return res;
    };
  }
}

export default new Logging();
