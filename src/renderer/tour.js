// Guided tour: a red pointer walks through the app, "clicks" things and explains them in a card.
// It only opens panels and adds demo bubbles; it never changes saved settings or calls paid APIs.

class Cancelled extends Error {}

let active = null;

export const isTourRunning = () => Boolean(active);
export const endTour = () => active?.abort();

const $ = (selector) => document.querySelector(selector);
const visible = (el) => Boolean(el && el.getClientRects().length && !el.closest('[hidden]'));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Word positions (as the server would send them) of the words to mark as uncertain in a demo bubble.
const uncertainAt = (text, words) =>
  text.split(/\s+/).flatMap((token, i) =>
    words.includes(token.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) ? [i] : [],
  );

export async function startTour(ctx) {
  if (active) return;
  if (ctx.isLive()) {
    ctx.toast('Detén la captura (Stop) para ver el tutorial.');
    return;
  }
  const controller = new AbortController();
  active = controller;
  const ui = buildUi(controller);
  try {
    await runSteps(ctx, ui, controller.signal);
  } catch (err) {
    if (!(err instanceof Cancelled)) console.error('Tour failed:', err);
  } finally {
    cleanup(ctx, ui);
    active = null;
  }
}

function buildUi(controller) {
  // A transparent layer catches stray clicks so the demo can't be knocked off course mid-step.
  const blocker = document.createElement('div');
  blocker.className = 'tour-blocker';
  const pointer = document.createElement('div');
  pointer.className = 'tour-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  const card = document.createElement('section');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  card.innerHTML =
    '<div class="tour-card-head"><span class="tour-step"></span><button type="button" class="tour-exit">Salir</button></div>' +
    '<h3 class="tour-title"></h3><p class="tour-body"></p>' +
    '<div class="tour-card-actions"><button type="button" class="tour-next primary">Siguiente →</button></div>';
  // Clicks inside the tour must not reach the app's "click outside closes the popup" handlers.
  for (const el of [blocker, card]) el.addEventListener('click', (e) => e.stopPropagation());
  card.querySelector('.tour-exit').addEventListener('click', () => controller.abort());
  const onKey = (e) => {
    if (e.key === 'Escape') controller.abort();
  };
  document.addEventListener('keydown', onKey);
  card.hidden = true;
  document.body.append(blocker, pointer, card);

  const startX = window.innerWidth / 2;
  const startY = window.innerHeight / 2;
  pointer.style.transform = `translate(${startX}px, ${startY}px)`;
  return { blocker, pointer, card, onKey, highlighted: null, pos: { x: startX, y: startY } };
}

function cleanup(ctx, ui) {
  document.removeEventListener('keydown', ui.onKey);
  ui.highlighted?.classList.remove('tour-highlight');
  ui.blocker.remove();
  ui.pointer.remove();
  ui.card.remove();
  // Put the app back the way the tour found it.
  const spelling = $('#spellingInput');
  if (spelling?.value) {
    spelling.value = '';
    spelling.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const panel of document.querySelectorAll('.tool-popover:not([hidden])')) {
    panel.querySelector('[data-close-popover]')?.click();
  }
  for (const panel of document.querySelectorAll('.help-panel:not([hidden])')) {
    document.querySelector(`.help-btn[aria-controls="${panel.id}"]`)?.click();
  }
  if (ctx.settingsOpen() && !ctx.settingsWereOpen) ctx.closeSettings();
  ctx.clearDemo();
}

