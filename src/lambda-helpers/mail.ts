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

import fs from 'node:fs';
import path from 'node:path';

import pug from 'pug';

/**
 * Mail
 * @class
 */
class Mail {
  // Compiled template sources by the template's real path
  _templates: {
    [path: string]: string;
  };

  /**
   * Constructor for Mail
   */
  constructor() {
    this._templates = {};
  }

  /**
   * Returns the source of a function, `template(locals)`, that renders a .pug template. Compiling it runs none of
   * the template's code: the caller runs the function where the template may run. The template, and any file it
   * includes or extends, must be inside `root` once links are resolved. Filters are refused, since pug runs them
   * while compiling.
   * @param {String} root - the folder the template must be in
   * @param {String} template - template path, relative to root
   * @return {String} source of the render function
   */
  getEmailTemplateSource(root: string, template: string) {
    const realRoot = fs.realpathSync(root);
    const file = this._realPathInside(realRoot, path.resolve(root, template));
    if (path.extname(file) !== '.pug') throw new Error('invalid_email_template');

    if (this._templates[file]) return this._templates[file];

    this._templates[file] = pug.compileFileClient(file, {
      name: 'template',
      compileDebug: false,
      inlineRuntimeFunctions: true,
      plugins: [
        {
          read: (filename: string) => fs.readFileSync(this._realPathInside(realRoot, filename), 'utf8'),
          postLex: (tokens: Array<{ type: string }>) => {
            if (tokens.some((token) => token.type === 'filter')) throw new Error('invalid_email_template');
            return tokens;
          },
        },
      ],
    });

    return this._templates[file];
  }

  _realPathInside(realRoot: string, filename: string) {
    let realPath: string;
    try {
      realPath = fs.realpathSync(filename);
    } catch {
      throw new Error('email_template_not_found');
    }
    if (!realPath.startsWith(`${realRoot}${path.sep}`)) throw new Error('invalid_email_template');
    return realPath;
  }
}
export default new Mail();
