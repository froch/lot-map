// Every word the map shows, in each language it speaks.
// A new language is one more table here and one more value of `language` in plugin.json.
import type { StationId } from '../types'

/** Why the terminal pane shows text and not the picture. */
export type TextReason = 'undrawn' | 'option' | 'inline' | 'small' | 'terminal' | 'bun' | 'images' | 'helper' | 'failed'

/** Where the helper that paints the terminal picture stands. */
export type HelperState = 'idle' | 'starting' | 'running' | 'paused' | 'restarting' | 'stopped' | 'given-up'

/** What `/lot-map stats` reports about the terminal picture. */
export type PictureStats = {
  /** Why the pane last drew text; absent while it draws the picture. */
  text?: { reason: TextReason; cause?: string }
  taken: number
  refused: number
  /** Frames let go with too many blits unanswered. */
  dropped: number
  /** Times the helper was asked again for a frame because the newest was not taken. */
  retries: number
  /** The words of each refusal, with how many times it came. */
  refusals: readonly (readonly [string, number])[]
  helper: HelperState
  restarts: number
  /** Milliseconds a blit took to answer; absent before the first. */
  blitMs?: { average: number; p95: number }
  lastS?: string
  lastE?: string
  /** `rejected`: setups and boards the helper answered 400, a body it would not take. */
  posts: { sent: number; coalesced: number; rejected: number }
}

/** The words of `/lot-map stats` in one language; `statsIn` lays them out the same way in all of them. */
type StatsWords = {
  mode: (shown: string) => string
  picture: string
  text: (why: string) => string
  reasons: Record<TextReason, string>
  frames: (taken: number, refused: number, dropped: number, retries: number) => string
  helper: (state: string, restarts: number) => string
  states: Record<HelperState, string>
  blit: (average: string, p95: string) => string
  noBlits: string
  lastS: (line: string) => string
  lastE: (line: string) => string
  none: string
  posts: (sent: number, coalesced: number) => string
  rejected: (n: number) => string
  decimal: (n: number) => string
}

const statsIn =
  (w: StatsWords) =>
  (s: PictureStats): string =>
    [
      w.mode(s.text === undefined ? w.picture : w.text(`${w.reasons[s.text.reason]}${s.text.cause ? `: ${s.text.cause}` : ''}`)),
      w.frames(s.taken, s.refused, s.dropped, s.retries),
      ...s.refusals.map(([words, n]) => `  ${n} × ${words}`),
      w.helper(w.states[s.helper], s.restarts),
      s.blitMs === undefined ? w.noBlits : w.blit(w.decimal(s.blitMs.average), w.decimal(s.blitMs.p95)),
      w.lastS(s.lastS ?? w.none),
      ...(s.lastE === undefined ? [] : [w.lastE(s.lastE)]),
      w.posts(s.posts.sent, s.posts.coalesced),
      ...(s.posts.rejected === 0 ? [] : [w.rejected(s.posts.rejected)]),
    ].join('\n')

const point = (n: number): string => n.toFixed(1)
const comma = (n: number): string => n.toFixed(1).replace('.', ',')

export type Strings = {
  title: string
  command: string
  opened: string
  cannotOpen: (reason: string) => string
  stations: Record<StationId, string>
  newMessage: string
  answerReady: string
  turnAborted: string
  step: (n: number) => string
  subagent: string
  compacting: string
  addedContext: (when: string) => string
  addedMemory: (when: string) => string
  toMessage: string
  atStart: string
  records: (n: number, shown: string) => string
  stopped: (tool: string) => string
  askedPermission: (tool: string) => string
  checkBefore: (tool: string) => string
  running: string
  nothingYet: string
  noCounts: string
  idle: string
  context: string
  andMore: (n: number) => string
  webSearch: string
  artifact: string
  workflow: string
  skill: string
  loadingTools: string
  questionForYou: string
  fileForYou: string
  ms: (n: number) => string
  seconds: (s: string) => string
  minutes: (m: number, s: number) => string
  /** What `/lot-map stats` answers. */
  stats: (s: PictureStats) => string
  /** The toast when the helper failed three times in a minute and the map shows as text for the session. */
  helperGaveUp: (cause: string) => string
}

