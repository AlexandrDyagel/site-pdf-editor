<script setup lang="ts">
/**
 * Превью круглой печати с интерактивными строками, кольцами и логотипом.
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
 *  - правый клик по тексту — «Редактировать / Удалить», по кольцу — «Удалить».
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StampTemplate } from '@/types';
import { computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import { sealArcMinSpan } from '@/services/sealRenderService';
import { useFontsStore } from '@/stores/fonts';
import { loadImage } from '@/utils/image';

const props = withDefaults(
  defineProps<{
    template: StampTemplate;
    zoom: number;
    handles?: boolean;
    selectedLineId?: string | null;
    selectedCenterIndex?: number | null;
    selectedRingIndex?: number | null;
    selectedLogo?: boolean;
  }>(),
  {
    handles: true,
    selectedLineId: null,
    selectedCenterIndex: null,
    selectedRingIndex: null,
    selectedLogo: false,
  },
);

const emit = defineEmits<{
  'select-line': [lineId: string | null];
  'span-change': [lineId: string, angle: number];
  'line-move': [lineId: string, radiusOffset: number, angleOffset: number];
  'text-hit': [lineId: string];
  'center-hit': [lineIndex: number];
  'center-select': [lineIndex: number];
  /** Маркер растянул строку центра до новой ширины, pt. */
  'center-stretch': [lineIndex: number, width: number];
  /** Строку центра перетащили (смещения от центра, pt). */
  'center-move': [lineIndex: number, offsetX: number, offsetY: number];
  'ring-select': [ringIndex: number];
  /** Кольцо потянули: новый радиус, pt. */
  'ring-resize': [ringIndex: number, radius: number];
  'ring-delete': [ringIndex: number];
  'logo-select': [];
  'logo-move': [offsetX: number, offsetY: number];
  'logo-resize': [width: number, height: number];
  'logo-rotate': [rotation: number];
  'edit-line': [lineId: string];
  'delete-line': [lineId: string];
}>();

const fonts = useFontsStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const logoImage = ref<HTMLImageElement | null>(null);

const size = computed(() => Math.max(24, Math.min(props.template.width, props.template.height)));
const displaySize = computed(() => Math.round(size.value * props.zoom * 100) / 100);
const layout = computed(() =>
  computeStampLayout(props.template, (fontId) => fonts.familyOf(fontId)),
);

/** Контекстное меню: по тексту или по кольцу. */
const menu = ref<
  | { kind: 'text'; lineId: string; x: number; y: number }
  | { kind: 'ring'; ringIndex: number; x: number; y: number }
  | null
>(null);

/* ======================== Отрисовка ======================== */

async function ensureLogo(): Promise<void> {
  const src = props.template.logo?.src;
  if (!src) {
    logoImage.value = null;
    return;
  }
  try {
    logoImage.value = await loadImage(src);
  } catch {
    logoImage.value = null;
  }
}

