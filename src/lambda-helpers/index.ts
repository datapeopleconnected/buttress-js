'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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
import fs from 'fs';

// ? Why are we dynamically loading classes from the filesystem?

const getClassesList = (dirName) => {
	let files: NodeRequire[] = [];
	const items = fs.readdirSync(dirName, {withFileTypes: true});
	for (const item of items) {
		if (item.isDirectory()) {
			files = [...files, ...getClassesList(`${dirName}/${item.name}`)];
		} else {
			files.push(require(`${dirName}/${item.name}`));
		}
	}

	return files;
};

const classes = getClassesList(__dirname);
const lambdaAPI = classes.reduce((obj, file) => {
	if (Object.keys(file).length < 1) return obj;

	const [className] = Object.keys(file);
	obj[className] = file[className];
	return obj;
}, {});

export default lambdaAPI;
