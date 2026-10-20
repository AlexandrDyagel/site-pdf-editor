/**
 * ============================================================================
 *  Инструменты редактора: обработка указателя и создание объектов.
 * ============================================================================
 *
 *  Здесь сосредоточена вся «рабочая» логика инструментов:
 *   - рисование от руки (мышь, палец, стилус) и корректор;
 *   - фигуры, текст, штампы, печати, подписи, изображения;
 *   - выделение рамкой;
 *   - панорамирование и зум колесом.
 */

import Konva from 'konva';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type {
  EditorObject,
  ShapeKind,
  SignatureTemplate,
  StampTemplate,
  StrokePoint,
  TextAlign,
} from '@/types';
import type { Point } from '@/utils/geometry';
import {
  boundsOfTransforms,
  equilateralTriangleBox,
  normalizeRect,
  pointInRect,
  rectFromPoints,
  rotatePoint,
  rotatedBounds,
  snapPointToAngle,
  squareFromPoints,
} from '@/utils/geometry';
import { caretOffsetAtPoint } from '@/utils/textCaret';
import {
  createDrawingObject,
  createHighlightObject,
  createImageObject,
  createShapeObject,
  createSignatureObject,
  createStampObject,
  createTextObject,
  createWhiteoutObject,
} from '@/services/objectFactory';
import { ACCEPT, openFileDialog, readImageFile } from '@/services/fileService';
import { pdfService } from '@/services/pdfService';
import { textInkCenter } from '@/services/textRenderService';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useSettingsStore } from '@/stores/settings';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { useFontsStore } from '@/stores/fonts';
import { isMaskingStroke } from '@/utils/masking';
import type { ObjectRendererApi } from '@/composables/useObjectRenderer';

/** Обработчики указателя для сцены. */
export interface EditorToolsApi {
  onPointerDown: (event: Konva.KonvaEventObject<PointerEvent>) => void;
  onPointerMove: (event: Konva.KonvaEventObject<PointerEvent>) => void;
  onPointerUp: (event: Konva.KonvaEventObject<PointerEvent>) => void;
  onDoubleClick: (event: Konva.KonvaEventObject<MouseEvent>) => void;
  onContextMenu: (event: Konva.KonvaEventObject<PointerEvent>) => void;
  onWheel: (event: Konva.KonvaEventObject<WheelEvent>) => void;
  isPanning: ReturnType<typeof ref<boolean>>;
}

interface PanState {
  pointer: Point;
  pan: Point;
}

