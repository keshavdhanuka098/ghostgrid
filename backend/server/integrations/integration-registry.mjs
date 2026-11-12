import { ENV_VARS, WORKS_ANONYMOUSLY } from './config.mjs';
import { describeMaps } from './google-maps/maps.service.mjs';

/**
 * The single list of integrations: what each one is for, what it needs, and how to verify it. `check` performs a real,
 * read-only request (or throws IntegrationError); it is called only by the health service, never on page load.
 */
export function createRegistry({ providers, huggingface, kaggle, wandb }) {
  const ai = Object.fromEntries(providers.map((p) => [p.id, p]));
  const maps = describeMaps();
  return [
    { id: 'gemini', label: 'Google Gemini', category: 'ai', description: 'Primary AI provider for explanations and recommendations.', features: ['Infrastructure analysis', 'Simulation and failure explanations', 'Model evaluation and experiment summaries', 'Dataset quality insights', 'Training recommendations'], check: () => ai.gemini.health() },
    { id: 'groq', label: 'Groq', category: 'ai', description: 'Fast fallback AI provider when Gemini is rate limited or unavailable.', features: ['Same AI tasks as Gemini', 'Automatic fallback on quota, timeout or outage'], check: () => ai.groq.health() },
    { id: 'huggingface', label: 'Hugging Face', category: 'datasets', description: 'Search public datasets and models, review licences, import supported files.', features: ['Dataset and model search', 'Licence and gating information', 'Explicit, size-limited dataset import', 'Model references on experiments'], anonymousCheck: true, check: () => huggingface.health() },
    { id: 'kaggle', label: 'Kaggle', category: 'datasets', description: 'Discover Kaggle datasets and import them on request.', features: ['Dataset search and metadata', 'User-initiated download with progress', 'Safe ZIP extraction', 'Provenance recording'], check: () => kaggle.health() },
    { id: 'wandb', label: 'Weights & Biases', category: 'tracking', description: 'Optional experiment tracking and lineage. Local training never depends on it.', features: ['Log configuration and metrics', 'Duration and dataset-version tracking', 'Opt-in checkpoint upload', 'Experiment ↔ run links', 'Local experiment comparison'], check: () => wandb.health() },
    { id: 'google-maps', label: 'Google Maps', category: 'maps', description: 'Geographic visualisation. Disabled by design in this version.', features: [], unsupported: maps.reason, check: async () => ({ detail: maps.reason }) },
  ].map((d) => ({ ...d, envVars: ENV_VARS[d.id], worksAnonymously: WORKS_ANONYMOUSLY.has(d.id), requiresCredentials: !WORKS_ANONYMOUSLY.has(d.id) }));
}
