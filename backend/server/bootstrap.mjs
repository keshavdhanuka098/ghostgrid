import fs from 'node:fs';
import { backfillMainBranches } from './graphgit/repo.mjs';
import { createScenario, countScenarios, getMeta, setMeta } from './repo.mjs';
import { restoreSamples } from './samples.mjs';
import { validateScenario } from './validate.mjs';

/**
 * One-time import of the Part 1 JSON store (data/db.json) into an empty database.
 * The JSON file is left untouched so nothing is lost if the import needs to be repeated by hand.
 */
export function importLegacyJson(db, file, log = () => {}) {
  if (getMeta(db, 'legacy_imported') || countScenarios(db) > 0 || !file || !fs.existsSync(file)) return 0;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log(`Skipping legacy import: ${file} is not readable JSON (${err.message}).`);
    return 0;
  }
  let imported = 0;
  let sampleAssigned = false;
  const names = new Set();
  for (const raw of Array.isArray(parsed?.scenarios) ? parsed.scenarios : []) {
    const result = validateScenario(raw, { legacy: true });
    if (!result.ok) {
      log(`Skipping legacy scenario "${raw?.name ?? raw?.id}": ${result.errors[0]}`);
      continue;
    }
    const doc = result.value;
    let name = doc.name;
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${doc.name.slice(0, 70)} (${i})`;
    names.add(name.toLowerCase());
    // Part 1's single built-in sample becomes the bundled metro sample, so restoring samples never duplicates it.
    const sampleKey = raw.isSample === true && !sampleAssigned ? 'metro-corridor' : null;
    if (sampleKey) sampleAssigned = true;
    createScenario(db, { ...doc, name }, { sampleKey, keepTimestamps: true });
    imported++;
  }
  setMeta(db, 'legacy_imported', new Date().toISOString());
  if (imported) log(`Imported ${imported} scenario(s) from ${file}.`);
  return imported;
}

/** Runs startup data tasks: legacy import, then one-time sample seeding (never repeated after the user deletes samples). */
export function bootstrap(db, { legacyFile, seedSamples = true, log = () => {} } = {}) {
  importLegacyJson(db, legacyFile, log);
  if (seedSamples && !getMeta(db, 'samples_seeded')) {
    const added = restoreSamples(db);
    setMeta(db, 'samples_seeded', new Date().toISOString());
    if (added.length) log(`Seeded ${added.length} simulated sample scenario(s).`);
  }
  // Scenarios saved before Graph Git existed get a main branch whose baseline is their current graph.
  const backfilled = backfillMainBranches(db);
  if (backfilled) log(`Created a main branch for ${backfilled} existing scenario(s).`);
}
