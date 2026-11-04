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
      // NestJS modules are decorated classes with only static forRoot().
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  // Integration tests read loosely typed JSON responses.
  { files: ['**/test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  { files: ['**/cli.ts', '**/scripts/**'], rules: { 'no-console': 'off' } },
);
