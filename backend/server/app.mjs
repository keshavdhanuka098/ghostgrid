import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from './db.mjs';
import { HttpError } from './errors.mjs';
import {
  countScenarios,
  createReport,
  createScenario,
  deleteAllScenarios,
  deleteReport,
  deleteScenario,
  duplicateScenario,
  listReports,
  listScenarios,
  readReport,
  readScenario,
  replaceScenario,
} from './repo.mjs';
import { extractFeatures } from './features.mjs';
import { createGraphGitRouter } from './graphgit/routes.mjs';
import { createIntegrations } from './integrations/index.mjs';
import { mountRoutes } from './integrations/routes.mjs';
import { restoreSamples } from './samples.mjs';
import { validateReport, validateScenario } from './validate.mjs';

/**
 * Creates the GhostGrid API on top of an open SQLite database.
 *
 * Scenarios are read and written as whole documents (assets, dependencies, runs, strategies, assumptions); each write
 * is one transaction, so a scenario is never left half-saved. Saved reports have their own endpoints.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, staticDir?: string }} options
 */
export function createApp({ db, staticDir, integrations = createIntegrations({ db }) }) {
  const app = express();
  app.disable('x-powered-by');

  // Baseline hardening for a locally hosted app: no MIME sniffing, no framing, no referrer leakage.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // API answers are live data and must never be served from a cache.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // The database is synchronous, so handlers are plain functions; thrown errors reach the error middleware.
  const h = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  const requireScenario = (id) => {
    const s = readScenario(db, id);
    if (!s) throw new HttpError(404, 'Scenario not found.');
    return s;
  };

  app.get('/api/health', h((_req, res) => {
    res.json({ ok: true, schemaVersion: SCHEMA_VERSION, scenarios: countScenarios(db) });
  }));

  /* ---- scenarios ---- */

  app.get('/api/scenarios', h((_req, res) => {
    res.json({ scenarios: listScenarios(db) });
  }));

  app.get('/api/scenarios/:id', h((req, res) => {
    res.json({ scenario: requireScenario(req.params.id) });
  }));

  app.post('/api/scenarios', h((req, res) => {
    const result = validateScenario(req.body);
    if (!result.ok) throw new HttpError(400, 'Scenario is not valid.', result.errors);
    res.status(201).json({ scenario: createScenario(db, result.value) });
  }));

  app.put('/api/scenarios/:id', h((req, res) => {
    const result = validateScenario(req.body);
    if (!result.ok) throw new HttpError(400, 'Scenario is not valid.', result.errors);
    if (result.value.id !== req.params.id) throw new HttpError(400, 'Scenario id does not match the URL.');
    res.json({ scenario: replaceScenario(db, req.params.id, result.value) });
  }));

  app.post('/api/scenarios/:id/duplicate', h((req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
    res.status(201).json({ scenario: duplicateScenario(db, req.params.id, name) });
  }));

  app.delete('/api/scenarios/:id', h((req, res) => {
    deleteScenario(db, req.params.id);
    res.status(204).end();
  }));

  app.delete('/api/scenarios', h((_req, res) => {
    deleteAllScenarios(db);
    res.status(204).end();
  }));

  /* ---- bundled simulated samples ---- */

  app.post('/api/samples/restore', h((_req, res) => {
    res.json({ added: restoreSamples(db) });
  }));

  /* ---- saved report snapshots ---- */

  app.get('/api/scenarios/:id/reports', h((req, res) => {
    requireScenario(req.params.id);
    res.json({ reports: listReports(db, req.params.id) });
  }));

  app.post('/api/scenarios/:id/reports', h((req, res) => {
    const result = validateReport(req.body);
    if (!result.ok) throw new HttpError(400, 'Report is not valid.', result.errors);
    res.status(201).json({ report: createReport(db, req.params.id, result.value) });
  }));

  app.get('/api/scenarios/:id/reports/:rid', h((req, res) => {
    const report = readReport(db, req.params.id, req.params.rid);
    if (!report) throw new HttpError(404, 'Report not found.');
    res.json({ report });
  }));

  app.delete('/api/scenarios/:id/reports/:rid', h((req, res) => {
    deleteReport(db, req.params.id, req.params.rid);
    res.status(204).end();
  }));

  /* ---- graph feature extraction (Python ML module) ---- */

  app.post('/api/scenarios/:id/features', async (req, res, next) => {
    try {
      const s = requireScenario(req.params.id);
      res.json(await extractFeatures({ assets: s.assets, dependencies: s.dependencies }));
    } catch (err) {
      next(err);
    }
  });

  /* ---- external integrations (AI, Hugging Face, Kaggle, W&B): optional, every call goes through this server ---- */

  app.use('/api/integrations', mountRoutes(express.Router(), integrations.handlers));

  /* ---- Graph Git: branches, commits, patches and branch simulations ---- */

  app.use('/api', createGraphGitRouter(db));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API route.')));

  /* ---- static app (production) ---- */

  if (staticDir) {
    // Vite fingerprints everything in /assets, so those files can be cached for good; the HTML shell must revalidate
    // so a new build is picked up straight away.
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, file) {
          const hashed = file.split(path.sep).includes('assets');
          res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.use(async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const index = path.join(staticDir, 'index.html');
      try {
        await fs.access(index);
        res.sendFile(index, { headers: { 'Cache-Control': 'no-cache' } });
      } catch {
        res.status(503).type('text').send('GhostGrid has not been built yet. Run "npm run build" from the repository root first, or use "npm run dev".');
      }
    });
  }

  /* ---- errors ---- */

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    if (err?.code === 'ERR_SQLITE_ERROR') {
      const msg = String(err.message);
      if (/UNIQUE constraint/i.test(msg)) return res.status(409).json({ error: 'That conflicts with existing data.' });
      if (/constraint failed/i.test(msg)) return res.status(400).json({ error: 'The data breaks a database rule.', details: [msg] });
      if (/locked|busy/i.test(msg)) return res.status(503).json({ error: 'The database is busy. Please try again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  return app;
}
