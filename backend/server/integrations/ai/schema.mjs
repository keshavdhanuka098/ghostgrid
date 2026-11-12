import { IntegrationError } from '../errors.mjs';

/**
 * Every AI task returns this one shape, whichever provider answered, so the UI and the tests never branch on provider.
 * Extra fields are dropped; missing or mistyped required fields are an error rather than something to guess at.
 */
export const OUTPUT_SHAPE_PROMPT = `Respond with ONE JSON object and nothing else, exactly in this shape:
{
  "summary": string,
  "findings": [ { "title": string, "detail": string, "severity": "info" | "notable" | "important", "evidence": string[], "assetIds": string[] } ],
  "recommendations": [ { "title": string, "rationale": string, "effort": "low" | "medium" | "high" | null, "basedOn": string[] } ],
  "caveats": string[]
}
"summary" is 2-5 sentences. "evidence" and "basedOn" must quote field names or values that appear in DATA. "assetIds" may only contain asset ids that appear in DATA. Put the limits of the supplied data in "caveats".`;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, max, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, max)).filter(Boolean).slice(0, n) : []);

export function extractJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return undefined;
}

/** Validates and normalises a model answer. `knownIds` (optional) filters out asset ids the model made up. */
export function normalizeOutput(raw, { provider, knownIds } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !str(raw.summary, 2000)) {
    throw new IntegrationError('bad_response', `${provider ?? 'The AI provider'} did not return the expected structured answer.`, { provider });
  }
  const caveats = strList(raw.caveats, 400, 10);
  let dropped = 0;
  const keep = (ids) => {
    const list = strList(ids, 120, 30);
    if (!knownIds) return list;
    const ok = list.filter((id) => knownIds.has(id));
    dropped += list.length - ok.length;
    return ok;
  };
  const sev = new Set(['info', 'notable', 'important']);
  const eff = new Set(['low', 'medium', 'high']);
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f) => f && typeof f === 'object' && str(f.title, 160))
    .slice(0, 12)
    .map((f) => ({ title: str(f.title, 160), detail: str(f.detail, 1200), severity: sev.has(f.severity) ? f.severity : 'info', evidence: strList(f.evidence, 240, 8), assetIds: keep(f.assetIds) }));
  const recommendations = (Array.isArray(raw.recommendations) ? raw.recommendations : [])
    .filter((r) => r && typeof r === 'object' && str(r.title, 160))
    .slice(0, 10)
    .map((r) => ({ title: str(r.title, 160), rationale: str(r.rationale, 1200), effort: eff.has(r.effort) ? r.effort : null, basedOn: strList(r.basedOn, 240, 8) }));
  if (dropped) caveats.push(`${dropped} asset reference${dropped === 1 ? '' : 's'} in the AI answer did not match your data and ${dropped === 1 ? 'was' : 'were'} removed.`);
  return { summary: str(raw.summary, 2000), findings, recommendations, caveats };
}