const en: Strings = {
  title: 'Work map',
  command: 'Open the work map beside the chat',
  opened: 'Work map opened.',
  cannotOpen: reason => `Nowhere to show the map right now: ${reason}`,
  stations: {
    you: 'You',
    model: 'Model',
    memory: 'Memory',
    files: 'Files',
    shell: 'Shell',
    web: 'Network',
    browser: 'Browser',
    agents: 'Agents',
    skills: 'Skills',
    hooks: 'Hooks',
  },
  newMessage: 'new message',
  answerReady: 'answer ready',
  turnAborted: 'turn interrupted',
  step: n => `step ${n}`,
  subagent: 'subagent',
  compacting: 'compacting context',
  addedContext: when => `added context ${when}`,
  addedMemory: when => `added memory ${when}`,
  toMessage: 'to the message',
  atStart: 'at session start',
  records: (n, shown) => `${n} record${n === 1 ? '' : 's'}: ${shown}`,
  stopped: tool => `stopped ${tool}`,
  askedPermission: tool => `asked permission: ${tool}`,
  checkBefore: tool => `check before ${tool}`,
  running: 'running',
  nothingYet: 'Nothing yet.',
  noCounts: 'No counts yet.',
  idle: 'Nothing is running.',
  context: 'context',
  andMore: n => ` and ${n} more`,
  webSearch: 'web search',
  artifact: 'artifact',
  workflow: 'workflow',
  skill: 'skill',
  loadingTools: 'loading tools',
  questionForYou: 'question for you',
  fileForYou: 'file for you',
  ms: n => `${n} ms`,
  seconds: s => `${s} s`,
  minutes: (m, s) => `${m} min ${s} s`,
  stats: statsIn({
    mode: shown => `mode: ${shown}`,
    picture: 'picture',
    text: why => `text (${why})`,
    reasons: {
      undrawn: 'the pane has not drawn in the terminal yet',
      option: 'the terminal option is set to text',
      inline: 'the pane is not docked',
      small: 'the pane is too small for the ring',
      terminal: 'this terminal is not Ghostty or kitty, or runs inside tmux, zellij, screen or ssh',
      bun: 'bun was not found',
      images: 'the terminal draws no images here',
      helper: 'the helper failed three times within a minute',
      failed: 'drawing the picture failed',
    },
    frames: (taken, refused, dropped, retries) => `frames: ${taken} taken · ${refused} refused · ${dropped} dropped · ${retries} asked again`,
    helper: (state, restarts) => `helper: ${state} · ${restarts} restart${restarts === 1 ? '' : 's'}`,
    states: { idle: 'not started', starting: 'starting', running: 'running', paused: 'paused', restarting: 'restarting', stopped: 'stopped', 'given-up': 'given up' },
    blit: (average, p95) => `blit: ${average} ms on average · ${p95} ms p95`,
    noBlits: 'blit: none yet',
    lastS: line => `helper's last S line: ${line}`,
    lastE: line => `helper's last E line: ${line}`,
    none: 'none',
    posts: (sent, coalesced) => `board posts: ${sent} sent · ${coalesced} coalesced`,
    rejected: n => `posts the helper rejected as malformed: ${n}`,
    decimal: point,
  }),
  helperGaveUp: cause => `The map's picture helper failed three times within a minute (${cause}), so the map shows as text.`,
}

