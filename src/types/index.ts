/**
 * ============================================================================
 *  Модель данных приложения «PDF Редактор».
 * ============================================================================
 *
 *  Система координат:
 *  ---------------------------------------------------------------------------
 *  Все объекты редактора хранятся в **PDF points** (1 pt = 1/72 дюйма) в
 *  «отображаемом» пространстве страницы:
 *    - origin  — левый верхний угол страницы (как у canvas/Konva);
 *    - ось Y   — вниз;
 *    - размеры — с учётом поворота страницы (/Rotate), то есть таково, как
 *                страница выглядит на экране.
 *
 *  Зум, панорамирование и размер окна НЕ влияют на сохраняемые координаты.
 *  Конвертация в систему PDF (origin снизу-слева, ось Y вверх) выполняется
 *  утилитами из `@/utils/coordinates`.
 */

/* ==========================================================================
 *  Инструменты и типы объектов
 * ========================================================================== */

/** Инструменты редактора. */
export type ToolType =
  | 'select'
  | 'pan'
  | 'text'
  | 'image'
  | 'brush'
  | 'marker'
  | 'eraser'
  | 'smart-eraser'
  | 'whiteout'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'polygon'
  | 'line'
  | 'arrow'
  | 'signature'
  | 'stamp'
  | 'seal'
  | 'marquee';

/** Инструменты рисования от руки. */
export type DrawTool = 'brush' | 'marker' | 'eraser' | 'smart-eraser';

/** Инструменты, создающие объект перетаскиванием рамки. */
export type BoxToolType = Extract<
  ToolType,
  'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'arrow' | 'whiteout' | 'highlight' | 'marquee'
>;

/** Тип объекта редактора (объекты, которые можно двигать/масштабировать). */
export type ShiftObjectType =
  | 'text'
  | 'image'
  | 'shape'
  | 'drawing'
  | 'signature'
  | 'stamp'
  | 'whiteout'
  | 'highlight';

/** Группы инструментов для панели. */
export type ToolGroupId = 'navigate' | 'content' | 'draw' | 'markup' | 'stamp';

/** Выравнивание текста. */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** Вертикальное выравнивание текста в рамке. */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** Вид фигуры. */
export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'arrow';

/** Наконечники стрелки. */
export type ArrowHead = 'none' | 'end' | 'both';

/* ==========================================================================
 *  Геометрия и базовый объект
 * ========================================================================== */

/** Геометрия объекта в координатах страницы (pt, top-left origin). */
export interface ObjectTransform {
  /** X левого верхнего угла неотrotated bbox, pt. */
  x: number;
  /** Y левого верхнего угла, pt. */
  y: number;
  /** Ширина, pt. */
  width: number;
  /** Высота, pt. */
  height: number;
  /** Поворот по часовой стрелке, градусы, вокруг точки (x, y). */
  rotation: number;
  /** Прозрачность 0..1. */
  opacity: number;
}

/** Общие поля любого объекта редактора. */
export interface EditorObjectCommon extends ObjectTransform {
  /** Уникальный идентификатор. */
  id: string;
  /** Тип объекта. */
  type: ShiftObjectType;
  /** Индекс страницы (0-based). */
  page: number;
  /** Видимость. */
  visible: boolean;
  /** Блокировка от изменений. */
  locked: boolean;
  /** Порядок наложения (больше — выше). */
  zIndex: number;
  /** Пользовательское имя (для панели слоёв). */
  name?: string;
  /** Идентификатор группы (группировка объектов). */
  groupId?: string | null;
  /** Дата создания, ISO-8601. */
  createdAt: string;
  /** Дата последнего изменения, ISO-8601. */
  updatedAt: string;
}

/** Базовый объект с типизированным payload. */
export interface BaseEditorObject<P> extends EditorObjectCommon {
  payload: P;
}

/* ==========================================================================
 *  Payload-и (содержимое) объектов
 * ========================================================================== */

/** Содержимое текстового объекта. */
export interface TextPayload {
  text: string;
  /** Идентификатор FontAsset. */
  fontId: string;
  /** CSS-семейство шрифта (загружается через FontFace API). */
  fontFamily: string;
  /** Размер шрифта в pt. */
  fontSize: number;
  /** Цвет текста, #rrggbb. */
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  /** Множитель межстрочного интервала. */
  lineHeight: number;
  /** Межбуквенное расстояние, pt. */
  letterSpacing: number;
  /** Внутренние отступы, pt. */
  padding: number;
  /** Автоматическая высота по содержимому. */
  autoHeight: boolean;
  /** Фон рамки. */
  backgroundColor: string | null;
  backgroundOpacity: number;
  /** Обводка рамки. */
  borderColor: string | null;
  borderWidth: number;
  /** Обводка букв (контур). */
  strokeColor: string | null;
  strokeWidth: number;
  /** Мягкая тень под текстом (улучшает читаемость поверх сканов). */
  shadow: boolean;
}

