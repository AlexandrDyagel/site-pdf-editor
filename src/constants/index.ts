import type {
  AppSettings,
  ExportSettings,
  LibraryItemType,
  ToolGroupId,
  ToolType,
} from '@/types';

/** Название приложения. */
export const APP_NAME = 'PDF Редактор';
/** Версия приложения. */
export const APP_VERSION = '1.0.0';
/** Версия схемы данных проекта (для миграций). */
export const PROJECT_SCHEMA_VERSION = 3;
/** Версия схемы библиотеки. */
export const LIBRARY_SCHEMA_VERSION = 2;

/** PDF points в дюйме. */
export const PT_PER_INCH = 72;
/** CSS-пикселей в дюйме (стандарт). */
export const CSS_PX_PER_INCH = 96;

/** Ограничения зума. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.2;
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Масштабы растрового экспорта. */
export const SCALE_PRESETS = [1, 1.5, 2, 3, 4];
/** Пресеты DPI. */
export const DPI_PRESETS = [72, 96, 120, 150, 200, 300, 600];

/** Ограничение истории. */
export const HISTORY_LIMIT = 120;

/** Ключи localStorage. */
export const STORAGE_KEYS = {
  settings: 'pdf-editor:settings:v3',
  ui: 'pdf-editor:ui:v3',
  fonts: 'pdf-editor:fonts:v1',
  recent: 'pdf-editor:recent:v1',
} as const;

/** Параметры IndexedDB. */
export const IDB = {
  name: 'pdf-editor-db',
  version: 2,
  stores: {
    library: 'library',
    projects: 'projects',
    assets: 'assets',
    meta: 'meta',
  },
} as const;

/** Путь к манифесту встроенных шрифтов. */
export const FONT_MANIFEST_PATH = 'fonts/fonts.json';

/** Идентификатор шрифта по умолчанию. */
export const DEFAULT_FONT_ID = 'pt-sans';

/** Палитра цветов для быстрого выбора. */
export const COLOR_PALETTE = [
  '#000000',
  '#1f2937',
  '#4b5563',
  '#9ca3af',
  '#ffffff',
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#16a34a',
  '#0d9488',
  '#2563eb',
  '#1d4ed8',
  '#7c3aed',
  '#c026d3',
  '#db2777',
  '#78350f',
];

/** Цвета для штампов и печатей. */
export const STAMP_COLORS = ['#1d4ed8', '#b91c1c', '#15803d', '#111827', '#7c3aed', '#0f766e'];

/**
 * Варианты штриховой линии для фигур.
 *
 * Значения — шаблон штриховки в pt (штрих, промежуток, штрих, промежуток…).
 * Точки делаем коротким штрихом 1 pt: при круглых концах линии он выглядит
 * точкой, и такой шаблон одинаково понимают Konva и pdf-lib. Промежутки
 * выбраны с запасом: круглый конец «съедает» половину толщины с каждой
 * стороны, и при промежутке меньше ~1.5 толщины пунктир сливался в сплошную.
 */
export const DASH_PRESETS: { value: string; label: string; pattern: number[] }[] = [
  { value: '', label: 'Сплошная', pattern: [] },
  { value: '6,5', label: 'Штрих', pattern: [6, 5] },
  { value: '1,6', label: 'Пунктир', pattern: [1, 6] },
  { value: '8,5,1,5', label: 'Штрих-пунктир', pattern: [8, 5, 1, 5] },
];

/** Пункты списка «Штриховая линия» (без шаблонов — только значение и подпись). */
export const DASH_OPTIONS = DASH_PRESETS.map(({ value, label }) => ({ value, label }));

/** Описания инструментов. */
export interface ToolDefinition {
  id: ToolType;
  label: string;
  icon: string;
  shortcut?: string;
  group: ToolGroupId;
  hint: string;
}