const ru: Strings = {
  title: 'Карта работы',
  command: 'Открыть карту работы рядом с чатом',
  opened: 'Карта работы открыта.',
  cannotOpen: reason => `Карту сейчас негде показать: ${reason}`,
  stations: {
    you: 'Ты',
    model: 'Модель',
    memory: 'Память',
    files: 'Файлы',
    shell: 'Терминал',
    web: 'Сеть',
    browser: 'Браузер',
    agents: 'Агенты',
    skills: 'Скиллы',
    hooks: 'Хуки',
  },
  newMessage: 'новое сообщение',
  answerReady: 'ответ готов',
  turnAborted: 'ход прерван',
  step: n => `шаг ${n}`,
  subagent: 'субагент',
  compacting: 'сжатие контекста',
  addedContext: when => `добавил контекст ${when}`,
  addedMemory: when => `подмешал память ${when}`,
  toMessage: 'к сообщению',
  atStart: 'при старте',
  records: (n, shown) => `записей ${n}: ${shown}`,
  stopped: tool => `остановил ${tool}`,
  askedPermission: tool => `спросил разрешение: ${tool}`,
  checkBefore: tool => `проверка перед ${tool}`,
  running: 'идёт',
  nothingYet: 'Пока ничего не было.',
  noCounts: 'Счётчики пусты.',
  idle: 'Сейчас ничего не выполняется.',
  context: 'контекст',
  andMore: n => ` и ещё ${n}`,
  webSearch: 'поиск в сети',
  artifact: 'артефакт',
  workflow: 'рабочий процесс',
  skill: 'скилл',
  loadingTools: 'загрузка инструментов',
  questionForYou: 'вопрос тебе',
  fileForYou: 'файл тебе',
  ms: n => `${n} мс`,
  seconds: s => `${s} с`,
  minutes: (m, s) => `${m} мин ${s} с`,
  stats: statsIn({
    mode: shown => `режим: ${shown}`,
    picture: 'картинка',
    text: why => `текст (${why})`,
    reasons: {
      undrawn: 'панель ещё не рисовалась в терминале',
      option: 'в настройке terminal выбран текст',
      inline: 'панель не закреплена сбоку',
      small: 'панель мала для кольца',
      terminal: 'это не Ghostty и не kitty, или терминал работает внутри tmux, zellij, screen или ssh',
      bun: 'bun не найден',
      images: 'терминал не рисует здесь картинок',
      helper: 'помощник трижды за минуту дал сбой',
      failed: 'картинку не удалось нарисовать',
    },
    frames: (taken, refused, dropped, retries) => `кадры: принято ${taken} · отклонено ${refused} · пропущено ${dropped} · запрошено снова ${retries}`,
    helper: (state, restarts) => `помощник: ${state} · перезапусков ${restarts}`,
    states: { idle: 'не запущен', starting: 'запускается', running: 'работает', paused: 'на паузе', restarting: 'перезапускается', stopped: 'остановлен', 'given-up': 'больше не запускается' },
    blit: (average, p95) => `вывод кадра: в среднем ${average} мс · p95 ${p95} мс`,
    noBlits: 'вывод кадра: пока ни одного',
    lastS: line => `последняя строка S помощника: ${line}`,
    lastE: line => `последняя строка E помощника: ${line}`,
    none: 'нет',
    posts: (sent, coalesced) => `состояние карты: отправлено ${sent} · объединено ${coalesced}`,
    rejected: n => `отправок, которые помощник отверг как некорректные: ${n}`,
    decimal: point,
  }),
  helperGaveUp: cause => `Помощник, который рисует картинку карты, трижды за минуту дал сбой (${cause}), и карта показывается текстом.`,
}

