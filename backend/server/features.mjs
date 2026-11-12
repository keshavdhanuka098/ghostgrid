import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.mjs';

/**
 * Runs at most `max` tasks at once; the rest wait their turn in order. Feature extraction starts a Python process per
 * request, so this keeps a burst of requests from launching dozens of interpreters at the same time.
 */
export function createLimiter(max) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= max || !waiting.length) return;
    running++;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

const limit = createLimiter(Math.max(1, Number(process.env.GHOSTGRID_FEATURE_CONCURRENCY) || 2));

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs the Python graph feature extractor (backend/ml) on a graph. The graph is sent on stdin as JSON and no shell
 * is involved, so nothing in the graph can reach a command line.
 */
export function extractFeatures(graph, options = {}) {
  return limit(() => runExtractor(graph, options));
}

function runExtractor(graph, { python = process.env.GHOSTGRID_PYTHON ?? 'python3', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-m', 'ml.feature_engineering.cli'],
      { cwd: backendRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, PYTHONPATH: backendRoot } },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new HttpError(503, 'Python is not installed, so graph features are unavailable. Install Python 3.10+ or set GHOSTGRID_PYTHON.'));
          return reject(new HttpError(500, `Feature extraction failed. ${String(stderr || err.message).slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new HttpError(500, 'Feature extraction returned unreadable output.'));
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ assets: graph.assets, dependencies: graph.dependencies }));
  });
}