async function runSteps(ctx, ui, signal) {
  const wait = (ms) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Cancelled());
      const timer = setTimeout(resolve, reducedMotion() ? Math.min(ms, 120) : ms);
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Cancelled())), { once: true });
    });

  const highlight = (el) => {
    ui.highlighted?.classList.remove('tour-highlight');
    ui.highlighted = el ?? null;
    el?.classList.add('tour-highlight');
  };

  const moveTo = async (el, { x = 0.5, y = 0.5 } = {}) => {
    if (!visible(el)) return;
    el.scrollIntoView({ block: 'nearest' });
    const rect = el.getBoundingClientRect();
    ui.pos = { x: rect.left + rect.width * x, y: rect.top + rect.height * y };
    ui.pointer.style.transform = `translate(${ui.pos.x}px, ${ui.pos.y}px)`;
    await wait(650);
  };

  // The pointer "clicks": a press-and-ripple animation, then the real click on the element.
  const click = async (el, { real = true } = {}) => {
    if (!el) return;
    await moveTo(el);
    ui.pointer.classList.remove('clicking');
    void ui.pointer.offsetWidth;
    ui.pointer.classList.add('clicking');
    await wait(260);
    if (real) el.click();
    await wait(320);
  };

  const steps = [];
  const step = (fn) => steps.push(fn);

  // Shows the card next to `el` (or centered) and waits for "Siguiente".
  const say = (el, title, body, { last = false } = {}) => {
    const card = ui.card;
    card.querySelector('.tour-step').textContent = `${current + 1} / ${steps.length}`;
    card.querySelector('.tour-title').textContent = title;
    card.querySelector('.tour-body').innerHTML = body;
    const next = card.querySelector('.tour-next');
    next.textContent = last ? 'Terminar ✓' : 'Siguiente →';
    highlight(visible(el) ? el : null);
    card.hidden = false;
    placeCard(card, visible(el) ? el.getBoundingClientRect() : null);
    next.focus({ preventScroll: true });
    return new Promise((resolve, reject) => {
      // The card hides while the pointer acts out the next step, so a stale "Siguiente" is never on screen.
      next.onclick = () => {
        card.hidden = true;
        highlight(null);
        resolve();
      };
      signal.addEventListener('abort', () => reject(new Cancelled()), { once: true });
    });
  };

  let demoLong = null;

  step(() =>
    say(
      null,
      '¡Bienvenido a Live Caption Plus!',
      'Este recorrido de un minuto te muestra qué hay que configurar y cómo se ve una llamada. ' +
        'El punto rojo hará los clics por ti. Puedes salir cuando quieras con <b>Salir</b> o <b>Esc</b>.',
    ),
  );

  step(async () => {
    await ctx.expand();
    ctx.settingsWereOpen = ctx.settingsOpen();
    const bar = $('#settingsBtn');
    if (!ctx.settingsOpen()) await click(bar);
    await wait(250);
    await say(bar, 'Engines: la configuración', 'Aquí se configura todo: el servidor, tu código de acceso, la traducción y Paraphrase.');
  });

  step(async () => {
    const url = $('[name="transcriptionUrl"]');
    await moveTo(url);
    await say(
      url,
      'Obligatorio · URL del servidor',
      'Ya viene puesta (<code>wss://whisper.life-caption-plus.bid/…</code>). Solo cámbiala si te indican otro servidor.',
    );
  });

  step(async () => {
    const code = $('[name="accessCode"]');
    await moveTo(code);
    await click($('.help-btn[aria-controls="accessHelp"]'));
    await wait(200);
    await say(
      $('#accessHelp'),
      'Obligatorio · Código de acceso',
      'Es personal y sin él la app no transcribe. Pídelo en el grupo de WhatsApp <b>LCP_LIVE_CAPTION_PLUS</b>: escanea este QR o pulsa el enlace. ' +
        'Luego pégalo en <b>Access code</b>.',
    );
    await click($('.help-btn[aria-controls="accessHelp"]'));
  });

  step(async () => {
    const translator = $('[name="translator"]');
    await moveTo(translator);
    await say(
      translator,
      'Opcional · Traducción',
      '<b>Google</b> y <b>MyMemory</b> son gratis y no piden nada. <b>DeepL</b> traduce mejor y necesita una key gratis (su botón <b>?</b> explica cómo). ' +
        '<b>Off</b> deja solo la transcripción.',
    );
  });

  step(async () => {
    const gemini = $('[name="geminiKey"]');
    await moveTo(gemini);
    await say(
      gemini,
      'Opcional · Paraphrase (Gemini)',
      'Con una key gratis de Gemini, el botón <b>Paraphrase</b> condensa los mensajes largos sin perder ideas. El <b>?</b> de al lado explica cómo conseguirla.',
    );
  });

  step(async () => {
    const done = $('.settings-actions button');
    await moveTo(done);
    await say(
      done,
      'Guardar',
      'Cuando termines de pegar tu código y tus keys, pulsa <b>Done</b>. El ojo 👁 de cada campo muestra lo que escribiste. ' +
        '<b>Copiar todo</b> guarda tu código y tus keys como texto, por si los necesitas en otra computadora.',
    );
    if (!ctx.settingsWereOpen) await click($('#settingsBtn'));
  });

  step(async () => {
    const notes = $('#callNotes');
    await moveTo(notes);
    await say(notes, 'Notas de la llamada', 'Apunta nombres, números o fechas mientras hablas. Se guardan solas; a la derecha puedes copiarlas o borrarlas.');
  });

  step(async () => {
    const indicators = $('.call-indicators');
    await moveTo(indicators);
    await say(
      indicators,
      'ON y MIC',
      '<b>ON/OFF</b> pausa la transcripción sin detener la captura (por ejemplo, para hablar en privado). ' +
        '<b>MIC</b> silencia o activa tu micrófono con un clic; en rojo significa que no te escuchan.',
    );
  });

  step(async () => {
    const start = $('#toggleBtn');
    await moveTo(start);
    await say(
      start,
      'Start',
      'Empieza a escuchar el audio de tu computadora (la llamada, un video…). Al lado, el <b>temporizador</b> cuenta el tiempo de espera y se reinicia con cada mensaje.',
    );
  });

  step(async () => {
    ctx.addDemoBlock('en', [
      {
        src: "Hi, this is Dr. Patel's office. I'm calling about your appointment on Thursday.",
        tr: 'Hola, le llamo de la oficina de la Dra. Patel. Llamo por su cita del jueves.',
      },
    ]);
    await wait(500);
    const reply = ctx.addDemoBlock('es', [
      {
        src: 'Sí, claro. ¿Me la puede cambiar para el viernes en la mañana?',
        tr: 'Yes, of course. Can you move it to Friday morning?',
      },
    ]);
    await wait(400);
    await say(
      reply,
      'Así se ve una llamada (demo)',
      'Cada burbuja es un turno, con su bandera e idioma, y la traducción debajo. Al pasar el mouse por una frase se resalta su traducción. ' +
        'El texto se puede seleccionar y copiar.',
    );
  });

  step(async () => {
    const src =
      'Okay, so the doctor wants you to bring all of your medications, um, the metformin and the lisinopril, and also, uh, ' +
      'your insurance card, and please arrive fifteen minutes early so we can update your paperwork.';
    demoLong = ctx.addDemoBlock('en', [
      {
        src,
        tr:
          'Bueno, el doctor quiere que traiga todos sus medicamentos, eh, la metformina y el lisinopril, y también, eh, ' +
          'su tarjeta del seguro, y por favor llegue quince minutos antes para actualizar sus papeles.',
        uncertain: uncertainAt(src, ['lisinopril']),
      },
    ]);
    await wait(400);
    const word = demoLong.querySelector('.uncertain');
    await moveTo(word);
    await say(
      word,
      'Palabras dudosas',
      'Las palabras con <b>subrayado ámbar</b> son las que el reconocimiento de voz no tiene claras. Verifícalas antes de repetirlas.',
    );
  });

  step(async () => {
    const button = demoLong?.querySelector('.paraphrase-btn');
    await click(button, { real: false }); // simulated: the demo never calls Gemini
    const summary = demoLong?.querySelector('.summary');
    if (summary) {
      summary.classList.remove('error');
      summary.textContent =
        'Traiga sus medicamentos (metformina y lisinopril) y su tarjeta del seguro, y llegue 15 minutos antes para actualizar sus papeles.';
      summary.hidden = false;
      button.textContent = 'Paraphrase again';
      summary.scrollIntoView({ block: 'nearest' });
    }
    await wait(300);
    await say(
      summary,
      'Paraphrase',
      'Para mensajes largos: condensa la traducción quitando relleno y repeticiones, pero conserva todas las ideas y datos. Necesita la key de Gemini.',
    );
  });

  step(async () => {
    await click($('.interpreter-tools [data-category="Saludos y cierres"]'));
    await wait(250);
    await say(
      $('#soundbytePopup'),
      'Frases rápidas',
      '<b>Saludos</b>, <b>Intervenciones</b> y <b>Solicitudes</b> abren frases listas para leer o copiar, con tu nombre e ID ya puestos. Puedes agregar las tuyas.',
    );
    await click($('#soundbytePopup [data-close-popover]'));
  });

  step(async () => {
    await click($('#spellingButton'));
    const input = $('#spellingInput');
    await moveTo(input);
    for (const letter of 'SMITH') {
      input.value += letter;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(220);
    }
    await say(
      $('#spellingTiles'),
      'ABC: deletreo',
      'Escribe un nombre o correo y verás cada letra con una palabra fácil («S de Sam, M de Mary…»), en inglés o español. <b>Copiar deletreo</b> lo copia completo.',
    );
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await click($('#spellingPopup [data-close-popover]'));
  });

  step(async () => {
    const toolbar = $('.bottom-toolbar');
    await moveTo(toolbar);
    await say(
      toolbar,
      'Barra inferior',
      'Muestra u oculta la transcripción o la traducción, una frase por línea, el tamaño de letra y el color de fondo. ' +
        '<b>Send</b> transcribe al instante lo que se está diciendo, sin esperar una pausa (también con Ctrl+Shift+Espacio).',
    );
  });

  step(() =>
    say(
      null,
      '¡Listo!',
      'Para empezar: pide tu código en el grupo de WhatsApp <b>LCP_LIVE_CAPTION_PLUS</b>, pégalo en <b>Engines</b>, pulsa <b>Done</b> y luego <b>Start</b>. ' +
        'Puedes repetir este tutorial en <b>View › Tutorial</b>.',
      { last: true },
    ),
  );

  let current = 0;
  for (; current < steps.length; current += 1) await steps[current]();
}

function placeCard(card, rect) {
  const margin = 10;
  const width = Math.min(310, window.innerWidth - margin * 2);
  card.style.width = `${width}px`;
  const height = card.offsetHeight;
  let top;
  if (!rect) {
    top = (window.innerHeight - height) / 2;
  } else if (rect.bottom + margin + height <= window.innerHeight - margin) {
    top = rect.bottom + margin;
  } else if (rect.top - margin - height >= margin) {
    top = rect.top - margin - height;
  } else {
    top = window.innerHeight - height - margin;
  }
  const center = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const left = Math.min(Math.max(center - width / 2, margin), window.innerWidth - width - margin);
  card.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(top, margin))}px)`;
}
