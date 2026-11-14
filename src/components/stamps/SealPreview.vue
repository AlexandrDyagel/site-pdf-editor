<script setup lang="ts">
/**
 * Превью круглой печати с интерактивными строками, кольцами, логотипом
 * и картинкой-образцом под оттиском.
 *
 * Рисуется тем же `computeStampLayout` + `paintStampLayout`, что и объект на
 * странице и экспорт в PDF, поэтому конструктор показывает ровно то, что
 * попадёт в документ.
 *
 * Взаимодействие:
 *  - клик по надписи выбирает строку (появляются маркеры угла);
 *  - клик по строке центра выбирает её (маркеры растяжения слева/справа);
 *  - клик по кольцу выбирает его (пунктирный контур); кольцо можно тянуть —
 *    меняется расстояние до предыдущего;
 *  - логотип выбирается кликом: его можно тащить, растягивать за углы
 *    (Shift — с сохранением пропорций) и вращать за круглый маркер;
 *  - картинка-образец под печатью ведёт себя так же и выделяется кликом по
 *    видимой части вокруг оттиска;
 *  - правый клик по пустому месту — меню «добавить кольцо/текст/образец»;
 *  - колесо мыши или перетаскивание средней кнопкой (или с зажатым пробелом)
 *    панорамирует превью.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import type { SealMultiSelection, StampTemplate } from '@/types';
import { computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import type { StampLineLayout } from '@/services/stampRenderService';
import { measureTextWidth } from '@/utils/textLayout';
import { sealArcMinSpan } from '@/services/sealRenderService';
import type { SealRingLineGeometry } from '@/services/sealRenderService';
import type { SealReference } from '@/services/sealDraft';
import { useFontsStore } from '@/stores/fonts';
import { loadImage } from '@/utils/image';

const nativeCanvasRect = HTMLCanvasElement.prototype.getBoundingClientRect;

const props = withDefaults(
  defineProps<{
    template: StampTemplate;
    zoom: number;
    handles?: boolean;
    selectedLineId?: string | null;
    selectedCenterIndex?: number | null;
    selectedRingIndex?: number | null;
    selectedStraightLineId?: string | null;
    selectedSymbolId?: string | null;
    selectedLogo?: boolean;
    selectedLogoIndex?: number | null;
    selectedReference?: boolean;
    reference?: SealReference | null;
    selection?: SealMultiSelection | null;
  }>(),
  {
    handles: true,
    selectedLineId: null,
    selectedCenterIndex: null,
    selectedRingIndex: null,
    selectedStraightLineId: null,
    selectedSymbolId: null,
    selectedLogo: false,
    selectedLogoIndex: null,
    selectedReference: false,
    reference: null,
    selection: null,
  },
);

const emit = defineEmits<{
  'select-line': [lineId: string | null];
  'clear-selection': [];
  'span-change': [lineId: string, angle: number];
  'line-move': [lineId: string, radiusOffset: number, angleOffset: number];
  'text-hit': [lineId: string];
  'center-hit': [lineIndex: number];
  'center-select': [lineIndex: number];
  'center-stretch': [lineIndex: number, width: number];
  'center-move': [lineIndex: number, offsetX: number, offsetY: number];
  'center-rotate': [lineIndex: number, rotation: number];
  'group-rotate': [deltaAngle: number, pivotX: number, pivotY: number];
  'ring-select': [ringIndex: number];
  'ring-resize': [ringIndex: number, radius: number];
  'ring-delete': [ringIndex: number];
  'logo-select': [logoIndex: number];
  'logo-move': [logoIndex: number, offsetX: number, offsetY: number];
  'logo-resize': [logoIndex: number, width: number, height: number];
  'logo-rotate': [logoIndex: number, rotation: number];
  'reference-select': [];
  'reference-move': [x: number, y: number];
  'reference-resize': [width: number, height: number];
  'reference-rotate': [rotation: number];
  'add-ring': [];
  'add-text': [];
  'add-center-text': [];
  'add-reference': [];
  'zoom-change': [factor: number];
  'selection-change': [selection: SealMultiSelection | null];
  'group-move': [dx: number, dy: number];
  'straight-line-select': [lineId: string];
  'straight-line-move': [lineId: string, x: number, y: number];
  'straight-line-resize': [lineId: string, x: number, y: number, length: number, rotation: number];
  'straight-line-rotate': [lineId: string, rotation: number];
  'symbol-select': [symbolId: string];
  'symbol-move': [symbolId: string, x: number, y: number];
  'symbol-rotate': [symbolId: string, rotation: number];
  'edit-line': [lineId: string];
  'delete-line': [lineId: string];
  'center-edit': [index: number];
  'center-delete': [index: number];
}>();

const fonts = useFontsStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const logoImages = ref<(HTMLImageElement | null)[]>([]);
const logoSources = computed(() =>
  Array.isArray(props.template.logos) && props.template.logos.length
    ? props.template.logos
    : props.template.logo
      ? [props.template.logo]
      : [],
);
const logos = computed(() => layout.value.logos);
const selectedLogoGeometry = computed(() => {
  const index = props.selectedLogoIndex ?? (props.selectedLogo ? 0 : null);
  if (index === null) return null;
  return layout.value.logos[index] ?? null;
});

const size = computed(() => Math.max(24, Math.min(props.template.width, props.template.height)));
const displaySize = computed(() => Math.round(size.value * props.zoom * 100) / 100);
const layout = computed(() =>
  computeStampLayout(props.template, (fontId) => fonts.familyOf(fontId)),
);

/** Панорама превью: сдвиг в экранных пикселях. */
const pan = ref({ x: 0, y: 0 });
const spacePressed = ref(false);
const panning = ref(false);
/** Рамка выделения в координатах печати. */
const marquee = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
/** Живая размерная линия между кольцами при перетаскивании. */
const ringAnnotation = ref<{ ringIndex: number; radius: number; angle: number } | null>(null);
/** Красная размерная линия при растягивании прямого объекта. */
const strokeAnnotation = ref<{
  endpoint: 'start' | 'end';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  distance: number;
} | null>(null);
const overlay = ref<HTMLCanvasElement | null>(null);
/** Размер рабочей области превью в CSS-пикселях. */
const viewport = ref({ w: 0, h: 0 });
let resizeObserver: ResizeObserver | null = null;
/** Курсор наведения на выбранное кольцо: две стрелки, как у маркеров. */
const ringHover = ref<'' | 'ew-resize' | 'ns-resize'>('');
/** Оси центрирования показываются только во время перемещения текста. */
const textMoving = ref(false);
/** Прилипание к осям: показываются только те оси, к которым текст прилип. */
const snapAxes = ref({ vertical: false, horizontal: false, circular: false });
const snapCircleRadius = ref<number | null>(null);
/** Оси видны, только пока есть прилипание под зажатой мышью. */
const guidesVisible = computed(
  () => snapAxes.value.vertical || snapAxes.value.horizontal || snapAxes.value.circular,
);
const cursorStyle = computed(() => {
  if (panning.value) return 'grabbing';
  if (spacePressed.value) return 'grab';
  if (ringHover.value) return ringHover.value;
  return 'default';
});

/** Контекстное меню: текст, кольцо или пустое место. */
type MenuState =
  | { kind: 'text'; lineId: string; x: number; y: number }
  | { kind: 'center'; index: number; x: number; y: number }
  | { kind: 'ring'; ringIndex: number; x: number; y: number }
  | { kind: 'empty'; x: number; y: number };
const menu = ref<MenuState | null>(null);

/* ======================== Отрисовка ======================== */

async function ensureLogo(): Promise<void> {
  const sources = (
    Array.isArray(props.template.logos) && props.template.logos.length
      ? props.template.logos
      : props.template.logo
        ? [props.template.logo]
        : []
  ).filter((item) => Boolean(item.src));
  if (sources.length === 0) {
    logoImages.value = [];
    return;
  }
  logoImages.value = await Promise.all(
    sources.map(async (logo) => {
      try {
        return await loadImage(logo.src);
      } catch {
        return null;
      }
    }),
  );
}

/** Цвет штриха выбранного кольца: контрастный цвету печати. */
function ringSelectionColor(): string {
  const value = layout.value.color.replace('#', '');
  const hex = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  const red = parseInt(hex.slice(0, 2), 16) || 0;
  const green = parseInt(hex.slice(2, 4), 16) || 0;
  const blue = parseInt(hex.slice(4, 6), 16) || 0;
  // Синяя/фиолетовая печать — оранжевый штрих, красная — голубой,
  // зелёная — малиновый; для остальных — красный.
  if (blue > red * 1.15 && blue >= green) return '#ff7a00';
  if (red > blue * 1.25 && red >= green) return '#00b7ff';
  if (green > red * 1.1 && green > blue * 1.1) return '#ff2d78';
  return '#e11d48';
}

/** «Палочка» от верхней кромки рамки до круглого маркера поворота. */
function drawRotationStem(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
): void {
  void width;
  const radians = (rotation * Math.PI) / 180;
  const top = height / 2;
  const markerDistance = height / 2 + 22 / Math.max(0.4, props.zoom);
  context.save();
  context.setLineDash([]);
  context.lineWidth = 1 / props.zoom;
  context.strokeStyle = '#355ef0';
  context.beginPath();
  context.moveTo(cx + Math.sin(radians) * top, cy - Math.cos(radians) * top);
  context.lineTo(cx + Math.sin(radians) * markerDistance, cy - Math.cos(radians) * markerDistance);
  context.stroke();
  context.restore();
}

function inkTop(line: { baseline: number; fontSize: number; inkAscent?: number }): number {
  return line.baseline - (line.inkAscent ?? line.fontSize * 0.72);
}
function inkBottom(line: { baseline: number; fontSize: number; inkDescent?: number }): number {
  return line.baseline + (line.inkDescent ?? line.fontSize * 0.2);
}
function inkCenter(line: {
  baseline: number;
  fontSize: number;
  inkAscent?: number;
  inkDescent?: number;
  inkCenterY?: number;
}): number {
  return line.inkCenterY ?? (inkTop(line) + inkBottom(line)) / 2;
}

/** Рамка вокруг повёрнутой строки текста (в координатах печати). */
function drawTextFrame(
  context: CanvasRenderingContext2D,
  line: StampLineLayout,
  color: string,
  padding = 1,
): void {
  const centerX = line.x + line.width / 2;
  const centerY = inkCenter(line);
  const width = line.width + padding * 2;
  const height = inkBottom(line) - inkTop(line) + padding * 2;
  context.save();
  context.translate(centerX, centerY);
  context.rotate(((line.rotation ?? 0) * Math.PI) / 180);
  context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  context.lineWidth = 3 / props.zoom;
  context.strokeRect(-width / 2, -height / 2, width, height);
  context.strokeStyle = color;
  context.lineWidth = 1 / props.zoom;
  context.strokeRect(-width / 2, -height / 2, width, height);
  context.restore();
}

/** Дуговая рамка вокруг текста по кольцу. */
function drawArcFrame(
  context: CanvasRenderingContext2D,
  line: SealRingLineGeometry,
  color: string,
): void {
  if (line.chars.length === 0) return;
  const outer = line.radius + line.fontSize * 0.85;
  const inner = Math.max(1, line.radius - line.fontSize * 0.85);
  const start = (line.startAngle * Math.PI) / 180;
  const end = (line.endAngle * Math.PI) / 180;
  const anticlockwise = line.endAngle < line.startAngle;
  context.save();
  context.beginPath();
  context.arc(line.cx, line.cy, outer, start, end, anticlockwise);
  context.arc(line.cx, line.cy, inner, end, start, !anticlockwise);
  context.closePath();
  context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  context.lineWidth = 3 / props.zoom;
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 1 / props.zoom;
  context.stroke();
  context.restore();
}

