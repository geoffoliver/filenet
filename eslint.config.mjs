import { defineConfig, globalIgnores } from 'eslint/config';
import nextTs from 'eslint-config-next/typescript';
import nextVitals from 'eslint-config-next/core-web-vitals';
import stylisticJs from '@stylistic/eslint-plugin';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Compiled/generated output
    'dist/**',
    'electron/main.js',
    // Example files not part of the app
    'examples/**',
  ]),
  // CommonJS scripts and Jest bootstrap files use require() by necessity
  {
    files: ['scripts/**/*.js', 'jest.globalSetup.js', 'jest.setup.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    plugins: {
      '@stylistic/js': stylisticJs,
    },
    rules: {
      quotes: ['error', 'single'],
      'comma-dangle': ['error', 'always-multiline'],
      '@typescript-eslint/no-explicit-any': 'off',
      semi: ['error', 'always'],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        'argsIgnorePattern': '^_',
        'varsIgnorePattern': '^_',
      }],
      'react-hooks/exhaustive-deps': ['error'],
      'sort-imports': ['error', {
        'ignoreCase': false,
        'ignoreDeclarationSort': false,
        'ignoreMemberSort': false,
        'memberSyntaxSortOrder': ['none', 'all', 'multiple', 'single'],
        'allowSeparatedGroups': true,
      }],
      '@stylistic/js/indent': ['error', 2, {
        'SwitchCase': 1,
        'VariableDeclarator': 1,
        'ArrayExpression': 1,
        'ObjectExpression': 1,
      }],
      '@stylistic/js/curly-newline': ['error', {
        'multiline': true,
        'minElements': 3,
        'consistent': true,
      }],
      '@stylistic/js/object-curly-newline': ['error', {
        'ObjectExpression': {
          'multiline': true, 'minProperties': 3, 'consistent': true,
        },
        'ObjectPattern': {
          'multiline': true, 'minProperties': 3, 'consistent': true,
        },
        'ImportDeclaration': {
          'multiline': true, 'minProperties': 3, 'consistent': true,
        },
        'ExportDeclaration': {
          'multiline': true, 'minProperties': 3, 'consistent': true,
        },
      }],
    },
  },
]);

export default eslintConfig;
