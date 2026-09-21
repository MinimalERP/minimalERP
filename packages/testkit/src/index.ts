/**
 * @minimalerp/testkit — demo company, scenario builders, property-test generators and the
 * backend contract suite. Cross-package behavioural tests live here because domain tests may not
 * import adapters, while these deliberately exercise domain + ports + an adapter together.
 */
export * from './world';
export * from './masterWorld';
export * from './scenarios';
export * from './arbitraries';
export * from './helpers';
export * from './contract';
