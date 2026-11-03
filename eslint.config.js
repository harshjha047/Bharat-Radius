import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'deploy/**', 'radius/**', 'mikrotik/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // Buffer/array indexing under noUncheckedIndexedAccess after explicit bounds checks.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  { files: ['**/cli.ts', '**/scripts/**'], rules: { 'no-console': 'off' } },
);
