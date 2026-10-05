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

// npm run docs:check [-- <docs folder>]: checks that every link and image in docs/ reaches a page, heading or file
// inside docs/, resolved the way docsify v4 resolves it in the browser. Links to other sites aren't fetched. Exits 1 if
// any link doesn't resolve.

import fs from 'node:fs';
import path from 'node:path';

const docsDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'docs'));

// With relativePath (set in docs/index.html), a page's links are relative to its own folder, as on GitHub. Without it
// docsify resolves them from the top of the site.
const relativePath = /relativePath\s*:\s*true/.test(fs.readFileSync(path.join(docsDir, 'index.html'), 'utf8'));

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.md')) files.push(file);
  }
};
walk(docsDir);

// docsify's slugify, applied to a heading's text without its inline code and emphasis marks.
const PUNCTUATION = /[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;
const headingIds = new Map();
const idsOf = (file) => {
  if (!headingIds.has(file)) {
    const ids = new Set();
    const seen = {};
    let fenced = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (!heading) continue;
      const slug = heading[1]
        .replace(/`|\*\*|\*/g, '')
        .trim()
        .replace(/[A-Z]+/g, (s) => s.toLowerCase())
        .replace(/<[^>]+>/g, '')
        .replace(PUNCTUATION, '')
        .replace(/\s/g, '-')
        .replace(/-+/g, '-')
        .replace(/^(\d)/, '_$1');
      seen[slug] = Object.hasOwn(seen, slug) ? seen[slug] + 1 : 0;
      ids.add(seen[slug] ? `${slug}-${seen[slug]}` : slug);
    }
    headingIds.set(file, ids);
  }
  return headingIds.get(file);
};

// A page's route: docs/a/b.md is /a/b, and docs/a/README.md is /a/.
const routeOf = (file) =>
  ('/' + path.relative(docsDir, file).split(path.sep).join('/')).replace(/README\.md$/, '').replace(/\.md$/, '');

// Joins a path onto a folder. docsify, like the browser, drops a '..' above the top, so a link meant for a file outside
// docs/ quietly lands on a page inside it; that's reported as leaving docs/.
const join = (folder, relative) => {
  const segments = [];
  let leaves = false;
  for (const segment of `${folder}/${relative}`.split('/')) {
    if (segment === '..') leaves = segments.pop() === undefined || leaves;
    else if (segment && segment !== '.') segments.push(segment);
  }
  return { target: '/' + segments.join('/') + (relative.endsWith('/') && segments.length ? '/' : ''), leaves };
};

// Where docsify sends a link (History.toURL): with relativePath, from the page's folder unless it starts with '/';
// otherwise from the top, keeping any '..', which on GitHub Pages leaves the site's folder.
const resolveLink = (link, route) => {
  if (link.startsWith('/')) return join('/', link);
  if (relativePath) return join(route.slice(0, route.lastIndexOf('/') + 1), link);
  return { ...join('/', link), leaves: link.split('/').includes('..') };
};

// The file docsify fetches for a route (getFileName): .md and .html as they are, a folder's README.md, otherwise .md.
const fileOf = (target) =>
  path.join(docsDir, /\.html$/.test(target) ? target : target.endsWith('/') ? `${target}README.md` : `${target}.md`);

const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+(["'])(.*?)\3)?\)/g;

let checked = 0;
const problems = [];
for (const file of files) {
  const at = path.relative(process.cwd(), file);
  // _sidebar.md and the other _ files are shown on every page, so their relative links resolve against whichever
  // page is open.
  const everyPage = path.basename(file).startsWith('_');
  const route = routeOf(file);
  let fenced = false;
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (fenced) return;
      for (const [, image, href, , title = ''] of line.replace(/`[^`]*`/g, '').matchAll(LINK)) {
        // docsify leaves links with ':' or '//' (other sites, mailto:) and ':ignore' links as they're written.
        if (/:|\/\//.test(href) || /:ignore\b/.test(title)) continue;
        checked++;
        const fail = (reason) => problems.push(`${at}:${i + 1}  ${href}  ${reason}`);
        const [pathAndQuery, hash] = href.split('#');
        const [linkPath, query = ''] = pathAndQuery.split('?');
        const anchor = hash ?? new URLSearchParams(query).get('id');

        if (image) {
          // Images are always relative to the page's folder, even with a leading '/'.
          if (everyPage) {
            fail('resolves against whichever page is open; use a full URL');
            continue;
          }
          const { target, leaves } = join(route.slice(0, route.lastIndexOf('/') + 1), linkPath);
          if (leaves) fail("leaves docs/, which GitHub Pages doesn't serve");
          else if (!fs.existsSync(path.join(docsDir, target))) fail(`no file at docs${target}`);
          continue;
        }

        if (!linkPath) {
          if (!everyPage && anchor && !idsOf(file).has(anchor)) fail(`no heading #${anchor} on this page`);
          continue;
        }
        if (everyPage && relativePath && !linkPath.startsWith('/')) {
          fail('resolves against whichever page is open; start it with /');
          continue;
        }
        const { target, leaves } = resolveLink(linkPath.replace(/\.md$/, ''), everyPage ? '/' : route);
        const page = fileOf(target);
        if (leaves) fail("leaves docs/, which GitHub Pages doesn't serve");
        else if (!fs.existsSync(page)) fail(`no page at docs/${path.relative(docsDir, page)}`);
        else if (anchor && !idsOf(page).has(anchor))
          fail(`no heading #${anchor} in docs/${path.relative(docsDir, page)}`);
      }
    });
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`Docs Links Check: \x1b[31mFailed\x1b[0m (${problems.length} of ${checked} links don't resolve)`);
  process.exitCode = 1;
} else {
  console.log(`Docs Links Check: \x1b[32mPassed\x1b[0m (${checked} links on ${files.length} pages)`);
}
