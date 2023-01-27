/**
 * @description
 * @author Lighten
 */

const fs = require('fs');

const getClassesList = (dirName) => {
	let files = [];
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
const lambdaAPI = classes.reduce((file, obj) => {
	if (Object.keys(file).length < 1) return obj;

	const [className] = Object.keys(file);
	obj[className] = file[className];
	return obj;
}, {});

module.exports = lambdaAPI;