function draw(): void {
  const element = canvas.value;
  if (!element) return;
  const parent = element.parentElement;
  if (!parent) return;
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, parent.clientWidth);
  const height = Math.max(1, parent.clientHeight);
  viewport.value = { w: width, h: height };
  element.width = Math.max(1, Math.round(width * ratio));
  element.height = Math.max(1, Math.round(height * ratio));
  const context = element.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  context.scale(ratio, ratio);
  // Печать рисуется в центре рабочей области; панорама смещает её.
  context.translate(width / 2 + pan.value.x, height / 2 + pan.value.y);
  context.scale(props.zoom, props.zoom);
  context.translate(-size.value / 2, -size.value / 2);
  paintStampLayout(context, layout.value, { logoImages: logoImages.value });

  // Выбранное кольцо — очень мелкий штрих, не сплошная линия.
  if (props.selectedRingIndex !== null && layout.value.seal) {
    const ring = layout.value.seal.ink.rings[props.selectedRingIndex];
    if (ring) {
      context.save();
      context.setLineDash([2 / props.zoom, 2 / props.zoom]);
      context.lineWidth = 1.05 / props.zoom;
      context.strokeStyle = ringSelectionColor();
      context.beginPath();
      context.arc(ring.cx, ring.cy, ring.radius, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  // Выбранная прямая линия — тонкий синий контур поверх штриха.
  if (selectedStraightLine.value) {
    const line = selectedStraightLine.value;
    context.save();
    context.setLineDash([3 / props.zoom, 2 / props.zoom]);
    context.lineWidth = 1 / props.zoom;
    context.strokeStyle = '#355ef0';
    context.beginPath();
    context.moveTo(line.x1, line.y1);
    context.lineTo(line.x2, line.y2);
    context.stroke();
    context.restore();
  }

  // Выбранная дуговая строка — красная дуговая рамка; строка центра —
  // повёрнутая прямоугольная рамка вокруг букв.
  context.save();
  context.lineWidth = 1 / props.zoom;
  if (selectedGeometry.value) drawArcFrame(context, selectedGeometry.value, '#e11d48');
  if (props.selectedCenterIndex !== null && layout.value.lines[props.selectedCenterIndex]) {
    drawTextFrame(context, layout.value.lines[props.selectedCenterIndex], '#e11d48');
  }
  if (selectedSymbol.value) {
    const symbol = selectedSymbol.value;
    context.save();
    context.translate(symbol.cx, symbol.cy);
    context.rotate((symbol.rotation * Math.PI) / 180);
    context.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    context.lineWidth = 3 / props.zoom;
    context.strokeRect(-symbol.width / 2 - 2, -symbol.height / 2 - 2, symbol.width + 4, symbol.height + 4);
    context.strokeStyle = '#2f6bff';
    context.lineWidth = 1.2 / props.zoom;
    context.strokeRect(-symbol.width / 2 - 2, -symbol.height / 2 - 2, symbol.width + 4, symbol.height + 4);
    context.restore();
  }
  context.restore();

  // Выбранный логотип — рамка как у картинки на холсте (сплошная синяя)
  // плюс «палочка» от рамки до маркера поворота.
  if (selectedLogoGeometry.value) {
    const logo = selectedLogoGeometry.value;
    const cx = logo.x + logo.width / 2;
    const cy = logo.y + logo.height / 2;
    context.save();
    drawRotationStem(context, cx, cy, logo.width, logo.height, logo.rotation ?? 0);
    context.translate(cx, cy);
    context.rotate(((logo.rotation ?? 0) * Math.PI) / 180);
    context.lineWidth = 1.2 / props.zoom;
    context.strokeStyle = '#355ef0';
    context.strokeRect(-logo.width / 2, -logo.height / 2, logo.width, logo.height);
    context.restore();
  }

  // Выбранный образец — такая же рамка, как у объекта на холсте.
  if (props.selectedReference && props.reference && !props.reference.locked) {
    const reference = props.reference;
    context.save();
    drawRotationStem(context, reference.x, reference.y, reference.width, reference.height, reference.rotation);
    context.translate(reference.x, reference.y);
    context.rotate((reference.rotation * Math.PI) / 180);
    context.lineWidth = 1.2 / props.zoom;
    context.strokeStyle = '#355ef0';
    context.strokeRect(-reference.width / 2, -reference.height / 2, reference.width, reference.height);
    context.restore();
  }

  // Групповое выделение: тонкая сплошная линия, как у объектов на холсте.
  if (props.selection) {
    context.save();
    context.lineWidth = 1 / props.zoom;
    context.strokeStyle = '#e11d48';
    for (const lineId of props.selection.lines) {
      const line = layout.value.seal?.ringLines.find((item) => item.lineId === lineId);
      if (line) drawArcFrame(context, line, '#e11d48');
    }
    for (const index of props.selection.centers) {
      const line = layout.value.lines[index];
      if (line) drawTextFrame(context, line, '#e11d48');
    }
    context.strokeStyle = '#355ef0';
    for (const lineId of props.selection.strokes ?? []) {
      const line = layout.value.seal?.straightLines.find((item) => item.lineId === lineId);
      if (!line) continue;
      context.save();
      context.strokeStyle = '#e11d48';
      context.translate(line.cx, line.cy);
      context.rotate((line.rotation * Math.PI) / 180);
      const halfHeight = Math.max(2, line.width / 2);
      context.strokeRect(
        -line.length / 2 - 3,
        -halfHeight - 3,
        line.length + 6,
        halfHeight * 2 + 6,
      );
      context.restore();
    }
    for (const index of props.selection.logos) {
      const logo = layout.value.logos[index];
      if (!logo) continue;
      context.save();
      context.translate(logo.x + logo.width / 2, logo.y + logo.height / 2);
      context.rotate(((logo.rotation ?? 0) * Math.PI) / 180);
      context.strokeRect(-logo.width / 2, -logo.height / 2, logo.width, logo.height);
      context.restore();
    }
    for (const index of props.selection.rings) {
      const ring = layout.value.seal?.ink.rings[index];
      if (ring) {
        context.strokeStyle = ringSelectionColor();
        context.beginPath();
        context.arc(ring.cx, ring.cy, ring.radius, 0, Math.PI * 2);
        context.stroke();
      }
    }
    context.restore();
  }
}

/** Полноразмерный слой поверх превью: маркиза, оси центрирования, размеры. */
function drawOverlay(): void {
  const element = overlay.value;
  if (!element) return;
  const root = element.parentElement;
  if (!root) return;
  const rootRect = root.getBoundingClientRect();
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  element.width = Math.max(1, Math.round(rootRect.width * ratio));
  element.height = Math.max(1, Math.round(rootRect.height * ratio));
  const context = element.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rootRect.width, rootRect.height);

  const zoom = props.zoom;
  const center = {
    x: rootRect.width / 2 + pan.value.x,
    y: rootRect.height / 2 + pan.value.y,
  };
  const toScreen = (x: number, y: number): { x: number; y: number } => ({
    x: center.x + (x - size.value / 2) * zoom,
    y: center.y + (y - size.value / 2) * zoom,
  });

  // Оси центрирования: только те, к которым текст прилип, и только пока
  // кнопка мыши зажата. Цвет — красный, чтобы не сливаться с печатью.
  const axisColor = '#e11d48';
  const axes = snapAxes.value;
  if (axes.vertical || axes.horizontal) {
    context.save();
    context.setLineDash([5, 4]);
    context.lineWidth = 1;
    context.strokeStyle = axisColor;
    context.beginPath();
    if (axes.horizontal) {
      context.moveTo(0, center.y);
      context.lineTo(rootRect.width, center.y);
    }
    if (axes.vertical) {
      context.moveTo(center.x, 0);
      context.lineTo(center.x, rootRect.height);
    }
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = axisColor;
    context.beginPath();
    context.arc(center.x, center.y, 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  const line = selectedStraightLine.value;
  if (line) {
    const centerPoint = toScreen(line.cx, line.cy);
    const rotate = strokeRotatePoint.value;
    context.save();
    context.strokeStyle = axisColor;
    context.lineWidth = 1;
    if (rotate) {
      context.beginPath();
      context.moveTo(centerPoint.x, centerPoint.y);
      context.lineTo(rotate.x, rotate.y);
      context.stroke();
    }
    context.fillStyle = '#ffffff';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(centerPoint.x, centerPoint.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  // Круговая ось: строка прилипла к середине кольцевого зазора.
  if (axes.circular && snapCircleRadius.value !== null) {
    context.save();
    context.setLineDash([5, 4]);
    context.lineWidth = 1;
    context.strokeStyle = axisColor;
    context.beginPath();
    context.arc(center.x, center.y, snapCircleRadius.value * zoom, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  // Маркер центра строки — такой же, как у группы строк.
  const selectedCenters = props.selection?.centers ?? [];
  const markerLines =
    selectedCenters.length > 0
      ? selectedCenters.map((index) => layout.value.lines[index]).filter((item) => Boolean(item))
      : props.selectedCenterIndex !== null && layout.value.lines[props.selectedCenterIndex]
        ? [layout.value.lines[props.selectedCenterIndex]]
        : [];
  if (markerLines.length > 0) {
    const left = Math.min(...markerLines.map((item) => item.x));
    const right = Math.max(...markerLines.map((item) => item.x + item.width));
    const top = Math.min(...markerLines.map((item) => inkTop(item)));
    const bottom = Math.max(...markerLines.map((item) => inkBottom(item)));
    const marker = toScreen((left + right) / 2, (top + bottom) / 2);
    context.save();
    if (centerRotation.value) {
      context.strokeStyle = axisColor;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(marker.x, marker.y);
      context.lineTo(centerRotation.value.marker.x, centerRotation.value.marker.y);
      context.stroke();
    }
    context.fillStyle = '#ffffff';
    context.strokeStyle = axisColor;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(marker.x, marker.y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  // Рамка выделения — тонкая, как на холсте.
  if (marquee.value) {
    const rect = marquee.value;
    const p1 = toScreen(Math.min(rect.x1, rect.x2), Math.min(rect.y1, rect.y2));
    const p2 = toScreen(Math.max(rect.x1, rect.x2), Math.max(rect.y1, rect.y2));
    context.save();
    context.fillStyle = 'rgba(53, 94, 240, 0.12)';
    context.fillRect(p1.x, p1.y, Math.max(1, p2.x - p1.x), Math.max(1, p2.y - p1.y));
    context.setLineDash([3, 3]);
    context.lineWidth = 1;
    context.strokeStyle = '#355ef0';
    context.strokeRect(p1.x, p1.y, Math.max(1, p2.x - p1.x), Math.max(1, p2.y - p1.y));
    context.restore();
  }

  // Живая размерная линия между кольцами при перетаскивании.
  const annotation = ringAnnotation.value;
  const rings = layout.value.seal?.ink.rings ?? [];
  if (annotation && rings[annotation.ringIndex] && rings[annotation.ringIndex - 1]) {
    const previous = rings[annotation.ringIndex - 1];
    const current = rings[annotation.ringIndex];
    const fromRadius = previous.radius - previous.width / 2;
    const toRadius = annotation.radius + current.width / 2;
    const direction = { x: Math.cos(annotation.angle), y: Math.sin(annotation.angle) };
    const center = toScreen(size.value / 2, size.value / 2);
    const p1 = {
      x: center.x + direction.x * fromRadius * zoom,
      y: center.y + direction.y * fromRadius * zoom,
    };
    const p2 = {
      x: center.x + direction.x * toRadius * zoom,
      y: center.y + direction.y * toRadius * zoom,
    };
    const distance = Math.abs(fromRadius - toRadius);
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = '#e11d48';
    context.beginPath();
    context.moveTo(p1.x, p1.y);
    context.lineTo(p2.x, p2.y);
    context.stroke();
    // Стрелки на концах.
    const angle = annotation.angle;
    const arrow = 5;
    for (const point of [p1, p2]) {
      context.beginPath();
      context.moveTo(
        point.x + Math.cos(angle + 2.6) * arrow,
        point.y + Math.sin(angle + 2.6) * arrow,
      );
      context.lineTo(point.x, point.y);
      context.lineTo(
        point.x + Math.cos(angle - 2.6) * arrow,
        point.y + Math.sin(angle - 2.6) * arrow,
      );
      context.stroke();
    }
    const middle = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const text = `${distance.toFixed(1)} pt`;
    context.font = '600 11px Ui Sans, system-ui, sans-serif';
    const textWidth = context.measureText(text).width;
    const perp = { x: -Math.sin(angle), y: Math.cos(angle) };
    // У мелких зазоров линия короткая — выносим подпись наружу по радиусу,
    // чтобы число всегда читалось.
    const labelX = middle.x + direction.x * 30 + perp.x * 10;
    const labelY = middle.y + direction.y * 30 + perp.y * 10;
    context.beginPath();
    context.moveTo(middle.x, middle.y);
    context.lineTo(labelX, labelY);
    context.stroke();
    context.fillStyle = 'rgba(255, 255, 255, 0.94)';
    context.strokeStyle = '#fda4af';
    const boxX = labelX - textWidth / 2 - 4;
    const boxY = labelY - 8;
    context.beginPath();
    context.roundRect(boxX, boxY, textWidth + 8, 16, 4);
    context.fill();
    context.stroke();
    context.fillStyle = '#be123c';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, labelX, labelY + 0.5);
    context.restore();
  }

  // Красная размерная линия при растягивании прямой линии.
  if (strokeAnnotation.value) {
    const info = strokeAnnotation.value;
    const start = toScreen(info.x1, info.y1);
    const end = toScreen(info.x2, info.y2);
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = '#e11d48';
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    for (const point of [start, end]) {
      context.beginPath();
      context.moveTo(point.x + Math.cos(angle + 2.6) * 5, point.y + Math.sin(angle + 2.6) * 5);
      context.lineTo(point.x, point.y);
      context.lineTo(point.x + Math.cos(angle - 2.6) * 5, point.y + Math.sin(angle - 2.6) * 5);
      context.stroke();
    }
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const text = `${info.distance.toFixed(1)} pt`;
    context.font = '600 11px Ui Sans, system-ui, sans-serif';
    const width = context.measureText(text).width;
    context.fillStyle = 'rgba(255,255,255,0.94)';
    context.strokeStyle = '#fda4af';
    context.beginPath();
    context.roundRect(middle.x - width / 2 - 4, middle.y - 18, width + 8, 16, 4);
    context.fill();
    context.stroke();
    context.fillStyle = '#be123c';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, middle.x, middle.y - 10);
    context.restore();
  }
}

watch(() => props.template, async () => {
  await ensureLogo();
  draw();
  drawOverlay();
}, { deep: true });
watch(() => props.zoom, () => {
  draw();
  drawOverlay();
});
watch(pan, () => { draw(); drawOverlay(); }, { deep: true });
watch(() => props.selectedRingIndex, () => { draw(); drawOverlay(); });
watch(() => props.selectedStraightLineId, () => { draw(); drawOverlay(); });
watch(strokeAnnotation, () => drawOverlay(), { deep: true });
watch(() => props.selectedCenterIndex, () => { draw(); drawOverlay(); });
watch(() => props.selectedLogoIndex, () => { draw(); drawOverlay(); });
watch(() => props.selectedLogo, () => { draw(); drawOverlay(); });
watch(() => props.selectedReference, () => { draw(); drawOverlay(); });
watch(() => props.selection, () => { draw(); drawOverlay(); }, { deep: true });
watch(textMoving, () => drawOverlay());
watch(snapAxes, () => drawOverlay(), { deep: true });
watch(snapCircleRadius, () => drawOverlay());
watch(marquee, () => drawOverlay(), { deep: true });
watch(ringAnnotation, () => drawOverlay(), { deep: true });
watch(() => props.reference, () => { draw(); drawOverlay(); }, { deep: true });
watch(() => fonts.loadedOnce, () => { draw(); drawOverlay(); });

/* ======================== Геометрия и попадания ======================== */

function toSealPoint(event: MouseEvent): { x: number; y: number } | null {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: (event.clientX - (rect.left + rect.width / 2) - pan.value.x) / props.zoom + size.value / 2,
    y: (event.clientY - (rect.top + rect.height / 2) - pan.value.y) / props.zoom + size.value / 2,
  };
}

function hitRingLine(point: { x: number; y: number }): string | null {
  const seal = layout.value.seal;
  if (!seal) return null;
  for (const ringLine of seal.ringLines) {
    for (const char of ringLine.chars) {
      const radians = (char.angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const glyphWidth = char.fontSize * 0.6;
      const centerX = char.x + cos * (glyphWidth / 2) + sin * (char.fontSize * 0.35);
      const centerY = char.y + sin * (glyphWidth / 2) - cos * (char.fontSize * 0.35);
      const reach = Math.max(4, char.fontSize * 0.7);
      if (Math.hypot(point.x - centerX, point.y - centerY) <= reach) {
        return ringLine.lineId;
      }
    }
  }
  return null;
}

function hitRing(point: { x: number; y: number }): number | null {
  const rings = layout.value.seal?.ink.rings ?? [];
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    const distance = Math.hypot(point.x - ring.cx, point.y - ring.cy);
    const reach = ring.width / 2 + 1.2;
    if (Math.abs(distance - ring.radius) <= reach) return index;
  }
  return null;
}

function hitCenterLine(point: { x: number; y: number }): number | null {
  let best: { index: number; score: number } | null = null;
  for (const [index, line] of layout.value.lines.entries()) {
    if (!line.text.trim()) continue;
    const cx = line.x + line.width / 2;
    const cy = inkCenter(line);
    const rad = ((line.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const localX = cx + dx * cos + dy * sin;
    const localY = cy - dx * sin + dy * cos;
    if (localY < inkTop(line) - 1.5 || localY > inkBottom(line) + 1.5) continue;
    let cursor = line.x;
    for (const char of line.text) {
      const charWidth = measureTextWidth(char, {
        fontFamily: line.family,
        fontSize: line.fontSize,
        bold: line.bold,
        italic: line.italic,
        letterSpacing: 0,
        wordSpacing: 0,
        lineHeight: 1.35,
      });
      const advance = charWidth + line.letterSpacing + (char === ' ' ? (line.wordSpacing ?? 0) : 0);
      if (
        char !== ' ' &&
        charWidth > 0.1 &&
        localX >= cursor - 1.5 &&
        localX <= cursor + charWidth + 1.5
      ) {
        const score = Math.abs(localY - cy) + Math.abs(localX - (cursor + charWidth / 2)) * 0.2;
        if (!best || score < best.score) best = { index, score };
      }
      cursor += advance;
    }
    // Пробел внутри строки тоже считается её областью, но пустое место
    // вокруг (в том числе старая горизонтальная область повёрнутой строки)
    // строку не выбирает.
    if (
      localX >= line.x - 1.5 &&
      localX <= line.x + line.width + 1.5 &&
      (!best || Math.abs(localY - cy) < best.score)
    ) {
      const score = Math.abs(localY - cy) + 0.6;
      if (!best || score < best.score) best = { index, score };
    }
  }
  return best?.index ?? null;
}

function hitLogo(point: { x: number; y: number }): number | null {
  // Верхний (последний добавленный) логотип получает клик первым.
  for (let index = layout.value.logos.length - 1; index >= 0; index -= 1) {
    const logo = layout.value.logos[index];
    if (
      pointInRotatedRect(
        point,
        logo.x + logo.width / 2,
        logo.y + logo.height / 2,
        logo.width,
        logo.height,
        logo.rotation ?? 0,
      )
    ) {
      return index;
    }
  }
  return null;
}

function pointInRotatedRect(
  point: { x: number; y: number },
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
): boolean {
  const radians = (-rotation * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(localX) <= width / 2 + 2 && Math.abs(localY) <= height / 2 + 2;
}

function hitReference(point: { x: number; y: number }): boolean {
  const reference = props.reference;
  if (!reference || !reference.visible || reference.locked) return false;
  return pointInRotatedRect(point, reference.x, reference.y, reference.width, reference.height, reference.rotation);
}

/** Точка вне самого оттиска — там образец можно взять мышью. */
function isOutsideSeal(point: { x: number; y: number }): boolean {
  const rings = layout.value.seal?.ink.rings ?? [];
  const outer = rings.length ? rings[0].radius + rings[0].width / 2 : size.value / 2;
  return Math.hypot(point.x - size.value / 2, point.y - size.value / 2) > outer + 2;
}

/* ======================== Маркеры ======================== */

/** Координаты печати → пиксели рабочей области с учётом панорамы. */
function screenPoint(x: number, y: number): { x: number; y: number } {
  const { w, h } = viewport.value;
  return {
    x: w / 2 + pan.value.x + (x - size.value / 2) * props.zoom,
    y: h / 2 + pan.value.y + (y - size.value / 2) * props.zoom,
  };
}

/** Для тестов и отладки: координаты печати → координаты окна. */
function exposePreviewDebug(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__SEAL_PREVIEW__ = {
    client: (x: number, y: number) => {
      const element = canvas.value;
      if (!element) return { x: 0, y: 0 };
      // Настоящий rect: тесты могут подменять его для пересчёта координат.
      const rect = nativeCanvasRect.call(element);
      const point = screenPoint(x, y);
      return { x: rect.left + point.x, y: rect.top + point.y };
    },
    zoom: () => props.zoom,
    size: () => size.value,
    pan: () => ({ ...pan.value }),
    viewport: () => ({ ...viewport.value }),
    ringGap: () => {
      const info = ringAnnotation.value;
      const rings = layout.value.seal?.ink.rings ?? [];
      const current = info ? rings[info.ringIndex] : null;
      const previous = info ? rings[info.ringIndex - 1] : null;
      if (!info || !current || !previous) return null;
      const gap =
        previous.radius - previous.width / 2 - (info.radius + current.width / 2);
      return Math.round(gap * 10) / 10;
    },
    axes: () => ({ ...snapAxes.value }),
    ringStroke: () => ringSelectionColor(),
    strokeAnnotation: () => (strokeAnnotation.value ? { ...strokeAnnotation.value } : null),
  };
}

/** Положение картинки-образца на экране (с панорамой и зумом). */
function referenceStyle(reference: SealReference): Record<string, string> {
  const center = screenPoint(reference.x, reference.y);
  return {
    left: `${center.x - (reference.width * props.zoom) / 2}px`,
    top: `${center.y - (reference.height * props.zoom) / 2}px`,
    width: `${reference.width * props.zoom}px`,
    height: `${reference.height * props.zoom}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `rotate(${reference.rotation}deg)`,
    opacity: String(reference.opacity),
  };
}

const selectedGeometry = computed(() => {
  if (!props.selectedLineId) return null;
  return layout.value.seal?.ringLines.find((item) => item.lineId === props.selectedLineId) ?? null;
});

const selectedStraightLine = computed(() => {
  if (!props.selectedStraightLineId) return null;
  return (
    layout.value.seal?.straightLines.find((item) => item.lineId === props.selectedStraightLineId) ?? null
  );
});

const selectedSymbol = computed(() => {
  if (!props.selectedSymbolId) return null;
  return layout.value.seal?.symbols.find((item) => item.symbolId === props.selectedSymbolId) ?? null;
});

const strokeHandlePoints = computed(() => {
  const line = selectedStraightLine.value;
  if (!line) return [] as { endpoint: 'start' | 'end'; x: number; y: number }[];
  return [
    { endpoint: 'start' as const, ...screenPoint(line.x1, line.y1) },
    { endpoint: 'end' as const, ...screenPoint(line.x2, line.y2) },
  ];
});

const strokeRotatePoint = computed(() => {
  const line = selectedStraightLine.value;
  if (!line) return null;
  const radians = (line.rotation * Math.PI) / 180;
  const distance = 22 / Math.max(0.4, props.zoom);
  return screenPoint(
    line.cx + Math.sin(radians) * distance,
    line.cy - Math.cos(radians) * distance,
  );
});

const handlePoints = computed(() => {
  const ringLine = selectedGeometry.value;
  if (!ringLine || ringLine.chars.length === 0) return [] as { angle: number; x: number; y: number }[];
  return [ringLine.startAngle, ringLine.endAngle].map((angle) => {
    const radians = (angle * Math.PI) / 180;
    return {
      angle,
      ...screenPoint(
        ringLine.cx + Math.cos(radians) * ringLine.radius,
        ringLine.cy + Math.sin(radians) * ringLine.radius,
      ),
    };
  });
});

const centerRotation = computed(() => {
  const selectedCenters = props.selection?.centers ?? [];
  if (selectedCenters.length > 1) {
    const lines = selectedCenters
      .map((index) => layout.value.lines[index])
      .filter((item) => Boolean(item));
    if (lines.length === 0) return null;
    const left = Math.min(...lines.map((item) => item.x));
    const right = Math.max(...lines.map((item) => item.x + item.width));
    const top = Math.min(...lines.map((item) => inkTop(item)));
    const bottom = Math.max(...lines.map((item) => inkBottom(item)));
    const pivotX = (left + right) / 2;
    const pivotY = (top + bottom) / 2;
    const marker = screenPoint(pivotX, top - 22 / Math.max(0.4, props.zoom));
    return { kind: 'group' as const, pivotX, pivotY, marker, rotation: 0 };
  }
  if (props.selectedCenterIndex === null) return null;
  const line = layout.value.lines[props.selectedCenterIndex];
  if (!line) return null;
  const centerX = line.x + line.width / 2;
  const centerY = inkCenter(line);
  const rotation = line.rotation ?? 0;
  const radians = (rotation * Math.PI) / 180;
  const distance = (line.inkAscent ?? line.fontSize * 0.72) + 22 / Math.max(0.4, props.zoom);
  const marker = screenPoint(
    centerX + Math.sin(radians) * distance,
    centerY - Math.cos(radians) * distance,
  );
  return { kind: 'single' as const, index: props.selectedCenterIndex, pivotX: centerX, pivotY: centerY, marker, rotation };
});

const centerHandlePoints = computed(() => {
  const index = props.selectedCenterIndex;
  if (index === null) return [] as { side: 'left' | 'right'; x: number; y: number }[];
  const line = layout.value.lines[index];
  if (!line) return [];
  const cx = line.x + line.width / 2;
  const cy = inkCenter(line);
  const radians = ((line.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const pointAt = (dx: number): { x: number; y: number } =>
    screenPoint(cx + dx * cos, cy + dx * sin);
  return [
    { side: 'left' as const, ...pointAt(-line.width / 2) },
    { side: 'right' as const, ...pointAt(line.width / 2) },
  ];
});

const logoHandlePoints = computed(() => {
  const logo = selectedLogoGeometry.value;
  if (!logo) return [] as { corner: 'nw' | 'ne' | 'se' | 'sw'; x: number; y: number }[];
  return rotatedCorners(logo.x + logo.width / 2, logo.y + logo.height / 2, logo.width, logo.height, logo.rotation ?? 0);
});

const logoRotatePoint = computed(() => {
  const logo = selectedLogoGeometry.value;
  if (!logo) return null;
  return rotateHandlePoint(logo.x + logo.width / 2, logo.y + logo.height / 2, logo.width, logo.height, logo.rotation ?? 0);
});

const symbolRotatePoint = computed(() => {
  const symbol = selectedSymbol.value;
  if (!symbol) return null;
  return rotateHandlePoint(symbol.cx, symbol.cy, symbol.width, symbol.height, symbol.rotation);
});

const referenceHandlePoints = computed(() => {
  const reference = props.reference;
  if (!reference) return [] as { corner: 'nw' | 'ne' | 'se' | 'sw'; x: number; y: number }[];
  return rotatedCorners(reference.x, reference.y, reference.width, reference.height, reference.rotation);
});

const referenceRotatePoint = computed(() => {
  const reference = props.reference;
  if (!reference) return null;
  return rotateHandlePoint(reference.x, reference.y, reference.width, reference.height, reference.rotation);
});

function rotatedCorners(
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
): { corner: 'nw' | 'ne' | 'se' | 'sw'; x: number; y: number }[] {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corner = (dx: number, dy: number) =>
    screenPoint(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
  const hw = width / 2;
  const hh = height / 2;
  return [
    { corner: 'nw' as const, ...corner(-hw, -hh) },
    { corner: 'ne' as const, ...corner(hw, -hh) },
    { corner: 'se' as const, ...corner(hw, hh) },
    { corner: 'sw' as const, ...corner(-hw, hh) },
  ];
}

/** Круглый маркер поворота над фигурой (с учётом её поворота). */
function rotateHandlePoint(
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation: number,
): { x: number; y: number } {
  void width;
  const radians = (rotation * Math.PI) / 180;
  const distance = height / 2 + 22 / Math.max(0.4, props.zoom);
  return screenPoint(
    cx + Math.sin(radians) * distance,
    cy - Math.cos(radians) * distance,
  );
}

/* ======================== Перетаскивания ======================== */

type DragState =
  | { kind: 'line'; lineId: string; pointerAngle: number; pointerRadius: number; startRadiusOffset: number; startAngleOffset: number; maxRadiusOffset: number; moved: boolean }
  | { kind: 'ring'; ringIndex: number }
  | { kind: 'center-move'; index: number; startX: number; startY: number; startOffsetX: number; startOffsetY: number; startCenterX: number; startCenterY: number }
  | { kind: 'center-stretch'; index: number; centerX: number }
  | { kind: 'logo-move'; logoIndex: number; startX: number; startY: number; startOffsetX: number; startOffsetY: number }
  | { kind: 'logo-resize'; logoIndex: number; centerX: number; centerY: number; startWidth: number; startHeight: number }
  | { kind: 'logo-rotate'; logoIndex: number; centerX: number; centerY: number; startPointerAngle: number; startRotation: number }
  | { kind: 'reference-move'; startX: number; startY: number; startCenterX: number; startCenterY: number }
  | { kind: 'reference-resize'; centerX: number; centerY: number; startWidth: number; startHeight: number }
  | { kind: 'reference-rotate'; centerX: number; centerY: number; startPointerAngle: number; startRotation: number }
  | { kind: 'group'; lastX: number; lastY: number }
  | {
      kind: 'symbol-move';
      symbolId: string;
      startX: number;
      startY: number;
      startOffsetX: number;
      startOffsetY: number;
    }
  | {
      kind: 'symbol-rotate';
      symbolId: string;
      centerX: number;
      centerY: number;
      startPointerAngle: number;
      startRotation: number;
    }
  | {
      kind: 'stroke-move';
      lineId: string;
      startX: number;
      startY: number;
      startCx: number;
      startCy: number;
    }
  | {
      kind: 'stroke-resize';
      lineId: string;
      endpoint: 'start' | 'end';
      otherX: number;
      otherY: number;
      startRotation: number;
    }
  | {
      kind: 'stroke-rotate';
      lineId: string;
      centerX: number;
      centerY: number;
      startPointerAngle: number;
      startRotation: number;
    }
  | {
      kind: 'center-rotate';
      index: number;
      centerX: number;
      centerY: number;
      startPointerAngle: number;
      startRotation: number;
    }
  | {
      kind: 'group-rotate';
      pivotX: number;
      pivotY: number;
      lastPointerAngle: number;
    }
  | { kind: 'pan'; startX: number; startY: number; startPanX: number; startPanY: number };

let dragState: DragState | null = null;

function radiusLimit(lineId: string): number {
  const seal = layout.value.seal;
  const line = props.template.seal?.lines.find((item) => item.id === lineId);
  if (!seal || !line) return 10;
  const slot = seal.slots[Math.min(seal.slots.length - 1, Math.max(0, line.slot))];
  if (!slot) return 10;
  return Math.max(0, slot.thickness / 2);
}

function startDrag(event: PointerEvent, state: DragState): void {
  dragState = state;
  textMoving.value =
    state.kind === 'center-move' ||
    (state.kind === 'group' && (props.selection?.centers.length ?? 0) > 0);
  snapAxes.value = { vertical: false, horizontal: false, circular: false };
  snapCircleRadius.value = null;
  if (state.kind === 'pan') panning.value = true;
  window.addEventListener('pointermove', onWindowMove);
  window.addEventListener('pointerup', onWindowUp, { once: true });
  event.preventDefault();
}

function updateStrokeDimension(
  endpoint: 'start' | 'end',
  originX: number,
  originY: number,
  otherX: number,
  otherY: number,
): void {
  const dx = originX - otherX;
  const dy = originY - otherY;
  const length = Math.max(0.01, Math.hypot(dx, dy));
  const rings = layout.value.seal?.ink.rings ?? [];
  const inner = rings[rings.length - 1];
  if (!inner) return;
  const cx = size.value / 2;
  const cy = size.value / 2;
  const innerEdge = Math.max(1, inner.radius - inner.width / 2);
  const unitX = dx / length;
  const unitY = dy / length;
  const localX = originX - cx;
  const localY = originY - cy;
  const b = localX * unitX + localY * unitY;
  const c = localX * localX + localY * localY - innerEdge * innerEdge;
  const disc = b * b - c;
  if (disc < 0) return;
  const t = -b + Math.sqrt(disc);
  if (t <= 0.05) return;
  strokeAnnotation.value = {
    endpoint,
    x1: originX,
    y1: originY,
    x2: cx + localX + unitX * t,
    y2: cy + localY + unitY * t,
    distance: t,
  };
}

function onWindowMove(event: PointerEvent): void {
  const state = dragState;
  if (!state) return;
  if (state.kind === 'pan') {
    pan.value = {
      x: state.startPanX + (event.clientX - state.startX),
      y: state.startPanY + (event.clientY - state.startY),
    };
    return;
  }
  const point = toSealPoint(event);
  if (!point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;

  if (state.kind === 'symbol-move') {
    let x = state.startOffsetX + point.x - state.startX;
    let y = state.startOffsetY + point.y - state.startY;
    const vertical = Math.abs(x) < 1.2;
    const horizontal = Math.abs(y) < 1.2;
    if (vertical) x = 0;
    if (horizontal) y = 0;
    snapAxes.value = { vertical, horizontal, circular: false };
    emit('symbol-move', state.symbolId, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    return;
  }

  if (state.kind === 'symbol-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit(
      'symbol-rotate',
      state.symbolId,
      Math.round(((state.startRotation + delta + 360) % 360) * 10) / 10,
    );
    return;
  }

  if (state.kind === 'stroke-move') {
    const x = state.startCx + point.x - state.startX;
    const y = state.startCy + point.y - state.startY;
    snapAxes.value = {
      vertical: Math.abs(x) < 2.5,
      horizontal: Math.abs(y) < 2.5,
      circular: false,
    };
    emit(
      'straight-line-move',
      state.lineId,
      Math.abs(x) < 2.5 ? 0 : Math.round(x * 10) / 10,
      Math.abs(y) < 2.5 ? 0 : Math.round(y * 10) / 10,
    );
    return;
  }

  if (state.kind === 'stroke-resize') {
    const dx = point.x - state.otherX;
    const dy = point.y - state.otherY;
    let length = Math.max(2, Math.hypot(dx, dy));
    let rotation = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    // Лёгкое прилипание к направлению линии (горизонт + её поворот) и к
    // ближайшей горизонтали/вертикали. Внутри допуска конец едет строго
    // по этому направлению, второй конец остаётся на месте.
    const candidates = [
      state.startRotation,
      state.startRotation + 180,
      0,
      90,
      180,
      270,
    ];
    let best: { angle: number; delta: number } | null = null;
    for (const angle of candidates) {
      const delta = Math.abs((((rotation - angle) % 360) + 540) % 360 - 180);
      if (delta <= 3 && (!best || delta < best.delta)) best = { angle: angle % 360, delta };
    }
    let endX = point.x;
    let endY = point.y;
    if (best) {
      const radians = (best.angle * Math.PI) / 180;
      const unitX = Math.cos(radians);
      const unitY = Math.sin(radians);
      const projected = Math.max(2, dx * unitX + dy * unitY);
      endX = state.otherX + unitX * projected;
      endY = state.otherY + unitY * projected;
      length = projected;
      rotation = ((best.angle % 360) + 360) % 360;
    }
    const centerX = state.otherX + (endX - state.otherX) / 2;
    const centerY = state.otherY + (endY - state.otherY) / 2;
    emit(
      'straight-line-resize',
      state.lineId,
      Math.round((centerX - size.value / 2) * 10) / 10,
      Math.round((centerY - size.value / 2) * 10) / 10,
      Math.round(length * 10) / 10,
      Math.round(rotation * 10) / 10,
    );
    updateStrokeDimension(state.endpoint, endX, endY, state.otherX, state.otherY);
    return;
  }

  if (state.kind === 'stroke-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit(
      'straight-line-rotate',
      state.lineId,
      Math.round(((state.startRotation + delta + 360) % 360) * 10) / 10,
    );
    return;
  }

  if (state.kind === 'center-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit(
      'center-rotate',
      state.index,
      Math.round(((state.startRotation + delta + 360) % 360) * 10) / 10,
    );
    return;
  }

  if (state.kind === 'group-rotate') {
    const angle = (Math.atan2(point.y - state.pivotY, point.x - state.pivotX) * 180) / Math.PI;
    let delta = angle - state.lastPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    state.lastPointerAngle = angle;
    emit('group-rotate', Math.round(delta * 10) / 10, state.pivotX, state.pivotY);
    return;
  }

  if (state.kind === 'group') {
    const dx = point.x - state.lastX;
    const dy = point.y - state.lastY;
    const centers = props.selection?.centers ?? [];
    if (centers.length > 0) {
      const boxes = centers
        .map((index) => layout.value.lines[index])
        .filter((item) => Boolean(item));
      if (boxes.length > 0) {
        const left = Math.min(...boxes.map((item) => item.x));
        const right = Math.max(...boxes.map((item) => item.x + item.width));
        const top = Math.min(...boxes.map((item) => inkTop(item)));
        const bottom = Math.max(...boxes.map((item) => inkBottom(item)));
        const groupX = (left + right) / 2 + dx;
        const groupY = (top + bottom) / 2 + dy;
        snapAxes.value = {
          vertical: Math.abs(groupX - cx) < 1.2,
          horizontal: Math.abs(groupY - cy) < 1.2,
          circular: false,
        };
      }
    }
    // Дуговой текст в группе прилипает к середине зазора своим общим
    // центром, а не каждой строкой отдельно.
    const lineIds = props.selection?.lines ?? [];
    if (lineIds.length > 1) {
      const bands = new Map<number, { outer: number; inner: number }>();
      for (const lineId of lineIds) {
        const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
        const geometry = layout.value.seal?.ringLines.find((item) => item.lineId === lineId);
        if (!templateLine || !geometry) continue;
        const radians = (geometry.centerAngle * Math.PI) / 180;
        const radialDelta = dx * Math.cos(radians) + dy * Math.sin(radians);
        const radius = geometry.radius + radialDelta;
        const ascent = geometry.fontSize * 0.72;
        const descent = geometry.fontSize * 0.2;
        const outerEdge = radius + (geometry.side === 'top' ? ascent : descent);
        const innerEdge = radius - (geometry.side === 'top' ? descent : ascent);
        const band = bands.get(geometry.slot) ?? {
          outer: Number.NEGATIVE_INFINITY,
          inner: Number.POSITIVE_INFINITY,
        };
        band.outer = Math.max(band.outer, outerEdge);
        band.inner = Math.min(band.inner, innerEdge);
        bands.set(geometry.slot, band);
      }
      let circular = false;
      let circleRadius: number | null = null;
      for (const [slotIndex, band] of bands) {
        const slot = layout.value.seal?.slots[slotIndex];
        if (!slot) continue;
        const groupCenter = (band.outer + band.inner) / 2;
        if (Math.abs(groupCenter - slot.center) < 1.2) {
          circular = true;
          circleRadius = slot.center;
          break;
        }
      }
      snapAxes.value = { ...snapAxes.value, circular };
      snapCircleRadius.value = circular ? circleRadius : null;
    }
    emit('group-move', dx, dy);
    state.lastX = point.x;
    state.lastY = point.y;
    return;
  }

  if (state.kind === 'line') {
    const angle = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
    const radius = Math.hypot(point.x - cx, point.y - cy);
    let deltaAngle = angle - state.pointerAngle;
    deltaAngle = ((deltaAngle % 360) + 540) % 360 - 180;
    const deltaRadius = radius - state.pointerRadius;
    if (!state.moved && Math.abs(deltaAngle) < 1 && Math.abs(deltaRadius) < 0.5) return;
    state.moved = true;
    let radiusOffset = Math.round(
      Math.min(state.maxRadiusOffset, Math.max(-state.maxRadiusOffset, state.startRadiusOffset + deltaRadius)) * 10,
    ) / 10;
    // Лёгкое прилипание строки к середине кольцевого зазора.
    const circularSnap = Math.abs(radiusOffset) < 0.9;
    if (circularSnap) radiusOffset = 0;
    const geometry = layout.value.seal?.ringLines.find((item) => item.lineId === state.lineId);
    const slot = geometry ? layout.value.seal?.slots[geometry.slot] : null;
    snapAxes.value = { vertical: false, horizontal: false, circular: circularSnap && Boolean(slot) };
    snapCircleRadius.value = circularSnap && slot ? slot.center : null;
    const angleOffset = Math.round((state.startAngleOffset + deltaAngle) * 10) / 10;
    emit('line-move', state.lineId, radiusOffset, angleOffset);
    return;
  }

  if (state.kind === 'ring') {
    const rings = layout.value.seal?.ink.rings ?? [];
    const currentRing = rings[state.ringIndex];
    const previousRing = rings[state.ringIndex - 1];
    let radius = Math.hypot(point.x - cx, point.y - cy);
    if (currentRing && previousRing) {
      // Те же пределы, что и у зазора в настройках: 0.5…100 pt.
      const innerEdge = previousRing.radius - previousRing.width / 2;
      const minRadius = Math.max(2, innerEdge - currentRing.width / 2 - 100);
      const maxRadius = Math.max(minRadius, innerEdge - currentRing.width / 2 - 0.5);
      radius = Math.min(maxRadius, Math.max(minRadius, radius));
    }
    const shown = ringAnnotation.value;
    if (
      shown &&
      shown.ringIndex === state.ringIndex &&
      Math.abs(shown.radius - radius) < 0.01
    ) {
      // Кольцо упёрлось в предел: размер и подпись больше не пересчитываются.
      return;
    }
    ringAnnotation.value = {
      ringIndex: state.ringIndex,
      radius,
      angle: Math.atan2(point.y - cy, point.x - cx),
    };
    emit('ring-resize', state.ringIndex, Math.round(radius * 10) / 10);
    return;
  }

  if (state.kind === 'center-move') {
    let offsetX = state.startOffsetX + point.x - state.startX;
    let offsetY = state.startOffsetY + point.y - state.startY;
    // Лёгкое прилипание центра текста к осям печати. Считаем от положения
    // на момент начала перетаскивания, иначе текущий layout уже содержит
    // смещение и прилипание «уезжает» вместе с текстом.
    const snapped = { vertical: false, horizontal: false, circular: false };
    const centerX = state.startCenterX + point.x - state.startX;
    const centerY = state.startCenterY + point.y - state.startY;
    if (Math.abs(centerX - size.value / 2) < 1.2) {
      offsetX = state.startOffsetX + (size.value / 2 - state.startCenterX);
      snapped.vertical = true;
    }
    if (Math.abs(centerY - size.value / 2) < 1.2) {
      offsetY = state.startOffsetY + (size.value / 2 - state.startCenterY);
      snapped.horizontal = true;
    }
    snapAxes.value = snapped;
    snapCircleRadius.value = null;
    emit(
      'center-move',
      state.index,
      Math.round(offsetX * 10) / 10,
      Math.round(offsetY * 10) / 10,
    );
    return;
  }

  if (state.kind === 'center-stretch') {
    emit('center-stretch', state.index, Math.round(Math.max(4, Math.abs(point.x - state.centerX) * 2) * 10) / 10);
    return;
  }

  if (state.kind === 'logo-move') {
    let offsetX = state.startOffsetX + point.x - state.startX;
    let offsetY = state.startOffsetY + point.y - state.startY;
    const vertical = Math.abs(offsetX) < 2.5;
    const horizontal = Math.abs(offsetY) < 2.5;
    if (vertical) offsetX = 0;
    if (horizontal) offsetY = 0;
    snapAxes.value = { vertical, horizontal, circular: false };
    emit(
      'logo-move',
      state.logoIndex,
      Math.round(offsetX * 10) / 10,
      Math.round(offsetY * 10) / 10,
    );
    return;
  }

  if (state.kind === 'logo-resize') {
    const logo = layout.value.logos[state.logoIndex];
    if (!logo) return;
    const radians = (-(logo.rotation ?? 0) * Math.PI) / 180;
    const dx = point.x - state.centerX;
    const dy = point.y - state.centerY;
    const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
    const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
    let width = Math.max(4, Math.abs(localX) * 2);
    let height = Math.max(4, Math.abs(localY) * 2);
    if (event.shiftKey) {
      const baseRatio = state.startWidth / Math.max(1, state.startHeight);
      if (width / height > baseRatio) height = width / baseRatio;
      else width = height * baseRatio;
    }
    emit('logo-resize', state.logoIndex, Math.round(width * 10) / 10, Math.round(height * 10) / 10);
    return;
  }

  if (state.kind === 'logo-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit('logo-rotate', state.logoIndex, Math.round(state.startRotation + delta));
    return;
  }

  if (state.kind === 'reference-move') {
    let centerX = state.startCenterX + point.x - state.startX;
    let centerY = state.startCenterY + point.y - state.startY;
    const vertical = Math.abs(centerX - cx) < 2.5;
    const horizontal = Math.abs(centerY - cy) < 2.5;
    if (vertical) centerX = cx;
    if (horizontal) centerY = cy;
    snapAxes.value = { vertical, horizontal, circular: false };
    emit(
      'reference-move',
      Math.round(centerX * 10) / 10,
      Math.round(centerY * 10) / 10,
    );
    return;
  }

  if (state.kind === 'reference-resize') {
    const radians = (-(props.reference?.rotation ?? 0) * Math.PI) / 180;
    const dx = point.x - state.centerX;
    const dy = point.y - state.centerY;
    const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
    const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
    let width = Math.max(8, Math.abs(localX) * 2);
    let height = Math.max(8, Math.abs(localY) * 2);
    if (event.shiftKey) {
      const baseRatio = state.startWidth / Math.max(1, state.startHeight);
      if (width / height > baseRatio) height = width / baseRatio;
      else width = height * baseRatio;
    }
    emit('reference-resize', Math.round(width * 10) / 10, Math.round(height * 10) / 10);
    return;
  }

  if (state.kind === 'reference-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit('reference-rotate', Math.round(state.startRotation + delta));
  }
}

function onWindowUp(): void {
  dragState = null;
  panning.value = false;
  textMoving.value = false;
  snapAxes.value = { vertical: false, horizontal: false, circular: false };
  snapCircleRadius.value = null;
  ringAnnotation.value = null;
  strokeAnnotation.value = null;
  window.removeEventListener('pointermove', onWindowMove);
}

/* ======================== Клики, меню, двойной клик ======================== */

/** Насколько точка «внутри» буквы: чем меньше, тем точнее попадание. */
function lineInkScore(point: { x: number; y: number }): { lineId: string; score: number } | null {
  const seal = layout.value.seal;
  if (!seal) return null;
  let best: { lineId: string; score: number } | null = null;
  for (const ringLine of seal.ringLines) {
    for (const char of ringLine.chars) {
      const radians = (char.angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const glyphWidth = char.fontSize * 0.6;
      const centerX = char.x + cos * (glyphWidth / 2) + sin * (char.fontSize * 0.35);
      const centerY = char.y + sin * (glyphWidth / 2) - cos * (char.fontSize * 0.35);
      const reach = Math.max(2, char.fontSize * 0.55);
      const score = Math.hypot(point.x - centerX, point.y - centerY) - reach;
      if (score <= 0 && (!best || score < best.score)) best = { lineId: ringLine.lineId, score };
    }
  }
  return best;
}

/** Насколько точка «внутри» штриха кольца. */
function ringInkScore(point: { x: number; y: number }): { ringIndex: number; score: number } | null {
  const rings = layout.value.seal?.ink.rings ?? [];
  let best: { ringIndex: number; score: number } | null = null;
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    const distance = Math.hypot(point.x - ring.cx, point.y - ring.cy);
    // Учитываем реальную ширину штриха: попасть можно в любое кольцо,
    // даже если рядом стоит текст.
    const score = Math.abs(distance - ring.radius) - Math.max(1.2, ring.width / 2);
    if (score <= 0 && (!best || score < best.score)) best = { ringIndex: index, score };
  }
  return best;
}

/** Кто из двух ближе к курсору — текст или кольцо. */
function pickInk(point: { x: number; y: number }): { kind: 'line'; lineId: string } | { kind: 'ring'; ringIndex: number } | null {
  const line = lineInkScore(point);
  const ring = ringInkScore(point);
  if (line && ring) return line.score <= ring.score ? { kind: 'line', lineId: line.lineId } : { kind: 'ring', ringIndex: ring.ringIndex };
  if (line) return { kind: 'line', lineId: line.lineId };
  if (ring) return { kind: 'ring', ringIndex: ring.ringIndex };
  return null;
}

function onCanvasMove(event: PointerEvent): void {
  if (props.selectedRingIndex === null) {
    ringHover.value = '';
    return;
  }
  const point = toSealPoint(event);
  if (!point || hitRing(point) !== props.selectedRingIndex) {
    ringHover.value = '';
    return;
  }
  const cx = size.value / 2;
  const cy = size.value / 2;
  const dx = Math.abs(point.x - cx);
  const dy = Math.abs(point.y - cy);
  ringHover.value = dx >= dy ? 'ew-resize' : 'ns-resize';
}

type Target =
  | { kind: 'line'; key: string }
  | { kind: 'center'; key: number }
  | { kind: 'ring'; key: number }
  | { kind: 'logo'; key: number }
  | { kind: 'stroke'; key: string };

function emptySelection(): SealMultiSelection {
  return { lines: [], centers: [], rings: [], logos: [], strokes: [] };
}

function selectionCount(selection: SealMultiSelection | null): number {
  if (!selection) return 0;
  return (
    selection.lines.length +
    selection.centers.length +
    selection.rings.length +
    selection.logos.length +
    selection.strokes.length
  );
}

function selectionIncludes(selection: SealMultiSelection | null, target: Target): boolean {
  if (!selection) return false;
  if (target.kind === 'line') return selection.lines.includes(target.key);
  if (target.kind === 'center') return selection.centers.includes(target.key);
  if (target.kind === 'ring') return selection.rings.includes(target.key);
  if (target.kind === 'stroke') return selection.strokes.includes(target.key);
  return selection.logos.includes(target.key);
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function hitSymbol(point: { x: number; y: number }): string | null {
  const symbols = layout.value.seal?.symbols ?? [];
  for (let index = symbols.length - 1; index >= 0; index -= 1) {
    const symbol = symbols[index];
    if (
      pointInRotatedRect(
        point,
        symbol.cx,
        symbol.cy,
        symbol.width + 4,
        symbol.height + 4,
        symbol.rotation,
      )
    ) {
      return symbol.symbolId;
    }
  }
  return null;
}

function hitStraightLine(point: { x: number; y: number }): string | null {
  const lines = layout.value.seal?.straightLines ?? [];
  for (const line of lines) {
    if (distanceToSegment(point, { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }) <= line.width / 2 + 2) {
      return line.lineId;
    }
  }
  return null;
}

/** Все объекты под точкой — для Shift-клика и группового перетаскивания. */
function hitTarget(point: { x: number; y: number }): Target | null {
  const logoIndex = hitLogo(point);
  if (logoIndex !== null) return { kind: 'logo', key: logoIndex };
  const strokeId = hitStraightLine(point);
  if (strokeId) return { kind: 'stroke', key: strokeId };
  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) return { kind: 'center', key: centerIndex };
  const ink = pickInk(point);
  if (ink?.kind === 'line') return { kind: 'line', key: ink.lineId };
  const ringIndex = hitRing(point);
  if (ringIndex !== null) return { kind: 'ring', key: ringIndex };
  return null;
}

function withTargetSelection(
  base: SealMultiSelection | null,
  target: Target,
  subtract: boolean,
): SealMultiSelection | null {
  const selection = base
    ? {
        lines: [...base.lines],
        centers: [...base.centers],
        rings: [...base.rings],
        logos: [...base.logos],
        strokes: [...base.strokes],
      }
    : emptySelection();
  const toggle = <T extends string | number>(list: T[], key: T): void => {
    const index = list.findIndex((value) => value === key);
    if (index >= 0) list.splice(index, 1);
    else if (!subtract) list.push(key);
  };
  if (target.kind === 'stroke') toggle(selection.strokes, target.key);
  else if (target.kind === 'line') toggle(selection.lines, target.key);
  else if (target.kind === 'center') toggle(selection.centers, target.key);
  else if (target.kind === 'ring') toggle(selection.rings, target.key);
  else toggle(selection.logos, target.key);
  return selectionCount(selection) > 0 ? selection : null;
}

/* --- маркиза --- */

interface MarqueeState {
  start: { x: number; y: number };
  additive: boolean;
}
let marqueeState: MarqueeState | null = null;

function startMarquee(event: PointerEvent, point: { x: number; y: number }): void {
  marqueeState = { start: point, additive: event.shiftKey };
  marquee.value = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  emit('selection-change', null);
  window.addEventListener('pointermove', onMarqueeMove);
  window.addEventListener('pointerup', onMarqueeUp, { once: true });
  event.preventDefault();
}

function onMarqueeMove(event: PointerEvent): void {
  if (!marqueeState) return;
  const point = toSealPoint(event);
  if (!point) return;
  marquee.value = {
    x1: marqueeState.start.x,
    y1: marqueeState.start.y,
    x2: point.x,
    y2: point.y,
  };
}

function onMarqueeUp(event: PointerEvent): void {
  window.removeEventListener('pointermove', onMarqueeMove);
  const state = marqueeState;
  marqueeState = null;
  const rect = marquee.value;
  marquee.value = null;
  if (!state || !rect) return;
  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);
  if (width < 2 && height < 2) {
    emit('clear-selection');
    return;
  }
  const x1 = Math.min(rect.x1, rect.x2);
  const x2 = Math.max(rect.x1, rect.x2);
  const y1 = Math.min(rect.y1, rect.y2);
  const y2 = Math.max(rect.y1, rect.y2);
  const pointInside = (x: number, y: number): boolean => x >= x1 && x <= x2 && y >= y1 && y <= y2;

  const selection = emptySelection();
  for (const line of layout.value.seal?.ringLines ?? []) {
    let hit = line.chars.some(
      (char) =>
        pointInside(char.x, char.y) ||
        pointInside(char.x - char.fontSize * 0.6, char.y - char.fontSize) ||
        pointInside(char.x + char.fontSize * 0.6, char.y + char.fontSize * 0.4),
    );
    if (!hit) {
      // Проверяем саму дугу: иначе тонкую строку легко «перепрыгнуть».
      const from = Math.min(line.startAngle, line.endAngle);
      const to = Math.max(line.startAngle, line.endAngle);
      for (let angle = from; angle <= to; angle += 2) {
        const radians = (angle * Math.PI) / 180;
        if (pointInside(line.cx + Math.cos(radians) * line.radius, line.cy + Math.sin(radians) * line.radius)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) selection.lines.push(line.lineId);
  }
  layout.value.lines.forEach((line, index) => {
    const inside =
      line.x <= x2 &&
      line.x + line.width >= x1 &&
      line.baseline - line.fontSize <= y2 &&
      line.baseline + line.fontSize * 0.3 >= y1;
    if (inside) selection.centers.push(index);
  });
  layout.value.logos.forEach((logo, index) => {
    const cx = logo.x + logo.width / 2;
    const cy = logo.y + logo.height / 2;
    const corners = rotatedCorners(cx, cy, logo.width, logo.height, logo.rotation ?? 0).map((item) => ({
      x: item.x / props.zoom,
      y: item.y / props.zoom,
    }));
    if (corners.some((corner) => pointInside(corner.x, corner.y)) || pointInside(cx, cy)) {
      selection.logos.push(index);
    }
  });
  for (const line of layout.value.seal?.straightLines ?? []) {
    let intersects = false;
    for (let step = 0; step <= 16; step += 1) {
      const t = step / 16;
      if (pointInside(line.x1 + (line.x2 - line.x1) * t, line.y1 + (line.y2 - line.y1) * t)) {
        intersects = true;
        break;
      }
    }
    if (intersects) selection.strokes.push(line.lineId);
  }
  for (const [index, ring] of (layout.value.seal?.ink.rings ?? []).entries()) {
    let intersects = false;
    // Частая выборка: кольцо тонкое, 32 точки его легко пропускают.
    for (let step = 0; step < 96; step += 1) {
      const angle = (step / 96) * Math.PI * 2;
      if (pointInside(ring.cx + Math.cos(angle) * ring.radius, ring.cy + Math.sin(angle) * ring.radius)) {
        intersects = true;
        break;
      }
    }
    if (intersects) selection.rings.push(index);
  }

  const merged = state.additive ? mergeSelections(props.selection, selection) : selection;
  emit('selection-change', selectionCount(merged) > 0 ? merged : null);
}

function mergeSelections(
  base: SealMultiSelection | null,
  extra: SealMultiSelection,
): SealMultiSelection {
  const merged = base
    ? {
        lines: [...base.lines],
        centers: [...base.centers],
        rings: [...base.rings],
        logos: [...base.logos],
        strokes: [...base.strokes],
      }
    : emptySelection();
  for (const key of extra.lines) if (!merged.lines.includes(key)) merged.lines.push(key);
  for (const key of extra.centers) if (!merged.centers.includes(key)) merged.centers.push(key);
  for (const key of extra.rings) if (!merged.rings.includes(key)) merged.rings.push(key);
  for (const key of extra.logos) if (!merged.logos.includes(key)) merged.logos.push(key);
  for (const key of extra.strokes) if (!merged.strokes.includes(key)) merged.strokes.push(key);
  return merged;
}


function blurActive(): void {
  const active = document.activeElement as HTMLElement | null;
  if (
    active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable)
  ) {
    active.blur();
  }
}

/** Клики/панорама по всей площади превью, а не только по квадрату оттиска. */
function onRootPointerDown(event: PointerEvent): void {
  if (event.target === canvas.value) return;
  blurActive();
  if (event.button === 1 || (event.button === 0 && spacePressed.value)) {
    event.preventDefault();
    startDrag(event, {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      startPanX: pan.value.x,
      startPanY: pan.value.y,
    });
    return;
  }
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button') || target?.closest('[data-testid=seal-text-menu]')) return;
  const point = toSealPoint(event);
  if (!point) return;
  // Пустая область вокруг оттиска — тоже начало рамки выделения.
  startMarquee(event, point);
}

function onCanvasDown(event: PointerEvent): void {
  blurActive();
  // Средняя кнопка и пробел+ЛКМ — панорамирование, а не выделение.
  if (event.button === 1 || (event.button === 0 && spacePressed.value)) {
    event.preventDefault();
    startDrag(event, {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      startPanX: pan.value.x,
      startPanY: pan.value.y,
    });
    return;
  }
  if (event.button !== 0) return;
  const point = toSealPoint(event);
  if (!point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;

  // Символы лежат поверх объектов: клик по символу выбирает именно его.
  const symbolId = hitSymbol(point);
  if (symbolId) {
    const symbol = props.template.seal?.symbols?.find((item) => item.id === symbolId);
    if (symbol) {
      emit('symbol-select', symbolId);
      startDrag(event, {
        kind: 'symbol-move',
        symbolId,
        startX: point.x,
        startY: point.y,
        startOffsetX: symbol.x,
        startOffsetY: symbol.y,
      });
    }
    return;
  }

  // Shift+клик — добавить/убрать объект из группы.
  const target = hitTarget(point);
  if (event.shiftKey && target) {
    emit(
      'selection-change',
      withTargetSelection(props.selection, target, selectionIncludes(props.selection, target)),
    );
    return;
  }

  // Тянем уже выделенную группу.
  if (target && selectionCount(props.selection) > 1 && selectionIncludes(props.selection, target)) {
    startDrag(event, { kind: 'group', lastX: point.x, lastY: point.y });
    return;
  }

  // Пустое место — рамка выделения. Образец под оттиском остаётся
  // обычным объектом: клик по нему выбирает его, а не начинает маркизу.
  if (!target) {
    const onReference = Boolean(props.reference?.visible && hitReference(point));
    if (!onReference) {
      startMarquee(event, point);
      return;
    }
  }

  // Логотипы лежат поверх текста: клик по любому выбирает именно его.
  const logoHit = hitLogo(point);
  if (logoHit !== null && logoHit === (props.selectedLogoIndex ?? -1)) {
    startLogoMove(event, point, logoHit);
    return;
  }
  if (logoHit !== null) {
    emit('logo-select', logoHit);
    startLogoMove(event, point, logoHit);
    return;
  }

  const strokeId = hitStraightLine(point);
  if (strokeId) {
    const line = layout.value.seal?.straightLines.find((item) => item.lineId === strokeId);
    if (line) {
      emit('straight-line-select', strokeId);
      startDrag(event, {
        kind: 'stroke-move',
        lineId: strokeId,
        startX: point.x,
        startY: point.y,
        startCx: line.cx - size.value / 2,
        startCy: line.cy - size.value / 2,
      });
    }
    return;
  }

  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) {
    emit('center-select', centerIndex);
    const line = props.template.lines[centerIndex];
    const geometry = layout.value.lines[centerIndex];
    startDrag(event, {
      kind: 'center-move',
      index: centerIndex,
      startX: point.x,
      startY: point.y,
      startOffsetX: line?.offsetX ?? 0,
      startOffsetY: line?.offsetY ?? 0,
      startCenterX: geometry ? geometry.x + geometry.width / 2 : cx,
      startCenterY: geometry ? inkCenter(geometry) : cy,
    });
    return;
  }

  // Текст и кольцо сравниваем по точности попадания: можно выбрать и то,
  // и другое, даже когда буквы стоят вплотную к штриху.
  const ink = pickInk(point);
  if (ink?.kind === 'line') {
    const lineId = ink.lineId;
    emit('select-line', lineId);
    const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
    if (!templateLine) return;
    startDrag(event, {
      kind: 'line',
      lineId,
      pointerAngle: (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI,
      pointerRadius: Math.hypot(point.x - cx, point.y - cy),
      startRadiusOffset: templateLine.radiusOffset,
      startAngleOffset: templateLine.angleOffset,
      maxRadiusOffset: radiusLimit(lineId),
      moved: false,
    });
    return;
  }
  if (ink?.kind === 'ring') {
    emit('ring-select', ink.ringIndex);
    if (ink.ringIndex > 0) startDrag(event, { kind: 'ring', ringIndex: ink.ringIndex });
    return;
  }

  // Образец лежит под оттиском: если сверху нет букв/колец/центра, клик
  // выбирает его — как обычный объект на холсте.
  if (props.reference?.visible && hitReference(point)) {
    emit('reference-select');
    startDrag(event, {
      kind: 'reference-move',
      startX: point.x,
      startY: point.y,
      startCenterX: props.reference.x,
      startCenterY: props.reference.y,
    });
    return;
  }

  emit('clear-selection');
}

function startLogoMove(event: PointerEvent, point: { x: number; y: number }, logoIndex: number): void {
  const logo = logoSources.value[logoIndex];
  if (!logo) return;
  startDrag(event, {
    kind: 'logo-move',
    logoIndex,
    startX: point.x,
    startY: point.y,
    startOffsetX: logo.offsetX,
    startOffsetY: logo.offsetY,
  });
}

/* --- маркеры --- */

/** Потянуть за конец линии: второй конец остаётся на месте. */
function onStrokeEndpointDown(event: PointerEvent, endpoint: 'start' | 'end'): void {
  event.preventDefault();
  event.stopPropagation();
  const line = selectedStraightLine.value;
  if (!line) return;
  startDrag(event, {
    kind: 'stroke-resize',
    lineId: line.lineId,
    endpoint,
    otherX: endpoint === 'start' ? line.x2 : line.x1,
    otherY: endpoint === 'start' ? line.y2 : line.y1,
    startRotation: line.rotation,
  });
  // Размер показываем сразу при нажатии на концевой маркер.
  updateStrokeDimension(
    endpoint,
    endpoint === 'start' ? line.x1 : line.x2,
    endpoint === 'start' ? line.y1 : line.y2,
    endpoint === 'start' ? line.x2 : line.x1,
    endpoint === 'start' ? line.y2 : line.y1,
  );
}

/** Поворот линии вокруг её центра. */
function onStrokeRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const line = selectedStraightLine.value;
  const point = toSealPoint(event);
  if (!line || !point) return;
  startDrag(event, {
    kind: 'stroke-rotate',
    lineId: line.lineId,
    centerX: line.cx,
    centerY: line.cy,
    startPointerAngle: (Math.atan2(point.y - line.cy, point.x - line.cx) * 180) / Math.PI,
    startRotation: line.rotation,
  });
}

/** Поворот строки центра или группы строк. */
function onCenterRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const target = centerRotation.value;
  const point = toSealPoint(event);
  if (!target || !point) return;
  const pointerAngle = (Math.atan2(point.y - target.pivotY, point.x - target.pivotX) * 180) / Math.PI;
  if (target.kind === 'single') {
    startDrag(event, {
      kind: 'center-rotate',
      index: target.index,
      centerX: target.pivotX,
      centerY: target.pivotY,
      startPointerAngle: pointerAngle,
      startRotation: target.rotation,
    });
  } else {
    startDrag(event, {
      kind: 'group-rotate',
      pivotX: target.pivotX,
      pivotY: target.pivotY,
      lastPointerAngle: pointerAngle,
    });
  }
}

function onRingHandleDown(event: PointerEvent): void {  event.preventDefault();
  event.stopPropagation();
  const lineId = props.selectedLineId;
  const ringLine = selectedGeometry.value;
  const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
  const point = toSealPoint(event);
  if (!lineId || !ringLine || !templateLine || !point) return;
  emit('select-line', lineId);
  const cx = size.value / 2;
  const cy = size.value / 2;
  dragState = {
    kind: 'line',
    lineId,
    pointerAngle: (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI,
    pointerRadius: Math.hypot(point.x - cx, point.y - cy),
    startRadiusOffset: templateLine.radiusOffset,
    startAngleOffset: templateLine.angleOffset,
    maxRadiusOffset: radiusLimit(lineId),
    moved: true,
  };
  window.addEventListener('pointermove', onRingHandleMove);
  window.addEventListener('pointerup', onRingHandleUp, { once: true });
}

function onRingHandleMove(event: PointerEvent): void {
  const lineId = props.selectedLineId;
  const ringLine = selectedGeometry.value;
  const point = toSealPoint(event);
  if (!lineId || !ringLine || !point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;
  const angle = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
  let delta = angle - ringLine.centerAngle;
  delta = ((delta % 360) + 540) % 360 - 180;

  const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
  const minimum = templateLine
    ? sealArcMinSpan({
        text: templateLine.text,
        radius: ringLine.radius,
        fontSize: ringLine.fontSize,
        letterSpacing: templateLine.letterSpacing,
        wordSpacing: templateLine.wordSpacing,
        family: fonts.familyOf(templateLine.fontId ?? props.template.fontId),
        bold: templateLine.bold,
        italic: templateLine.italic,
      })
    : 0;

  const span = Math.min(400, Math.max(8, minimum, Math.abs(delta) * 2));
  emit('span-change', lineId, Math.round(span * 10) / 10);
}

function onRingHandleUp(): void {
  window.removeEventListener('pointermove', onRingHandleMove);
}

function onCenterHandleDown(event: PointerEvent, index: number): void {
  event.preventDefault();
  event.stopPropagation();
  const line = layout.value.lines[index];
  if (!line) return;
  startDrag(event, { kind: 'center-stretch', index, centerX: line.x + line.width / 2 });
}

function onLogoCornerDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const index = props.selectedLogoIndex ?? 0;
  const logo = layout.value.logos[index];
  if (!logo) return;
  startDrag(event, {
    kind: 'logo-resize',
    logoIndex: index,
    centerX: logo.x + logo.width / 2,
    centerY: logo.y + logo.height / 2,
    startWidth: logo.width,
    startHeight: logo.height,
  });
}

function onLogoRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const index = props.selectedLogoIndex ?? 0;
  const logo = layout.value.logos[index];
  const point = toSealPoint(event);
  if (!logo || !point) return;
  const centerX = logo.x + logo.width / 2;
  const centerY = logo.y + logo.height / 2;
  startDrag(event, {
    kind: 'logo-rotate',
    logoIndex: index,
    centerX,
    centerY,
    startPointerAngle: (Math.atan2(point.y - centerY, point.x - centerX) * 180) / Math.PI,
    startRotation: logo.rotation ?? 0,
  });
}

function onSymbolRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const symbol = selectedSymbol.value;
  const point = toSealPoint(event);
  if (!symbol || !point) return;
  startDrag(event, {
    kind: 'symbol-rotate',
    symbolId: symbol.symbolId,
    centerX: symbol.cx,
    centerY: symbol.cy,
    startPointerAngle: (Math.atan2(point.y - symbol.cy, point.x - symbol.cx) * 180) / Math.PI,
    startRotation: symbol.rotation,
  });
}

function onReferenceCornerDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const reference = props.reference;
  if (!reference) return;
  startDrag(event, {
    kind: 'reference-resize',
    centerX: reference.x,
    centerY: reference.y,
    startWidth: reference.width,
    startHeight: reference.height,
  });
}

function onReferenceRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const reference = props.reference;
  const point = toSealPoint(event);
  if (!reference || !point) return;
  startDrag(event, {
    kind: 'reference-rotate',
    centerX: reference.x,
    centerY: reference.y,
    startPointerAngle: (Math.atan2(point.y - reference.y, point.x - reference.x) * 180) / Math.PI,
    startRotation: reference.rotation,
  });
}

/* --- контекстное меню --- */

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const point = toSealPoint(event);
  const element = canvas.value;
  if (!point || !element) return;
  const rect = element.getBoundingClientRect();

  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) {
    emit('center-select', centerIndex);
    menu.value = { kind: 'center', index: centerIndex, x: event.clientX, y: event.clientY };
    return;
  }

  const ink = pickInk(point);
  if (ink?.kind === 'line') {
    emit('select-line', ink.lineId);
    menu.value = { kind: 'text', lineId: ink.lineId, x: event.clientX, y: event.clientY };
    return;
  }
  if (ink?.kind === 'ring') {
    emit('ring-select', ink.ringIndex);
    menu.value = { kind: 'ring', ringIndex: ink.ringIndex, x: event.clientX, y: event.clientY };
    return;
  }
  menu.value = { kind: 'empty', x: event.clientX, y: event.clientY };
}

function closeMenu(): void {
  menu.value = null;
}

function onWindowDown(event: PointerEvent): void {
  if (!menu.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-testid=seal-text-menu]')) return;
  closeMenu();
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu();
}

function pickEdit(): void {
  if (!menu.value) return;
  if (menu.value.kind === 'center') {
    const index = menu.value.index;
    closeMenu();
    emit('center-edit', index);
    return;
  }
  if (menu.value.kind !== 'text') return;
  const lineId = menu.value.lineId;
  closeMenu();
  emit('edit-line', lineId);
}

function pickDelete(): void {
  if (!menu.value) return;
  if (menu.value.kind === 'center') {
    const index = menu.value.index;
    closeMenu();
    emit('center-delete', index);
    return;
  }
  if (menu.value.kind === 'text') {
    const lineId = menu.value.lineId;
    closeMenu();
    emit('delete-line', lineId);
    return;
  }
  if (menu.value.kind === 'ring') {
    const ringIndex = menu.value.ringIndex;
    closeMenu();
    emit('ring-delete', ringIndex);
  }
}

function pickAdd(action: 'ring' | 'text' | 'center' | 'reference'): void {
  closeMenu();
  if (action === 'ring') emit('add-ring');
  else if (action === 'text') emit('add-text');
  else if (action === 'center') emit('add-center-text');
  else emit('add-reference');
}

function onDoubleClick(event: MouseEvent): void {
  const point = toSealPoint(event);
  if (!point) return;
  const ink = pickInk(point);
  if (ink?.kind === 'line') {
    emit('text-hit', ink.lineId);
    return;
  }
  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) emit('center-hit', centerIndex);
}

/* --- панорама --- */

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    emit('zoom-change', event.deltaY < 0 ? 1.1 : 1 / 1.1);
    return;
  }
  pan.value = {
    x: pan.value.x - event.deltaX,
    y: pan.value.y - event.deltaY,
  };
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.code === 'Space' && !isTypingTarget(event.target)) {
    spacePressed.value = true;
    event.preventDefault();
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') spacePressed.value = false;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
      (element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        element.tagName === 'SELECT' ||
        element.isContentEditable),
  );
}

function resetPan(): void {
  pan.value = { x: 0, y: 0 };
}

defineExpose({ resetPan });

onMounted(async () => {
  await ensureLogo();
  draw();
  drawOverlay();
  exposePreviewDebug();
  if (canvas.value?.parentElement) {
    resizeObserver = new ResizeObserver(() => {
      draw();
      drawOverlay();
    });
    resizeObserver.observe(canvas.value.parentElement);
  }
  window.addEventListener('pointerdown', onWindowDown, true);
  window.addEventListener('keydown', onEscape);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointermove', onRingHandleMove);
  window.removeEventListener('pointerup', onWindowUp);
  window.removeEventListener('pointerup', onRingHandleUp);
  window.removeEventListener('pointerdown', onWindowDown, true);
  window.removeEventListener('keydown', onEscape);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  logoImages.value = [];
});
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden"
    data-testid="seal-preview"
    :data-ring-annotation="ringAnnotation ? 'true' : 'false'"
    :data-stroke-annotation="strokeAnnotation ? 'true' : 'false'"
    :data-marquee="marquee ? 'true' : 'false'"
    :data-guides="guidesVisible ? 'true' : 'false'"
    :class="spacePressed ? 'cursor-grab' : ''"
    @wheel="onWheel"
    @pointerdown="onRootPointerDown"
    @contextmenu="onContextMenu"
  >
    <div
      class="absolute inset-0"
      data-testid="seal-preview-content"
      :data-selected-reference="selectedReference ? 'true' : 'false'"
      :data-reference-visible="reference?.visible ? 'true' : 'false'"
    >
      <!-- Образец печати: под оттиском, не часть печати. -->
      <img
        v-if="reference && reference.visible"
        :src="reference.src"
        alt="Образец печати"
        data-testid="seal-reference-image"
        class="pointer-events-none absolute select-none"
        :style="referenceStyle(reference)"
      />

      <canvas
        ref="canvas"
        data-testid="seal-preview-canvas"
        class="absolute inset-0 block h-full w-full"
        :style="{ cursor: cursorStyle }"
        @pointerdown="onCanvasDown"
        @pointermove="onCanvasMove"
        @dblclick="onDoubleClick"
        @auxclick.prevent
      />

      <!-- Маркеры строки по кольцу -->
      <template v-if="handles && selectedLineId">
        <button
          v-for="(point, index) in handlePoints"
          :key="`ring-handle-${index}`"
          type="button"
          :data-testid="`seal-handle-${index}`"
          class="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[1px] border-[1.5px] border-[#e11d48] bg-white shadow-sm"
          :style="{ left: `${point.x}px`, top: `${point.y}px` }"
          title="Потяните, чтобы растянуть или сжать строку"
          @pointerdown="onRingHandleDown"
        />
      </template>

      <!-- Маркеры строки центра -->
      <template v-if="handles && selectedCenterIndex !== null">
        <button
          v-for="(point, index) in centerHandlePoints"
          :key="`center-handle-${index}`"
          type="button"
          :data-testid="`seal-center-handle-${index}`"
          class="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[1px] border-[1.5px] border-[#e11d48] bg-white shadow-sm"
          :style="{ left: `${point.x}px`, top: `${point.y}px` }"
          title="Потяните, чтобы растянуть или сжать строку центра"
          @pointerdown="onCenterHandleDown($event, selectedCenterIndex)"
        />
      </template>

      <!-- Поворот строки центра / группы строк -->
      <template v-if="handles && centerRotation">
        <button
          type="button"
          data-testid="seal-center-rotate"
          :data-kind="centerRotation.kind"
          class="absolute z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-white bg-[#e11d48] text-white shadow-md"
          :style="{ left: `${centerRotation.marker.x}px`, top: `${centerRotation.marker.y}px` }"
          title="Повернуть текст"
          @pointerdown="onCenterRotateDown"
        >
          <AppIcon name="rotate" :size="12" />
        </button>
      </template>

      <!-- Маркеры прямой линии: концы + поворот -->
      <template v-if="handles && selectedStraightLineId !== null && strokeHandlePoints.length > 0">
        <button
          v-for="point in strokeHandlePoints"
          :key="`stroke-handle-${point.endpoint}`"
          type="button"
          :data-testid="`seal-stroke-handle-${point.endpoint}`"
          class="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[1px] border-[1.5px] border-[#2f6bff] bg-white shadow-sm"
          :style="{ left: `${point.x}px`, top: `${point.y}px` }"
          title="Потяните за конец линии"
          @pointerdown="onStrokeEndpointDown($event, point.endpoint)"
        />
        <button
          v-if="strokeRotatePoint"
          type="button"
          data-testid="seal-stroke-rotate"
          class="absolute z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-white bg-[#2f6bff] text-white shadow-md"
          :style="{ left: `${strokeRotatePoint.x}px`, top: `${strokeRotatePoint.y}px` }"
          title="Повернуть линию"
          @pointerdown="onStrokeRotateDown"
        >
          <AppIcon name="rotate" :size="12" />
        </button>
      </template>

      <!-- Маркер поворота символа -->
      <template v-if="handles && selectedSymbolId && symbolRotatePoint">
        <button
          type="button"
          data-testid="seal-symbol-rotate"
          class="absolute z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-white bg-[#2f6bff] text-white shadow-md"
          :style="{ left: `${symbolRotatePoint.x}px`, top: `${symbolRotatePoint.y}px` }"
          title="Повернуть символ"
          @pointerdown="onSymbolRotateDown"
        >
          <AppIcon name="rotate" :size="12" />
        </button>
      </template>

      <!-- Маркеры логотипа: углы + поворот -->
      <template v-if="handles && selectedLogoIndex !== null && logos.length > 0">
        <button
          v-for="point in logoHandlePoints"
          :key="`logo-${point.corner}`"
          type="button"
          :data-testid="`seal-logo-handle-${point.corner}`"
          class="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[1px] border-[1.5px] border-[#355ef0] bg-white shadow-sm"
          :class="point.corner === 'nw' || point.corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'"
          :style="{ left: `${point.x}px`, top: `${point.y}px` }"
          title="Потяните, чтобы изменить размер (Shift — с сохранением пропорций)"
          @pointerdown="onLogoCornerDown"
        />
        <button
          v-if="logoRotatePoint"
          type="button"
          data-testid="seal-logo-rotate"
          class="absolute z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-white shadow"
          style="background-color: #355ef0"
          :style="{ left: `${logoRotatePoint.x}px`, top: `${logoRotatePoint.y}px` }"
          title="Повернуть логотип"
          @pointerdown="onLogoRotateDown"
        >
          <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round">
            <path d="M9.5 4.2A4 4 0 1 0 10 7.5" />
            <path d="M10 2v2.6H7.4" />
          </svg>
        </button>
      </template>

      <!-- Маркеры образца: углы + поворот -->
      <template v-if="handles && selectedReference && reference && !reference.locked">
        <button
          v-for="point in referenceHandlePoints"
          :key="`ref-${point.corner}`"
          type="button"
          :data-testid="`seal-ref-handle-${point.corner}`"
          class="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[1px] border-[1.5px] border-[#355ef0] bg-white shadow-sm"
          :class="point.corner === 'nw' || point.corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'"
          :style="{ left: `${point.x}px`, top: `${point.y}px` }"
          title="Потяните, чтобы изменить размер (Shift — с сохранением пропорций)"
          @pointerdown="onReferenceCornerDown"
        />
        <button
          v-if="referenceRotatePoint"
          type="button"
          data-testid="seal-ref-rotate"
          class="absolute z-10 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border-2 border-white shadow"
          style="background-color: #355ef0"
          :style="{ left: `${referenceRotatePoint.x}px`, top: `${referenceRotatePoint.y}px` }"
          title="Повернуть образец"
          @pointerdown="onReferenceRotateDown"
        >
          <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round">
            <path d="M9.5 4.2A4 4 0 1 0 10 7.5" />
            <path d="M10 2v2.6H7.4" />
          </svg>
        </button>
      </template>
    </div>

    <canvas
      ref="overlay"
      data-testid="seal-overlay"
      class="pointer-events-none absolute inset-0 z-[5] h-full w-full"
    />

    <!-- Контекстное меню (телепорт: не обрезается превью и его полосами) -->
    <Teleport to="body">
      <div
        v-if="menu"
        data-testid="seal-text-menu"
        class="fixed z-[1000] min-w-[190px] animate-fade-in rounded-lg border border-slate-200 bg-white py-1 shadow-floating dark:border-slate-700 dark:bg-slate-900"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      >
      <template v-if="menu.kind === 'text'">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-edit"
          @click="pickEdit"
        >
          Редактировать
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          data-testid="seal-menu-delete"
          @click="pickDelete"
        >
          Удалить
        </button>
      </template>
      <template v-else-if="menu.kind === 'center'">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-center-edit"
          @click="pickEdit"
        >
          Редактировать
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          data-testid="seal-menu-center-delete"
          @click="pickDelete"
        >
          Удалить
        </button>
      </template>
      <template v-else-if="menu.kind === 'ring'">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          data-testid="seal-menu-ring-delete"
          @click="pickDelete"
        >
          Удалить кольцо
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-add-ring"
          @click="pickAdd('ring')"
        >
          Добавить кольцо
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-add-text"
          @click="pickAdd('text')"
        >
          Добавить текст по кольцу
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-add-center-text"
          @click="pickAdd('center')"
        >
          Добавить текст в центре
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          data-testid="seal-menu-add-reference"
          @click="pickAdd('reference')"
        >
          Добавить образец…
        </button>
      </template>
      </div>
    </Teleport>
  </div>
</template>
