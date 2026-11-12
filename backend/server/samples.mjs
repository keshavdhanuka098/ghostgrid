import fs from 'node:fs';
import { createScenario } from './repo.mjs';
import { validateScenario } from './validate.mjs';

// The sample scenarios live in shared/samples.json so the server and the web app read one source of truth.
const raw = JSON.parse(fs.readFileSync(new URL('../shared/samples.json', import.meta.url), 'utf8'));

export const SAMPLES = raw.map((s) => {
  const result = validateScenario({ ...s, id: `sample-${s.sampleKey}` });
  if (!result.ok) throw new Error(`Bundled sample "${s.sampleKey}" is invalid: ${result.errors.join(' ')}`);
  return { sampleKey: s.sampleKey, doc: result.value };
});

/** Adds any bundled sample that is not already present. Returns the scenarios that were added. */
export function restoreSamples(db) {
  const added = [];
  for (const { sampleKey, doc } of SAMPLES) {
    if (db.prepare('SELECT 1 FROM scenarios WHERE sample_key = ?').get(sampleKey)) continue;
    let { id, name } = doc;
    if (db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(id)) id = `${id}-${Date.now().toString(36)}`;
    if (db.prepare('SELECT 1 FROM scenarios WHERE name = ? COLLATE NOCASE').get(name)) name = `${name} (restored)`;
    added.push(createScenario(db, { ...doc, id, name }, { sampleKey }));
  }
  return added;
}