function draw(): void {
  const element = canvas.value;
  if (!element) return;
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const cssSize = displaySize.value;
  element.width = Math.max(1, Math.round(cssSize * ratio));
  element.height = Math.max(1, Math.round(cssSize * ratio));
  element.style.width = `${cssSize}px`;
  element.style.height = `${cssSize}px`;
  const context = element.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  const scale = (cssSize / size.value) * ratio;
  context.scale(scale, scale);
  paintStampLayout(context, layout.value, { logoImage: logoImage.value });

  // Выбранное кольцо — очень мелкий пунктир поверх оттиска.
  if (props.selectedRingIndex !== null && layout.value.seal) {
    const ring = layout.value.seal.ink.rings[props.selectedRingIndex];
    if (ring) {
      context.save();
      context.setLineDash([3, 2]);
      context.lineWidth = 1.2;
      context.strokeStyle = '#2f6bff';
      context.beginPath();
      context.arc(ring.cx, ring.cy, ring.radius, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  // Выбранный логотип — пунктирная рамка (с поворотом).
  if (props.selectedLogo && layout.value.logo) {
    const logo = layout.value.logo;
    const cx = logo.x + logo.width / 2;
    const cy = logo.y + logo.height / 2;
    context.save();
    context.translate(cx, cy);
    context.rotate(((logo.rotation ?? 0) * Math.PI) / 180);
    context.setLineDash([3, 2]);
    context.lineWidth = 1;
    context.strokeStyle = '#2f6bff';
    context.strokeRect(-logo.width / 2, -logo.height / 2, logo.width, logo.height);
    context.restore();
  }
}

watch(() => props.template, async () => {
  await ensureLogo();
  draw();
}, { deep: true });
watch(() => props.zoom, () => draw());
watch(() => props.selectedRingIndex, () => draw());
watch(() => props.selectedLogo, () => draw());
watch(() => fonts.loadedOnce, () => draw());

/* ======================== Геометрия и попадания ======================== */

function toSealPoint(event: MouseEvent): { x: number; y: number } | null {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / props.zoom,
    y: (event.clientY - rect.top) / props.zoom,
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
      const reach = Math.max(5, char.fontSize * 0.85);
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
  for (const [index, line] of layout.value.lines.entries()) {
    if (
      point.x >= line.x - 2 &&
      point.x <= line.x + line.width + 2 &&
      point.y >= line.baseline - line.fontSize * 1.05 &&
      point.y <= line.baseline + line.fontSize * 0.3
    ) {
      return index;
    }
  }
  return null;
}

/** Логотип под курсором (с учётом поворота). */
function hitLogo(point: { x: number; y: number }): boolean {
  const logo = layout.value.logo;
  if (!logo) return false;
  const cx = logo.x + logo.width / 2;
  const cy = logo.y + logo.height / 2;
  const radians = (-(logo.rotation ?? 0) * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(localX) <= logo.width / 2 + 2 && Math.abs(localY) <= logo.height / 2 + 2;
}

/* ======================== Маркеры ======================== */

const selectedGeometry = computed(() => {
  if (!props.selectedLineId) return null;
  return layout.value.seal?.ringLines.find((item) => item.lineId === props.selectedLineId) ?? null;
});

const handlePoints = computed(() => {
  const ringLine = selectedGeometry.value;
  if (!ringLine || ringLine.chars.length === 0) {
    return [] as { angle: number; x: number; y: number }[];
  }
  return [ringLine.startAngle, ringLine.endAngle].map((angle) => {
    const radians = (angle * Math.PI) / 180;
    return {
      angle,
      x: (ringLine.cx + Math.cos(radians) * ringLine.radius) * props.zoom,
      y: (ringLine.cy + Math.sin(radians) * ringLine.radius) * props.zoom,
    };
  });
});

const centerHandlePoints = computed(() => {
  const index = props.selectedCenterIndex;
  if (index === null) return [] as { side: 'left' | 'right'; x: number; y: number }[];
  const line = layout.value.lines[index];
  if (!line) return [];
  const y = (line.baseline - line.fontSize * 0.35) * props.zoom;
  return [
    { side: 'left' as const, x: line.x * props.zoom, y },
    { side: 'right' as const, x: (line.x + line.width) * props.zoom, y },
  ];
});

const logoHandlePoints = computed(() => {
  const logo = layout.value.logo;
  if (!logo) return [] as { corner: 'nw' | 'ne' | 'se' | 'sw'; x: number; y: number }[];
  const cx = logo.x + logo.width / 2;
  const cy = logo.y + logo.height / 2;
  const radians = ((logo.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corner = (dx: number, dy: number) => ({
    x: (cx + dx * cos - dy * sin) * props.zoom,
    y: (cy + dx * sin + dy * cos) * props.zoom,
  });
  const hw = logo.width / 2;
  const hh = logo.height / 2;
  return [
    { corner: 'nw' as const, ...corner(-hw, -hh) },
    { corner: 'ne' as const, ...corner(hw, -hh) },
    { corner: 'se' as const, ...corner(hw, hh) },
    { corner: 'sw' as const, ...corner(-hw, hh) },
  ];
});

const logoRotatePoint = computed(() => {
  const logo = layout.value.logo;
  if (!logo) return null;
  const cx = logo.x + logo.width / 2;
  const cy = logo.y + logo.height / 2;
  const radians = ((logo.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const distance = logo.height / 2 + 22 / Math.max(0.4, props.zoom);
  return {
    x: (cx - sin * distance) * props.zoom,
    y: (cy - cos * distance) * props.zoom,
  };
});

/* ======================== Перетаскивания ======================== */

type DragState =
  | { kind: 'line'; lineId: string; pointerAngle: number; pointerRadius: number; startRadiusOffset: number; startAngleOffset: number; maxRadiusOffset: number; moved: boolean }
  | { kind: 'ring'; ringIndex: number }
  | { kind: 'center-move'; index: number; startX: number; startY: number; startOffsetX: number; startOffsetY: number }
  | { kind: 'center-stretch'; index: number; centerX: number }
  | { kind: 'logo-move'; startX: number; startY: number; startOffsetX: number; startOffsetY: number }
  | { kind: 'logo-resize'; centerX: number; centerY: number; startWidth: number; startHeight: number }
  | { kind: 'logo-rotate'; centerX: number; centerY: number; startPointerAngle: number; startRotation: number };

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
  window.addEventListener('pointermove', onWindowMove);
  window.addEventListener('pointerup', onWindowUp, { once: true });
  event.preventDefault();
}

function onWindowMove(event: PointerEvent): void {
  const state = dragState;
  const point = toSealPoint(event);
  if (!state || !point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;

  if (state.kind === 'line') {
    const angle = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
    const radius = Math.hypot(point.x - cx, point.y - cy);
    let deltaAngle = angle - state.pointerAngle;
    deltaAngle = ((deltaAngle % 360) + 540) % 360 - 180;
    const deltaRadius = radius - state.pointerRadius;
    if (!state.moved && Math.abs(deltaAngle) < 1 && Math.abs(deltaRadius) < 0.5) return;
    state.moved = true;
    const radiusOffset = Math.round(
      Math.min(state.maxRadiusOffset, Math.max(-state.maxRadiusOffset, state.startRadiusOffset + deltaRadius)) * 10,
    ) / 10;
    const angleOffset = Math.round((state.startAngleOffset + deltaAngle) * 10) / 10;
    emit('line-move', state.lineId, radiusOffset, angleOffset);
    return;
  }

  if (state.kind === 'ring') {
    emit('ring-resize', state.ringIndex, Math.round(Math.hypot(point.x - cx, point.y - cy) * 10) / 10);
    return;
  }

  if (state.kind === 'center-move') {
    emit(
      'center-move',
      state.index,
      Math.round((state.startOffsetX + point.x - state.startX) * 10) / 10,
      Math.round((state.startOffsetY + point.y - state.startY) * 10) / 10,
    );
    return;
  }

  if (state.kind === 'center-stretch') {
    const width = Math.max(4, Math.abs(point.x - state.centerX) * 2);
    emit('center-stretch', state.index, Math.round(width * 10) / 10);
    return;
  }

  if (state.kind === 'logo-move') {
    emit(
      'logo-move',
      Math.round((state.startOffsetX + point.x - state.startX) * 10) / 10,
      Math.round((state.startOffsetY + point.y - state.startY) * 10) / 10,
    );
    return;
  }

  if (state.kind === 'logo-resize') {
    const logo = layout.value.logo;
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
    emit('logo-resize', Math.round(width * 10) / 10, Math.round(height * 10) / 10);
    return;
  }

  if (state.kind === 'logo-rotate') {
    const angle = (Math.atan2(point.y - state.centerY, point.x - state.centerX) * 180) / Math.PI;
    let delta = angle - state.startPointerAngle;
    delta = ((delta % 360) + 540) % 360 - 180;
    emit('logo-rotate', Math.round(state.startRotation + delta));
  }
}

function onWindowUp(): void {
  dragState = null;
  window.removeEventListener('pointermove', onWindowMove);
}

/* ======================== Клики, меню, двойной клик ======================== */

function onCanvasDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const point = toSealPoint(event);
  if (!point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;

  // Выбранный логотип тянется первым — он может лежать поверх текста.
  if (props.selectedLogo && hitLogo(point)) {
    const logo = props.template.logo;
    if (!logo) return;
    startDrag(event, {
      kind: 'logo-move',
      startX: point.x,
      startY: point.y,
      startOffsetX: logo.offsetX,
      startOffsetY: logo.offsetY,
    });
    return;
  }

  // Логотип лежит поверх текста: клик по нему всегда выбирает логотип.
  if (hitLogo(point)) {
    const logo = props.template.logo;
    if (logo) {
      emit('logo-select');
      startDrag(event, {
        kind: 'logo-move',
        startX: point.x,
        startY: point.y,
        startOffsetX: logo.offsetX,
        startOffsetY: logo.offsetY,
      });
      return;
    }
  }

  // Кольцо проверяем до текста: у букв «щедрый» радиус попадания, иначе
  // кольцо под надписью выбрать нельзя. Приоритет — тонкая полоса кольца.
  const ringIndex = hitRing(point);
  if (ringIndex !== null) {
    emit('ring-select', ringIndex);
    if (ringIndex > 0) startDrag(event, { kind: 'ring', ringIndex });
    return;
  }

  const lineId = hitRingLine(point);
  if (lineId) {
    emit('select-line', lineId);
    const ringLine = layout.value.seal?.ringLines.find((item) => item.lineId === lineId);
    const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
    if (!ringLine || !templateLine) return;
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

  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) {
    emit('center-select', centerIndex);
    const line = props.template.lines[centerIndex];
    startDrag(event, {
      kind: 'center-move',
      index: centerIndex,
      startX: point.x,
      startY: point.y,
      startOffsetX: line?.offsetX ?? 0,
      startOffsetY: line?.offsetY ?? 0,
    });
    return;
  }

  if (hitLogo(point)) {
    const logo = props.template.logo;
    if (!logo) return;
    emit('logo-select');
    startDrag(event, {
      kind: 'logo-move',
      startX: point.x,
      startY: point.y,
      startOffsetX: logo.offsetX,
      startOffsetY: logo.offsetY,
    });
    return;
  }

  emit('select-line', null);
}

/* --- маркеры --- */

function onRingHandleDown(event: PointerEvent): void {
  event.preventDefault();
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
  const logo = layout.value.logo;
  if (!logo) return;
  startDrag(event, {
    kind: 'logo-resize',
    centerX: logo.x + logo.width / 2,
    centerY: logo.y + logo.height / 2,
    startWidth: logo.width,
    startHeight: logo.height,
  });
}

function onLogoRotateDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const logo = layout.value.logo;
  const point = toSealPoint(event);
  if (!logo || !point) return;
  const centerX = logo.x + logo.width / 2;
  const centerY = logo.y + logo.height / 2;
  startDrag(event, {
    kind: 'logo-rotate',
    centerX,
    centerY,
    startPointerAngle: (Math.atan2(point.y - centerY, point.x - centerX) * 180) / Math.PI,
    startRotation: logo.rotation ?? 0,
  });
}

/* --- контекстное меню --- */

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const point = toSealPoint(event);
  const element = canvas.value;
  if (!point || !element) return;
  const rect = element.getBoundingClientRect();

  // Сначала текст: он лежит поверх колец, и его меню важнее.
  const lineId = hitRingLine(point);
  if (lineId) {
    emit('select-line', lineId);
    menu.value = { kind: 'text', lineId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    return;
  }
  // Свободное место на кольце — меню кольца.
  const ringIndex = hitRing(point);
  if (ringIndex !== null) {
    emit('ring-select', ringIndex);
    menu.value = { kind: 'ring', ringIndex, x: event.clientX - rect.left, y: event.clientY - rect.top };
    return;
  }
  menu.value = null;
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
  if (!menu.value || menu.value.kind !== 'text') return;
  const lineId = menu.value.lineId;
  closeMenu();
  emit('edit-line', lineId);
}

function pickDelete(): void {
  if (!menu.value) return;
  if (menu.value.kind === 'text') {
    const lineId = menu.value.lineId;
    closeMenu();
    emit('delete-line', lineId);
    return;
  }
  const ringIndex = menu.value.ringIndex;
  closeMenu();
  emit('ring-delete', ringIndex);
}

function onDoubleClick(event: MouseEvent): void {
  const point = toSealPoint(event);
  if (!point) return;
  const lineId = hitRingLine(point);
  if (lineId) {
    emit('text-hit', lineId);
    return;
  }
  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) emit('center-hit', centerIndex);
}

onMounted(async () => {
  await ensureLogo();
  draw();
  window.addEventListener('pointerdown', onWindowDown, true);
  window.addEventListener('keydown', onEscape);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowMove);
  window.removeEventListener('pointermove', onRingHandleMove);
  window.removeEventListener('pointerup', onWindowUp);
  window.removeEventListener('pointerup', onRingHandleUp);
  window.removeEventListener('pointerdown', onWindowDown, true);
  window.removeEventListener('keydown', onEscape);
  logoImage.value = null;
});
</script>

<template>
  <div
    class="relative inline-flex items-center justify-center"
    :style="{ width: `${displaySize}px`, height: `${displaySize}px` }"
  >
    <canvas
      ref="canvas"
      data-testid="seal-preview-canvas"
      class="block cursor-pointer rounded-sm"
      @pointerdown="onCanvasDown"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
    />

    <!-- Маркеры строки по кольцу -->
    <template v-if="handles && selectedLineId">
      <button
        v-for="(point, index) in handlePoints"
        :key="`ring-handle-${index}`"
        type="button"
        :data-testid="`seal-handle-${index}`"
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-brand-500 shadow ring-1 ring-brand-700/40 transition-transform hover:scale-125"
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
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-brand-500 shadow ring-1 ring-brand-700/40 transition-transform hover:scale-125"
        :style="{ left: `${point.x}px`, top: `${point.y}px` }"
        title="Потяните, чтобы растянуть или сжать строку центра"
        @pointerdown="onCenterHandleDown($event, selectedCenterIndex)"
      />
    </template>

    <!-- Маркеры логотипа: углы + поворот -->
    <template v-if="handles && selectedLogo && template.logo">
      <button
        v-for="point in logoHandlePoints"
        :key="`logo-${point.corner}`"
        type="button"
        :data-testid="`seal-logo-handle-${point.corner}`"
        class="absolute z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white bg-brand-500 shadow"
        :style="{ left: `${point.x}px`, top: `${point.y}px` }"
        title="Потяните, чтобы изменить размер (Shift — с сохранением пропорций)"
        @pointerdown="onLogoCornerDown"
      />
      <button
        v-if="logoRotatePoint"
        type="button"
        data-testid="seal-logo-rotate"
        class="absolute z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-brand-600 text-white shadow"
        :style="{ left: `${logoRotatePoint.x}px`, top: `${logoRotatePoint.y}px` }"
        title="Повернуть логотип"
        @pointerdown="onLogoRotateDown"
      >
        <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M9.5 4.2A4 4 0 1 0 10 7.5" />
          <path d="M10 2v2.6H7.4" />
        </svg>
      </button>
    </template>

    <!-- Контекстное меню -->
    <div
      v-if="menu"
      data-testid="seal-text-menu"
      class="absolute z-20 min-w-[160px] animate-fade-in rounded-lg border border-slate-200 bg-white py-1 shadow-floating dark:border-slate-700 dark:bg-slate-900"
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
      <button
        v-else
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
        data-testid="seal-menu-ring-delete"
        @click="pickDelete"
      >
        Удалить кольцо
      </button>
    </div>
  </div>
</template>
