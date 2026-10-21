const DEFAULT_SOUNDBYTES = [
  {
    id: 'provider-greeting',
    title: 'Saludo al proveedor',
    category: 'Saludos y cierres',
    language: 'EN',
    text:
      'Hello. My name is [Name], interpreter ID [ID], and I will be your Spanish interpreter. Please speak in clear, short sentences so that I can interpret everything. How may I assist you?',
  },
  {
    id: 'spanish-greeting',
    title: 'Saludo a la persona hispanohablante',
    category: 'Saludos y cierres',
    language: 'ES',
    text:
      'Hola, yo seré su intérprete de inglés. Todo lo que diga será confidencial. Por favor hable en oraciones claras y cortas para poder interpretar todo.',
  },
  {
    id: 'repetition',
    title: 'Solicitar repetición',
    category: 'Intervenciones y espera',
    language: 'EN',
    text: 'Excuse the interpreter, may I ask the patient for a repetition?',
  },
  {
    id: 'clarification',
    title: 'Solicitar aclaración',
    category: 'Intervenciones y espera',
    language: 'EN',
    text: 'Excuse the interpreter, may I clarify a term with the patient?',
  },
  {
    id: 'pause-flow',
    title: 'Pedir una pausa',
    category: 'Intervenciones y espera',
    language: 'EN',
    text: 'Excuse the interpreter, please allow the interpreter to catch up.',
  },
  {
    id: 'spanish-switch',
    title: 'Cambio al español (con permiso)',
    category: 'Intervenciones y espera',
    language: 'ES',
    text: 'Este es el intérprete, ¿me podría repetir/aclarar lo último, por favor?',
  },
  {
    id: 'hold-start',
    title: 'Aviso al iniciar la espera',
    category: 'Intervenciones y espera',
    language: 'EN',
    text:
      'Excuse the interpreter, I would like to remind you that I can be on hold for 15 minutes at a time. If you need more time, please check back in to reset the timer.',
  },
  {
    id: 'hold-checkin-en',
    title: 'Aviso de espera (7 min)',
    category: 'Intervenciones y espera',
    language: 'EN',
    text: "Excuse the interpreter, just advising I'm still on hold.",
  },
  {
    id: 'hold-checkin-es',
    title: 'Aviso de espera (7 min)',
    category: 'Intervenciones y espera',
    language: 'ES',
    text: 'Este es el intérprete, solo notificando que sigo en la línea.',
  },
  {
    id: 'other-language',
    title: 'Solicitud de otro idioma',
    category: 'Solicitudes y cierres',
    language: 'EN',
    text:
      'I am a Spanish interpreter. To request an interpreter for another language, you will need to dial back into the main line. Is there anything else in Spanish I can help you with?',
  },
  {
    id: 'out-of-scope',
    title: 'Tarea fuera del alcance',
    category: 'Solicitudes y cierres',
    language: 'EN',
    text:
      'As the interpreter, my role is limited to interpreting the conversation. I am not able to [review documents / give advice].',
  },
  {
    id: 'standard-closing',
    title: 'Cierre estándar',
    category: 'Solicitudes y cierres',
    language: 'EN',
    text:
      'Is there anything else I can assist you with today?... Thank you for using Propio Language Services. This was [Name], ID [ID]. Have a great day!',
  },
];

const STORAGE_KEY = 'interpreter-toolkit-v1';
const DEFAULT_SOUNDBYTE_COLOR = '#252832';
// Muted tones that stay readable on the dark theme; card text contrast is computed per color anyway.
const SOUNDBYTE_PALETTE = [
  '#2d3a5c', '#3b2f5c', '#24494b', '#4d3826', '#4d2a3d',
  '#2f4a30', '#45421f', '#264160', '#553044', '#2b5046',
];
const randomSoundbyteColor = () => SOUNDBYTE_PALETTE[Math.floor(Math.random() * SOUNDBYTE_PALETTE.length)];
const withRandomColors = (soundbytes) =>
  soundbytes.map((item) => ({ ...item, backgroundColor: item.backgroundColor || randomSoundbyteColor() }));
const DEFAULT_CATEGORY = 'Saludos y cierres';
const CATEGORY_LABELS = {
  'Saludos y cierres': 'Saludos',
  'Intervenciones y espera': 'Intervenciones',
  'Solicitudes y cierres': 'Solicitudes',
};
const LEGACY_REMOVED_IDS = new Set(['dialout-transfer', 'another-dialout']);
const LEGACY_DEFAULT_TEXTS = new Map([
  [
    'provider-greeting',
    'Good morning/afternoon. My name is [Name], interpreter ID [ID], and I will be your Spanish interpreter. Please speak in clear, short sentences so that I can interpret everything. How may I assist you?',
  ],
]);
const $ = (id) => document.getElementById(id);
const isHexColor = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

