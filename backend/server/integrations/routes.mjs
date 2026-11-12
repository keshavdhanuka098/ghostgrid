import { IntegrationError } from './errors.mjs';

/** [method, path, handler name, success status]. One table drives both the Express adapter and the tests. */
export const ROUTES = [
  ['GET', '/', 'list', 200],
  ['POST', '/health', 'checkHealth', 200],
  ['PATCH', '/:id', 'setEnabled', 200],

  ['GET', '/ai/status', 'aiStatus', 200],
  ['PUT', '/ai/preferences', 'aiSetPreferences', 200],
  ['POST', '/ai/analyze', 'aiAnalyze', 200],

  ['GET', '/huggingface/datasets', 'hfSearchDatasets', 200],
  ['GET', '/huggingface/models', 'hfSearchModels', 200],
  ['GET', '/huggingface/dataset', 'hfDataset', 200],
  ['GET', '/huggingface/model', 'hfModel', 200],
  ['POST', '/huggingface/imports', 'hfImport', 202],
  ['GET', '/kaggle/datasets', 'kaggleSearch', 200],
  ['GET', '/kaggle/dataset', 'kaggleDataset', 200],
  ['POST', '/kaggle/imports', 'kaggleImport', 202],

  ['GET', '/imports', 'importsList', 200],
  ['GET', '/imports/:id', 'importGet', 200],
  ['POST', '/imports/:id/cancel', 'importCancel', 200],
  ['POST', '/imports/:id/register', 'importRegister', 200],
  ['DELETE', '/imports/:id', 'importRemove', 200],

  ['GET', '/model-references', 'modelRefsList', 200],
  ['POST', '/model-references', 'modelRefsCreate', 201],
  ['DELETE', '/model-references/:id', 'modelRefsDelete', 200],

  ['GET', '/ml/datasets', 'mlDatasets', 200],
  ['GET', '/ml/experiments', 'mlExperiments', 200],
  ['POST', '/wandb/sync', 'wandbSync', 200],
  ['POST', '/wandb/compare', 'wandbCompare', 200],
];

/** Mounts the table on an Express router. Integration failures become { error, code, provider } JSON; nothing else leaks. */
export function mountRoutes(router, handlers, { log = (m) => console.error(m) } = {}) {
  for (const [method, path, name, ok] of ROUTES) {
    router[method.toLowerCase()](path, async (req, res, next) => {
      try {
        const result = await handlers[name]({ params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? {} });
        res.status(ok).json(result);
      } catch (err) {
        if (err instanceof IntegrationError) {
          if (err.retryAfterSec) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterSec)));
          return res.status(err.httpStatus).json(err.toJSON());
        }
        log(`[integrations] unexpected error in ${name}: ${err?.name}: ${String(err?.message).slice(0, 200)}`);
        next(err);
      }
    });
  }
  return router;
}
