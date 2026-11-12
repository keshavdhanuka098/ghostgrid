import { aiDefaults, createSecrets } from './config.mjs';
import { createGeminiProvider } from './ai/gemini.provider.mjs';
import { createGroqProvider } from './ai/groq.provider.mjs';
import { createLlmService } from './ai/llm.service.mjs';
import { createImportManager } from './dataset-import.mjs';
import { createHandlers } from './handlers.mjs';
import { createHuggingFaceService } from './huggingface/huggingface.service.mjs';
import { createHealthService } from './integration-health.service.mjs';
import { createRegistry } from './integration-registry.mjs';
import { createKaggleService } from './kaggle/kaggle.service.mjs';
import { createMlStore } from './ml-store.mjs';
import { createWandbService } from './wandb/wandb.service.mjs';
import { extractFeatures } from '../features.mjs';
import { runSimulation } from '../graphgit/engine.mjs';
import { readScenario } from '../repo.mjs';
import { getMeta, setMeta } from '../repo.mjs';

/**
 * Wires every integration together. Everything that touches the network accepts an injectable `fetchImpl`, which is how
 * the tests exercise retry, fallback and error handling without a real provider. Nothing here runs at import time.
 */
export function createIntegrations({ db, env = process.env, fetchImpl = globalThis.fetch, sleep, log = (m) => console.warn(m), backendRoot, runPythonImpl, importLimits, python = env.GHOSTGRID_PYTHON, now } = {}) {
  const secrets = createSecrets(env);
  const defaults = aiDefaults(secrets);
  const net = { fetchImpl, sleep, log };

  const providers = [
    createGeminiProvider({ secrets, model: defaults.geminiModel, ...net }),
    createGroqProvider({ secrets, model: defaults.groqModel, ...net }),
  ];
  const mlStore = createMlStore({ backendRoot, python });
  const huggingface = createHuggingFaceService({ secrets, ...net });
  const kaggle = createKaggleService({ secrets, ...net });
  const wandb = createWandbService({ db, secrets, mlStore, python, runPythonImpl, ...net });
  const imports = createImportManager({ db, backendRoot, fetchImpl, python, log, limits: importLimits, runPythonImpl });
  const registry = createRegistry({ providers, huggingface, kaggle, wandb });
  const health = createHealthService({ db, secrets, registry, log, now });

  const getPrefs = () => {
    const p = getMeta(db, 'ai.provider');
    const f = getMeta(db, 'ai.fallback');
    return { provider: ['auto', 'gemini', 'groq'].includes(p) ? p : defaults.provider, fallback: f === null || f === undefined ? defaults.fallback : f === 'true' };
  };
  const llm = createLlmService({ providers, getPrefs, isEnabled: (id) => health.isEnabled(id), log, now });
  const handlers = createHandlers({ db, secrets, health, llm, hf: huggingface, kaggle, wandb, imports, mlStore, getMeta, setMeta, readScenario: (id) => readScenario(db, id), extractFeatures, runSimulation });

  return { handlers, health, llm, imports, mlStore, secrets, recover: () => imports.recoverInterrupted() };
}
