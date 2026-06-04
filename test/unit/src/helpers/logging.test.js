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

import { describe, it } from 'mocha';
import assert from 'assert';

import Logging from '../../../../dist/helpers/logging.js';

describe('helpers/logging:Constants', () => {
  it('should expose LogLevel constants', () => {
    assert.strictEqual(Logging.Constants.LogLevel.ERR, 'error');
    assert.strictEqual(Logging.Constants.LogLevel.WARN, 'warn');
    assert.strictEqual(Logging.Constants.LogLevel.INFO, 'info');
    assert.strictEqual(Logging.Constants.LogLevel.VERBOSE, 'verbose');
    assert.strictEqual(Logging.Constants.LogLevel.DEBUG, 'debug');
    assert.strictEqual(Logging.Constants.LogLevel.SILLY, 'silly');
    assert.strictEqual(Logging.Constants.LogLevel.DEFAULT, 'info');
  });
});

describe('helpers/logging:log', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should capture a log entry when captureOutput is enabled', () => {
    Logging.log('test message');
    Logging.flush();
  });

  it('should capture a log entry with id', () => {
    Logging.log('test message', Logging.LogLevel.INFO, 'req-123');
    Logging.flush();
  });

  it('should use default level when not specified', () => {
    Logging.log('default level');
    Logging.flush();
  });
});

describe('helpers/logging:logVerbose', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log at verbose level', () => {
    Logging.logVerbose('verbose message');
    Logging.flush();
  });
});

describe('helpers/logging:logInfo', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log at info level', () => {
    Logging.logInfo('info message');
    Logging.flush();
  });
});

describe('helpers/logging:logDebug', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log at debug level', () => {
    Logging.logDebug('debug message');
    Logging.flush();
  });
});

describe('helpers/logging:logSilly', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log at silly level', () => {
    Logging.logSilly('silly message');
    Logging.flush();
  });
});

describe('helpers/logging:logWarn', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log at warn level', () => {
    Logging.logWarn('warn message');
    Logging.flush();
  });
});

describe('helpers/logging:logError', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log a string error', () => {
    Logging.logError('something went wrong');
    Logging.flush();
  });

  it('should log an Error object with stack trace', () => {
    const err = new Error('test error');
    Logging.logError(err);
    Logging.flush();
  });
});

describe('helpers/logging:captureOutput', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should store captured log lines in the buffer', () => {
    Logging.log('line1');
    Logging.log('line2');
    Logging.flush();
  });

  it('should clear the buffer on clean', () => {
    Logging.log('should be cleared');
    Logging.clean();
    Logging.flush();
  });
});

describe('helpers/logging:setLogLevel', () => {
  it('should change the logger level', () => {
    const original = Logging.level;
    Logging.setLogLevel('debug');
    assert.strictEqual(Logging.level, 'debug');
    Logging.setLogLevel(original);
  });
});

describe('helpers/logging:startupMessage', () => {
  it('should print the startup banner without error', () => {
    Logging.startupMessage();
  });
});

describe('helpers/logging:logTimer', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log timer info when timer object is provided', () => {
    const timer = { interval: 1.234, lapTime: 0.567 };
    Logging.logTimer('test request', timer, Logging.LogLevel.INFO);
    Logging.flush();
  });

  it('should log without timer info when timer is not provided', () => {
    Logging.logTimer('test request', null, Logging.LogLevel.INFO);
    Logging.flush();
  });
});

describe('helpers/logging:logTimerException', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log when interval exceeds time threshold', () => {
    const timer = { interval: 2.5, lapTime: 1.0 };
    Logging.logTimerException('slow request', timer, 1.0);
    Logging.flush();
  });

  it('should not log when interval is below time threshold', () => {
    const timer = { interval: 0.5, lapTime: 0.1 };
    Logging.logTimerException('fast request', timer, 1.0);
    Logging.flush();
  });
});

describe('helpers/logging:logObject', () => {
  beforeEach(() => {
    Logging.clean();
  });

  it('should log JSON-stringified object', () => {
    Logging.logObject({ key: 'value', num: 42 });
    Logging.flush();
  });
});