/** Содержимое объекта-изображения. */
export interface ImagePayload {
  /** data:URL (base64) — самодостаточно для проекта и экспорта. */
  src: string;
  mimeType: string;
  /** Исходные размеры изображения, px. */
  naturalWidth: number;
  naturalHeight: number;
  fit: 'contain' | 'cover' | 'fill';
  cornerRadius: number;
  borderColor: string | null;
  borderWidth: number;
  /** Описание для доступности и имени файла при экспорте. */
  alt?: string;
}

/** Содержимое фигуры. */
export interface ShapePayload {
  kind: ShapeKind;
  /** Цвет обводки; null — «без цвета», обводка не рисуется. */
  stroke: string | null;
  strokeWidth: number;
  fill: string | null;
  /** Штриховая линия (в pt). */
  dash: number[];
  cornerRadius: number;
  /** Число сторон многоугольника (только для kind: 'polygon', по умолчанию 5). */
  sides?: number;
  arrowHead: ArrowHead;
  /** Для line/arrow: нормализованные точки начала и конца внутри bbox (0..1). */
  points: [number, number, number, number];
}

/** Точка рукописного штриха (локальные координаты объекта, pt). */
export interface StrokePoint {
  x: number;
  y: number;
  /** Давление пера 0..1 (0.5, если устройство не поддерживает). */
  pressure: number;
}

/** Один штрих рукописного рисунка/подписи. */
export interface StrokeData {
  tool: DrawTool;
  color: string;
  /** Толщина линии, pt. */
  width: number;
  opacity: number;
  points: StrokePoint[];
  /** Сглаживание через perfect-freehand. */
  smooth: boolean;
  /** Признак «контурной» отрисовки (filled outline) при экспорте. */
  filled?: boolean;
}

/** Содержимое рукописного рисунка. */
/**
 * Настройки «умного корректора»: закрашивает только светлые участки, тёмный
 * текст остаётся. Маска строится по растру страницы (см. services/smartErase).
 */
export interface SmartEraseSettings {
  /** Порог яркости 0..255: пиксели светлее закрашиваются, темнее остаются. */
  threshold: number;
  /** Цвет заливки, #rrggbb. */
  color: string;
  /**
   * Подбирать цвет заливки под бумагу под штрихом (по умолчанию да).
   *
   * На сканах бумага почти никогда не чисто-белая: заливка выбранным цветом
   * оставляла бы видимый след мазка. В авторежиме берётся тон бумаги из-под
   * штриха, и закрашенное место сливается с фоном.
   */
  autoColor?: boolean;
  /**
   * Стирать всё под мазком, включая тёмное (текст, линии).
   *
   * По умолчанию тёмное остаётся — это и есть «умный» корректор. Но печатную
   * надпись иногда нужно убрать целиком: тогда включается этот режим.
   */
  eraseAll?: boolean;
}

export interface DrawingPayload {
  strokes: StrokeData[];
  /** Размеры «дизайнерской» области, в которой заданы точки, pt. */
  designWidth: number;
  designHeight: number;
  /** Рисунок нарисован в режиме корректора (белый цвет). */
  erasable: boolean;
  /** Режим «умного корректора» (null/undefined — обычный рисунок). */
  smart?: SmartEraseSettings | null;
}

/** Содержимое подписи. */
export interface SignaturePayload {
  strokes: StrokeData[];
  designWidth: number;
  designHeight: number;
  color: string;
  strokeWidth: number;
  /** SVG-представление (опционально, для экспорта/библиотеки). */
  svg?: string | null;
  /** PNG data:URL с прозрачным фоном (опционально). */
  png?: string | null;
  source: 'draw' | 'library' | 'image';
  /** Ссылка на элемент библиотеки подписей. */
  modelId?: string | null;
}

/** Содержимое штампа/печати. */
export interface StampPayload {
  /** Ссылка на шаблон в библиотеке (может быть null для «одноразового»). */
  templateId: string | null;
  /** Снимок шаблона: объект самодостаточен и не зависит от библиотеки. */
  template: StampTemplate;
  /** Переопределения на конкретном объекте. */
  overrides: {
    color?: string;
    opacity?: number;
    textOverride?: string | null;
  };
}

/** Содержимое «закрашивания» (корректора). */
export interface WhiteoutPayload {
  color: string;
  /** Рисовать поверх с полной непрозрачностью. */
  solid: boolean;
}