const es: Strings = {
  title: 'Mapa de trabajo',
  command: 'Abrir el mapa de trabajo junto al chat',
  opened: 'Mapa de trabajo abierto.',
  cannotOpen: reason => `Ahora no hay dónde mostrar el mapa: ${reason}`,
  stations: {
    you: 'Tú',
    model: 'Modelo',
    memory: 'Memoria',
    files: 'Archivos',
    shell: 'Terminal',
    web: 'Red',
    browser: 'Navegador',
    agents: 'Agentes',
    skills: 'Skills',
    hooks: 'Hooks',
  },
  newMessage: 'mensaje nuevo',
  answerReady: 'respuesta lista',
  turnAborted: 'turno interrumpido',
  step: n => `paso ${n}`,
  subagent: 'subagente',
  compacting: 'compactando el contexto',
  addedContext: when => `añadió contexto ${when}`,
  addedMemory: when => `añadió memoria ${when}`,
  toMessage: 'al mensaje',
  atStart: 'al iniciar la sesión',
  records: (n, shown) => `${n} registro${n === 1 ? '' : 's'}: ${shown}`,
  stopped: tool => `detuvo ${tool}`,
  askedPermission: tool => `pidió permiso: ${tool}`,
  checkBefore: tool => `comprobación antes de ${tool}`,
  running: 'en curso',
  nothingYet: 'Todavía nada.',
  noCounts: 'Aún no hay recuentos.',
  idle: 'No hay nada en ejecución.',
  context: 'contexto',
  andMore: n => ` y ${n} más`,
  webSearch: 'búsqueda web',
  artifact: 'artefacto',
  workflow: 'flujo de trabajo',
  skill: 'skill',
  loadingTools: 'cargando herramientas',
  questionForYou: 'pregunta para ti',
  fileForYou: 'archivo para ti',
  ms: n => `${n} ms`,
  seconds: s => `${s} s`,
  minutes: (m, s) => `${m} min ${s} s`,
  stats: statsIn({
    mode: shown => `modo: ${shown}`,
    picture: 'imagen',
    text: why => `texto (${why})`,
    reasons: {
      undrawn: 'el panel aún no se ha dibujado en el terminal',
      option: 'la opción terminal está en texto',
      inline: 'el panel no está acoplado',
      small: 'el panel es demasiado pequeño para el anillo',
      terminal: 'este terminal no es Ghostty ni kitty, o funciona dentro de tmux, zellij, screen o ssh',
      bun: 'no se encontró bun',
      images: 'el terminal no dibuja imágenes aquí',
      helper: 'el ayudante falló tres veces en un minuto',
      failed: 'no se pudo dibujar la imagen',
    },
    frames: (taken, refused, dropped, retries) => `fotogramas: ${taken} aceptados · ${refused} rechazados · ${dropped} descartados · ${retries} pedidos de nuevo`,
    helper: (state, restarts) => `ayudante: ${state} · ${restarts} reinicio${restarts === 1 ? '' : 's'}`,
    states: { idle: 'sin iniciar', starting: 'iniciándose', running: 'en marcha', paused: 'en pausa', restarting: 'reiniciándose', stopped: 'detenido', 'given-up': 'abandonado' },
    blit: (average, p95) => `envío de fotograma: ${average} ms de media · p95 ${p95} ms`,
    noBlits: 'envío de fotograma: ninguno aún',
    lastS: line => `última línea S del ayudante: ${line}`,
    lastE: line => `última línea E del ayudante: ${line}`,
    none: 'ninguna',
    posts: (sent, coalesced) => `estados del mapa: ${sent} enviados · ${coalesced} fusionados`,
    rejected: n => `envíos que el ayudante rechazó por mal formados: ${n}`,
    decimal: point,
  }),
  helperGaveUp: cause => `El ayudante que dibuja la imagen del mapa falló tres veces en un minuto (${cause}); el mapa se muestra como texto.`,
}