const elements = {
  categoryButtons: [...document.querySelectorAll('.interpreter-tools [data-category]')],
  soundbytePopup: $('soundbytePopup'),
  soundbyteHeading: $('soundbyteHeading'),
  soundbyteSearch: $('soundbyteSearch'),
  soundbyteList: $('soundbyteList'),
  soundbyteEmpty: $('soundbyteEmpty'),
  name: $('interpreterName'),
  interpreterId: $('interpreterId'),
  notes: $('callNotes'),
  notesSaveStatus: $('notesSaveStatus'),
  toast: $('toolToast'),
  dialog: $('soundbyteDialog'),
  form: $('soundbyteForm'),
  dialogTitle: $('soundbyteDialogTitle'),
  title: $('soundbyteTitle'),
  category: $('soundbyteCategory'),
  language: $('soundbyteLanguage'),
  text: $('soundbyteText'),
  backgroundColor: $('soundbyteBackgroundColor'),
};

let state = loadState();
persistState(); // Saves any colors just assigned so they stay the same across launches.
let activeCategory = DEFAULT_CATEGORY;
let editingSoundbyteId = null;
let toastTimeout;

function loadState() {
  const fallback = {
    name: '',
    interpreterId: '',
    notes: '',
    soundbytes: withRandomColors(structuredClone(DEFAULT_SOUNDBYTES)),
  };

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return fallback;
    const parsed = JSON.parse(saved);
    const savedSoundbytes = Array.isArray(parsed.soundbytes)
      ? parsed.soundbytes
          .filter(
            (item) =>
              item &&
              typeof item.id === 'string' &&
              typeof item.title === 'string' &&
              typeof item.category === 'string' &&
              typeof item.language === 'string' &&
              typeof item.text === 'string' &&
              !LEGACY_REMOVED_IDS.has(item.id) &&
              !/dial.?out|tercero en la línea/i.test(item.title),
          )
          .map((item) => {
            const updatedDefault = DEFAULT_SOUNDBYTES.find((soundbyte) => soundbyte.id === item.id);
            const isUnmodifiedOldDefault = LEGACY_DEFAULT_TEXTS.get(item.id) === item.text;
            return {
              ...item,
              category: item.category === 'Saludos y dial-out' ? DEFAULT_CATEGORY : item.category,
              text: isUnmodifiedOldDefault && updatedDefault ? updatedDefault.text : item.text,
              // The old color-input default counts as "never chosen", so those cards get a random color too.
              backgroundColor:
                isHexColor(item.backgroundColor) && item.backgroundColor !== DEFAULT_SOUNDBYTE_COLOR
                  ? item.backgroundColor
                  : randomSoundbyteColor(),
            };
          })
          .filter((item) => Object.hasOwn(CATEGORY_LABELS, item.category))
      : fallback.soundbytes;

    return {
      ...fallback,
      name: typeof parsed.name === 'string' ? parsed.name : fallback.name,
      interpreterId: typeof parsed.interpreterId === 'string' ? parsed.interpreterId : fallback.interpreterId,
      notes: typeof parsed.notes === 'string' ? parsed.notes : fallback.notes,
      soundbytes: savedSoundbytes,
    };
  } catch (error) {
    console.error('No se pudieron cargar las notas y soundbytes guardados:', error);
    return fallback;
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    elements.notesSaveStatus.textContent = 'Guardado automáticamente';
  } catch (error) {
    elements.notesSaveStatus.textContent = 'No se pudieron guardar los cambios';
    console.error('No se pudieron guardar las notas y soundbytes:', error);
  }
}

function personalizedText(text) {
  return text
    .replaceAll('[Name]', state.name.trim() || '[Name]')
    .replaceAll('[ID]', state.interpreterId.trim() || '[ID]');
}

