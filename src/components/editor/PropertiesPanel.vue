<script setup lang="ts">
/**
 * Панель свойств выделенного объекта (или группы объектов).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type {
  DrawingPayload,
  EditorObject,
  HighlightPayload,
  ImagePayload,
  ShapePayload,
  SignaturePayload,
  StampPayload,
  TextPayload,
  TextAlign,
  VerticalAlign,
  WhiteoutPayload,
} from '@/types';
import { DASH_OPTIONS, ZOOM_PRESETS } from '@/constants';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useFontsStore } from '@/stores/fonts';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { useSettingsStore } from '@/stores/settings';
import { usePdfStore } from '@/stores/pdf';
import { rescaleStrokesForBox, scaleStrokes } from '@/services/strokeService';
import { layerBaseName, layerDetail, layerLabels } from '@/utils/layers';
import { fitStampTemplate } from '@/services/stampRenderService';
import AppSection from '@/components/ui/AppSection.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const objects = useObjectsStore();
const editor = useEditorStore();
const fonts = useFontsStore();
const library = useLibraryStore();
const ui = useUiStore();
const settings = useSettingsStore();
const pdf = usePdfStore();

const textArea = ref<HTMLTextAreaElement | null>(null);

const selected = computed(() => objects.selectedObjects);
const single = computed(() => (selected.value.length === 1 ? selected.value[0] : null));
const multiple = computed(() => selected.value.length > 1);

/** Приведение типа payload. */
const textPayload = computed(() => single.value?.payload as TextPayload | undefined);
const imagePayload = computed(() => single.value?.payload as ImagePayload | undefined);
const shapePayload = computed(() => single.value?.payload as ShapePayload | undefined);

/**
 * Подпись цвета у фигур: у линий и стрелок заливки нет, поэтому «Обводка»
 * там называется просто «Цвет».
 */
const shapeColorLabel = computed(() => {
  const kind = shapePayload.value?.kind;
  return kind === 'line' || kind === 'arrow' ? 'Цвет' : 'Обводка';
});
const stampPayload = computed(() => single.value?.payload as StampPayload | undefined);
const drawingPayload = computed(
  () => single.value?.payload as DrawingPayload | SignaturePayload | undefined,
);
const whiteoutPayload = computed(() => single.value?.payload as WhiteoutPayload | undefined);
const highlightPayload = computed(() => single.value?.payload as HighlightPayload | undefined);

/* ======================== «Живые» правки ======================== */

let burstActive = false;
let burstTimer: number | null = null;

/**
 * Изменение с одним снимком истории на серию правок: набор текста,
 * движение ползунка или несколько быстрых кликов по цвету.
 */
function edit(label: string, mutate: () => void): void {
  if (!burstActive) {
    objects.commit(label);
    burstActive = true;
  }
  mutate();
  if (burstTimer !== null) window.clearTimeout(burstTimer);
  burstTimer = window.setTimeout(() => {
    burstActive = false;
    burstTimer = null;
  }, 700);
}

function patch(id: string, value: Parameters<typeof objects.patchSilent>[1]): void {
  objects.patchSilent(id, value);
}

/* ======================== Общие свойства ======================== */

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: `${font.name}${font.supportsCyrillic ? '' : ' (без кириллицы)'}`,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

const shapeKindLabels: Record<string, string> = {
  rect: 'Прямоугольник',
  ellipse: 'Эллипс',
  line: 'Линия',
  arrow: 'Стрелка',
};

/**
 * Заголовок объекта — так же, как в панели «Слои»: название по инструменту и
 * номер для одинаковых («Прямоугольник 2», «Эллипс»).
 */
const objectTitle = computed(() => {
  const obj = single.value;
  if (!obj) return '';
  const labels = layerLabels(objects.forPage(obj.page));
  return labels.get(obj.id) ?? layerBaseName(obj);
});

