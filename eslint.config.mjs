// ESLint flat config. Correctness only: formatting and style rules stay off (no Prettier, no churn), and the type
// checker (`npm run typecheck`) remains the authority on types. Errors fail CI; warnings are reported but allowed.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'out-*/**',
      'release/**',
      'dist/**',
      'dist-phone-site/**',
      'website/**',
      'ios/**',
      'principia-data/**',
      'cloud/workspace/**',
      '.hive-dev-data/**',
      'src/**/*.gen.ts',
      // Test fixtures are sample repos and stub programs, not our code.
      'src/**/__tests__/fixtures/**'
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // tsc already reports undefined names, with real types.
      'no-undef': 'off',
      // Stripping ANSI/OSC escapes and control bytes from terminal output is core to this app.
      'no-control-regex': 'off',
      // Mostly defensive initialisers before try/catch (`let names: string[] = []`); kept visible, not blocking.
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ],
      // Escape hatches the codebase uses deliberately (IPC payloads, JSON from disk, child-process output).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        // Files outside both tsconfig projects get a default program instead of a parse error.
        projectService: { allowDefaultProject: ['vite.console.config.ts', 'scripts/fake-linear.ts'] },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // A dropped promise in the main process is an unhandled rejection that nobody sees.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // The renderer is sandboxed and talks to the main process only through the preload bridge (window.hive).
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['electron', 'child_process', 'fs', 'path', 'os', 'net', 'http', 'https'],
          patterns: [{ group: ['node:*'], message: 'The renderer has no Node; go through the preload bridge.' }]
        }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      // `const crypto = require('node:crypto')` is fine even though Node also has a global `crypto`.
      'no-redeclare': ['error', { builtinGlobals: false }]
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' }
  }
)
