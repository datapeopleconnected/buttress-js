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

import {
  assertLambdaSharedModules,
  isGitBranch,
  isGitHash,
  isGitUrl,
  isLambdaName,
} from '../../../../dist/helpers/git.js';

describe('helpers/git:lambda git source checks', () => {
  it('accepts the names, branches, hashes and urls lambdas use', () => {
    for (const name of ['hello-world', 'hello_world.v2', 'Lambda1']) assert.ok(isLambdaName(name), name);
    for (const branch of ['main', 'develop', 'feature/new-thing', 'release-1.2', 'v1.2.3']) {
      assert.ok(isGitBranch(branch), branch);
    }
    for (const hash of ['HEAD', 'a1b2c3d', '3f786850e387550fdab836ed7e6dc881de23001b']) assert.ok(isGitHash(hash), hash);
    for (const url of [
      'https://github.com/org/repo.git',
      'http://git.example.com/repo',
      'ssh://git@github.com/org/repo.git',
      'git://example.com/repo.git',
      'file:///srv/git/repo.git',
      'git@github.com:org/repo.git',
      'github.com:org/repo.git',
      '/srv/git/repo',
    ]) {
      assert.ok(isGitUrl(url), url);
    }
  });

  it('refuses values that are options, shell syntax, paths or not strings', () => {
    for (const name of ['', '-x', '../x', 'a/b', 'a b', 'a;b', '$(id)', null, 1]) {
      assert.ok(!isLambdaName(name), JSON.stringify(name));
    }
    for (const branch of ['', '-b', '--output=x', 'a b', 'a;b', 'a`b`', '$(id)', 'a\nb', null, ['main']]) {
      assert.ok(!isGitBranch(branch), JSON.stringify(branch));
    }
    for (const hash of ['', 'main', 'abc', 'g1b2c3d', 'a1b2c3d;id', `${'a'.repeat(41)}`, null]) {
      assert.ok(!isGitHash(hash), JSON.stringify(hash));
    }
    for (const url of [
      '',
      '-uhelp',
      '--upload-pack=id',
      'ext::sh -c id',
      'fd::17',
      '/srv/git/repo; id',
      'https://example.com/repo $(id)',
      '-oProxyCommand=id@host:repo',
      'git@-oProxyCommand=id:repo',
      'relative/path',
      'https://example.com/\nrepo',
      null,
      { $ne: 1 },
    ]) {
      assert.ok(!isGitUrl(url), JSON.stringify(url));
    }
  });
});

describe('helpers/git:lambda shared module checks', () => {
  it('accepts no shared modules, and modules with a plain name and a .js file in the checkout', () => {
    assert.deepStrictEqual(assertLambdaSharedModules(undefined), []);
    assert.deepStrictEqual(assertLambdaSharedModules(null), []);
    const modules = [
      { name: 'Snippet', entryFile: '_snippets/index.js' },
      { name: 'shared_2', entryFile: 'lib/./shared.js' },
    ];
    assert.deepStrictEqual(assertLambdaSharedModules(modules), modules);
  });

  it('refuses names that are not identifiers, files outside the checkout, and repeated names', () => {
    for (const modules of [
      'Snippet',
      { name: 'Snippet', entryFile: '_snippets/index.js' },
      [{ name: 'Snip-pet', entryFile: '_snippets/index.js' }],
      [{ name: '1Snippet', entryFile: '_snippets/index.js' }],
      [{ name: 'Snippet', entryFile: '../other/index.js' }],
      [{ name: 'Snippet', entryFile: '_snippets/../../index.js' }],
      [{ name: 'Snippet', entryFile: '/etc/passwd.js' }],
      [{ name: 'Snippet', entryFile: '_snippets\\index.js' }],
      [{ name: 'Snippet', entryFile: '_snippets/index.ts' }],
      [{ name: 'Snippet', entryFile: '_snippets/in dex.js' }],
      [{ name: 'Snippet' }],
      [null],
      [
        { name: 'Snippet', entryFile: 'a.js' },
        { name: 'Snippet', entryFile: 'b.js' },
      ],
      Array.from({ length: 17 }, (_, i) => ({ name: `m${i}`, entryFile: 'a.js' })),
    ]) {
      assert.throws(() => assertLambdaSharedModules(modules), { code: 400 }, JSON.stringify(modules));
    }
  });
});
