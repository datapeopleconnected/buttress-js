const gulp = require('gulp');
const ts = require('gulp-typescript');
const sourceMaps = require('gulp-sourcemaps');

const tsProject = ts.createProject('tsconfig.json');

// Define a task to compile TypeScript files from src to dist
gulp.task('typescript', () => {
	return tsProject.src()
		.pipe(sourceMaps.init())
		.pipe(tsProject(ts.reporter.longReporter()))
		.pipe(sourceMaps.write())
		.pipe(gulp.dest('dist'));
});

// Define a task to copy js, json, and html files from src to dist
gulp.task('copy-other', () => {
	return gulp.src(['src/**/*.js', 'src/**/*.json', 'src/**/*.html'])
		.pipe(gulp.dest('dist'));
});

// Define a task to watch for changes in src and re-run the compile and copy tasks
gulp.task('watch', () => {
	gulp.watch('src/**/*.ts', gulp.series('typescript'));
	gulp.watch('src/**/*.{js,json,html}', gulp.series('copy-other'));
});

// Define a default task that runs both the compile and copy tasks
gulp.task('build', gulp.series('typescript', 'copy-other'));
