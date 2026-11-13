
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { bootstrap } from './bootstrap.mjs';
import { openDatabase } from './db.mjs';
import { createIntegrations } from './integrations/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Optional .env file (see .env.example). Real environment variables always win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

const dbFile = path.resolve(root, process.env.GHOSTGRID_DB ?? 'data/ghostgrid.db');
const legacyFile = path.resolve(root, process.env.GHOSTGRID_LEGACY_JSON ?? 'data/db.json');
const seedSamples = !/^(0|false|no|off)$/i.test(process.env.GHOSTGRID_SEED_SAMPLES ?? 'true');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT "${process.env.PORT}". Use a number between 1 and 65535.`);
  process.exit(1);
}

let db;
try {
  db = openDatabase(dbFile);
  bootstrap(db, { legacyFile, seedSamples, log: (m) => console.log(m) });
} catch (err) {
  console.error(`Could not start GhostGrid: ${err.message}`);
  process.exit(1);
}

const integrations = createIntegrations({ db });
const recovered = integrations.recover();
if (recovered) console.log(`Marked ${recovered} interrupted dataset import(s) as failed.`);

const app = createApp({
  db,
  staticDir: path.resolve(root, '../frontend/dist'),
  integrations
});

const server = app.listen(port, host, () => {
  const bound = server.address();
  console.log(`GhostGrid API listening on ${bound.address}:${bound.port}`);
  console.log(`Database: ${dbFile}`);
});

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Set PORT to another value.`
      : `Server error: ${err.message}`
  );
  process.exit(1);
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