function renderSoundbytes() {
  const query = elements.soundbyteSearch.value.trim().toLocaleLowerCase();
  const categorySoundbytes = state.soundbytes.filter((item) => item.category === activeCategory);
  const soundbytes = categorySoundbytes.filter((item) => {
    const matchesSearch = [item.title, item.language, personalizedText(item.text)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query);
    return matchesSearch;
  });

  elements.soundbyteHeading.textContent = CATEGORY_LABELS[activeCategory];
  elements.soundbyteList.replaceChildren();
  elements.soundbyteEmpty.hidden = soundbytes.length > 0;

  for (const item of soundbytes) {
    const card = document.createElement('article');
    card.className = 'soundbyte-card';
    if (isHexColor(item.backgroundColor)) {
      const color = item.backgroundColor;
      const [r, g, b] = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
      const luminance =
        0.2126 * (r <= 0.03928 ? r / 12.92 : ((r + 0.055) / 1.055) ** 2.4) +
        0.7152 * (g <= 0.03928 ? g / 12.92 : ((g + 0.055) / 1.055) ** 2.4) +
        0.0722 * (b <= 0.03928 ? b / 12.92 : ((b + 0.055) / 1.055) ** 2.4);
      const lightBackground = luminance > 0.179;
      card.style.setProperty('--soundbyte-background', color);
      card.style.setProperty('--soundbyte-text', lightBackground ? '#16181d' : '#ffffff');
      card.style.setProperty(
        '--soundbyte-muted',
        lightBackground ? 'rgba(0, 0, 0, 0.62)' : 'rgba(255, 255, 255, 0.72)',
      );
    }
    const heading = document.createElement('h3');
    heading.textContent = item.title;
    const meta = document.createElement('span');
    meta.className = 'soundbyte-meta';
    meta.textContent = languageLabel(item.language);
    heading.append(meta);

    const text = document.createElement('p');
    text.textContent = personalizedText(item.text);
    const actions = document.createElement('div');
    actions.className = 'soundbyte-actions';
    const categoryIndex = categorySoundbytes.findIndex((soundbyte) => soundbyte.id === item.id);
    actions.append(      
      makeAction('Copiar', () => copyText(personalizedText(item.text), 'Frase copiada')),
      makeAction('Editar', () => openEditor(item)),
      makeAction('Eliminar', () => deleteSoundbyte(item.id)),
      makeMoveAction('↑', `Mover ${item.title} hacia arriba`, () => moveSoundbyte(item.id, -1), categoryIndex === 0),
      makeMoveAction(
        '↓',
        `Mover ${item.title} hacia abajo`,
        () => moveSoundbyte(item.id, 1),
        categoryIndex === categorySoundbytes.length - 1,
      ),
    );
    card.dataset.id = item.id;
    card.append(heading, text, actions);
    elements.soundbyteList.append(card);
  }
}

function makeAction(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function makeMoveAction(label, accessibleLabel, action, disabled) {
  const button = makeAction(label, action);
  button.title = accessibleLabel;
  button.setAttribute('aria-label', accessibleLabel);
  button.disabled = disabled;
  return button;
}

function moveSoundbyte(id, offset) {
  const index = state.soundbytes.findIndex((item) => item.id === id);
  if (index < 0) return;
  const categoryItems = state.soundbytes
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => item.category === state.soundbytes[index].category);
  const position = categoryItems.findIndex(({ item }) => item.id === id);
  const neighbor = categoryItems[position + offset];
  if (!neighbor) return;

  [state.soundbytes[index], state.soundbytes[neighbor.itemIndex]] = [
    state.soundbytes[neighbor.itemIndex],
    state.soundbytes[index],
  ];
  persistState();
  renderSoundbytes();

  // Keep focus on the moved card's arrow so repeated clicks or Enter presses keep moving it.
  const card = [...elements.soundbyteList.children].find((el) => el.dataset.id === String(id));
  if (!card) return;
  const [up, down] = card.querySelectorAll('.soundbyte-actions button[aria-label^="Mover"]');
  const preferred = offset < 0 ? up : down;
  (preferred.disabled ? (offset < 0 ? down : up) : preferred).focus();
  card.scrollIntoView({ block: 'nearest' });
}

function languageLabel(language) {
  return { EN: 'EN', ES: 'ES', BILINGUAL: 'Bilingüe' }[language] ?? language;
}

function showPopover(popover) {
  elements.soundbytePopup.hidden = popover !== elements.soundbytePopup;
}

function openEditor(item = null) {
  editingSoundbyteId = item?.id ?? null;
  elements.dialogTitle.textContent = item ? 'Editar frase' : 'Agregar frase';
  elements.title.value = item?.title ?? '';
  elements.category.value = item?.category ?? activeCategory;
  elements.language.value = item?.language ?? 'EN';
  elements.text.value = item?.text ?? '';
  elements.backgroundColor.value = isHexColor(item?.backgroundColor)
    ? item.backgroundColor
    : randomSoundbyteColor();
  elements.dialog.showModal();
  elements.title.focus();
}