/** Дополнительная строка под заголовком: текст объекта, название штампа. */
const objectSubtitle = computed(() => {
  const obj = single.value;
  return obj ? layerDetail(obj) : '';
});

/* ======================== Текст ======================== */

function onTextInput(event: Event): void {
  const obj = single.value;
  if (!obj) return;
  const value = (event.target as HTMLTextAreaElement).value;
  edit('Изменение текста', () => patch(obj.id, { payload: { text: value } }));
}

function setFont(fontId: string | number | null): void {
  const obj = single.value;
  if (!obj || typeof fontId !== 'string') return;
  const family = fonts.familyOf(fontId);
  objects.update(obj.id, { payload: { fontId, fontFamily: family } }, 'Смена шрифта');
  void fonts.ensureFontLoadedFor(fontId, textPayload.value?.bold ?? false, textPayload.value?.italic ?? false);
  void checkCoverage(fontId);
}

/** Предупреждение, если в шрифте нет нужных символов. */
async function checkCoverage(fontId: string): Promise<void> {
  const payload = textPayload.value;
  if (!payload || !settings.settings.checkGlyphs) return;
  const result = await fonts.checkCoverage(
    fontId,
    payload.text,
    payload.bold,
    payload.italic,
  );
  if (!result.supported) {
    ui.notify.warning(
      'В шрифте нет части символов',
      `Отсутствуют: ${result.missing.slice(0, 20).join(' ')}. При экспорте будет подобран шрифт с поддержкой.`,
    );
  }
}

function toggleBold(): void {
  const obj = single.value;
  const payload = textPayload.value;
  if (!obj || !payload) return;
  if (!fonts.hasBold(payload.fontId)) {
    ui.notify.info('У шрифта нет жирного начертания', 'Текст будет выведен обычным начертанием.');
  }
  objects.update(obj.id, { payload: { bold: !payload.bold } }, 'Жирный шрифт');
}

function toggleItalic(): void {
  const obj = single.value;
  const payload = textPayload.value;
  if (!obj || !payload) return;
  if (!fonts.hasItalic(payload.fontId)) {
    ui.notify.info('У шрифта нет курсива', 'В PDF будет применён наклон текста.');
  }
  objects.update(obj.id, { payload: { italic: !payload.italic } }, 'Курсив');
}

const alignButtons: { value: TextAlign; icon: string; label: string }[] = [
  { value: 'left', icon: 'alignLeft', label: 'По левому краю' },
  { value: 'center', icon: 'alignCenter', label: 'По центру' },
  { value: 'right', icon: 'alignRight', label: 'По правому краю' },
];

const verticalOptions: { value: VerticalAlign; label: string }[] = [
  { value: 'top', label: 'Сверху' },
  { value: 'middle', label: 'По центру' },
  { value: 'bottom', label: 'Снизу' },
];

/* ======================== Штампы ======================== */

function openStampEditor(): void {
  const payload = stampPayload.value;
  if (!payload) return;
  ui.openModal('stampEditor', { templateId: payload.templateId, objectId: single.value?.id });
}

/** Сохранить изменённый штамп обратно в библиотеку. */
async function saveStampToLibrary(): Promise<void> {
  const payload = stampPayload.value;
  if (!payload) return;
  await library.saveStamp({ ...payload.template, name: payload.template.name });
  ui.notify.success('Штамп сохранён в библиотеку', payload.template.name);
}

