import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLimiter } from '../features.mjs';

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const limit = createLimiter(2);

/**
 * Runs a script from backend/scripts with an argument array (no shell, so nothing user-supplied can become a command).
 * Resolves with { code, stdout, stderr } for any exit status; it rejects only when Python itself cannot start.
 * `extraEnv` is how a credential reaches a child process: it is passed in memory and never appears in argv.
 */
export function runPython(script, args = [], { python = process.env.GHOSTGRID_PYTHON ?? 'python3', cwd = backendRoot, extraEnv = {}, timeoutMs = 60000, input } = {}) {
  return limit(
    () =>
      new Promise((resolve, reject) => {
        const child = execFile(
          python,
          [path.join('scripts', script), ...args],
          { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, PYTHONPATH: cwd, PYTHONIOENCODING: 'utf-8', ...extraEnv } },
          (err, stdout, stderr) => {
            if (err && err.code === 'ENOENT') return reject(Object.assign(new Error('Python is not installed or GHOSTGRID_PYTHON is wrong.'), { code: 'PYTHON_MISSING' }));
            if (err && err.killed) return reject(Object.assign(new Error('The Python helper timed out.'), { code: 'PYTHON_TIMEOUT' }));
            resolve({ code: typeof err?.code === 'number' ? err.code : 0, stdout, stderr });
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(input ?? '');
      }),
  );
}

export function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}
