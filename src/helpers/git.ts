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
import util from 'node:util';
import { execFile as cpExecFile } from 'node:child_process';

import { RequestError } from './errors.js';

const execFile = util.promisify(cpExecFile);

// Lambda code is cloned from a git repository named by the lambda. These checks keep each value to what git
// needs for that job, so none of them can be read as an option or reach a path outside the lambda code folder.

// Used in the lambda's folder name, so no path separators
const LAMBDA_NAME = /^[A-Za-z0-9_][\w.-]{0,254}$/;
const GIT_BRANCH = /^[A-Za-z0-9_][\w./-]{0,254}$/;
const GIT_HASH = /^(?:[0-9a-f]{7,40}|HEAD)$/i;

// git reads `<transport>::<address>` as a remote helper
const GIT_REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
const GIT_URL_FORMS = [
  // https://host/path, ssh://user@host/path, git://host/path
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[A-Za-z0-9[][^\s]*$/i,
  /^file:\/\/\/\S+$/i,
  // scp-like: user@host:path
  /^(?:[A-Za-z0-9_][\w.-]*@)?[A-Za-z0-9][\w.-]*:(?!\/\/)\S+$/,
  // a repository on this host
  /^\/\S*$/,
];

export const isLambdaName = (value: unknown): value is string => typeof value === 'string' && LAMBDA_NAME.test(value);

export const isGitBranch = (value: unknown): value is string => typeof value === 'string' && GIT_BRANCH.test(value);

export const isGitHash = (value: unknown): value is string => typeof value === 'string' && GIT_HASH.test(value);

export const isGitUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 2048 &&
  !/[\s\u0000-\u001f\u007f]/.test(value) &&
  !GIT_REMOTE_HELPER.test(value) &&
  GIT_URL_FORMS.some((form) => form.test(value));

/**
 * Refuses a lambda git source whose given fields aren't a plain name, url, branch or hash, with a 400.
 */
export const assertLambdaGitSource = (source: { name?: unknown; url?: unknown; branch?: unknown; hash?: unknown }) => {
  if ('name' in source && !isLambdaName(source.name)) throw new RequestError(400, 'invalid_lambda_name');
  if ('url' in source && !isGitUrl(source.url)) throw new RequestError(400, 'invalid_lambda_git_url');
  if ('branch' in source && !isGitBranch(source.branch)) throw new RequestError(400, 'invalid_lambda_git_branch');
  if ('hash' in source && !isGitHash(source.hash)) throw new RequestError(400, 'invalid_lambda_git_hash');
};

/**
 * Runs git in `cwd` with `args` as its argument list, without a shell.
 */
export const git = (args: string[], cwd: string) => execFile('git', args, { cwd, encoding: 'utf8' });
