import { IntegrationError, USER_MESSAGES } from '../errors.mjs';
import { requestJson } from '../http.mjs';

const BASE = 'https://api.groq.com/openai/v1';

export function createGroqProvider({ secrets, model, fetchImpl, sleep, log }) {
  const common = () => ({ provider: 'Groq', fetchImpl, sleep, log, secretValues: secrets.values() });
  const headers = () => ({ Authorization: `Bearer ${secrets.get('GROQ_API_KEY')}` });
  return {
    id: 'groq',
    label: 'Groq',
    model,
    isConfigured: () => secrets.isConfigured('groq'),

    async health() {
      await requestJson({ ...common(), url: `${BASE}/models`, headers: headers(), timeoutMs: 8000, retries: 0 });
      return { detail: `Key accepted. Model: ${model}` };
    },

    async generate({ system, prompt, temperature = 0.2, maxOutputTokens = 2048, timeoutMs = 30000 }) {
      const { data } = await requestJson({
        ...common(),
        url: `${BASE}/chat/completions`,
        method: 'POST',
        headers: headers(),
        timeoutMs,
        retries: 1,
        body: {
          model,
          temperature,
          max_tokens: maxOutputTokens,
          response_format: { type: 'json_object' },
          // Groq's JSON mode requires the word JSON to appear in the messages; the system prompts always say it.
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
      });
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new IntegrationError('bad_response', 'Groq’s answer was cut off before it finished.', { provider: 'Groq' });
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new IntegrationError('bad_response', USER_MESSAGES.bad_response('Groq'), { provider: 'Groq' });
      return { text, model, usage: data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined };
    },
  };
}
