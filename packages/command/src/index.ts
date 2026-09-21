/**
 * @minimalerp/command — the Command Registry, module manifests, the Universal Search (Go To)
 * service and its providers, recents/favourites, and the screen stack.
 * Generic: it must not import the domain. Entities (ledgers, parties…) join later as SearchProviders.
 */
export * from './types';
export * from './registry';
export * from './panel';
export * from './fuzzy';
export * from './query';
export * from './recents';
export * from './search';
export * from './entity';
export * from './screenStack';
