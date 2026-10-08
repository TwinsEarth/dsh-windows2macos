// ESLint flat configuration for the W2M DSH plugin.
//
// The project is plain ESM JavaScript with no build step and no TypeScript, so
// this file deliberately uses only the stock JS parser: no type-aware rules.
// Every type-aware rule (notably `no-floating-promises`) needs typescript-eslint
// and a TS program, i.e. exactly the TypeScript dependency the user asked to
// defer. What the stock parser still catches is what a type checker would have
// caught first: unbound identifiers, unused bindings that are usually typos, and
// statement-level mistakes.
//
// The findings this configuration produced on the existing tree, and the
// disposition of each, are recorded in docs/LINT-AUDIT.md.

import js from '@eslint/js';
import globals from 'globals';

export default [
  // ---------------------------------------------------------------------
  // Scope. `dist/` holds generated release artifacts, `node_modules/` is never
  // committed, and the deploy/ copies are templates rather than code.
  // ---------------------------------------------------------------------
  {
    ignores: [
      'dist/',
      'dist-*/',
      'node_modules/',
      '*.tgz',
      '.w2m/',
      'coverage/',
      'e2e-tmp/',
      'test-tmp/',
    ],
  },

  // ---------------------------------------------------------------------
  // Base: eslint's own recommended set for plain JavaScript.
  // ---------------------------------------------------------------------
  js.configs.recommended,

  // ---------------------------------------------------------------------
  // The project's sources, tests and scripts.
  // ---------------------------------------------------------------------
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      // A stale disable comment is a false claim about what the code needs, so
      // failing on it keeps `eslint-disable` an accurate index of exceptions.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ---- correctness: unbound and unused names ------------------------
      // `no-undef` is the closest thing to a type checker this project has: it
      // catches "renamed a helper but missed a call site".
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        // `_`-prefixed bindings are the codebase's existing convention for
        // "intentionally unused" (catch bindings, destructuring discards).
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // ---- correctness: async / promise mistakes ------------------------
      // Parser-free substitutes for the type-aware rules; see the header note.
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'error',
      'no-return-await': 'error',
      'no-promise-executor-return': 'error',
      'no-await-in-loop': 'off', // deliberate: retries and sequential steps

      // `no-useless-assignment` ships as an error in eslint 10's recommended
      // set. It fires on the defensive `let x = null; try { x = ... } catch
      // { x = null }` idiom used throughout this codebase: eslint models the
      // try/catch as "assigned on every path" and cannot see that the initial
      // value covers the window before the first assignment. Removing those
      // initialisers would be the wrong fix, so the rule is off with the
      // rationale recorded here rather than silently tolerated.
      'no-useless-assignment': 'off',

      // ---- correctness: suspicious but legal code -----------------------
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-compare-neg-zero': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-fallthrough': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-template-curly-in-string': 'error',
      'no-sparse-arrays': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-useless-backreference': 'error',
      'no-prototype-builtins': 'error',
      'no-constructor-return': 'error',
      'no-setter-return': 'error',

      // ---- correctness: shadowing and redeclaration ---------------------
      'no-redeclare': 'error',
      'no-shadow-restricted-names': 'error',
      'no-case-declarations': 'error',

      // ---- hygiene ------------------------------------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-global-assign': 'error',
      'no-implicit-globals': 'error',
      'no-undef-init': 'error',
      'no-unused-private-class-members': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unsafe-finally': 'error',
      'no-sequences': 'error',

      // ---- output discipline --------------------------------------------
      // The project writes structured output through process.stdout/stderr, so
      // `console` outside the CLI entry points is nearly always a leftover
      // debug statement.
      'no-console': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // CLI entry points: console is the interface here, so allow it.
  // ---------------------------------------------------------------------
  {
    files: ['bin/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Test surfaces: test/ and the probe scripts under scripts/.
  //
  // Two rules are demoted to warnings here, and both demotions are measured,
  // not guessed (see docs/LINT-AUDIT.md for the counts):
  //
  //   no-promise-executor-return  fires 31 times, always on
  //       `new Promise((r) => setTimeout(r, ms))`, which is the idiomatic and
  //       correct sleep. The rule is about *returning* a value from an executor;
  //       an arrow body that is a bare call is not that mistake.
  //
  //   require-atomic-updates      fires 18 times, always on state that these
  //       tests assign deliberately: `globalThis.fetch = stub` in a finally,
  //       `process.env.X = ...` around a case, `group.relay = await ...` while
  //       driving a scenario. Each file is a sequential script, so there is no
  //       interleaving for the rule to be right about.
  //
  // Keeping them as warnings rather than turning them off means a *new* real
  // instance still shows up in the output instead of being silenced.
  // ---------------------------------------------------------------------
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-promise-executor-return': 'warn',
      'require-atomic-updates': 'warn',
    },
  },
];
