// Tried in order; a model that is overloaded ("high demand"), rate-limited or retired hands over to the next one.
// "latest" aliases: Google moves them to each new release, so the app doesn't need updating.
const GEMINI_MODELS = [
  { name: 'gemini-flash-lite-latest' },
  { name: 'gemini-flash-latest', thinkingConfig: { thinkingLevel: 'low' } },
];
const REQUEST_TIMEOUT_MS = 20000;
const RETRYABLE_STATUS = new Set([404, 429, 500, 502, 503, 504]);
const LANGUAGE_NAMES = { en: 'English', es: 'Spanish' };

// Condense, don't summarize: every idea survives, only the wording gets shorter.
const instruction = (language) => `You help a live phone interpreter relay long messages faster.
Rewrite the speaker's message in ${language}, as a condensed version of what they said.

Keep:
- Every distinct idea, request, question, answer, reason and condition. If the speaker made four points, the result has four points.
- Every specific detail exactly: names, numbers, dates, times, addresses, amounts, medications and doses, instructions, and who does what.
- The speaker's point of view (first person stays first person), the order of ideas, negations, and how certain or urgent they sound ("I think", "maybe", "right now").

Remove:
- Repetition: say each idea once, in its clearest form.
- Filler, hesitations, false starts, and politeness padding that carries no information.
- Self-corrections: keep only the corrected version.

Rules:
- Shorten the wording, never the content. Do not add, explain, interpret or give advice.
- If a word is clearly a transcription error, use the obviously intended word; if unsure, keep it.
- If the message is already concise, return it almost unchanged.
- Reply with the rewritten message only: plain text, no preamble, no quotes. Use short bullet points only when the speaker listed several separate items.`;
const TEMPERATURE = 0.2; // low: faithful rewording, not creative variation

async function callGemini(model, text, lang, apiKey) {
  const system = instruction(LANGUAGE_NAMES[lang] ?? 'the same language as the message');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: TEMPERATURE, ...(model.thinkingConfig && { thinkingConfig: model.thinkingConfig }) },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: `Gemini: ${data.error?.message || `HTTP ${res.status}`}`, retry: RETRYABLE_STATUS.has(res.status) };
    }
    const summary = (data.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    return summary ? { text: summary } : { error: 'Gemini returned an empty answer', retry: true };
  } catch (err) {
    return { error: `Gemini: ${err.name === 'TimeoutError' ? 'request timed out' : err.message}`, retry: true };
  }
}

async function paraphrase(text, lang, settings) {
  if (!settings.geminiKey) return { text: '', error: 'Gemini API key is not set' };
  const errors = [];
  for (const model of GEMINI_MODELS) {
    const result = await callGemini(model, text, lang, settings.geminiKey);
    if (result.text) return { text: result.text, model: model.name };
    errors.push(result.error);
    console.warn(`Paraphrase with ${model.name} failed: ${result.error}`);
    if (!result.retry) break; // e.g. a bad key fails the same way on every model
  }
  return { text: '', error: [...new Set(errors)].join(' · ') };
}

module.exports = { paraphrase };
