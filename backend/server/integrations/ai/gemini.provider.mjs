import { IntegrationError, USER_MESSAGES } from '../errors.mjs';
import { requestJson } from '../http.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini reports a bad API key as HTTP 400 with reason API_KEY_INVALID, so the status alone would mislead. */
function classify(status, text) {
  if (/API_KEY_INVALID|API key not valid|API_KEY_/i.test(text)) return 'invalid_credentials';
  if (status === 400 && /FAILED_PRECONDITION/i.test(text)) return 'forbidden';
  if (status === 403 && /PERMISSION_DENIED|API key/i.test(text)) return 'invalid_credentials';
  return undefined;
}

export function createGeminiProvider({ secrets, model, fetchImpl, sleep, log }) {
  const common = () => ({ provider: 'Gemini', fetchImpl, sleep, log, classify, secretValues: secrets.values() });
  const headers = () => ({ 'x-goog-api-key': secrets.get('GEMINI_API_KEY') }); // header, not URL: keys in URLs leak into logs
  return {
    id: 'gemini',
    label: 'Google Gemini',
    model,
    isConfigured: () => secrets.isConfigured('gemini'),

    /** Cheap, read-only check: listing one model proves the key works without spending generation quota. */
    async health() {
      await requestJson({ ...common(), url: `${BASE}/models?pageSize=1`, headers: headers(), timeoutMs: 8000, retries: 0 });
      return { detail: `Key accepted. Model: ${model}` };
    },

    async generate({ system, prompt, temperature = 0.2, maxOutputTokens = 2048, timeoutMs = 45000 }) {
      const { data } = await requestJson({
        ...common(),
        url: `${BASE}/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: headers(),
        timeoutMs,
        retries: 1,
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
        },
      });
      if (data?.promptFeedback?.blockReason) throw new IntegrationError('blocked', 'Gemini declined to process this request.', { provider: 'Gemini' });
      const cand = data?.candidates?.[0];
      if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') throw new IntegrationError('blocked', 'Gemini declined to answer this request.', { provider: 'Gemini' });
      if (cand?.finishReason === 'MAX_TOKENS') throw new IntegrationError('bad_response', 'Gemini’s answer was cut off before it finished.', { provider: 'Gemini' });
      const text = (cand?.content?.parts ?? []).map((p) => p?.text ?? '').join('');
      if (!text.trim()) throw new IntegrationError('bad_response', USER_MESSAGES.bad_response('Gemini'), { provider: 'Gemini' });
      return { text, model, usage: data?.usageMetadata ? { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount } : undefined };
    },
  };
}
