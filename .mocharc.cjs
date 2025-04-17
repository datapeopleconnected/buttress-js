module.exports = {
  diff: true,
  require: ["test/hooks.js"],
  extension: ['ts', 'tsx', 'js'], // include extensions
  package: './package.json',
  reporter: 'spec',
  slow: 75,
  timeout: 2000,
  ui: 'bdd',
};