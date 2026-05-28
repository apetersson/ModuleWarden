import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/shared/src/__tests__/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'no-implicit-coercion': 'error',
      'no-throw-literal': 'error',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignoreConditionalTests: true,
          ignoreMixedLogicalExpressions: true,
          ignorePrimitives: true,
        },
      ],
      '@typescript-eslint/prefer-optional-chain': 'error',
    },
  },
  {
    files: ['packages/web-ui/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
    },
  }
);
