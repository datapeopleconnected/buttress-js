import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "max-len": ["error", { "code": 150, "ignoreStrings": true, "ignoreTemplateLiterals": true }],
    },
    ignores: ["dist/", "node_modules/", "deploy/"]
  }
);