/** Содержимое выделения (хайлайтер-область). */
export interface HighlightPayload {
  color: string;
  blend: 'multiply' | 'normal';
}

/** Объединение всех payload-ов. */
export type ObjectPayload =
  | TextPayload
  | ImagePayload
  | ShapePayload
  | DrawingPayload
  | SignaturePayload
  | StampPayload
  | WhiteoutPayload
  | HighlightPayload;

/* ==========================================================================
 *  Конкретные объекты
 * ========================================================================== */

export type TextObject = BaseEditorObject<TextPayload> & { type: 'text' };
export type ImageObject = BaseEditorObject<ImagePayload> & { type: 'image' };
export type ShapeObject = BaseEditorObject<ShapePayload> & { type: 'shape' };
export type DrawingObject = BaseEditorObject<DrawingPayload> & { type: 'drawing' };
export type SignatureObject = BaseEditorObject<SignaturePayload> & { type: 'signature' };
export type StampObject = BaseEditorObject<StampPayload> & { type: 'stamp' };
export type WhiteoutObject = BaseEditorObject<WhiteoutPayload> & { type: 'whiteout' };
export type HighlightObject = BaseEditorObject<HighlightPayload> & { type: 'highlight' };

/** Любой объект редактора (discriminated union по полю `type`). */
export type EditorObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | DrawingObject
  | SignatureObject
  | StampObject
  | WhiteoutObject
  | HighlightObject;

/** Любой payload. */
export type AnyPayload = EditorObject['payload'];

/* ==========================================================================
 *  Документ и страницы
 * ========================================================================== */

/** Состояние отрисовки страницы. */
export type PageRenderStatus = 'idle' | 'queued' | 'rendering' | 'ready' | 'error';

/** Состояние одной страницы PDF. */
export interface PdfPageState {
  /** 0-based индекс. */
  index: number;
  /** Ширина страницы как в PDF (MediaBox), pt. */
  width: number;
  /** Высота страницы как в PDF, pt. */
  height: number;
  /** Поворот страницы из PDF (/Rotate), градусы: 0|90|180|270. */
  rotation: number;
  /**
   * Поворот, добавленный пользователем в редакторе, градусы: 0|90|180|270.
   * Итоговый поворот страницы = `(rotation + viewRotation) % 360`, и именно он
   * записывается в PDF при экспорте.
   */
  viewRotation?: number;
  /** Ширина с учётом поворота (то, что видит пользователь), pt. */
  displayWidth: number;
  /** Высота с учётом поворота, pt. */
  displayHeight: number;
  status: PageRenderStatus;
  error?: string | null;
  /** Превью для панели миниатюр (PNG data:URL). */
  thumbnail?: string | null;
  thumbnailStatus: PageRenderStatus;
  /** Есть ли текстовый слой. */
  hasTextLayer: boolean;
  /** Масштаб, в котором отрисовано полотно страницы. */
  renderScale?: number;
}

/** Метаданные PDF. */
export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

/** Состояние документа. */
export interface PdfDocumentState {
  /** Имя исходного файла (UTF-8). */
  fileName: string;
  /** Размер файла в байтах. */
  fileSize: number;
  /** Количество страниц. */
  numPages: number;
  /** Признак успешной загрузки. */
  isLoaded: boolean;
  /** Идёт загрузка/парсинг. */
  isLoading: boolean;
  /** Документ зашифрован. */
  isEncrypted: boolean;
  /** Требуется пароль. */
  needsPassword: boolean;
  /** Документ имеет ограничения (запрет печати/копирования). */
  isRestricted: boolean;
  /** Отпечаток файла (pdf.js fingerprint). */
  fingerprint: string | null;
  /** Метаданные. */
  metadata: PdfMetadata;
  /** Страницы. */
  pages: PdfPageState[];
  /** Текст ошибки загрузки. */
  error: string | null;
}

/* ==========================================================================
 *  Шаблоны: штампы, печати, подписи
 * ========================================================================== */

/** Строка текста внутри штампа/печати. */
export interface StampTextLine {
  id: string;
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Межбуквенное расстояние, pt. */
  letterSpacing: number;
  /** Смещение по вертикали от центра, pt (0 — авто-раскладка). */
  offsetY: number;
  color: string | null;
  /** Шрифт (FontAsset.id). */
  fontId?: string;
}

