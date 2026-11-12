import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COMMIT_KINDS, PATCH_CATEGORIES, PATCH_TYPES } from './graphgit/constants.mjs';
import { ASSET_KINDS, CONFIDENCES, CRITICALITIES, ESTIMATE_LEVELS, LINK_STATUSES, MITIGATION_KINDS, MODES, RELATIONS, TARGET_TYPES } from './validate.mjs';

const list = (values) => values.map((v) => `'${v}'`).join(', ');

/**
 * Ordered, append-only migrations. `PRAGMA user_version` records how many have run, so an existing database is
 * upgraded in place on startup. Never edit a migration that has shipped; add a new one.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE scenarios (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '',
        sector      TEXT NOT NULL,
        sample_key  TEXT UNIQUE,                 -- non-null marks a bundled, simulated sample
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_scenarios_name ON scenarios (name COLLATE NOCASE);

      -- Nodes: infrastructure components or services. Ids are unique within a scenario.
      CREATE TABLE nodes (
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN (${list(ASSET_KINDS)})),
        criticality TEXT NOT NULL CHECK (criticality IN (${list(CRITICALITIES)})),
        notes       TEXT NOT NULL DEFAULT '',
        x           REAL,                        -- optional pinned position; NULL means auto-layout
        y           REAL,
        sort_order  INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id),
        CHECK ((x IS NULL) = (y IS NULL))
      );
      CREATE UNIQUE INDEX idx_nodes_name ON nodes (scenario_id, name COLLATE NOCASE);

      -- Directed dependency links: dependent_id relies on provider_id.
      CREATE TABLE links (
        scenario_id  TEXT NOT NULL,
        id           TEXT NOT NULL,
        dependent_id TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        mode         TEXT NOT NULL CHECK (mode IN (${list(MODES)})),
        status       TEXT NOT NULL CHECK (status IN (${list(LINK_STATUSES)})),
        relation     TEXT NOT NULL CHECK (relation IN (${list(RELATIONS)})),
        notes        TEXT NOT NULL DEFAULT '',
        sort_order   INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id),
        UNIQUE (scenario_id, dependent_id, provider_id),
        CHECK (dependent_id <> provider_id),
        FOREIGN KEY (scenario_id, dependent_id) REFERENCES nodes (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, provider_id)  REFERENCES nodes (scenario_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_links_provider ON links (scenario_id, provider_id);

      CREATE TABLE assumptions (
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        text        TEXT NOT NULL CHECK (length(text) > 0),
        target_type TEXT NOT NULL CHECK (target_type IN (${list(TARGET_TYPES)})),
        target_id   TEXT,                        -- node or link id within the scenario; NULL for scenario-wide
        confidence  TEXT NOT NULL CHECK (confidence IN (${list(CONFIDENCES)})),
        created_at  TEXT NOT NULL,
        sort_order  INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id),
        CHECK ((target_type = 'scenario') = (target_id IS NULL))
      );

      -- Mitigations: give dependent_id a backup provider for its dependency on provider_id.
      CREATE TABLE mitigations (
        scenario_id  TEXT NOT NULL,
        id           TEXT NOT NULL,
        name         TEXT NOT NULL,
        dependent_id TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        backup_id    TEXT NOT NULL,
        notes        TEXT NOT NULL DEFAULT '',
        sort_order   INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id),
        FOREIGN KEY (scenario_id, dependent_id) REFERENCES nodes (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, provider_id)  REFERENCES nodes (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, backup_id)    REFERENCES nodes (scenario_id, id) ON DELETE CASCADE
      );

      -- Saved simulation runs (which nodes were failed). Results are recomputed from the live graph.
      CREATE TABLE simulation_runs (
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        id          TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        sort_order  INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id)
      );
      CREATE TABLE run_failed_nodes (
        scenario_id TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        PRIMARY KEY (scenario_id, run_id, node_id),
        FOREIGN KEY (scenario_id, run_id)  REFERENCES simulation_runs (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, node_id) REFERENCES nodes (scenario_id, id) ON DELETE CASCADE
      );

      -- Saved report snapshots: display blocks as JSON, so a report keeps what it said when it was saved.
      CREATE TABLE reports (
        id          TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        options     TEXT NOT NULL DEFAULT '{}',
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_reports_scenario ON reports (scenario_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'link failures in saved runs; mitigation kinds and estimates',
    sql: `
      -- A saved run can now fail individual dependency links as well as assets.
      CREATE TABLE run_failed_links (
        scenario_id TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        link_id     TEXT NOT NULL,
        PRIMARY KEY (scenario_id, run_id, link_id),
        FOREIGN KEY (scenario_id, run_id)  REFERENCES simulation_runs (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, link_id) REFERENCES links (scenario_id, id) ON DELETE CASCADE
      );

      -- Mitigations gain a kind (backup or decouple) and the user's own ordinal cost and effort estimates.
      -- backup_id becomes optional (decouple has none), which SQLite can only do by rebuilding the table.
      CREATE TABLE mitigations_v2 (
        scenario_id  TEXT NOT NULL,
        id           TEXT NOT NULL,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'backup' CHECK (kind IN (${list(MITIGATION_KINDS)})),
        dependent_id TEXT NOT NULL,
        provider_id  TEXT NOT NULL,
        backup_id    TEXT,
        notes        TEXT NOT NULL DEFAULT '',
        cost_level   TEXT CHECK (cost_level IS NULL OR cost_level IN (${list(ESTIMATE_LEVELS)})),
        effort_level TEXT CHECK (effort_level IS NULL OR effort_level IN (${list(ESTIMATE_LEVELS)})),
        sort_order   INTEGER NOT NULL,
        PRIMARY KEY (scenario_id, id),
        CHECK ((kind = 'backup') = (backup_id IS NOT NULL)),
        FOREIGN KEY (scenario_id, dependent_id) REFERENCES nodes (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, provider_id)  REFERENCES nodes (scenario_id, id) ON DELETE CASCADE,
        FOREIGN KEY (scenario_id, backup_id)    REFERENCES nodes (scenario_id, id) ON DELETE CASCADE
      );
      INSERT INTO mitigations_v2 (scenario_id, id, name, kind, dependent_id, provider_id, backup_id, notes, sort_order)
        SELECT scenario_id, id, name, 'backup', dependent_id, provider_id, backup_id, notes, sort_order FROM mitigations;
      DROP TABLE mitigations;
      ALTER TABLE mitigations_v2 RENAME TO mitigations;
    `,
  },
  {
    version: 3,
    name: 'graph git: branches, commits, immutable snapshots, patches, branch simulations',
    sql: `
      -- Immutable, de-duplicated graph snapshots. graph is canonical JSON: { engineVersion, assets, dependencies }.
      CREATE TABLE graph_snapshots (
        id          TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        hash        TEXT NOT NULL,
        graph       TEXT NOT NULL,
        node_count  INTEGER NOT NULL,
        link_count  INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (scenario_id, hash)
      );
      CREATE TRIGGER graph_snapshots_immutable BEFORE UPDATE ON graph_snapshots
        BEGIN SELECT RAISE(ABORT, 'graph snapshots are immutable'); END;

      -- Branches. head/base commits and commits.branch_id reference each other, so those foreign keys are deferred
      -- until the end of the transaction that creates them.
      CREATE TABLE branches (
        id               TEXT PRIMARY KEY,
        scenario_id      TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        description      TEXT NOT NULL DEFAULT '',
        parent_branch_id TEXT REFERENCES branches (id) ON DELETE SET NULL,
        base_commit_id   TEXT NOT NULL REFERENCES commits (id) DEFERRABLE INITIALLY DEFERRED,
        head_commit_id   TEXT NOT NULL REFERENCES commits (id) DEFERRABLE INITIALLY DEFERRED,
        is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_branches_name ON branches (scenario_id, name COLLATE NOCASE);
      CREATE UNIQUE INDEX idx_branches_default ON branches (scenario_id) WHERE is_default = 1;
      CREATE INDEX idx_branches_base ON branches (base_commit_id);
      CREATE INDEX idx_branches_head ON branches (head_commit_id);

      CREATE TABLE commits (
        id               TEXT PRIMARY KEY,
        scenario_id      TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        branch_id        TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        parent_commit_id TEXT REFERENCES commits (id) DEFERRABLE INITIALLY DEFERRED,
        snapshot_id      TEXT NOT NULL REFERENCES graph_snapshots (id),
        seq              INTEGER NOT NULL,
        kind             TEXT NOT NULL CHECK (kind IN (${list(COMMIT_KINDS)})),
        message          TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 120),
        body             TEXT NOT NULL DEFAULT '',
        author           TEXT,
        summary          TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        UNIQUE (scenario_id, seq)
      );
      CREATE INDEX idx_commits_branch ON commits (branch_id, seq);
      CREATE INDEX idx_commits_parent ON commits (parent_commit_id);
      CREATE INDEX idx_commits_snapshot ON commits (snapshot_id);
      CREATE TRIGGER commits_immutable BEFORE UPDATE ON commits
        BEGIN SELECT RAISE(ABORT, 'commits are immutable'); END;

      -- Structured patch operations. commit_id is NULL while a patch is pending on its branch and is set once, by the
      -- commit that includes it. inverse holds the operations that undo it.
      CREATE TABLE graph_patches (
        id               TEXT PRIMARY KEY,
        scenario_id      TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        branch_id        TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
        commit_id        TEXT REFERENCES commits (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        base_commit_id   TEXT NOT NULL REFERENCES commits (id) DEFERRABLE INITIALLY DEFERRED,
        seq              INTEGER NOT NULL,
        op_type          TEXT NOT NULL CHECK (op_type IN (${list(PATCH_TYPES)})),
        category         TEXT NOT NULL CHECK (category IN (${list(PATCH_CATEGORIES)})),
        payload          TEXT NOT NULL,
        inverse          TEXT NOT NULL,
        description      TEXT NOT NULL,
        reverts_patch_id TEXT REFERENCES graph_patches (id) ON DELETE SET NULL,
        created_at       TEXT NOT NULL,
        UNIQUE (branch_id, seq)
      );
      CREATE INDEX idx_patches_commit ON graph_patches (commit_id);
      CREATE INDEX idx_patches_pending ON graph_patches (branch_id, commit_id);

      -- Simulations recorded against one exact commit. The result is stored as computed; it is never recomputed
      -- against a different graph.
      CREATE TABLE branch_simulations (
        id            TEXT PRIMARY KEY,
        scenario_id   TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        branch_id     TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
        commit_id     TEXT NOT NULL REFERENCES commits (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        failed_nodes  TEXT NOT NULL,
        failed_links  TEXT NOT NULL,
        config        TEXT NOT NULL,
        result        TEXT NOT NULL,
        total_failed  INTEGER NOT NULL,
        cascaded      INTEGER NOT NULL,
        critical      INTEGER NOT NULL,
        rounds        INTEGER NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_sims_branch ON branch_simulations (branch_id, created_at);
      CREATE INDEX idx_sims_commit ON branch_simulations (commit_id);
    `,
  },
  {
    version: 4,
    name: 'external integrations: settings, health history, imported datasets, model references, W&B links',
    sql: `
      -- Purely additive: nothing here touches scenarios, Graph Git or any earlier table.
      CREATE TABLE integration_settings (
        id         TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      -- Last known outcome of a real health check (never inferred from the presence of a key).
      CREATE TABLE integration_health (
        id              TEXT PRIMARY KEY,
        last_checked_at TEXT,
        last_ok_at      TEXT,
        last_error_code TEXT
      );

      -- Datasets pulled from Hugging Face or Kaggle. UNIQUE keeps one row (and one folder) per source item and revision,
      -- so an import can never silently replace an earlier one.
      CREATE TABLE external_datasets (
        id               TEXT PRIMARY KEY,
        source           TEXT NOT NULL CHECK (source IN ('huggingface', 'kaggle')),
        source_id        TEXT NOT NULL,
        revision         TEXT NOT NULL DEFAULT '',
        source_url       TEXT NOT NULL,
        license          TEXT,
        license_status   TEXT NOT NULL DEFAULT 'unknown' CHECK (license_status IN ('permissive', 'conditions', 'restricted', 'unknown')),
        status           TEXT NOT NULL CHECK (status IN ('downloading', 'extracting', 'validating', 'downloaded', 'registered', 'failed', 'cancelled')),
        total_bytes      INTEGER,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        local_path       TEXT NOT NULL,
        files            TEXT NOT NULL DEFAULT '[]',
        sha256           TEXT,
        validation       TEXT,
        manifest_name    TEXT,
        manifest_version TEXT,
        error            TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (source, source_id, revision)
      );

      -- External model repositories associated with a local experiment (a reference only: nothing is downloaded).
      CREATE TABLE model_references (
        id            TEXT PRIMARY KEY,
        provider      TEXT NOT NULL CHECK (provider IN ('huggingface')),
        repo_id       TEXT NOT NULL,
        revision      TEXT NOT NULL DEFAULT '',
        url           TEXT NOT NULL,
        license       TEXT,
        experiment_id TEXT NOT NULL DEFAULT '',
        note          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        UNIQUE (provider, repo_id, revision, experiment_id)
      );

      -- Link between a GhostGrid experiment id and its W&B run. The primary key makes a second sync of the same
      -- experiment impossible, even with two simultaneous requests.
      CREATE TABLE wandb_syncs (
        experiment_id       TEXT PRIMARY KEY,
        run_id              TEXT,
        run_url             TEXT,
        entity              TEXT,
        project             TEXT,
        status              TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'failed')),
        uploaded_checkpoint INTEGER NOT NULL DEFAULT 0,
        error               TEXT,
        created_at          TEXT NOT NULL,
        synced_at           TEXT
      );
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** Opens (creating if needed) the database and applies any pending migrations. Use ':memory:' for tests. */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema v${current} is newer than this version of GhostGrid understands (v${SCHEMA_VERSION}). Update GhostGrid or use a different database file.`);
  }
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
  return db;
}

const inTransaction = new WeakSet();

/** Runs fn inside a transaction; rolls back if it throws. Re-entrant: a nested call joins the outer transaction. */
export function tx(db, fn) {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    inTransaction.delete(db);
  }
}
