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

import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaHelpers from '../../../../dist/lambda-helpers/helpers.js';

const Config = createConfig();

const HASH = '1111111111111111111111111111111111111111';
const OTHER_HASH = '2222222222222222222222222222222222222222';

// Calls getEmailTemplate from inside a live isolate, as a lambda does. The template's code must run in the
// isolate, and only templates in the executing lambda's own code folder can be used.
describe('lambda-helpers/Helpers:getEmailTemplate', () => {
  let tmpDir;
  let savedPaths;
  let isolate;
  let context;

  const write = (file, content) => {
    const full = path.join(Config.paths.lambda.code, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const render = (data) =>
    context.eval(`getEmailTemplate(${JSON.stringify(data)})`, { promise: true, copy: true, timeout: 5000 });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-email-template-'));
    savedPaths = { ...Config.paths.lambda };
    Config.paths.lambda.code = path.join(tmpDir, 'code');
    Config.paths.lambda.plugins = path.join(tmpDir, 'plugins');
    fs.mkdirSync(Config.paths.lambda.plugins, { recursive: true });

    write(`lambda-${HASH}/templates/welcome.pug`, 'p Hello #{name}\n');
    write(`lambda-${HASH}/templates/realm.pug`, 'p= typeof process\n');
    write(`lambda-${HASH}/templates/layout.pug`, 'div\n  include partial.pug\n');
    write(`lambda-${HASH}/templates/partial.pug`, 'span= name\n');
    write(`lambda-${HASH}/templates/escape.pug`, 'include ../../secret.txt\n');
    write(`lambda-${HASH}/templates/filter.pug`, 'include:markdown-it partial.pug\n');
    write(`lambda-${HASH}/templates/not-pug.txt`, 'p hi\n');
    write('secret.txt', 'host secret');
    write(`lambda-${OTHER_HASH}/other.pug`, 'p other tenant\n');
    fs.symlinkSync(path.join(Config.paths.lambda.code, 'secret.txt'), path.join(Config.paths.lambda.code, `lambda-${HASH}/templates/link.pug`));

    isolate = new ivm.Isolate();
    context = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, context, context.global);
  });

  after(() => {
    isolate.dispose();
    Object.assign(Config.paths.lambda, savedPaths);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    LambdaHelpers.lambdaGitHash = HASH;
  });

  afterEach(() => {
    LambdaHelpers.lambdaGitHash = null;
  });

  it("renders a template from the lambda's code folder with the email data", async () => {
    const html = await render({ gitHash: HASH, emailTemplate: 'templates/welcome.pug', emailData: { name: 'Ada' } });

    assert.strictEqual(html, '<p>Hello Ada</p>');
  });

  it('renders includes from the same folder', async () => {
    const html = await render({ gitHash: HASH, emailTemplate: 'templates/layout.pug', emailData: { name: 'Ada' } });

    assert.strictEqual(html, '<div><span>Ada</span></div>');
  });

  it("runs the template's code in the isolate, not on the host", async () => {
    const html = await render({ gitHash: HASH, emailTemplate: 'templates/realm.pug', emailData: {} });

    assert.strictEqual(html, '<p>undefined</p>');
  });

  it("uses the executing lambda's code folder whatever gitHash the lambda passes", async () => {
    await assert.rejects(render({ gitHash: OTHER_HASH, emailTemplate: 'other.pug', emailData: {} }), /email_template_not_found/);
    await assert.rejects(
      render({ gitHash: HASH, emailTemplate: `../lambda-${OTHER_HASH}/other.pug`, emailData: {} }),
      /invalid_email_template/,
    );
  });

  it("refuses a template, include or link that leaves the lambda's code folder", async () => {
    for (const emailTemplate of ['../secret.txt', 'templates/escape.pug', 'templates/link.pug']) {
      await assert.rejects(render({ gitHash: HASH, emailTemplate, emailData: {} }), /invalid_email_template/, emailTemplate);
    }
  });

  it('refuses a file that is not a .pug template, and pug filters', async () => {
    for (const emailTemplate of ['templates/not-pug.txt', 'templates/filter.pug']) {
      await assert.rejects(render({ gitHash: HASH, emailTemplate, emailData: {} }), /invalid_email_template/, emailTemplate);
    }
  });

  it('refuses when no lambda is executing', async () => {
    LambdaHelpers.lambdaGitHash = null;

    await assert.rejects(
      render({ gitHash: HASH, emailTemplate: 'templates/welcome.pug', emailData: { name: 'Ada' } }),
      /no_executing_lambda/,
    );
  });
});
