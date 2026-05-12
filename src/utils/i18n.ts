export type Lang = "en" | "es";

const strings = {
  en: {
    // shared
    wpm: "wpm",
    cancel: "Cancel",
    words: "words",
    page: "page",
    pages: "pages",
    plainText: "Plain text",

    // time left
    minLeft: "~{m}m left",
    hrLeft: "~{h}h left",
    hrMinLeft: "~{h}h {m}m left",

    // HomeScreen
    readingSpeed: "Reading speed",
    upload: "Upload",
    fromUrl: "URL",
    browse: "Browse",
    formatsNote: "PDF · EPUB · HTML · Markdown · Plain text",
    chooseFile: "Choose file",
    chooseAnother: "Choose another",
    readingFile: "Reading\u2026",
    parsing: "Parsing\u2026",
    load: "Load",
    fetching: "Fetching\u2026",
    pageOf: "page {current} of {total}\u2026",
    pageNum: "page {current}\u2026",
    savedProgress: "Saved progress: page {page}",
    clear: "Clear",
    startFromPage: "Start from page",
    startReading: "Start reading",
    searchPlaceholder: "Search by title or author\u2026",
    search: "Search",
    searchingGutenberg: "Searching Project Gutenberg \u2014 this may take a moment\u2026",
    downloads: "downloads",
    unavailable: "unavailable",
    invalidPage: "Invalid page",
    invalidPageMsg: "Enter a number between 1 and {max}.",
    txtOnlyMsg:
      '"{title}" is only available as plain text \u2014 EPUB and PDF are not offered for this book.\n\nOpen the plain text file in a new tab?',
    featureDocumentation: "Feature documentation",
    continueReading: "Continue reading",

    // ReaderScreen
    tapToResume: "tap to resume",
    lookUpWord: "look up word",
    flowOn: "flow on",
    flowOff: "flow off",
    keepAwakeOn: "Awake",
    keepAwakeOff: "Stay awake",
    back: "\u2190 back",
    backBtn: "\u2190 Back",
    jumpToPage: "Jump to page",
    jump: "Jump",
    finished: "Finished",
    dictionaryCom: "dictionary.com",
    finishedSub: "{count} words \u00b7 {wpm} wpm",
    tapToPause: "tap to pause",
  },
  es: {
    // shared
    wpm: "ppm",
    cancel: "Cancelar",
    words: "palabras",
    page: "p\u00e1gina",
    pages: "p\u00e1ginas",
    plainText: "Texto plano",

    // time left
    minLeft: "~{m}min restante",
    hrLeft: "~{h}h restante",
    hrMinLeft: "~{h}h {m}min restante",

    // HomeScreen
    readingSpeed: "Velocidad de lectura",
    upload: "Subir",
    fromUrl: "URL",
    browse: "Buscar",
    formatsNote:
      "PDF \u00b7 EPUB \u00b7 HTML \u00b7 Markdown \u00b7 Texto plano",
    chooseFile: "Elegir archivo",
    chooseAnother: "Elegir otro",
    readingFile: "Leyendo\u2026",
    parsing: "Procesando\u2026",
    load: "Cargar",
    fetching: "Descargando\u2026",
    pageOf: "p\u00e1gina {current} de {total}\u2026",
    pageNum: "p\u00e1gina {current}\u2026",
    savedProgress: "Progreso guardado: p\u00e1gina {page}",
    clear: "Borrar",
    startFromPage: "Empezar en p\u00e1gina",
    startReading: "Comenzar lectura",
    searchPlaceholder: "Buscar por t\u00edtulo o autor\u2026",
    search: "Buscar",
    searchingGutenberg: "Buscando en Project Gutenberg \u2014 esto puede tardar un momento\u2026",
    downloads: "descargas",
    unavailable: "no disponible",
    invalidPage: "P\u00e1gina inv\u00e1lida",
    invalidPageMsg: "Ingresa un n\u00famero entre 1 y {max}.",
    txtOnlyMsg:
      '"{title}" solo est\u00e1 disponible en texto plano \u2014 EPUB y PDF no est\u00e1n disponibles.\n\n\u00bfAbrir el archivo de texto en una nueva pesta\u00f1a?',
    featureDocumentation: "Documentaci\u00f3n de la funci\u00f3n",
    continueReading: "Continuar leyendo",

    // ReaderScreen
    tapToResume: "toca para continuar",
    lookUpWord: "buscar palabra",
    flowOn: "flujo activado",
    flowOff: "flujo desactivado",
    keepAwakeOn: "Activa",
    keepAwakeOff: "No apagar",
    back: "\u2190 atr\u00e1s",
    backBtn: "\u2190 Volver",
    jumpToPage: "Ir a p\u00e1gina",
    jump: "Ir",
    finished: "Terminado",
    dictionaryCom: "dictionary.com",
    finishedSub: "{count} palabras \u00b7 {wpm} ppm",
    tapToPause: "toca para pausar",
  },
} as const;

export type TKey = keyof typeof strings.en;

export function t(
  lang: Lang,
  key: TKey,
  vars?: Record<string, string | number>,
): string {
  let str = strings[lang][key] as string;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

export function formatTimeLeft(
  lang: Lang,
  remainingWords: number,
  wpmValue: number,
): string {
  const mins = Math.ceil(remainingWords / wpmValue);
  if (mins < 60) return t(lang, "minLeft", { m: mins });
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? t(lang, "hrLeft", { h }) : t(lang, "hrMinLeft", { h, m });
}
