// Tried in order; a model that is overloaded, rate-limited or gone hands over to the next one.
// Providers without an API key in settings are skipped.
const MODELS = [
  // "latest" alias: Google moves it to each new Flash-Lite release, so the app doesn't need updating.
  { provider: 'gemini', name: 'gemini-flash-lite-latest' },
  { provider: 'groq', name: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' } },
  { provider: 'groq', name: 'llama-3.3-70b-versatile' },
];
const KEY_SETTING = { gemini: 'geminiKey', groq: 'groqKey' };
const PROVIDER_LABEL = { gemini: 'Gemini', groq: 'Groq' };
const REQUEST_TIMEOUT_MS = 20000;
// Overloaded ("high demand"), rate-limited, retired model or a passing server error: worth trying the next model.
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

function buildRequest(model, system, text, apiKey) {
  if (model.provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`,
      headers: { 'x-goog-api-key': apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: TEMPERATURE },
      },
      read: (data) =>
        (data.candidates?.[0]?.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join(''),
    };
  }
  return {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: model.name,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      temperature: TEMPERATURE,
      ...model.extra,
    },
    read: (data) => data.choices?.[0]?.message?.content ?? '',
  };
}

async function callModel(model, text, lang, apiKey) {
  const label = PROVIDER_LABEL[model.provider];
  const system = instruction(LANGUAGE_NAMES[lang] ?? 'the same language as the message');
  const request = buildRequest(model, system, text, apiKey);
  try {
    const res = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: `${label}: ${data.error?.message || `HTTP ${res.status}`}`, retry: RETRYABLE_STATUS.has(res.status) };
    }
    const summary = request.read(data).trim();
    return summary ? { text: summary } : { error: `${label} returned an empty answer`, retry: true };
  } catch (err) {
    return { error: `${label}: ${err.name === 'TimeoutError' ? 'request timed out' : err.message}`, retry: true };
  }
}

async function paraphrase(text, lang, settings) {
  const available = MODELS.filter((model) => settings[KEY_SETTING[model.provider]]);
  if (available.length === 0) return { text: '', error: 'Paraphrase API key is not set' };
  const errors = [];
  const brokenProviders = new Set();
  for (const model of available) {
    if (brokenProviders.has(model.provider)) continue;
    const result = await callModel(model, text, lang, settings[KEY_SETTING[model.provider]]);
    if (result.text) return { text: result.text, model: model.name };
    errors.push(result.error);
    console.warn(`Paraphrase with ${model.name} failed: ${result.error}`);
    // A bad key fails the same way on every model of that provider, but the other provider may still work.
    if (!result.retry) brokenProviders.add(model.provider);
  }
  return { text: '', error: [...new Set(errors)].join(' · ') };
}

module.exports = { paraphrase };