const fr: Strings = {
  title: 'Carte du travail',
  command: 'Ouvrir la carte du travail à côté du chat',
  opened: 'Carte du travail ouverte.',
  cannotOpen: reason => `Impossible d'afficher la carte pour le moment : ${reason}`,
  stations: {
    you: 'Vous',
    model: 'Modèle',
    memory: 'Mémoire',
    files: 'Fichiers',
    shell: 'Terminal',
    web: 'Réseau',
    browser: 'Navigateur',
    agents: 'Agents',
    skills: 'Skills',
    hooks: 'Hooks',
  },
  newMessage: 'nouveau message',
  answerReady: 'réponse prête',
  turnAborted: 'tour interrompu',
  step: n => `étape ${n}`,
  subagent: 'sous-agent',
  compacting: 'compactage du contexte',
  addedContext: when => `contexte ajouté ${when}`,
  addedMemory: when => `mémoire ajoutée ${when}`,
  toMessage: 'au message',
  atStart: 'au démarrage de la session',
  records: (n, shown) => `${n} enregistrement${n > 1 ? 's' : ''} : ${shown}`,
  stopped: tool => `${tool} arrêté`,
  askedPermission: tool => `autorisation demandée : ${tool}`,
  checkBefore: tool => `vérification avant ${tool}`,
  running: 'en cours',
  nothingYet: 'Rien pour le moment.',
  noCounts: 'Aucun compteur pour le moment.',
  idle: 'Rien en cours.',
  context: 'contexte',
  andMore: n => ` et ${n} de plus`,
  webSearch: 'recherche web',
  artifact: 'artefact',
  workflow: 'workflow',
  skill: 'skill',
  loadingTools: 'chargement des outils',
  questionForYou: 'question pour vous',
  fileForYou: 'fichier pour vous',
  ms: n => `${n} ms`,
  seconds: s => `${s.replace('.', ',')} s`,
  minutes: (m, s) => `${m} min ${s} s`,
  stats: statsIn({
    mode: shown => `mode : ${shown}`,
    picture: 'image',
    text: why => `texte (${why})`,
    reasons: {
      undrawn: "le panneau ne s'est pas encore affiché dans le terminal",
      option: "l'option terminal est réglée sur texte",
      inline: "le panneau n'est pas ancré",
      small: "le panneau est trop petit pour l'anneau",
      terminal: "ce terminal n'est ni Ghostty ni kitty, ou il tourne dans tmux, zellij, screen ou ssh",
      bun: 'bun est introuvable',
      images: "le terminal n'affiche pas d'images ici",
      helper: "l'auxiliaire a échoué trois fois en une minute",
      failed: "l'image n'a pas pu être dessinée",
    },
    frames: (taken, refused, dropped, retries) =>
      `images : ${taken} acceptée${taken > 1 ? 's' : ''} · ${refused} refusée${refused > 1 ? 's' : ''} · ${dropped} abandonnée${dropped > 1 ? 's' : ''} · ${retries} redemandée${retries > 1 ? 's' : ''}`,
    helper: (state, restarts) => `auxiliaire : ${state} · ${restarts} redémarrage${restarts > 1 ? 's' : ''}`,
    states: { idle: 'pas démarré', starting: 'en démarrage', running: 'en marche', paused: 'en pause', restarting: 'en redémarrage', stopped: 'arrêté', 'given-up': 'abandonné' },
    blit: (average, p95) => `envoi d'image : ${average} ms en moyenne · p95 ${p95} ms`,
    noBlits: "envoi d'image : aucun pour le moment",
    lastS: line => `dernière ligne S de l'auxiliaire : ${line}`,
    lastE: line => `dernière ligne E de l'auxiliaire : ${line}`,
    none: 'aucune',
    posts: (sent, coalesced) => `états de la carte : ${sent} envoyé${sent > 1 ? 's' : ''} · ${coalesced} fusionné${coalesced > 1 ? 's' : ''}`,
    rejected: n => `envois refusés par l'auxiliaire comme mal formés : ${n}`,
    decimal: comma,
  }),
  helperGaveUp: cause => `L'auxiliaire qui dessine l'image de la carte a échoué trois fois en une minute (${cause}) ; la carte s'affiche en texte.`,
}

