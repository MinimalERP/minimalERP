import tseslint from 'typescript-eslint';

/**
 * Keyboard handling is one architectural layer (packages/keyboard). Components declare scopes and
 * commands; they never attach shortcut listeners. These rules make that mechanical.
 */
const KEY_EVENT_MESSAGE =
  'Key events are handled only by packages/keyboard (and low-level primitives in apps/web/src/ui). ' +
  'Declare a scope/command instead — see docs/architecture.md §7.';

const noKeyEventHandlers = [
  'error',
  {
    selector: 'JSXAttribute[name.name=/^onKey(Down|Up|Press)(Capture)?$/]',
    message: KEY_EVENT_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up|press)$/]",
    message: KEY_EVENT_MESSAGE,
  },
  {
    selector: "MemberExpression[property.name='keyCode']",
    message: 'keyCode is deprecated and layout-fragile. Use the chord normaliser in packages/keyboard.',
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'supabase/functions/**/*.bundle.js'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: { 'no-restricted-syntax': noKeyEventHandlers },
  },
  {
    // The only places allowed to touch key events (e2e/ observes them from outside the app, to test it).
    files: ['packages/keyboard/**', 'apps/web/src/ui/**', 'e2e/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