/** Текст по кругу (для круглых печатей). */
export interface StampCircularText {
  enabled: boolean;
  text: string;
  fontSize: number;
  /** Радиус расположения текста, pt. */
  radius: number;
  /** Начальный угол, градусы (0 — справа, по часовой). */
  startAngle: number;
  /** Направление обхода. */
  direction: 'cw' | 'ccw';
  letterSpacing: number;
  color: string | null;
  /** Разнести по верхней и нижней дуге (текст сверху и снизу). */
  splitBottom: boolean;
  bottomText: string;
}

/** Логотип/иконка внутри штампа. */
export interface StampLogo {
  /** data:URL PNG/SVG/JPEG. */
  src: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  opacity: number;
}

/** Шаблон штампа. */
export interface StampTemplate {
  id: string;
  name: string;
  kind: 'stamp' | 'seal';
  shape: 'rect' | 'round' | 'oval';
  /** Размер в pt. */
  width: number;
  height: number;
  color: string;
  borderWidth: number;
  doubleBorder: boolean;
  /** Расстояние между рамками при doubleBorder, pt. */
  borderGap: number;
  cornerRadius: number;
  opacity: number;
  rotation: number;
  fontId: string;
  /** Внутренние текстовые строки (авто-раскладка сверху вниз от центра). */
  lines: StampTextLine[];
  circularText: StampCircularText;
  logo: StampLogo | null;
  /** Заливка фона (обычно прозрачная). */
  backgroundColor: string | null;
  /** Внутренний разделитель (линия) для прямоугольных штампов. */
  divider: boolean;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  /** PNG data:URL превью (кэш). */
  preview?: string | null;
}

/** Круглая/овальная печать (частный случай штампа). */
export interface SealTemplate extends StampTemplate {
  kind: 'seal';
}

/** Шаблон подписи. */
export interface SignatureTemplate {
  id: string;
  name: string;
  strokes: StrokeData[];
  designWidth: number;
  designHeight: number;
  color: string;
  strokeWidth: number;
  /** SVG с прозрачным фоном. */
  svg?: string | null;
  /** PNG data:URL с прозрачным фоном. */
  png?: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  preview?: string | null;
}

/** Шаблон сохранённого рисунка. */
export interface DrawingTemplate {
  id: string;
  name: string;
  strokes: StrokeData[];
  designWidth: number;
  designHeight: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  preview?: string | null;
}

/** Элемент библиотеки изображений. */
export interface ImageTemplate {
  id: string;
  name: string;
  src: string;
  mimeType: string;
  naturalWidth: number;
  naturalHeight: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  preview?: string | null;
}

/** Общий тип элемента библиотеки. */
export type LibraryItemType = 'stamp' | 'seal' | 'signature' | 'drawing' | 'image';

export type LibraryItem =
  | StampTemplate
  | SignatureTemplate
  | DrawingTemplate
  | ImageTemplate;

/** Обёртка элемента библиотеки в хранилище. */
export interface LibraryRecord<T = LibraryItem> {
  id: string;
  type: LibraryItemType;
  name: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  preview?: string | null;
  data: T;
}

/* ==========================================================================
 *  Шрифты
 * ========================================================================== */

/** Источник шрифта. */
export type FontSource = 'bundled' | 'user' | 'remote';

/** Описание начертания шрифта. */
export interface FontFaceDescriptor {
  weight: number;
  style: 'normal' | 'italic';
  /** URL относительно base (для bundled/remote) или data:URL (для user). */
  url: string;
  fileName?: string;
}

/** Шрифт приложения. */
export interface FontAsset {
  id: string;
  /** Отображаемое имя (например, «PT Sans»). */
  name: string;
  /** CSS-семейство, под которым шрифт зарегистрирован в браузере. */
  family: string;
  source: FontSource;
  /** Начертания: ключ — `weight-style`. */
  faces: Record<string, FontFaceDescriptor>;
  /** Поддерживает ли шрифт кириллицу. */
  supportsCyrillic: boolean;
  /** Загружен ли шрифт в браузер (FontFace API). */
  loaded?: boolean;
  /** Размер файла, байт. */
  size?: number;
  /** Лицензия/примечание. */
  license?: string;
  /** Регистрация в PDF-экспорте прошла успешно. */
  embeddable?: boolean;
  /**
   * Можно ли встраивать шрифт подмножеством (`subset: true`).
   *
   * Подмножества pdf-lib повреждают часть шрифтов: глифы пропадают или
   * подменяются (проверено скриптом `scripts/check-font-subsets.mjs` для
   * всех встроенных начертаний). Для таких шрифтов используется полное
   * встраивание — файл больше, но кириллица гарантированно корректна.
   */
  subsetSafe?: boolean;
}

/** Результат проверки покрытия глифов. */
export interface GlyphCoverageResult {
  supported: boolean;
  /** Символы, отсутствующие в шрифте. */
  missing: string[];
}

