/**
 * @minimalerp/keyboard — chord normaliser, keymap, scope stack, the single KeyboardManager, and the
 * list/form/grid navigation models. Framework-free: the only package (with apps/web/src/ui
 * primitives) allowed to touch key events. Knows nothing about accounting or commands.
 */
export * from './chord';
export * from './scopes';
export * from './keymap';
export * from './keymapStore';
export * from './manager';
export * from './navigation';
