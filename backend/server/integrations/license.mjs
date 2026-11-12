/**
 * Coarse licence triage for dataset and model listings. This is a signal to prompt a human check, never legal advice:
 * only a recognised permissive licence is labelled "permissive", and even then the UI asks the user to confirm.
 */
const PERMISSIVE = [/^apache-?2/, /^mit$/, /^bsd/, /^cc0/, /^cc-?by-?(1|2|3|4)/, /^odc-?by$/, /^pddl$/, /^unlicense$/, /^isc$/, /^zlib$/, /^cdla-?permissive/, /^afl/, /^artistic/, /^wtfpl$/, /^publicdomain$/, /^public-?domain$/, /^cc-?by$/];
const CONDITIONS = [/(^|-)sa(-|$)/, /^gpl/, /^agpl/, /^lgpl/, /^odbl/, /^odc-?odbl/, /^mpl/, /^epl/, /^cdla-?sharing/, /^eupl/, /^cc-?by-?sa/];
const RESTRICTED = [/-nc/, /nc-/, /^cc-?by-?nc/, /-nd/, /^other$/, /^unknown$/, /research/, /non-?commercial/, /openrail/, /^llama/, /^gemma/, /proprietary/, /copyright/, /all-?rights/];

/** Lower-cases and hyphenates a licence name so "CC BY-SA 4.0" and "cc-by-sa-4.0" compare equal. */
export function normalizeLicense(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();
  if (!s) return null;
  return s.replace(/^license:/, '').replace(/[\s_]+/g, '-').replace(/[()©:,]/g, '').replace(/-+/g, '-');
}

export function assessLicense(raw) {
  const id = normalizeLicense(raw);
  if (!id) return { id: null, status: 'unknown', requiresReview: true, summary: 'No licence is declared. Do not assume the data can be used; check with the owner.' };
  // Order matters: "cc-by-nc-sa" must be caught as restricted before "sa" marks it as share-alike.
  if (RESTRICTED.some((r) => r.test(id))) return { id, status: 'restricted', requiresReview: true, summary: 'Declared licence restricts use (non-commercial, no-derivatives, unspecified or custom terms). Read the terms before use.' };
  if (CONDITIONS.some((r) => r.test(id))) return { id, status: 'conditions', requiresReview: true, summary: 'Licence attaches conditions such as share-alike or copyleft. Check they fit your use.' };
  if (PERMISSIVE.some((r) => r.test(id))) return { id, status: 'permissive', requiresReview: false, summary: 'Declared licence is generally permissive. This is a signal, not legal advice; confirm it fits your use.' };
  return { id, status: 'unknown', requiresReview: true, summary: 'Licence is not one GhostGrid recognises. Check the terms yourself.' };
}