export function useEditorTools(deps: {
  screenToPage: (clientX: number, clientY: number) => Point;
  renderer: ObjectRendererApi;
}): EditorToolsApi {
  const editor = useEditorStore();
  const objects = useObjectsStore();
  const pdf = usePdfStore();
  const settings = useSettingsStore();
  const library = useLibraryStore();
  const ui = useUiStore();
  const fonts = useFontsStore();

  const isPanning = ref(false);
  let panState: PanState | null = null;
  let marqueeStart: Point | null = null;
  let pointerDown: Point | null = null;
  let movedDuringGesture = false;
  /** Элемент, на котором захвачен указатель (для рисования за пределами холста). */
  let capturedElement: HTMLElement | null = null;
  let capturedPointerId: number | null = null;

  /* ======================== Действия на холсте ======================== */

  /**
   * Добавление объектов, созданных на холсте.
   *
   * После действия на холсте сразу показываем «Свойства» нового объекта.
   * Выделение строки в панели «Слои» сюда не попадает — там свойства
   * открываются двойным кликом.
   */
  function addFromCanvas(
    items: EditorObject[],
    label: string,
    options: { select?: boolean; openProperties?: boolean } = {},
  ): void {
    const { select = true, openProperties = true } = options;
    objects.add(items, label);
    // Закрашенные участки не становятся активными: рамку пользователь увидит,
    // только если выберет их в панели «Слои».
    if (!select) {
      objects.clearSelection();
      return;
    }
    if (openProperties) ui.setRightTab('properties');
  }

  /* ======================== Захват указателя ======================== */

  /**
   * Захватываем указатель на элементе Konva (`.konvajs-content`).
   *
   * Зачем: без захвата Konva получает события только пока курсор находится
   * над холстом. Если вести мышь за пределы холста (в панель, на панель
   * инструментов, за окно), штрих обрывался, а при отпускании кнопки вне
   * холста — вообще терялся: следующее нажатие перезаписывало незавершённый
   * штрих. Именно так «корректор не всё обрабатывал».
   */
  function capturePointer(event: Konva.KonvaEventObject<PointerEvent>): void {
    const stage = event.target.getStage();
    const element = (stage?.content as HTMLElement | undefined) ?? stage?.container() ?? null;
    if (!element) return;
    try {
      element.setPointerCapture?.(event.evt.pointerId);
      capturedElement = element;
      capturedPointerId = event.evt.pointerId;
    } catch {
      /* захват недоступен — сработает страховка на window */
    }
  }

  function releasePointer(): void {
    const element = capturedElement;
    const pointerId = capturedPointerId;
    capturedElement = null;
    capturedPointerId = null;
    if (!element || pointerId === null) return;
    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      /* уже отпущен */
    }
  }

  /** Давление пера (0.5 для мыши). */
  function pressureOf(event: PointerEvent): number {
    const value = typeof event.pressure === 'number' ? event.pressure : 0;
    if (value > 0 && Math.abs(value - 0.5) > 0.001) return Math.min(1, Math.max(0.05, value));
    return 0.5;
  }

  function pointToStroke(point: Point, event: PointerEvent): StrokePoint {
    return { x: point.x, y: point.y, pressure: pressureOf(event) };
  }

  /** Текущая позиция указателя в координатах страницы. */
  function pointerPoint(event: Konva.KonvaEventObject<PointerEvent | WheelEvent | MouseEvent>): Point {
    return deps.screenToPage(event.evt.clientX, event.evt.clientY);
  }

  /**
   * Поиск объекта по цели события Konva.
   * Событие приходит от дочернего узла (фигура, изображение, текст), поэтому
   * поднимаемся по родителям до группы с идентификатором объекта.
   */
  function objectIdFromTarget(target: Konva.Node | null): string | null {
    let node: Konva.Node | null = target;
    while (node) {
      const id = node.getAttr('objectId');
      if (typeof id === 'string' && id.length > 0) return id;
      node = node.getParent();
    }
    return null;
  }

  /** Служебные элементы сцены: ручки Transformer и фон — их клики игнорируем. */
  function isStageChrome(target: Konva.Node | null): boolean {
    let node: Konva.Node | null = target;
    while (node) {
      if (node.name() === 'transformer' || node.getParent()?.name() === 'transformer') return true;
      if (node.getAttr('role') === 'transformer') return true;
      node = node.getParent();
    }
    return false;
  }

  /* ======================== Создание объектов ======================== */

  /** Вставка текста в точке. */
  function insertText(at: Point, preset?: { text: string; fontSize: number; width: number }): void {
    const defaults = { ...settings.textDefaults, ...editor.toolOptions.text };
    const fontId = defaults.fontId || settings.settings.defaultFontId;
    const font = fonts.byId(fontId);
    const fontSize = preset?.fontSize ?? defaults.fontSize;
    // Новая текстовая область — маленькая, примерно под один символ: по мере
    // набора её размер увеличивает оверлей-редактор (`TextInlineEditor`).
    const width = preset?.width ?? Math.max(12, fontSize * 1.1);
    const draft = createTextObject({
      page: editor.currentPage,
      x: at.x,
      y: at.y,
      width,
      height: fontSize * 1.4,
      text: preset?.text ?? '',
      autoHeight: true,
      defaults: {
        fontId,
        fontFamily: font?.family ?? defaults.fontFamily,
        fontSize,
        color: defaults.color,
        bold: defaults.bold ?? false,
        italic: defaults.italic ?? false,
        align: defaults.align ?? ('left' as TextAlign),
        lineHeight: defaults.lineHeight ?? 1.25,
        letterSpacing: defaults.letterSpacing ?? 0,
      },
    });
    // Текст должен начинаться ровно там, где нажали: у объекта сверху есть
    // межстрочный «полуотступ» до верхушки букв, поэтому сдвигаем рамку так,
    // чтобы верх «чернил» первой строки совпал с точкой клика. Тот же отступ
    // использует оверлей ввода, поэтому каретка стоит на одной высоте с буквами.
    const padding = Math.max(0, draft.payload.padding);
    const inkShift = textInkCenter(draft.payload, draft.height);
    const object = { ...draft, x: at.x - padding, y: at.y - inkShift };
    addFromCanvas([object], 'Добавление текста');
    // Сразу открываем ввод с кареткой в начале текста.
    editor.startTextEditing(object.id, 0);
    ui.setRightTab('properties');
    void fonts.ensureFontLoadedFor(fontId);
  }

  /** Текстовый объект под точкой (с учётом z-порядка и поворота). */
  function findTextAt(point: Point): EditorObject | null {
    const list = objects.forPage(editor.currentPage);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const obj = list[index];
      if (obj.type !== 'text' || !obj.visible || obj.locked) continue;
      const bounds = rotatedBounds(obj);
      if (pointInRect(point, bounds)) return obj;
    }
    return null;
  }

  /** Вход в редактирование существующего текста с кареткой в месте клика. */
  function editTextAt(obj: EditorObject, point: Point): void {
    if (obj.type !== 'text') return;
    // Точка в локальной системе объекта (без учёта поворота).
    const local = rotatePoint(point, { x: obj.x, y: obj.y }, -obj.rotation);
    const caret = caretOffsetAtPoint(
      obj.payload,
      obj.width,
      obj.height,
      local.x - obj.x,
      local.y - obj.y,
    );
    objects.selectOne(obj.id);
    editor.startTextEditing(obj.id, caret);
    void fonts.ensureFontLoadedFor(obj.payload.fontId);
  }

  /** Вставка изображения из файла. */
  async function insertImages(at: Point): Promise<void> {
    const files = await openImageDialog();
    if (files.length === 0) return;
    const maxWidth = editor.pageSize.width * 0.5;
    let offset = 0;
    const created = [];
    for (const file of files) {
      try {
        const image = await readImageFile(file);
        const scale = Math.min(1, maxWidth / image.naturalWidth);
        const width = Math.max(24, image.naturalWidth * scale);
        const height = Math.max(24, image.naturalHeight * scale);
        created.push(
          createImageObject({
            page: editor.currentPage,
            x: at.x + offset,
            y: at.y + offset,
            width,
            height,
            src: image.src,
            mimeType: image.mimeType,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            alt: file.name,
          }),
        );
        offset += 12;
      } catch {
        ui.notify.error('Не удалось загрузить изображение', file.name);
      }
    }
    if (created.length > 0) {
      addFromCanvas(created, 'Добавление изображения');
      ui.notify.success('Изображение добавлено', `${created.length} шт.`);
    }
  }

  /** Создание изображения из библиотеки. */
  function insertLibraryImage(src: string, naturalWidth: number, naturalHeight: number, mimeType: string, at: Point): void {
    const maxWidth = editor.pageSize.width * 0.5;
    const scale = Math.min(1, maxWidth / Math.max(1, naturalWidth));
    addFromCanvas(
      [
        createImageObject({
          page: editor.currentPage,
          x: at.x,
          y: at.y,
          width: Math.max(24, naturalWidth * scale),
          height: Math.max(24, naturalHeight * scale),
          src,
          mimeType,
          naturalWidth,
          naturalHeight,
        }),
      ],
      'Добавление изображения',
    );
  }

  /** Вставка штампа/печати. */
  function insertStamp(template: StampTemplate, at: Point): void {
    const object = createStampObject(template, {
      page: editor.currentPage,
      x: at.x - template.width / 2,
      y: at.y - template.height / 2,
      templateId: template.id,
    });
    addFromCanvas([object], template.kind === 'seal' ? 'Добавление печати' : 'Добавление штампа');
  }

  /** Вставка подписи из библиотеки. */
  function insertSignature(template: SignatureTemplate, at: Point): void {
    const object = createSignatureObject({
      page: editor.currentPage,
      x: at.x - template.designWidth / 2,
      y: at.y - template.designHeight / 2,
      width: template.designWidth,
      height: template.designHeight,
      strokes: template.strokes,
      color: template.color,
      strokeWidth: template.strokeWidth,
      svg: template.svg ?? null,
      png: template.png ?? null,
      modelId: template.id,
      source: 'library',
    });
    addFromCanvas([object], 'Добавление подписи');
  }

  /* ======================== Обработчики ======================== */

  function onPointerDown(event: Konva.KonvaEventObject<PointerEvent>): void {
    // Ручки трансформера работают при любом инструменте (растянуть/повернуть
    // выделенный объект, не переключаясь на «Выбор»). Их нажатия не должны
    // запускать рисование.
    if (isStageChrome(event.target)) return;

    const point = pointerPoint(event);
    editor.cursorPosition = point;
    movedDuringGesture = false;

    // Незавершённый жест (например, кнопку отпустили вне окна) сначала
    // доводим до конца, чтобы нарисованное не пропадало.
    if (editor.activeStroke || editor.shapeDraft || marqueeStart) {
      finishGesture(point);
    }

    pointerDown = point;
    capturePointer(event);

    // Средняя кнопка мыши или инструмент «панорама» — перемещение холста.
    if (event.evt.button === 1 || editor.isPanTool || editor.tool === 'pan') {
      isPanning.value = true;
      panState = { pointer: { x: event.evt.clientX, y: event.evt.clientY }, pan: { ...editor.pan } };
      return;
    }
    if (event.evt.button !== 0) return;
    if (editor.viewOnly) return;

    switch (editor.tool) {
      case 'select': {
        // Клик по объекту обрабатывается узлом; клик по пустому месту — рамка.
        // Закрашенный участок (корректор) ведёт себя как пустое место: сам он
        // не выделяется, но и не мешает снять рамку с другого объекта.
        const targetId = objectIdFromTarget(event.target);
        const targetObject = targetId ? objects.byId(targetId) : null;
        const isObject = targetId !== null && !isMaskingStroke(targetObject);
        if (!isObject && !isStageChrome(event.target)) {
          if (!event.evt.shiftKey) objects.clearSelection();
          marqueeStart = point;
          editor.setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
        }
        break;
      }
      case 'marquee': {
        marqueeStart = point;
        editor.setMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
        break;
      }
      case 'text': {
        if (event.evt.altKey) {
          void replacePdfTextAt(point, event.evt.ctrlKey || event.evt.metaKey);
        } else {
          // Клик по готовому тексту — редактируем его с кареткой в месте клика,
          // иначе создаём новый текст и сразу показываем каретку.
          const existing = findTextAt(point);
          if (existing) editTextAt(existing, point);
          else insertText(point);
        }
        break;
      }
      case 'image':
        void insertImages(point);
        break;
      case 'brush':
      case 'marker':
      case 'eraser':
      case 'smart-eraser':
        editor.startStroke(pointToStroke(point, event.evt));
        break;
      case 'rect':
      case 'ellipse':
      case 'triangle':
      case 'polygon':
      case 'line':
      case 'arrow':
      case 'whiteout':
        editor.startShapeDraft(point);
        break;
      case 'highlight':
        editor.startShapeDraft(point);
        break;
      case 'stamp':
      case 'seal': {
        const wanted = editor.tool === 'seal' ? library.seals : library.stamps;
        const template = wanted.find((item) => item.id === editor.toolOptions.lastStampId) ?? wanted[0];
        if (template) {
          insertStamp(template, point);
        } else {
          ui.setLeftTab('library');
          library.activeType = editor.tool === 'seal' ? 'seal' : 'stamp';
          ui.notify.info(
            editor.tool === 'seal' ? 'В библиотеке нет печатей' : 'В библиотеке нет штампов',
            'Создайте новый в редакторе штампов.',
          );
        }
        break;
      }
      case 'signature': {
        const template = library.signatureById(editor.toolOptions.lastSignatureId) ?? library.signatures[0];
        if (template) {
          insertSignature(template, point);
        } else {
          ui.openModal('signatureEditor');
        }
        break;
      }
      default:
        break;
    }
  }

  function onPointerMove(event: Konva.KonvaEventObject<PointerEvent>): void {
    const point = pointerPoint(event);
    editor.cursorPosition = point;
    if (pointerDown && (Math.abs(point.x - pointerDown.x) > 1 || Math.abs(point.y - pointerDown.y) > 1)) {
      movedDuringGesture = true;
    }

    if (isPanning.value && panState) {
      editor.setPan({
        x: panState.pan.x + (event.evt.clientX - panState.pointer.x),
        y: panState.pan.y + (event.evt.clientY - panState.pointer.y),
      });
      return;
    }

    if (editor.activeStroke) {
      editor.appendStrokePoint(pointToStroke(point, event.evt));
      return;
    }

    if (editor.shapeDraft) {
      editor.updateShapeDraft(point, event.evt.shiftKey);
      return;
    }

    if (marqueeStart) {
      const rect = normalizeRect(rectFromPoints(marqueeStart, point));
      editor.setMarquee(rect);
    }
  }

  /**
   * Завершение текущего жеста: штрих, фигура или выделение рамкой.
   * Вызывается и по отпусканию кнопки, и при отмене указателя, и перед
   * началом нового жеста — поэтому нарисованное не теряется.
   */
  function finishGesture(point: Point | null): void {
    if (isPanning.value) {
      isPanning.value = false;
      panState = null;
    }

    // Рисование.
    if (editor.activeStroke) {
      const stroke = editor.takeStroke();
      if (stroke && stroke.points.length > 0) {
        const isSmart = stroke.tool === 'smart-eraser';
        const smartOptions = editor.toolOptions.smartEraser;
        const drawing = createDrawingObject([stroke], {
          page: editor.currentPage,
          eraser: stroke.tool === 'eraser',
          smart: isSmart
            ? {
                threshold: smartOptions.threshold,
                color: smartOptions.color,
                autoColor: smartOptions.autoColor !== false,
                eraseAll: smartOptions.eraseAll === true,
                targetColor: smartOptions.targetColor ?? null,
                colorTolerance: smartOptions.colorTolerance ?? 22,
              }
            : null,
          name: isSmart ? 'Умный корректор' : stroke.tool === 'eraser' ? 'Корректор' : 'Рисунок',
        });
        if (drawing) {
          // Невыделяемым оставляем только корректор; умный корректор ведёт
          // себя как обычный объект и сразу становится активным.
          const isMasking = stroke.tool === 'eraser';
          addFromCanvas(
            [drawing],
            isSmart ? 'Осветление' : stroke.tool === 'eraser' ? 'Стирание' : 'Рисование',
            // Закрашенное не выделяем: рамки после штриха быть не должно.
            { select: !isMasking, openProperties: !isMasking },
          );
        }
      }
      return;
    }

    // Фигуры.
    if (editor.shapeDraft) {
      const draft = editor.takeShapeDraft();
      if (draft) {
        const end = point ?? draft.end;
        const rect = normalizeRect(rectFromPoints(draft.start, end));
        const tiny = rect.width < 3 && rect.height < 3;
        if (!tiny) {
          createShapeFromDraft(draft.start, end, rect, draft.constrained);
        } else if (editor.tool === 'whiteout' && point) {
          addFromCanvas(
            [
              createWhiteoutObject({
                page: editor.currentPage,
                x: point.x,
                y: point.y,
                width: 120,
                height: 24,
                color: editor.toolOptions.whiteout.color,
              }),
            ],
            'Закрашивание',
          );
        }
      }
      return;
    }

    // Выделение рамкой.
    if (marqueeStart) {
      const end = point ?? marqueeStart;
      const rect = normalizeRect(rectFromPoints(marqueeStart, end));
      marqueeStart = null;
      editor.setMarquee(null);
      if (rect.width > 2 || rect.height > 2) {
        const inside = objects
          .forPage(editor.currentPage)
          .filter((obj) => obj.visible)
          // Закрашенные участки рамкой не выделяются: только через «Слои».
          .filter((obj) => !isMaskingStroke(obj))
          .filter((obj) => {
            const bounds = boundsOfTransforms([obj]);
            return (
              bounds.x < rect.x + rect.width &&
              bounds.x + bounds.width > rect.x &&
              bounds.y < rect.y + rect.height &&
              bounds.y + bounds.height > rect.y
            );
          })
          .map((obj) => obj.id);
        objects.select(inside);
        // Выделили рамкой на холсте — показываем свойства.
        if (inside.length > 0) ui.setRightTab('properties');
      }
    }
  }

  function onPointerUp(event: Konva.KonvaEventObject<PointerEvent>): void {
    finishGesture(pointerPoint(event));
    releasePointer();
    pointerDown = null;
  }

  /**
   * Страховка: отпускание кнопки или отмена указателя в любом месте окна.
   * Нужна, если указатель ушёл за пределы холста и события Konva не пришли.
   */
  function onWindowPointerEnd(event: PointerEvent): void {
    if (!editor.activeStroke && !editor.shapeDraft && !marqueeStart && !isPanning.value) return;
    finishGesture(deps.screenToPage(event.clientX, event.clientY));
    releasePointer();
    pointerDown = null;
  }

  function onWindowKeyBlur(): void {
    // Потеря фокуса окна (например, Alt+Tab во время рисования) —
    // доводим жест до конца, чтобы штрих не остался «висящим».
    if (editor.activeStroke || editor.shapeDraft) finishGesture(null);
    isPanning.value = false;
    panState = null;
  }

  onMounted(() => {
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    window.addEventListener('blur', onWindowKeyBlur);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('pointerup', onWindowPointerEnd);
    window.removeEventListener('pointercancel', onWindowPointerEnd);
    window.removeEventListener('blur', onWindowKeyBlur);
  });

  function onDoubleClick(event: Konva.KonvaEventObject<MouseEvent>): void {
    const id = objectIdFromTarget(event.target);
    if (!id) return;
    const obj = objects.byId(id);
    if (!obj) return;
    if (isMaskingStroke(obj)) return;
    objects.select([id]);
    if (obj.type === 'text') {
      editor.startTextEditing(id);
      ui.setRightTab('properties');
    } else if (obj.type === 'stamp') {
      ui.openModal('stampEditor', { templateId: obj.payload.templateId, objectId: id });
    } else if (obj.type === 'signature') {
      ui.openModal('signatureEditor', { signatureId: obj.payload.modelId, objectId: id });
    } else if (obj.type === 'drawing') {
      ui.openModal('drawingEditor', { objectId: id });
    }
  }

  /**
   * Правая кнопка мыши на холсте: контекстное меню «Сгруппировать / Удалить».
   *
   * Если кликнули по объекту вне выделения — сначала выделяем его (или всю его
   * группу), чтобы действия меню применялись к тому, на что нажали.
   */
  function onContextMenu(event: Konva.KonvaEventObject<PointerEvent>): void {
    event.evt.preventDefault();
    if (editor.viewOnly) return;
    const id = objectIdFromTarget(event.target);
    if (!id) {
      ui.closeContextMenu();
      return;
    }
    const obj = objects.byId(id);
    if (!obj) return;
    // Закрашенные участки на холсте не выделяются — и меню у них нет.
    if (isMaskingStroke(obj) && !objects.selectedIds.includes(id)) return;
    if (!objects.selectedIds.includes(id)) {
      objects.select(obj.groupId ? groupMembersOf(obj) : [id]);
    }
    ui.openContextMenu({
      x: event.evt.clientX,
      y: event.evt.clientY,
      ids: [...objects.selectedIds],
      groupId: obj.groupId ?? null,
      title:
        objects.selectedIds.length === 1
          ? 'Объект'
          : `Выбрано объектов: ${objects.selectedIds.length}`,
    });
  }

  /** Все объекты группы, к которой принадлежит объект. */
  function groupMembersOf(obj: EditorObject): string[] {
    if (!obj.groupId) return [obj.id];
    return objects.objects
      .filter((item) => item.groupId === obj.groupId)
      .map((item) => item.id);
  }

  function onWheel(event: Konva.KonvaEventObject<WheelEvent>): void {
    event.evt.preventDefault();
    const { deltaY, ctrlKey, metaKey, shiftKey, clientX, clientY } = event.evt;
    if (ctrlKey || metaKey) {
      // Зум колесом с Ctrl (как в браузере) — вокруг курсора.
      const stage = event.target.getStage();
      const rect = stage?.container().getBoundingClientRect();
      const focus = rect
        ? { x: clientX - rect.left, y: clientY - rect.top }
        : { x: clientX, y: clientY };
      if (deltaY < 0) editor.zoomIn(focus);
      else editor.zoomOut(focus);
      return;
    }
    // Обычное колесо — прокрутка, Shift — по горизонтали.
    if (shiftKey) editor.panBy(-deltaY, 0);
    else editor.panBy(-event.evt.deltaX, -deltaY);
  }

  /** Создание фигуры по нарисованной рамке. */
  function createShapeFromDraft(
    start: Point,
    end: Point,
    rect: { x: number; y: number; width: number; height: number },
    constrained: boolean,
  ): void {
    const tool = editor.tool;
    // Shift: у линии и стрелки — угол, кратный 45°; у треугольника — рамка
    // правильного треугольника (иначе он лишь равнобедренный); у остальных фигур
    // квадратная рамка (круг, квадрат, многоугольник в квадрате).
    if (constrained) {
      rect = tool === 'triangle' ? equilateralTriangleBox(start, end) : squareFromPoints(start, end);
    }
    const defaultStyle = settings.shapeDefaults;
    // Значения из параметров инструмента берём как есть: 0 — это осознанная
    // нулевая толщина, null — «без цвета». Раньше `0 || default` и
    // `null || default` подменяли выбор пользователя, и фигура рисовалась
    // с обводкой «по умолчанию».
    const toolStroke = editor.toolOptions.shape.stroke;
    const style = {
      stroke: toolStroke === '' ? null : toolStroke,
      strokeWidth: Math.max(0, editor.toolOptions.shape.strokeWidth ?? defaultStyle.strokeWidth),
      fill: editor.toolOptions.shape.fill,
    };
    const page = editor.currentPage;

    if (tool === 'whiteout') {
      addFromCanvas(
        [
          createWhiteoutObject({
            page,
            x: rect.x,
            y: rect.y,
            width: Math.max(4, rect.width),
            height: Math.max(4, rect.height),
            color: editor.toolOptions.whiteout.color || settings.settings.defaultWhiteoutColor,
          }),
        ],
        'Закрашивание',
      );
      return;
    }

    if (tool === 'highlight') {
      addFromCanvas(
        [
          createHighlightObject({
            page,
            x: rect.x,
            y: rect.y,
            width: Math.max(4, rect.width),
            height: Math.max(4, rect.height),
            color: editor.toolOptions.highlight.color || settings.settings.defaultHighlightColor,
          }),
        ],
        'Выделение',
      );
      return;
    }

    if (tool === 'line' || tool === 'arrow') {
      // Привязка к углам, кратным 45° (общая функция с предпросмотром).
      const target = constrained ? snapPointToAngle(start, end) : end;
      const bounds = normalizeRect(rectFromPoints(start, target));
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const points: [number, number, number, number] = [
        (start.x - bounds.x) / width,
        (start.y - bounds.y) / height,
        (target.x - bounds.x) / width,
        (target.y - bounds.y) / height,
      ];
      addFromCanvas(
        [
          createShapeObject(tool, {
            page,
            x: bounds.x,
            y: bounds.y,
            width,
            height,
            defaults: style,
            points,
          }),
        ],
        'Добавление линии',
      );
      return;
    }

    // Прямоугольник, эллипс, треугольник и многоугольник — одинаково рисуются
    // рамкой, отличаются только видом и параметрами.
    const kind: ShapeKind =
      tool === 'ellipse'
        ? 'ellipse'
        : tool === 'triangle'
          ? 'triangle'
          : tool === 'polygon'
            ? 'polygon'
            : 'rect';

    addFromCanvas(
      [
        createShapeObject(kind, {
          page,
          x: rect.x,
          y: rect.y,
          width: Math.max(4, rect.width),
          height: Math.max(4, rect.height),
          defaults: style,
          cornerRadius: editor.toolOptions.shape.cornerRadius,
          sides: kind === 'polygon' ? editor.toolOptions.shape.sides : undefined,
        }),
      ],
      'Добавление фигуры',
    );
  }

  /**
   * «Корректурный слой»: замена текста из исходного PDF.
   * Старый текст закрывается закрашиванием, новый добавляется сверху.
   */
  async function replacePdfTextAt(point: Point, keepStyle: boolean): Promise<void> {
    if (!pdfService.getDocument()) {
      insertText(point);
      return;
    }
    try {
      const blocks = await pdfService.getTextBlocks(editor.currentPage);
      const block = blocks.find(
        (item) =>
          point.x >= item.x &&
          point.x <= item.x + item.width &&
          point.y >= item.y &&
          point.y <= item.y + item.height,
      );
      if (!block) {
        insertText(point);
        return;
      }
      const whiteout = createWhiteoutObject({
        page: editor.currentPage,
        x: block.x - 1,
        y: block.y - 1,
        width: block.width + 2,
        height: block.height + 2,
        color: editor.toolOptions.whiteout.color || '#ffffff',
      });
      const textObject = createTextObject({
        page: editor.currentPage,
        x: block.x,
        y: block.y,
        width: Math.max(block.width + 24, 120),
        height: block.fontSize * 1.4,
        text: block.text,
        autoHeight: true,
        defaults: {
          fontId: settings.settings.defaultFontId,
          fontFamily: fonts.familyOf(settings.settings.defaultFontId),
          fontSize: keepStyle ? Math.max(6, Math.round(block.fontSize)) : settings.settings.defaultTextSize,
          color: settings.settings.defaultTextColor,
          align: 'left',
        },
      });
      addFromCanvas([whiteout, textObject], 'Замена текста PDF');
      editor.startTextEditing(textObject.id);
      ui.setRightTab('properties');
      ui.notify.info(
        'Режим корректурного слоя',
        'Исходный текст закрыт закрашиванием — измените текст в панели свойств.',
      );
    } catch {
      insertText(point);
    }
  }

  /** Диалог выбора изображений. */
  async function openImageDialog(): Promise<File[]> {
    return openFileDialog({ accept: ACCEPT.images, multiple: true });
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    onContextMenu,
    onWheel,
    isPanning,
  };
}