const de: Strings = {
  title: 'Arbeitskarte',
  command: 'Arbeitskarte neben dem Chat öffnen',
  opened: 'Arbeitskarte geöffnet.',
  cannotOpen: reason => `Die Karte kann gerade nirgends angezeigt werden: ${reason}`,
  stations: {
    you: 'Du',
    model: 'Modell',
    memory: 'Gedächtnis',
    files: 'Dateien',
    shell: 'Terminal',
    web: 'Netzwerk',
    browser: 'Browser',
    agents: 'Agenten',
    skills: 'Skills',
    hooks: 'Hooks',
  },
  newMessage: 'neue Nachricht',
  answerReady: 'Antwort fertig',
  turnAborted: 'Durchgang abgebrochen',
  step: n => `Schritt ${n}`,
  subagent: 'Subagent',
  compacting: 'Kontext wird komprimiert',
  addedContext: when => `Kontext ${when} hinzugefügt`,
  addedMemory: when => `Erinnerungen ${when} hinzugefügt`,
  toMessage: 'zur Nachricht',
  atStart: 'beim Sitzungsstart',
  records: (n, shown) => `${n} ${n === 1 ? 'Eintrag' : 'Einträge'}: ${shown}`,
  stopped: tool => `${tool} gestoppt`,
  askedPermission: tool => `um Erlaubnis gefragt: ${tool}`,
  checkBefore: tool => `Prüfung vor ${tool}`,
  running: 'läuft',
  nothingYet: 'Noch nichts.',
  noCounts: 'Noch keine Zählerstände.',
  idle: 'Nichts läuft.',
  context: 'Kontext',
  andMore: n => ` und ${n} weitere`,
  webSearch: 'Websuche',
  artifact: 'Artefakt',
  workflow: 'Workflow',
  skill: 'Skill',
  loadingTools: 'Werkzeuge werden geladen',
  questionForYou: 'Frage an dich',
  fileForYou: 'Datei für dich',
  ms: n => `${n} ms`,
  seconds: s => `${s.replace('.', ',')} s`,
  minutes: (m, s) => `${m} Min. ${s} s`,
  stats: statsIn({
    mode: shown => `Modus: ${shown}`,
    picture: 'Bild',
    text: why => `Text (${why})`,
    reasons: {
      undrawn: 'das Panel wurde im Terminal noch nicht gezeichnet',
      option: 'die Option terminal steht auf Text',
      inline: 'das Panel ist nicht angedockt',
      small: 'das Panel ist zu klein für den Ring',
      terminal: 'dieses Terminal ist weder Ghostty noch kitty oder läuft in tmux, zellij, screen oder ssh',
      bun: 'bun wurde nicht gefunden',
      images: 'das Terminal zeigt hier keine Bilder',
      helper: 'der Helfer ist dreimal in einer Minute ausgefallen',
      failed: 'das Bild ließ sich nicht zeichnen',
    },
    frames: (taken, refused, dropped, retries) => `Bilder: ${taken} angenommen · ${refused} abgelehnt · ${dropped} verworfen · ${retries} neu angefordert`,
    helper: (state, restarts) => `Helfer: ${state} · ${restarts} Neustart${restarts === 1 ? '' : 's'}`,
    states: { idle: 'nicht gestartet', starting: 'startet', running: 'läuft', paused: 'pausiert', restarting: 'startet neu', stopped: 'gestoppt', 'given-up': 'aufgegeben' },
    blit: (average, p95) => `Bildübergabe: ${average} ms im Mittel · p95 ${p95} ms`,
    noBlits: 'Bildübergabe: noch keine',
    lastS: line => `letzte S-Zeile des Helfers: ${line}`,
    lastE: line => `letzte E-Zeile des Helfers: ${line}`,
    none: 'keine',
    posts: (sent, coalesced) => `Kartenstände: ${sent} gesendet · ${coalesced} zusammengefasst`,
    rejected: n => `vom Helfer als fehlerhaft abgelehnte Sendungen: ${n}`,
    decimal: comma,
  }),
  helperGaveUp: cause => `Der Bildhelfer der Karte ist dreimal in einer Minute ausgefallen (${cause}); die Karte wird als Text gezeigt.`,
}

const TABLES = new Map<unknown, Strings>([['en', en], ['ru', ru], ['es', es], ['fr', fr], ['de', de]])

export const stringsFor = (language: unknown): Strings => TABLES.get(language) ?? en
