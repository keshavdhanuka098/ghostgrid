// Shared constants for Graph Git. Kept in their own module so db.mjs can use them in CHECK constraints
// without importing the (larger) patch engine.

/** baseline: the first commit on main. commit: user changes. restore/revert: new commits that bring older content back. sync: scenario edits copied onto main. */
export const COMMIT_KINDS = ['baseline', 'commit', 'restore', 'revert', 'sync'];

/**
 * Patch operations the simulation engine can meaningfully honour.
 * Behavioural operations change how a failure propagates; structural ones change what the graph contains.
 * "layout" operations only move an asset on the canvas and never affect a simulation.
 */
export const PATCH_TYPES = [
  'add_node',
  'delete_node',
  'modify_node',
  'set_criticality',
  'move_node',
  'add_dependency',
  'remove_dependency',
  'modify_dependency',
  'replace_provider',
  'set_dependency_mode',
];
export const PATCH_CATEGORIES = ['structural', 'behavioural', 'layout'];

/**
 * Behavioural changes people reasonably ask for that GhostGrid's failure model does not have. They are rejected
 * with an explanation rather than stored as parameters that would change nothing.
 */
export const UNSUPPORTED_PATCH_TYPES = {
  increase_latency: 'latency',
  reduce_availability: 'availability',
  modify_capacity: 'capacity',
  set_failure_threshold: 'failure thresholds',
  set_circuit_breaker: 'circuit breakers',
  set_recovery: 'recovery parameters',
};

/** Bump when propagation rules change, so a stored simulation can say which rules produced it. */
export const ENGINE_VERSION = 1;

export const LIMITS_GG = { branches: 100, commitsPerScenario: 5000, patchesPerRequest: 50, pendingPatches: 500, simulationsPerBranch: 500 };
