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
import type ivm from 'isolated-vm';

import Logging from '../helpers/logging.js';
import type { IsolateCallback } from './isolate-bridge.js';

export interface LambdaResult {
  err?: boolean;
  errMessage?: string;
  redirect?: boolean;
  code?: string;
  httpStatus?: number;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface LambdaExecutionLog {
  log: string;
  type: string;
}

/**
 * How a host function answers the isolate: through its callback, only while the run that called it is going.
 */
export type RunCallback = Pick<IsolateCallback, 'applyIgnored'>;

// How much of a run's logging is kept with its execution, which Mongo caps at 16 MB with everything else it holds
const MAX_EXECUTION_LOG_BYTES = 1024 * 1024;

/**
 * One execution of a lambda, which the host functions it calls act for: whose metadata they update, whose code folder
 * email templates come from, whose caller a request is made as, and where its result and logs go.
 *
 * One isolate runs every lambda and an app's context is kept between runs, so code a lambda leaves running when it
 * returns, e.g. after a sleep(), would otherwise go on into a later run. A host function binds to the run going in its
 * context when it's called, and is refused when there's none. When the run ends its sleeps and requests are cancelled
 * and nothing more is answered to the isolate for it, so its code left behind never resumes to call one again.
 */
export default class LambdaRun {
  // The runner takes one lambda at a time
  private static _current: LambdaRun | null = null;

  readonly context: ivm.Context;
  readonly lambdaId: string;
  readonly lambdaGitHash: string | null;
  // For an endpoint that runs as its caller: the caller's token, which stays out of the isolate, and the origin of this
  // Buttress instance, the only place _fetch uses it
  readonly caller: { token: string; origin: string } | null;

  result: LambdaResult | null = null;

  private _logs: LambdaExecutionLog[] = [];
  private _logBytes = 0;
  private _droppedLogs = 0;

  // Cancels the run's sleeps and requests when it ends
  private readonly _ended = new AbortController();

  constructor(
    context: ivm.Context,
    lambda: { lambdaId: string; lambdaGitHash: string | null; caller?: { token: string; origin: string } | null },
  ) {
    this.context = context;
    this.lambdaId = lambda.lambdaId;
    this.lambdaGitHash = lambda.lambdaGitHash;
    this.caller = lambda.caller ?? null;
  }

  /**
   * Starts a run in the context, which the host functions called from it act for until it ends.
   */
  static start(context: ivm.Context, lambda: ConstructorParameters<typeof LambdaRun>[1]) {
    LambdaRun._current?.end();
    LambdaRun._current = new LambdaRun(context, lambda);
    return LambdaRun._current;
  }

  /**
   * The run a host function called from the context acts for. None when no run is going in that context: the call came
   * from code a run left behind, which is refused.
   */
  static in(context: ivm.Context, hostFunction: string) {
    const run = LambdaRun._current;
    if (run && run.context === context) return run;

    Logging.logWarn(`Refused ${hostFunction} called by a lambda run that has finished`);
    return null;
  }

  get ended() {
    return this._ended.signal.aborted;
  }

  // Aborts once the run has ended
  get signal() {
    return this._ended.signal;
  }

  /**
   * Ends the run, cancelling its sleeps and requests. Its host functions don't answer the isolate from now on.
   */
  end() {
    if (LambdaRun._current === this) LambdaRun._current = null;
    this._ended.abort(new Error('lambda_run_ended'));
  }

  /**
   * Answers the isolate through the callback only while the run is going, so code it left behind never resumes.
   */
  answer<T>(callback: ivm.Reference<T>): Pick<ivm.Reference<T>, 'applyIgnored'> {
    return {
      applyIgnored: (...args) => {
        if (!this.ended) callback.applyIgnored(...args);
      },
    };
  }

  log(log: unknown, type: string) {
    let text: string;
    try {
      text = typeof log === 'string' ? log : (JSON.stringify(log) ?? String(log));
    } catch {
      text = String(log);
    }

    const bytes = Buffer.byteLength(text);
    if (this._logBytes + bytes > MAX_EXECUTION_LOG_BYTES) {
      this._droppedLogs++;
      return;
    }
    this._logBytes += bytes;
    this._logs.push({ log: text, type });
  }

  /**
   * Gives the run's logs, with a note of how many were left out past the limit, and starts afresh.
   */
  takeLogs(): LambdaExecutionLog[] {
    const logs = this._logs;
    if (this._droppedLogs > 0) {
      logs.push({ log: `${this._droppedLogs} more log lines were left out`, type: 'warn' });
    }
    this._logs = [];
    this._logBytes = 0;
    this._droppedLogs = 0;
    return logs;
  }
}