/** Список инструментов редактора. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'select',
    label: 'Выбор',
    icon: 'cursor',
    shortcut: 'V',
    group: 'navigate',
    hint: 'Выделение, перемещение и масштабирование объектов',
  },
  {
    id: 'pan',
    label: 'Панорама',
    icon: 'hand',
    shortcut: 'H',
    group: 'navigate',
    hint: 'Перемещение по документу (или зажмите пробел)',
  },
  {
    id: 'text',
    label: 'Текст',
    icon: 'type',
    shortcut: 'T',
    group: 'content',
    hint: 'Кликните по странице, чтобы добавить текст',
  },
  {
    id: 'image',
    label: 'Изображение',
    icon: 'image',
    shortcut: 'I',
    group: 'content',
    hint: 'Вставка изображения из файла или библиотеки',
  },
  {
    id: 'brush',
    label: 'Кисть',
    icon: 'brush',
    shortcut: 'B',
    group: 'draw',
    hint: 'Рисование от руки (мышь, палец, стилус)',
  },
  {
    id: 'marker',
    label: 'Маркер',
    icon: 'marker',
    shortcut: 'M',
    group: 'draw',
    hint: 'Полупрозрачное выделение текста и областей',
  },
  {
    id: 'eraser',
    label: 'Корректор',
    icon: 'eraser',
    shortcut: 'E',
    group: 'draw',
    hint: 'Стирание штрихом: закрашивает область цветом фона',
  },
  {
    id: 'smart-eraser',
    label: 'Умный корректор',
    icon: 'magicEraser',
    shortcut: 'C',
    group: 'draw',
    hint: 'Закрашивает только светлый фон — тёмный текст остаётся',
  },
  {
    id: 'whiteout',
    label: 'Закрасить',
    icon: 'whiteout',
    shortcut: 'W',
    group: 'markup',
    hint: 'Прямоугольник, скрывающий содержимое страницы',
  },
  {
    id: 'highlight',
    label: 'Выделение',
    icon: 'highlight',
    shortcut: 'U',
    group: 'markup',
    hint: 'Полупрозрачное выделение области (как маркер по тексту)',
  },
  {
    id: 'rect',
    label: 'Прямоугольник',
    icon: 'square',
    shortcut: 'R',
    group: 'markup',
    hint: 'Прямоугольник с настраиваемой рамкой и заливкой',
  },
  {
    id: 'ellipse',
    label: 'Эллипс',
    icon: 'circle',
    shortcut: 'O',
    group: 'markup',
    hint: 'Эллипс или круг',
  },
  {
    id: 'triangle',
    label: 'Треугольник',
    icon: 'triangle',
    shortcut: 'Y',
    group: 'markup',
    hint: 'Треугольник с настраиваемым скруглением углов',
  },
  {
    id: 'polygon',
    label: 'Многоугольник',
    icon: 'polygon',
    shortcut: 'N',
    group: 'markup',
    hint: 'Многоугольник: число углов и скругление',
  },
  {
    id: 'line',
    label: 'Линия',
    icon: 'line',
    shortcut: 'L',
    group: 'markup',
    hint: 'Прямая линия',
  },
  {
    id: 'arrow',
    label: 'Стрелка',
    icon: 'arrow',
    shortcut: 'A',
    group: 'markup',
    hint: 'Линия со стрелкой на конце',
  },
  {
    id: 'signature',
    label: 'Подпись',
    icon: 'signature',
    shortcut: 'S',
    group: 'stamp',
    hint: 'Подпись от руки из библиотеки или новая',
  },
  {
    id: 'stamp',
    label: 'Штамп',
    icon: 'stamp',
    shortcut: 'P',
    group: 'stamp',
    hint: 'Прямоугольный штамп из библиотеки',
  },
  {
    id: 'seal',
    label: 'Печать',
    icon: 'seal',
    shortcut: 'G',
    group: 'stamp',
    hint: 'Круглая или овальная печать из библиотеки',
  },
];

/** Группы инструментов. */
export const TOOL_GROUPS: { id: ToolGroupId; label: string }[] = [
  { id: 'navigate', label: 'Навигация' },
  { id: 'content', label: 'Содержимое' },
  { id: 'draw', label: 'Рисование' },
  { id: 'markup', label: 'Разметка' },
  { id: 'stamp', label: 'Штампы и подписи' },
];