/* ==========================================================================
 *  Экспорт
 * ========================================================================== */

export type ExportFormat =
  | 'pdf'
  | 'pdf-flat'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'docx'
  | 'json'
  | 'svg'
  | 'library';

export type PageRangeMode = 'all' | 'current' | 'custom';

/** Настройки экспорта. */
export interface ExportSettings {
  format: ExportFormat;
  pageRange: PageRangeMode;
  /** Явный список страниц (1-based) для режима custom. */
  pages: number[];
  /** Масштаб для растрового экспорта. */
  scale: number;
  /** DPI (приоритетнее scale, если задан). */
  dpi: number | null;
  /** Качество JPEG/WebP 0..1. */
  quality: number;
  /** Прозрачный фон при растровом экспорте. */
  transparentBackground: boolean;
  /** Включать аннотации редактора. */
  includeAnnotations: boolean;
  /** Включать исходное содержимое PDF (иначе только аннотации). */
  includeOriginalContent: boolean;
  /** Встроить (flatten) аннотации в поток страницы. */
  flatten: boolean;
  /** Растеризовать страницы целиком (плоский PDF). */
  rasterize: boolean;
  /** Сжимать изображения (перекодировать в JPEG перед вставкой). */
  compressImages: boolean;
  /** Упаковать постраничные изображения в ZIP. */
  zip: boolean;
  fileName: string;
  /** Экспортировать все страницы одним длинным изображением. */
  singleImage: boolean;
  metadata: PdfMetadata;
}

/** Результат экспорта. */
export interface ExportResult {
  ok: boolean;
  fileName: string;
  size: number;
  blob: Blob;
  warnings: string[];
  error?: string;
}

/** Прогресс длительной операции. */
export interface ProgressState {
  active: boolean;
  /** 0..1 */
  value: number;
  label: string;
  detail?: string;
}

/* ==========================================================================
 *  Настройки приложения
 * ========================================================================== */

export type ThemeMode = 'light' | 'dark' | 'system';

/** Настройки приложения. */
export interface AppSettings {
  theme: ThemeMode;
  /** Язык интерфейса (пока только ru). */
  locale: 'ru' | 'en';
  /** Шаг сетки, pt. */
  gridSize: number;
  showGrid: boolean;
  snapToGrid: boolean;
  snapToObjects: boolean;
  showRulers: boolean;
  /** Автосохранение проекта в IndexedDB (мс, 0 — выключено). */
  autosaveInterval: number;
  historyLimit: number;
  defaultFontId: string;
  defaultTextSize: number;
  defaultTextColor: string;
  defaultStrokeColor: string;
  defaultStrokeWidth: number;
  defaultHighlightColor: string;
  defaultWhiteoutColor: string;
  /** Предупреждать о слишком больших файлах. */
  warnLargeFiles: boolean;
  /** Порог «большого» файла, МБ. */
  largeFileThresholdMb: number;
  /** DPI по умолчанию для растрового экспорта. */
  defaultDpi: number;
  /** Проверять покрытие глифов перед экспортом PDF. */
  checkGlyphs: boolean;
  /** Показывать подсказки (тултипы). */
  tooltips: boolean;
  /** Компактный режим панелей. */
  compactPanels: boolean;
  /** Цвет фона рабочей области. */
  canvasBackground: 'dark' | 'light' | 'checker';
  /** Растеризовать сложные штампы вместо векторной отрисовки. */
  rasterizeComplexStamps: boolean;
  /** Максимальный кэш отрисованных страниц. */
  pageCacheLimit: number;
}

/* ==========================================================================
 *  Проект
 * ========================================================================== */

/** Сериализованный проект. */
export interface ProjectFile {
  schemaVersion: number;
  app: string;
  appVersion: string;
  savedAt: string;
  fileName: string;
  metadata: PdfMetadata;
  /** Оригинальный PDF в base64 (опционально). */
  originalPdfBase64: string | null;
  originalPdfSize: number;
  pages: PdfPageState[];
  objects: EditorObject[];
  settings: Partial<AppSettings>;
}

/** Результат загрузки файла. */
export interface LoadedFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/* ==========================================================================
 *  Прочее
 * ========================================================================== */

/** Тост-уведомление. */
export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  text?: string;
  timeout: number;
}

/** Элемент выпадающего меню. */
export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

/** Снимок истории для undo/redo. */
export interface HistorySnapshot {
  objects: EditorObject[];
  /** Повороты страниц (`viewRotation`) на момент снимка. */
  pageRotations?: number[];
  label: string;
  at: number;
}

/** Область выделения (marquee). */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
