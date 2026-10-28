const REQUEST_TIMEOUT_MS = 8000;
const COOLDOWN_MS = 5 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const MYMEMORY_MAX_BYTES = 480;
const APERTIUM_CODES = { en: 'eng', es: 'spa' };

class QuotaError extends Error {}

async function request(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 429) throw new QuotaError('rate limit exceeded (HTTP 429)');
  if (res.status === 456) throw new QuotaError('monthly character quota exceeded (HTTP 456)');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function splitByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return [text];
  const chunks = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (Buffer.byteLength(candidate) > maxBytes && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function myMemory(text, from, to, settings) {
  const parts = await Promise.all(
    splitByBytes(text, MYMEMORY_MAX_BYTES).map(async (chunk) => {
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', chunk);
      url.searchParams.set('langpair', `${from}|${to}`);
      if (settings.myMemoryEmail) url.searchParams.set('de', settings.myMemoryEmail);
      const data = await request(url);
      const status = Number(data.responseStatus);
      if (status === 429 || data.quotaFinished) throw new QuotaError(data.responseDetails || 'Daily quota used up');
      if (status !== 200) throw new Error(data.responseDetails || `status ${status}`);
      return data.responseData.translatedText;
    })
  );
  return parts.join(' ');
}

// Free keys (":fx") go to api-free, paid ones to api. Newer plans (Developer/Growth) may not follow that
// suffix, so a 403 from one host retries the other, and the host that worked is remembered per key.
const deeplHostByKey = new Map();

async function deepl(text, from, to, settings) {
  const key = settings.deeplKey;
  const guess = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const other = guess === 'api.deepl.com' ? 'api-free.deepl.com' : 'api.deepl.com';
  const call = (host) =>
    request(`https://${host}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [text],
        source_lang: from.toUpperCase(),
        target_lang: to === 'en' ? 'EN-US' : to.toUpperCase(),
      }),
    });
  const known = deeplHostByKey.get(key);
  if (known) return (await call(known)).translations[0].text;
  let host = guess;
  let data;
  try {
    data = await call(host);
  } catch (err) {
    if (err.message !== 'HTTP 403') throw err;
    host = other;
    data = await call(host); // still 403 → the key itself is wrong
  }
  deeplHostByKey.set(key, host);
  return data.translations[0].text;
}

// Unofficial endpoint used by Google's own web widgets: no key, but rate-limited per IP.
async function google(text, from, to) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', from);
  url.searchParams.set('tl', to);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);
  const data = await request(url);
  return data[0].map((part) => part[0]).join('');
}

async function apertium(text, from, to) {
  const data = await request('https://apertium.org/apy/translate', {
    method: 'POST',
    body: new URLSearchParams({
      langpair: `${APERTIUM_CODES[from]}|${APERTIUM_CODES[to]}`,
      q: text,
      markUnknown: 'no',
    }),
  });
  if (Number(data.responseStatus) !== 200) throw new Error(data.responseDetails || `status ${data.responseStatus}`);
  return data.responseData.translatedText.trim();
}

const PROVIDERS = {
  deepl: { name: 'DeepL', run: deepl, available: (s) => Boolean(s.deeplKey) },
  google: { name: 'Google', run: google, available: () => true },
  mymemory: { name: 'MyMemory', run: myMemory, available: () => true },
  apertium: { name: 'Apertium', run: apertium, available: () => true },
};
const AUTO_ORDER = ['deepl', 'google', 'mymemory', 'apertium'];

const cooldownUntil = new Map();

async function runProvider(id, text, from, to, settings) {
  const provider = PROVIDERS[id];
  if (!provider.available(settings)) throw new Error(`${provider.name} API key is not set`);
  try {
    const translated = await provider.run(text, from, to, settings);
    cooldownUntil.delete(id);
    return translated;
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'timed out' : err.message;
    cooldownUntil.set(id, Date.now() + (err instanceof QuotaError ? QUOTA_COOLDOWN_MS : COOLDOWN_MS));
    throw new Error(`${provider.name}: ${message}`);
  }
}

async function translate(text, from, to, settings) {
  if (!text.trim() || from === to || settings.translator === 'off') return { text: '' };

  if (settings.translator !== 'auto') {
    const id = PROVIDERS[settings.translator] ? settings.translator : 'mymemory';
    try {
      return { text: await runProvider(id, text, from, to, settings), provider: PROVIDERS[id].name };
    } catch (err) {
      return { text: '', error: err.message };
    }
  }

  const candidates = AUTO_ORDER.filter((id) => PROVIDERS[id].available(settings));
  const ready = candidates.filter((id) => (cooldownUntil.get(id) ?? 0) <= Date.now());
  // If every service is cooling down, retry them all rather than give up.
  const order = ready.length ? ready : candidates;
  const errors = [];
  for (const id of order) {
    try {
      return { text: await runProvider(id, text, from, to, settings), provider: PROVIDERS[id].name };
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { text: '', error: errors.join(' · ') };
}

module.exports = { translate };
