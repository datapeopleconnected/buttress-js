import tseslint from 'typescript-eslint';

import { coreModelAccessRestrictions } from './eslint/core-model-access.mjs';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // Type-aware linting, needed by the no-unsafe-* rules
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      // Stop any from libraries (JSON.parse, express's req.body, ...) flowing on into typed code
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "max-len": ["error", { "code": 150, "ignoreStrings": true, "ignoreTemplateLiterals": true }],
    },
    ignores: ["dist/", "node_modules/", "deploy/"]
  },
  {
    // A promise a route neither awaits nor catches ends the process when it rejects
    files: ["src/routes/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // Core routes reach core rows only through the model scoped to the caller's app, or an explicit unscoped one
    files: ["src/routes/api/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...coreModelAccessRestrictions],
    },
  }
);