/** Человекочитаемые названия форматов экспорта. */
export const EXPORT_FORMAT_LABELS: Record<string, string> = {
  pdf: 'PDF с аннотациями',
  'pdf-flat': 'Плоский PDF (растеризация)',
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  docx: 'Word (DOCX)',
  json: 'Проект (JSON)',
  svg: 'SVG (штамп/подпись)',
  library: 'Библиотека (JSON)',
};

/** Названия типов элементов библиотеки. */
export const LIBRARY_TYPE_LABELS: Record<LibraryItemType, string> = {
  stamp: 'Штампы',
  seal: 'Печати',
  signature: 'Подписи',
  drawing: 'Рисунки',
  image: 'Изображения',
};

/** Стандартные размеры страниц, pt. */
export const PAGE_SIZE_PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: 'a4', label: 'A4 (210×297 мм)', width: 595.28, height: 841.89 },
  { id: 'a5', label: 'A5 (148×210 мм)', width: 419.53, height: 595.28 },
  { id: 'a3', label: 'A3 (297×420 мм)', width: 841.89, height: 1190.55 },
  { id: 'letter', label: 'Letter (8.5×11")', width: 612, height: 792 },
  { id: 'legal', label: 'Legal (8.5×14")', width: 612, height: 1008 },
];

/** Настройки приложения по умолчанию. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'ru',
  gridSize: 10,
  showGrid: false,
  snapToGrid: false,
  snapToObjects: true,
  showRulers: false,
  autosaveInterval: 0,
  historyLimit: HISTORY_LIMIT,
  defaultFontId: DEFAULT_FONT_ID,
  defaultTextSize: 14,
  defaultTextColor: '#111827',
  defaultStrokeColor: '#dc2626',
  defaultStrokeWidth: 2,
  defaultHighlightColor: '#facc15',
  defaultWhiteoutColor: '#ffffff',
  warnLargeFiles: true,
  largeFileThresholdMb: 60,
  defaultDpi: 150,
  checkGlyphs: true,
  tooltips: true,
  compactPanels: false,
  canvasBackground: 'dark',
  rasterizeComplexStamps: false,
  pageCacheLimit: 8,
};

/** Настройки экспорта по умолчанию. */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'pdf',
  pageRange: 'all',
  pages: [],
  scale: 2,
  dpi: 150,
  quality: 0.92,
  transparentBackground: false,
  includeAnnotations: true,
  includeOriginalContent: true,
  flatten: true,
  rasterize: false,
  compressImages: false,
  zip: false,
  fileName: 'document',
  singleImage: false,
  metadata: {
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: 'PDF Редактор',
    producer: 'PDF Редактор (pdf-lib)',
  },
};

/** Ограничения размеров. */
export const LIMITS = {
  /** Максимальный размер загружаемого PDF, МБ (предупреждение, не блокировка). */
  softMaxPdfMb: 60,
  /** Максимальный размер изображения, МБ. */
  maxImageMb: 25,
  /** Максимальное количество объектов на документ. */
  maxObjects: 5000,
  /** Порог, после которого текстовый слой не извлекается автоматически. */
  textLayerPageLimit: 400,
  /** Размер кэша страниц по умолчанию. */
  pageCache: 8,
} as const;

/** Клавиши-модификаторы по умолчанию. */
export const HOTKEYS = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  save: 'Ctrl+S',
  open: 'Ctrl+O',
  export: 'Ctrl+E',
  delete: 'Delete',
  duplicate: 'Ctrl+D',
  selectAll: 'Ctrl+A',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  escape: 'Escape',
} as const;
