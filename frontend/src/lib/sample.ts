import samples from '@shared/samples.json';
import { normalizeScenario } from './scenarioOps';
import type { Scenario } from './types';

/**
 * The bundled simulated scenarios. The server seeds the same file (shared/samples.json) into the database; this module
 * exists so unit tests and offline logic can build a scenario without a server. Nothing here describes real infrastructure.
 */
export function makeSampleScenario(key = 'metro-corridor'): Scenario {
  const def = samples.find((s) => s.sampleKey === key);
  if (!def) throw new Error(`Unknown sample "${key}"`);
  const now = new Date().toISOString();
  return normalizeScenario({
    ...(structuredClone(def) as unknown as Scenario),
    id: `sample-${key}`,
    isSample: true,
    createdAt: now,
    updatedAt: now,
  });
}

export const SAMPLE_KEYS = samples.map((s) => s.sampleKey);