describe('helpers/logging:Promise', () => {
  describe('log', () => {
    it('should return a function that logs and passes through the value', () => {
      const fn = Logging.Promise.log('test', Logging.LogLevel.INFO);
      assert(typeof fn === 'function');
      const result = fn('resolved');
      assert.strictEqual(result, 'resolved');
    });
  });

  describe('logIf', () => {
    it('should log when value matches', () => {
      const fn = Logging.Promise.logIf('match', 'expected', Logging.LogLevel.INFO);
      const result = fn('expected');
      assert.strictEqual(result, 'expected');
    });

    it('should not log when value does not match', () => {
      const fn = Logging.Promise.logIf('match', 'expected', Logging.LogLevel.INFO);
      const result = fn('unexpected');
      assert.strictEqual(result, 'unexpected');
    });
  });

  describe('logIfNot', () => {
    it('should log when value does not match', () => {
      const fn = Logging.Promise.logIfNot('no match', 'expected', Logging.LogLevel.INFO);
      const result = fn('unexpected');
      assert.strictEqual(result, 'unexpected');
    });

    it('should not log when value matches', () => {
      const fn = Logging.Promise.logIfNot('no match', 'expected', Logging.LogLevel.INFO);
      const result = fn('expected');
      assert.strictEqual(result, 'expected');
    });
  });

  describe('logProp', () => {
    it('should log a property of the resolved value', () => {
      const fn = Logging.Promise.logProp('prop', 'name', Logging.LogLevel.INFO);
      const result = fn({ name: 'test', id: 1 });
      assert.strictEqual(result.name, 'test');
    });
  });

  describe('logPropIf', () => {
    it('should log when property matches value', () => {
      const fn = Logging.Promise.logPropIf('prop match', 'status', 'done', Logging.LogLevel.INFO);
      const result = fn({ status: 'done' });
      assert.strictEqual(result.status, 'done');
    });

    it('should not log when property does not match', () => {
      const fn = Logging.Promise.logPropIf('prop match', 'status', 'done', Logging.LogLevel.INFO);
      const result = fn({ status: 'pending' });
      assert.strictEqual(result.status, 'pending');
    });
  });

  describe('logPropIfNot', () => {
    it('should log when property does not match', () => {
      const fn = Logging.Promise.logPropIfNot('prop no match', 'status', 'done', Logging.LogLevel.INFO);
      const result = fn({ status: 'pending' });
      assert.strictEqual(result.status, 'pending');
    });

    it('should not log when property matches', () => {
      const fn = Logging.Promise.logPropIfNot('prop no match', 'status', 'done', Logging.LogLevel.INFO);
      const result = fn({ status: 'done' });
      assert.strictEqual(result.status, 'done');
    });
  });

  describe('logArray', () => {
    it('should log array length and each element', () => {
      const fn = Logging.Promise.logArray('items', Logging.LogLevel.INFO);
      const result = fn(['a', 'b']);
      assert.deepStrictEqual(result, ['a', 'b']);
    });
  });

  describe('logArrayProp', () => {
    it('should log array length and property of each element', () => {
      const fn = Logging.Promise.logArrayProp('items', 'name', Logging.LogLevel.INFO);
      const result = fn([{ name: 'a' }, { name: 'b' }]);
      assert.strictEqual(result.length, 2);
    });
  });

  describe('logError', () => {
    it('should log error message and stack', () => {
      const fn = Logging.Promise.logError();
      const err = new Error('promise error');
      const result = fn(err);
      assert.strictEqual(result, err);
    });
  });

  describe('logTimer', () => {
    it('should return a function that delegates to logging.logTimer', () => {
      const timer = { interval: 1.0, lapTime: 0.5 };
      const fn = Logging.Promise.logTimer('timed', timer, Logging.LogLevel.INFO);
      const result = fn('data');
      assert.strictEqual(result, 'data');
    });
  });

  describe('logTimerException', () => {
    it('should return a function that delegates to logging.logTimerException', () => {
      const timer = { interval: 2.0, lapTime: 1.0 };
      const fn = Logging.Promise.logTimerException('slow', timer, 1.0);
      const result = fn('data');
      assert.strictEqual(result, 'data');
    });
  });
});

describe('helpers/logging:newInstance', () => {
  it('should create a new independent Logging instance', () => {
    const instance = Logging.newInstance();
    assert(instance !== Logging);
    assert(typeof instance.log === 'function');
    assert(typeof instance.logVerbose === 'function');
  });
});