function saveSoundbyte(event) {
  event.preventDefault();
  const soundbyte = {
    id: editingSoundbyteId ?? crypto.randomUUID(),
    title: elements.title.value.trim(),
    category: elements.category.value,
    language: elements.language.value,
    text: elements.text.value.trim(),
    backgroundColor: elements.backgroundColor.value,
  };
  if (!soundbyte.title || !soundbyte.text) return;

  if (editingSoundbyteId) {
    state.soundbytes = state.soundbytes.map((item) => (item.id === editingSoundbyteId ? soundbyte : item));
  } else {
    state.soundbytes.unshift(soundbyte);
  }
  activeCategory = soundbyte.category;
  persistState();
  renderSoundbytes();
  elements.dialog.close();
  showToast(editingSoundbyteId ? 'Frase actualizada' : 'Frase agregada');
  editingSoundbyteId = null;
}

function deleteSoundbyte(id) {
  const item = state.soundbytes.find((soundbyte) => soundbyte.id === id);
  if (!item || !window.confirm(`¿Eliminar «${item.title}» de tus frases?`)) return;
  state.soundbytes = state.soundbytes.filter((soundbyte) => soundbyte.id !== id);
  persistState();
  renderSoundbytes();
  showToast('Frase eliminada');
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch (clipboardError) {
    const temporary = document.createElement('textarea');
    temporary.value = text;
    temporary.setAttribute('readonly', '');
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (copied) {
      showToast(successMessage);
    } else {
      console.error('No se pudo copiar al portapapeles:', clipboardError);
      showToast('No se pudo copiar; selecciona y copia el texto manualmente.');
    }
  }
}

function updateNotes() {
  state.notes = elements.notes.value;
  persistState();
}

export function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => elements.toast.classList.remove('visible'), 2200);
}

for (const button of elements.categoryButtons) {
  button.addEventListener('click', () => {
    const isOpen = !elements.soundbytePopup.hidden;
    const sameCategory = activeCategory === button.dataset.category;
    activeCategory = button.dataset.category;
    elements.soundbyteSearch.value = '';
    renderSoundbytes();
    showPopover(isOpen && sameCategory ? null : elements.soundbytePopup);
  });
}

for (const button of document.querySelectorAll('[data-close-popover]')) {
  button.addEventListener('click', () => showPopover(null));
}

document.addEventListener('click', (event) => {
  // composedPath() is captured at dispatch, so it still holds the popover even when the
  // click re-rendered the list and detached the target (e.g. reordering a soundbyte).
  const path = event.composedPath();
  const inside = (selector) => path.some((node) => node instanceof Element && node.matches(selector));
  if (elements.dialog.open || inside('.tool-popover') || inside('.interpreter-tools')) {
    return;
  }
  showPopover(null);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.dialog.open) showPopover(null);
});

elements.soundbyteSearch.addEventListener('input', renderSoundbytes);
elements.name.addEventListener('input', () => {
  state.name = elements.name.value;
  persistState();
  renderSoundbytes();
});
elements.interpreterId.addEventListener('input', () => {
  state.interpreterId = elements.interpreterId.value;
  persistState();
  renderSoundbytes();
});
elements.notes.addEventListener('input', updateNotes);
$('copyNotes').addEventListener('click', () => copyText(elements.notes.value, 'Notas copiadas'));
$('clearNotes').addEventListener('click', () => {
  if (!elements.notes.value || window.confirm('¿Limpiar todas las notas de esta llamada?')) {
    elements.notes.value = '';
    updateNotes();
    showToast('Notas limpiadas');
  }
});
$('addSoundbyte').addEventListener('click', () => openEditor());
$('restoreSoundbytes')?.addEventListener('click', () => {
  if (!window.confirm('¿Restaurar las frases iniciales? Se reemplazará la biblioteca actual.')) return;
  state.soundbytes = withRandomColors(structuredClone(DEFAULT_SOUNDBYTES));
  activeCategory = DEFAULT_CATEGORY;
  persistState();
  renderSoundbytes();
  showToast('Frases iniciales restauradas');
});
$('closeSoundbyteDialog').addEventListener('click', () => elements.dialog.close());
$('cancelSoundbyte').addEventListener('click', () => elements.dialog.close());
elements.form.addEventListener('submit', saveSoundbyte);
elements.dialog.addEventListener('close', () => {
  editingSoundbyteId = null;
});

elements.name.value = state.name;
elements.interpreterId.value = state.interpreterId;
elements.notes.value = state.notes;
renderSoundbytes();
