// Branch simulations use GhostGrid's one and only propagation engine, engine/graph.ts. It is imported here (Node
// strips the type annotations), not copied, so the browser and the server can never disagree about a cascade.

import { outcomeFor } from '../../engine/graph.ts';
import { ENGINE_VERSION } from './constants.mjs';

/** The settings a result depends on. The failure model has no tunable parameters today, so this records the rules version and the seed. */
export function simulationConfig() {
  return { engineVersion: ENGINE_VERSION, model: 'ghostgrid-cascade', linkFailures: true };
}

const fromMap = (m) => Object.fromEntries(m);

/**
 * Runs the existing cascade simulation on a graph and returns a JSON-safe record of everything needed to explain it.
 * Deterministic: the same graph and failure seed always give the same result.
 */
export function runSimulation(graph, seed) {
  const out = outcomeFor(graph.assets, graph.dependencies, { nodes: seed.nodes, links: seed.links });
  const sim = out.sim;
  return {
    seedNodes: sim.seedNodes,
    seedLinks: sim.seedLinks,
    failed: [...sim.failed],
    rounds: sim.rounds,
    roundOf: fromMap(sim.roundOf),
    causes: fromMap(sim.causes),
    causeKind: fromMap(sim.causeKind),
    causeLinkIds: Object.fromEntries([...sim.causeLinks].map(([id, links]) => [id, links.map((l) => l.id)])),
    linkDownRound: fromMap(sim.linkDownRound),
    totals: { failed: out.total, cascaded: out.cascaded, critical: out.critical, rounds: sim.rounds.length - 1 },
  };
}