/** Применить штамп ко всем страницам документа. */
function applyStampToAllPages(): void {
  const obj = single.value;
  if (!obj || obj.type !== 'stamp') return;
  const payload = obj.payload as StampPayload;
  const created: EditorObject[] = [];
  for (let page = 0; page < pdf.pageCount; page += 1) {
    if (page === obj.page) continue;
    created.push({
      ...JSON.parse(JSON.stringify(obj)),
      id: `${obj.id}-p${page}`,
      page,
      zIndex: objects.nextZIndex(page),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as EditorObject);
  }
  if (created.length === 0) {
    ui.notify.info('Штамп уже стоит на всех страницах');
    return;
  }
  objects.add(created, 'Перенос штампа на все страницы');
  ui.notify.success('Штамп перенесён', `Добавлено страниц: ${created.length}`);
  void payload;
}

/* ======================== Подписи/рисунки ======================== */

function setStrokeColor(color: string): void {
  const obj = single.value;
  const payload = drawingPayload.value;
  if (!obj || !payload) return;
  edit('Цвет подписи', () =>
    patch(obj.id, {
      payload: {
        color,
        strokes: payload.strokes.map((stroke) => ({ ...stroke, color })),
      },
    }),
  );
}

function setStrokeWidthScale(factor: number): void {
  const obj = single.value;
  const payload = drawingPayload.value;
  if (!obj || !payload) return;
  const reference = payload.strokes[0]?.width ?? 2;
  const target = Math.max(0.5, reference * factor);
  const ratio = target / Math.max(0.1, reference);
  edit('Толщина линий', () =>
    patch(obj.id, {
      payload: {
        strokeWidth: target,
        strokes: payload.strokes.map((stroke) => ({
          ...stroke,
          width: Math.max(0.2, stroke.width * ratio),
        })),
      },
    }),
  );
}

/** Пропорциональное изменение размера (без искажения). */
function keepAspect(): void {
  const obj = single.value;
  if (!obj) return;
  objects.update(obj.id, { height: (obj.height / obj.width) * obj.width }, 'Пропорции');
}

/* ======================== Изображения ======================== */

async function replaceImageSource(): Promise<void> {
  const obj = single.value;
  if (!obj || obj.type !== 'image') return;
  const { openFileDialog, readImageFile } = await import('@/services/fileService');
  const { ACCEPT } = await import('@/services/fileService');
  const files = await openFileDialog({ accept: ACCEPT.images });
  if (files.length === 0) return;
  const image = await readImageFile(files[0]);
  objects.update(
    obj.id,
    {
      payload: {
        src: image.src,
        mimeType: image.mimeType,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      },
    },
    'Замена изображения',
  );
}

async function saveImageToLibrary(): Promise<void> {
  const payload = imagePayload.value;
  const obj = single.value;
  if (!payload || !obj) return;
  await library.saveImage({
    id: `image-${obj.id}`,
    name: payload.alt || 'Изображение',
    src: payload.src,
    mimeType: payload.mimeType,
    naturalWidth: payload.naturalWidth,
    naturalHeight: payload.naturalHeight,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
  });
  ui.notify.success('Изображение сохранено в библиотеку');
}

/* ======================== Множественное выделение ======================== */

const alignActions: { kind: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'; icon: string; label: string }[] = [
  { kind: 'left', icon: 'alignLeft', label: 'По левому краю' },
  { kind: 'center', icon: 'alignCenter', label: 'По центру' },
  { kind: 'right', icon: 'alignRight', label: 'По правому краю' },
  { kind: 'top', icon: 'moveUp', label: 'По верху' },
  { kind: 'middle', icon: 'front', label: 'По середине' },
  { kind: 'bottom', icon: 'moveDown', label: 'По низу' },
];

/**
 * Фокус в поле текста при редактировании.
 *
 * flush: 'post' — ждём, пока панель отрисуется. Если панель смонтировалась уже
 * после начала редактирования (переключили вкладку), фокус ставим в onMounted.
 */
watch(
  () => editor.editingTextId,
  async (id) => {
    if (!id) return;
    await nextTick();
    textArea.value?.focus();
    textArea.value?.select();
  },
  { flush: 'post' },
);

onMounted(async () => {
  if (!editor.editingTextId) return;
  await nextTick();
  textArea.value?.focus();
  textArea.value?.select();
});

/**
 * Фокус в поле текста — только при явном редактировании.
 *
 * Раньше фокус ставился на любом выделении текстового объекта, и тогда все
 * горячие клавиши (Ctrl+Z, Ctrl+C, буквы инструментов) переставали работать:
 * обработчик намеренно игнорирует клавиши в полях ввода. Явные способы
 * редактирования (двойной клик по объекту, кнопка в панели слоёв, создание
 * текста) ставят `editor.editingTextId` сами.
 */
watch(
  () => [single.value?.id, single.value?.type] as const,
  () => {
    const id = single.value?.id;
    // Прекращаем редактирование, если выделен другой объект.
    if (editor.editingTextId && editor.editingTextId !== id) {
      editor.editingTextId = null;
    }
  },
);

void keepAspect;
void ZOOM_PRESETS;
void fitStampTemplate;
void rescaleStrokesForBox;
void scaleStrokes;
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <!-- Нет выделения -->
    <template v-if="!objects.hasSelection">
      <AppEmptyState
        compact
        icon="cursor"
        title="Объект не выбран"
        text="Выберите объект на странице или добавьте новый инструментом слева."
      />
      <AppSection title="Подсказки" icon="info">
        <ul class="space-y-1.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
          <li>• Двойной клик по объекту — редактирование</li>
          <li>• Shift + клик — добавить к выделению</li>
          <li>• Alt + текст — заменить текст из PDF (корректурный слой)</li>
          <li>• Колесо мыши — прокрутка, Ctrl + колесо — зум</li>
        </ul>
      </AppSection>
    </template>

    <template v-else>
      <!-- Заголовок -->
      <div class="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <div class="min-w-0">
          <p
            class="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100"
            data-object-title
          >
            {{ single ? objectTitle : `${selected.length} объектов` }}
          </p>
          <p
            v-if="single && objectSubtitle"
            class="truncate text-[11px] text-slate-400"
            data-object-subtitle
          >
            {{ objectSubtitle }}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <AppTooltip :text="selected.every((o) => o.locked) ? 'Разблокировать' : 'Заблокировать'">
            <AppButton
              :icon="selected.every((o) => o.locked) ? 'lock' : 'unlock'"
              size="icon"
              variant="ghost"
              @click="objects.setLocked(objects.selectedIds, !selected.every((o) => o.locked))"
            />
          </AppTooltip>
          <AppTooltip :text="selected.every((o) => o.visible) ? 'Скрыть' : 'Показать'">
            <AppButton
              :icon="selected.every((o) => o.visible) ? 'eye' : 'eyeOff'"
              size="icon"
              variant="ghost"
              @click="objects.setVisible(objects.selectedIds, !selected.every((o) => o.visible))"
            />
          </AppTooltip>
          <AppTooltip text="Удалить" shortcut="Delete">
            <AppButton
              icon="trash"
              size="icon"
              variant="ghost"
              @click="objects.remove(objects.selectedIds)"
            />
          </AppTooltip>
        </div>
      </div>

      <!-- Геометрия -->
      <AppSection title="Положение и размер" icon="crop">
        <div class="grid grid-cols-2 gap-2">
          <AppInput
            label="X, pt"
            type="number"
            size="sm"
            :step="0.5"
            :model-value="single ? Number(single.x.toFixed(2)) : null"
            :disabled="!single"
            @update:model-value="single && objects.update(single.id, { x: Number($event) || 0 }, 'Позиция')"
          />
          <AppInput
            label="Y, pt"
            type="number"
            size="sm"
            :step="0.5"
            :model-value="single ? Number(single.y.toFixed(2)) : null"
            :disabled="!single"
            @update:model-value="single && objects.update(single.id, { y: Number($event) || 0 }, 'Позиция')"
          />
          <AppInput
            label="Ширина, pt"
            type="number"
            size="sm"
            :min="1"
            :step="0.5"
            :model-value="single ? Number(single.width.toFixed(2)) : null"
            :disabled="!single"
            @update:model-value="single && objects.update(single.id, { width: Math.max(1, Number($event) || 1) }, 'Размер')"
          />
          <AppInput
            label="Высота, pt"
            type="number"
            size="sm"
            :min="1"
            :step="0.5"
            :model-value="single ? Number(single.height.toFixed(2)) : null"
            :disabled="!single"
            @update:model-value="single && objects.update(single.id, { height: Math.max(1, Number($event) || 1) }, 'Размер')"
          />
        </div>
        <AppSlider
          label="Поворот"
          unit="°"
          :min="-180"
          :max="180"
          :step="1"
          :model-value="single ? single.rotation : 0"
          :disabled="!single"
          @update:model-value="single && edit('Поворот', () => patch(single!.id, { rotation: $event }))"
        />
        <AppSlider
          label="Прозрачность"
          :min="0.05"
          :max="1"
          :step="0.01"
          :precision="2"
          :model-value="single ? single.opacity : 1"
          @update:model-value="
            objects.setOpacity(objects.selectedIds, $event)
          "
        />
      </AppSection>

      <!-- Текст -->
      <AppSection v-if="single && single.type === 'text' && textPayload" title="Текст" icon="type">
        <textarea
          ref="textArea"
          :value="textPayload.text"
          rows="4"
          placeholder="Введите текст (поддерживается кириллица)"
          class="w-full resize-y rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          @input="onTextInput"
        />
        <AppSelect
          label="Шрифт"
          size="sm"
          :model-value="textPayload.fontId"
          :options="fontOptions"
          @update:model-value="setFont"
        />
        <div class="grid grid-cols-2 gap-2">
          <AppInput
            label="Размер, pt"
            type="number"
            size="sm"
            :min="4"
            :max="400"
            :model-value="textPayload.fontSize"
            @update:model-value="
              single && edit('Размер шрифта', () => patch(single!.id, { payload: { fontSize: Number($event) || 12 } }))
            "
          />
          <AppColorPicker
            label="Цвет"
            compact
            :model-value="textPayload.color"
            @update:model-value="single && edit('Цвет текста', () => patch(single!.id, { payload: { color: $event } }))"
          />
        </div>
        <div class="flex items-center gap-1">
          <AppTooltip text="Жирный">
            <AppButton
              icon="bold"
              size="icon"
              variant="ghost"
              :active="textPayload.bold"
              @click="toggleBold"
            />
          </AppTooltip>
          <AppTooltip text="Курсив">
            <AppButton
              icon="italic"
              size="icon"
              variant="ghost"
              :active="textPayload.italic"
              @click="toggleItalic"
            />
          </AppTooltip>
          <AppTooltip text="Подчёркнутый">
            <AppButton
              icon="underline"
              size="icon"
              variant="ghost"
              :active="textPayload.underline"
              @click="single && objects.update(single.id, { payload: { underline: !textPayload!.underline } }, 'Подчёркивание')"
            />
          </AppTooltip>
          <div class="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-700" />
          <AppTooltip v-for="item in alignButtons" :key="item.value" :text="item.label">
            <AppButton
              :icon="item.icon"
              size="icon"
              variant="ghost"
              :active="textPayload.align === item.value"
              @click="single && objects.update(single.id, { payload: { align: item.value } }, 'Выравнивание')"
            />
          </AppTooltip>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <AppInput
            label="Межстрочный"
            type="number"
            size="sm"
            :min="0.8"
            :max="3"
            :step="0.05"
            :model-value="textPayload.lineHeight"
            @update:model-value="single && edit('Межстрочный интервал', () => patch(single!.id, { payload: { lineHeight: Number($event) || 1.25 } }))"
          />
          <AppInput
            label="Межбуквенный"
            type="number"
            size="sm"
            :min="-5"
            :max="20"
            :step="0.1"
            :model-value="textPayload.letterSpacing"
            @update:model-value="single && edit('Межбуквенное расстояние', () => patch(single!.id, { payload: { letterSpacing: Number($event) || 0 } }))"
          />
        </div>
        <AppSelect
          label="Вертикальное выравнивание"
          size="sm"
          :model-value="textPayload.verticalAlign"
          :options="verticalOptions"
          @update:model-value="single && objects.update(single.id, { payload: { verticalAlign: $event } }, 'Вертикальное выравнивание')"
        />
        <AppToggle
          label="Автовысота по тексту"
          :model-value="textPayload.autoHeight"
          @update:model-value="single && objects.update(single.id, { payload: { autoHeight: $event } }, 'Автовысота')"
        />
        <AppToggle
          label="Тень под текстом"
          hint="Помогает читаемости поверх сканов"
          :model-value="textPayload.shadow"
          @update:model-value="single && objects.update(single.id, { payload: { shadow: $event } }, 'Тень текста')"
        />
        <AppColorPicker
          label="Фон под текстом"
          allow-null
          :model-value="textPayload.backgroundColor ?? ''"
          @update:model-value="single && edit('Фон текста', () => patch(single!.id, { payload: { backgroundColor: $event || null } }))"
        />
      </AppSection>

      <!-- Изображение -->
      <AppSection v-if="single && single.type === 'image' && imagePayload" title="Изображение" icon="image">
        <AppSelect
          label="Вписывание"
          size="sm"
          :model-value="imagePayload.fit"
          :options="[
            { value: 'contain', label: 'Вписать целиком' },
            { value: 'cover', label: 'Заполнить (обрезать)' },
            { value: 'fill', label: 'Растянуть' },
          ]"
          @update:model-value="single && objects.update(single.id, { payload: { fit: $event } }, 'Вписывание')"
        />
        <AppInput
          label="Скругление углов, pt"
          type="number"
          size="sm"
          :min="0"
          :model-value="imagePayload.cornerRadius"
          @update:model-value="single && edit('Скругление', () => patch(single!.id, { payload: { cornerRadius: Number($event) || 0 } }))"
        />
        <div class="grid grid-cols-2 gap-2">
          <AppColorPicker
            label="Рамка"
            compact
            allow-null
            :model-value="imagePayload.borderColor ?? ''"
            @update:model-value="single && edit('Рамка', () => patch(single!.id, { payload: { borderColor: $event || null } }))"
          />
          <AppInput
            label="Толщина"
            type="number"
            size="sm"
            :min="0"
            :model-value="imagePayload.borderWidth"
            @update:model-value="single && edit('Толщина рамки', () => patch(single!.id, { payload: { borderWidth: Number($event) || 0 } }))"
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <AppButton size="sm" icon="refresh" @click="replaceImageSource">Заменить</AppButton>
          <AppButton size="sm" icon="book" @click="saveImageToLibrary">В библиотеку</AppButton>
        </div>
        <p class="text-[11px] text-slate-400">
          Исходный размер: {{ imagePayload.naturalWidth }} × {{ imagePayload.naturalHeight }} px
        </p>
      </AppSection>

      <!-- Фигура -->
      <AppSection v-if="single && single.type === 'shape' && shapePayload" title="Фигура" icon="square">
        <p class="text-[11px] text-slate-400">{{ shapeKindLabels[shapePayload.kind] }}</p>
        <div class="grid grid-cols-2 gap-2">
          <AppColorPicker
            :label="shapeColorLabel"
            compact
            allow-null
            :model-value="shapePayload.stroke ?? ''"
            @update:model-value="single && edit('Цвет обводки', () => patch(single!.id, { payload: { stroke: $event || null } }))"
          />
          <AppInput
            label="Толщина"
            type="number"
            size="sm"
            :min="0"
            :step="0.5"
            :model-value="shapePayload.strokeWidth"
            @update:model-value="single && edit('Толщина обводки', () => patch(single!.id, { payload: { strokeWidth: Math.max(0, Number($event) || 0) } }))"
          />
        </div>
        <AppColorPicker
          v-if="shapePayload.kind !== 'line' && shapePayload.kind !== 'arrow'"
          label="Заливка"
          allow-null
          :model-value="shapePayload.fill ?? ''"
          @update:model-value="single && edit('Заливка', () => patch(single!.id, { payload: { fill: $event || null } }))"
        />
        <AppInput
          v-if="shapePayload.kind === 'rect'"
          label="Скругление, pt"
          type="number"
          size="sm"
          :min="0"
          :model-value="shapePayload.cornerRadius"
          @update:model-value="single && edit('Скругление', () => patch(single!.id, { payload: { cornerRadius: Number($event) || 0 } }))"
        />
        <AppSelect
          label="Штриховая линия"
          size="sm"
          :model-value="shapePayload.dash.join(',')"
          :options="DASH_OPTIONS"
          @update:model-value="
            single &&
            objects.update(
              single.id,
              { payload: { dash: String($event) ? String($event).split(',').map(Number) : [] } },
              'Штриховая линия',
            )
          "
        />
        <AppSelect
          v-if="shapePayload.kind === 'arrow'"
          label="Наконечники"
          size="sm"
          :model-value="shapePayload.arrowHead"
          :options="[
            { value: 'end', label: 'На конце' },
            { value: 'both', label: 'С двух сторон' },
            { value: 'none', label: 'Без наконечника' },
          ]"
          @update:model-value="single && objects.update(single.id, { payload: { arrowHead: $event } }, 'Наконечники')"
        />
      </AppSection>

      <!-- Закрашивание / выделение -->
      <AppSection
        v-if="single && single.type === 'whiteout' && whiteoutPayload"
        title="Закрашивание"
        icon="whiteout"
      >
        <AppColorPicker
          label="Цвет"
          :model-value="whiteoutPayload.color"
          @update:model-value="single && edit('Цвет закрашивания', () => patch(single!.id, { payload: { color: $event } }))"
        />
      </AppSection>

      <AppSection
        v-if="single && single.type === 'highlight' && highlightPayload"
        title="Выделение"
        icon="highlight"
      >
        <AppColorPicker
          label="Цвет"
          :model-value="highlightPayload.color"
          @update:model-value="single && edit('Цвет выделения', () => patch(single!.id, { payload: { color: $event } }))"
        />
        <AppSelect
          label="Режим наложения"
          size="sm"
          :model-value="highlightPayload.blend"
          :options="[
            { value: 'multiply', label: 'Multiply (текст остаётся чёрным)' },
            { value: 'normal', label: 'Обычный' },
          ]"
          @update:model-value="single && objects.update(single.id, { payload: { blend: $event } }, 'Режим наложения')"
        />
      </AppSection>

      <!-- Подпись/рисунок -->
      <AppSection
        v-if="single && (single.type === 'signature' || single.type === 'drawing') && drawingPayload"
        title="Штрихи"
        icon="signature"
      >
        <AppColorPicker
          label="Цвет"
          :model-value="drawingPayload.strokes[0]?.color ?? '#111827'"
          @update:model-value="setStrokeColor"
        />
        <div class="flex items-center gap-2">
          <AppButton size="sm" variant="subtle" @click="setStrokeWidthScale(0.8)">Тоньше</AppButton>
          <AppButton size="sm" variant="subtle" @click="setStrokeWidthScale(1.25)">Толще</AppButton>
        </div>
        <p class="text-[11px] text-slate-400">
          Штрихов: {{ drawingPayload.strokes.length }} · векторное хранение
        </p>
        <AppButton
          size="sm"
          icon="trash"
          variant="ghost"
          @click="
            single &&
              objects.update(single.id, { payload: { strokes: [] } }, 'Очистка штрихов')
          "
        >
          Очистить штрихи
        </AppButton>
      </AppSection>

      <!-- Штамп -->
      <AppSection v-if="single && single.type === 'stamp' && stampPayload" title="Штамп" icon="stamp">
        <p class="text-[11px] text-slate-400">
          {{ stampPayload.template.kind === 'seal' ? 'Печать' : 'Штамп' }} ·
          {{ stampPayload.template.shape === 'rect' ? 'прямоугольный' : 'круглый' }}
        </p>
        <AppInput
          label="Текст (первая строка)"
          size="sm"
          :model-value="stampPayload.overrides.textOverride ?? stampPayload.template.lines[0]?.text ?? ''"
          @update:model-value="single && edit('Текст штампа', () => patch(single!.id, { payload: { overrides: { ...stampPayload!.overrides, textOverride: $event } } }))"
        />
        <AppColorPicker
          label="Цвет"
          compact
          allow-null
          :model-value="stampPayload.overrides.color ?? stampPayload.template.color"
          @update:model-value="single && edit('Цвет штампа', () => patch(single!.id, { payload: { overrides: { ...stampPayload!.overrides, color: $event || null } } }))"
        />
        <div class="flex flex-wrap gap-2">
          <AppButton size="sm" icon="settings" @click="openStampEditor">Редактировать</AppButton>
          <AppButton size="sm" icon="save" @click="saveStampToLibrary">В библиотеку</AppButton>
          <AppButton size="sm" icon="copy" @click="applyStampToAllPages">На все страницы</AppButton>
        </div>
      </AppSection>

      <!-- Группа объектов -->
      <AppSection v-if="multiple" title="Выравнивание" icon="alignCenter">
        <div class="flex flex-wrap gap-1">
          <AppTooltip v-for="action in alignActions" :key="action.kind" :text="action.label">
            <AppButton
              :icon="action.icon"
              size="icon"
              variant="ghost"
              @click="objects.align(action.kind)"
            />
          </AppTooltip>
        </div>
        <div class="flex gap-2">
          <AppButton size="sm" icon="alignLeft" @click="objects.distribute('horizontal')">
            Распределить по X
          </AppButton>
          <AppButton size="sm" icon="moveUp" @click="objects.distribute('vertical')">
            По Y
          </AppButton>
        </div>
        <div class="flex gap-2">
          <AppButton size="sm" icon="group" @click="objects.group()">Группировать</AppButton>
          <AppButton size="sm" icon="ungroup" @click="objects.ungroup()">Разгруппировать</AppButton>
        </div>
        <AppButton size="sm" icon="copy" variant="subtle" block @click="objects.duplicate()">
          Дублировать выделенные
        </AppButton>
      </AppSection>

      <!-- Порядок и перенос -->
      <AppSection title="Порядок и перенос" icon="layers">
        <div class="flex gap-1">
          <AppButton size="sm" icon="front" block @click="objects.bringToFront()">Поверх</AppButton>
          <AppButton size="sm" icon="back" block @click="objects.sendToBack()">Вниз</AppButton>
        </div>
        <AppSelect
          label="Перенести на страницу"
          size="sm"
          :model-value="null"
          placeholder="Выберите страницу…"
          :options="
            pdf.pages.map((page) => ({
              value: page.index + 1,
              label: `Страница ${page.index + 1}`,
            }))
          "
          @update:model-value="
            (value) => objects.moveToPage(objects.selectedIds, Number(value) - 1, pdf.geometry(Number(value) - 1))
          "
        />
      </AppSection>

      <!-- Служебное -->
      <AppSection title="Служебное" icon="info" :default-open="false">
        <p class="text-[11px] text-slate-400">
          Создан: {{ single?.createdAt ? new Date(single.createdAt).toLocaleString('ru-RU') : '—' }}
        </p>
        <p class="text-[11px] text-slate-400">
          Изменён: {{ single?.updatedAt ? new Date(single.updatedAt).toLocaleString('ru-RU') : '—' }}
        </p>
        <AppInput
          label="Имя объекта"
          size="sm"
          :model-value="single?.name ?? ''"
          @update:model-value="single && objects.rename(single.id, String($event))"
        />
      </AppSection>
    </template>
  </div>
</template>
