<script setup lang="ts">
/**
 * Конструктор штампов и печатей.
 *
 * Возможности: прямоугольные/круглые/овальные формы, рамка и двойная рамка,
 * текст по прямой и по кругу, логотип, прозрачность, поворот, палитра.
 * Превью рисуется тем же кодом, что используется при вставке в документ,
 * поэтому результат совпадает с предпросмотром.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { StampTemplate, StampTextLine } from '@/types';
import { STAMP_COLORS } from '@/constants';
import { createId } from '@/utils/id';
import { createStampLine, createStampTemplate, createSealTemplate, computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import { createStampObject } from '@/services/objectFactory';
import { loadImage } from '@/utils/image';
import { strokesToSvg } from '@/services/strokeService';
import { useUiStore } from '@/stores/ui';
import { useLibraryStore } from '@/stores/library';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useFontsStore } from '@/stores/fonts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppTabs from '@/components/ui/AppTabs.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const ui = useUiStore();
const library = useLibraryStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const fonts = useFontsStore();

const canvas = ref<HTMLCanvasElement | null>(null);
const tab = ref('main');
const template = ref<StampTemplate>(createStampTemplate());
const targetObjectId = ref<string | null>(null);
const logoImage = ref<HTMLImageElement | null>(null);
const isSaving = ref(false);
const pixelRatio = 3;

const isOpen = computed({
  get: () => ui.modals.stampEditor,
  set: (value: boolean) => {
    if (value) ui.openModal('stampEditor');
    else ui.closeModal('stampEditor');
  },
});

const tabs = [
  { id: 'main', label: 'Основа', icon: 'stamp' },
  { id: 'lines', label: 'Текст', icon: 'type' },
  { id: 'circle', label: 'По кругу', icon: 'circle' },
  { id: 'logo', label: 'Логотип', icon: 'image' },
];

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: font.name,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

/* ======================== Загрузка/инициализация ======================== */

watch(
  () => ui.modals.stampEditor,
  async (open) => {
    if (!open) return;
    const payload = ui.modalPayload;
    const templateId = typeof payload.templateId === 'string' ? payload.templateId : null;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : null;
    const kind = payload.kind === 'seal' ? 'seal' : 'stamp';
    targetObjectId.value = objectId;

    if (objectId) {
      const object = objects.byId(objectId);
      if (object?.type === 'stamp') {
        template.value = JSON.parse(JSON.stringify(object.payload.template)) as StampTemplate;
        await ensureLogo();
        await nextTick();
        return;
      }
    }

    const fromLibrary = templateId ? library.stampById(templateId) : undefined;
    template.value = fromLibrary
      ? (JSON.parse(JSON.stringify(fromLibrary)) as StampTemplate)
      : kind === 'seal'
        ? createSealTemplate()
        : createStampTemplate();
    await ensureLogo();
    await nextTick();
  },
);

/** Загрузка логотипа в память. */
async function ensureLogo(): Promise<void> {
  const src = template.value.logo?.src;
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

/* ======================== Превью ======================== */

/** Перерисовка превью. */
function drawPreview(): void {
  const element = canvas.value;
  if (!element) return;
  const current = template.value;
  const width = Math.max(8, current.width);
  const height = Math.max(8, current.height);
  element.width = Math.round(width * pixelRatio);
  element.height = Math.round(height * pixelRatio);
  const context = element.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  context.scale(pixelRatio, pixelRatio);
  const layout = computeStampLayout(current, (fontId) => fonts.familyOf(fontId));
  paintStampLayout(context, layout, { logoImage: logoImage.value });
}

watch(
  () => template.value,
  async () => {
    await ensureLogo();
    drawPreview();
  },
  { deep: true },
);

watch(
  () => fonts.loadedOnce,
  () => drawPreview(),
);

/* ======================== Редактирование ======================== */

function setKind(kind: 'stamp' | 'seal'): void {
  const previous = template.value;
  const base = kind === 'seal' ? createSealTemplate() : createStampTemplate();
  template.value = {
    ...base,
    id: previous.id,
    name: previous.name,
    color: previous.color,
    fontId: previous.fontId,
    lines: previous.lines,
    createdAt: previous.createdAt,
    tags: previous.tags,
  };
}

function addLine(): void {
  template.value.lines = [
    ...template.value.lines,
    createStampLine('Новая строка', { fontSize: 10 }),
  ];
}

function removeLine(index: number): void {
  template.value.lines = template.value.lines.filter((_, i) => i !== index);
}

function updateLine(index: number, patch: Partial<StampTextLine>): void {
  template.value.lines = template.value.lines.map((line, i) =>
    i === index ? { ...line, ...patch } : line,
  );
}

function moveLine(index: number, direction: -1 | 1): void {
  const lines = [...template.value.lines];
  const target = index + direction;
  if (target < 0 || target >= lines.length) return;
  [lines[index], lines[target]] = [lines[target], lines[index]];
  template.value.lines = lines;
}

/** Загрузка логотипа из файла. */
async function uploadLogo(): Promise<void> {
  const { openFileDialog, readImageFile, ACCEPT } = await import('@/services/fileService');
  const files = await openFileDialog({ accept: ACCEPT.images });
  if (files.length === 0) return;
  const image = await readImageFile(files[0]);
  const maxSide = Math.min(template.value.width, template.value.height) * 0.5;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  template.value.logo = {
    src: image.src,
    width: image.naturalWidth * scale,
    height: image.naturalHeight * scale,
    offsetX: 0,
    offsetY: 0,
    opacity: 1,
  };
}

function removeLogo(): void {
  template.value.logo = null;
  logoImage.value = null;
}

/** Готовые образцы — быстрое начало работы. */
const presets: { label: string; build: () => StampTemplate }[] = [
  {
    label: 'УТВЕРЖДАЮ',
    build: () =>
      createStampTemplate({
        name: 'Утверждаю',
        lines: [
          createStampLine('УТВЕРЖДАЮ', { fontSize: 15, bold: true, letterSpacing: 1.5 }),
          createStampLine('Генеральный директор', { fontSize: 10 }),
          createStampLine('___________ / И. И. Иванов', { fontSize: 10 }),
        ],
        divider: true,
      }),
  },
  {
    label: 'СОГЛАСОВАНО',
    build: () =>
      createStampTemplate({
        name: 'Согласовано',
        color: '#15803d',
        lines: [
          createStampLine('СОГЛАСОВАНО', { fontSize: 15, bold: true, letterSpacing: 1.5 }),
          createStampLine('Дата: «___» __________ 20__ г.', { fontSize: 9 }),
        ],
      }),
  },
  {
    label: 'Копия верна',
    build: () =>
      createStampTemplate({
        name: 'Копия верна',
        color: '#1d4ed8',
        width: 190,
        height: 60,
        lines: [
          createStampLine('КОПИЯ ВЕРНА', { fontSize: 14, bold: true }),
          createStampLine('Секретарь ______________', { fontSize: 9 }),
        ],
      }),
  },
  {
    label: 'Круглая печать',
    build: () =>
      createSealTemplate({
        name: 'Печать организации',
        lines: [
          createStampLine('ООО «Ромашка»', { fontSize: 11, bold: true }),
          createStampLine('ОГРН 1234567890123', { fontSize: 8 }),
        ],
        circularText: {
          enabled: true,
          text: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
          bottomText: 'г. Москва · ИНН 7701234567',
          fontSize: 9,
          radius: 0,
          startAngle: 270,
          direction: 'cw',
          letterSpacing: 1,
          color: null,
          splitBottom: true,
        },
      }),
  },
];

function applyPreset(build: () => StampTemplate): void {
  const preset = build();
  template.value = { ...preset, id: template.value.id || createId('stamp') };
  void drawPreview();
}

/* ======================== Действия ======================== */

/**
 * Сборка шаблона для сохранения.
 * Данные копируются вглубь: реактивные Proxy нельзя отдать в IndexedDB,
 * а неглубокая копия оставляла бы вложенные объекты реактивными.
 */
function collectTemplate(): StampTemplate {
  const now = new Date().toISOString();
  const plain = JSON.parse(JSON.stringify(template.value)) as StampTemplate;
  return {
    ...plain,
    id: plain.id || createId('stamp'),
    name: plain.name.trim() || (plain.kind === 'seal' ? 'Печать' : 'Штамп'),
    updatedAt: now,
    createdAt: plain.createdAt || now,
  };
}

async function saveToLibrary(): Promise<void> {
  isSaving.value = true;
  try {
    const value = collectTemplate();
    template.value = value;
    await library.saveStamp(value);
    // Показываем пользователю соответствующий раздел библиотеки,
    // иначе печать легко не заметить среди штампов.
    library.activeType = value.kind === 'seal' ? 'seal' : 'stamp';
    ui.notify.success('Сохранено в библиотеку', `${value.name} · раздел «${value.kind === 'seal' ? 'Печати' : 'Штампы'}»`);
  } catch (error) {
    ui.notify.error(
      'Не удалось сохранить в библиотеку',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    isSaving.value = false;
  }
}

async function insertIntoDocument(): Promise<void> {
  const value = collectTemplate();
  template.value = value;

  // Сохранение в библиотеку не должно мешать вставке на страницу:
  // если хранилище недоступно, штамп всё равно попадает в документ.
  try {
    await library.saveStamp(value);
    library.activeType = value.kind === 'seal' ? 'seal' : 'stamp';
  } catch (error) {
    ui.notify.warning(
      'Штамп не сохранён в библиотеку',
      `${error instanceof Error ? error.message : String(error)} — объект добавлен только на страницу.`,
    );
  }

  if (targetObjectId.value) {
    objects.update(
      targetObjectId.value,
      { payload: { templateId: value.id, template: value } },
      'Обновление штампа',
    );
    ui.notify.success('Штамп обновлён на странице');
  } else {
    const object = createStampObject(value, {
      page: editor.currentPage,
      x: editor.pageSize.width / 2 - value.width / 2,
      y: editor.pageSize.height / 2 - value.height / 2,
      templateId: value.id,
    });
    objects.add([object], value.kind === 'seal' ? 'Добавление печати' : 'Добавление штампа');
    ui.notify.success('Штамп добавлен на страницу');
  }
  editor.toolOptions.lastStampId = value.id;
  ui.closeModal('stampEditor');
}

/** Экспорт штампа в SVG (векторно). */
function exportSvg(): void {
  const value = collectTemplate();
  import('@/services/stampRenderService').then(({ stampTemplateToSvg }) => {
    const svg = stampTemplateToSvg(value, (fontId) => fonts.familyOf(fontId));
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${value.name.replace(/[\\/:*?"<>|]/g, '_')}.svg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  });
}

/** Экспорт превью в PNG. */
function exportPng(): void {
  const element = canvas.value;
  if (!element) return;
  const link = document.createElement('a');
  link.href = element.toDataURL('image/png');
  link.download = `${collectTemplate().name.replace(/[\\/:*?"<>|]/g, '_')}.png`;
  link.click();
}

onBeforeUnmount(() => {
  logoImage.value = null;
});

void strokesToSvg;
void AppIcon;
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Конструктор штампа"
    subtitle="Прямоугольные штампы и круглые печати с поддержкой кириллицы"
    icon="stamp"
    width="xl"
  >
    <div class="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <!-- Превью и быстрые шаблоны -->
      <div class="space-y-3">
        <div
          class="checker-bg flex items-center justify-center rounded-xl border border-slate-200 p-4 dark:border-slate-700"
        >
          <canvas
            ref="canvas"
            class="max-h-64 max-w-full"
            :style="{ width: `${template.width}px`, height: `${template.height}px` }"
          />
        </div>

        <div class="grid grid-cols-2 gap-2">
          <AppInput
            v-model="template.width"
            label="Ширина, pt"
            type="number"
            size="sm"
            :min="20"
            :max="600"
          />
          <AppInput
            v-model="template.height"
            label="Высота, pt"
            type="number"
            size="sm"
            :min="20"
            :max="600"
          />
        </div>

        <div class="space-y-1.5">
          <p class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Готовые образцы
          </p>
          <div class="flex flex-wrap gap-1.5">
            <AppButton
              v-for="preset in presets"
              :key="preset.label"
              size="sm"
              variant="subtle"
              @click="applyPreset(preset.build)"
            >
              {{ preset.label }}
            </AppButton>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <AppButton size="sm" icon="file" @click="exportSvg">SVG</AppButton>
          <AppButton size="sm" icon="image" @click="exportPng">PNG</AppButton>
        </div>
      </div>

      <!-- Настройки -->
      <div class="space-y-3">
        <AppTabs v-model="tab" :items="tabs" />

        <!-- Основа -->
        <div v-show="tab === 'main'" class="space-y-3">
          <AppSection title="Основное" icon="stamp">
            <AppInput v-model="template.name" label="Название" size="sm" />
            <div class="grid grid-cols-2 gap-2">
              <AppSelect
                :model-value="template.kind"
                label="Тип"
                size="sm"
                :options="[
                  { value: 'stamp', label: 'Штамп' },
                  { value: 'seal', label: 'Печать' },
                ]"
                @update:model-value="setKind($event as 'stamp' | 'seal')"
              />
              <AppSelect
                v-model="template.shape"
                label="Форма"
                size="sm"
                :options="[
                  { value: 'rect', label: 'Прямоугольная' },
                  { value: 'round', label: 'Круглая' },
                  { value: 'oval', label: 'Овальная' },
                ]"
              />
            </div>
            <AppSelect
              v-model="template.fontId"
              label="Шрифт"
              size="sm"
              :options="fontOptions"
            />
            <AppColorPicker v-model="template.color" label="Цвет" :presets="STAMP_COLORS" />
          </AppSection>

          <AppSection title="Рамка" icon="square">
            <AppSlider
              v-model="template.borderWidth"
              label="Толщина рамки"
              unit="pt"
              :min="0"
              :max="12"
              :step="0.25"
              :precision="2"
            />
            <AppToggle v-model="template.doubleBorder" label="Двойная рамка" />
            <AppSlider
              v-if="template.doubleBorder"
              v-model="template.borderGap"
              label="Расстояние между рамками"
              unit="pt"
              :min="1"
              :max="20"
              :step="0.5"
              :precision="1"
            />
            <AppSlider
              v-if="template.shape === 'rect'"
              v-model="template.cornerRadius"
              label="Скругление углов"
              unit="pt"
              :min="0"
              :max="30"
              :step="1"
            />
            <AppToggle v-model="template.divider" label="Разделительная линия" />
          </AppSection>

          <AppSection title="Прозрачность и поворот" icon="sliders">
            <AppSlider
              v-model="template.opacity"
              label="Прозрачность"
              :min="0.1"
              :max="1"
              :step="0.05"
              :precision="2"
            />
            <AppSlider
              v-model="template.rotation"
              label="Поворот"
              unit="°"
              :min="-180"
              :max="180"
              :step="1"
            />
            <AppColorPicker
              :model-value="template.backgroundColor ?? ''"
              label="Фон"
              allow-null
              @update:model-value="template.backgroundColor = $event || null"
            />
          </AppSection>
        </div>

        <!-- Текстовые строки -->
        <div v-show="tab === 'lines'" class="space-y-2">
          <div class="flex items-center justify-between">
            <p class="text-[11px] text-slate-400">
              Строки располагаются по центру, если не выбрано иное выравнивание.
            </p>
            <AppButton size="sm" icon="plus" @click="addLine">Строка</AppButton>
          </div>

          <div
            v-for="(line, index) in template.lines"
            :key="line.id"
            class="rounded-xl border border-slate-200 p-2.5 dark:border-slate-700"
          >
            <div class="flex items-center gap-1.5">
              <AppInput
                :model-value="line.text"
                size="sm"
                placeholder="Текст строки"
                class="flex-1"
                @update:model-value="updateLine(index, { text: String($event ?? '') })"
              />
              <AppButton
                size="xs"
                variant="ghost"
                icon="moveUp"
                :disabled="index === 0"
                @click="moveLine(index, -1)"
              />
              <AppButton
                size="xs"
                variant="ghost"
                icon="moveDown"
                :disabled="index === template.lines.length - 1"
                @click="moveLine(index, 1)"
              />
              <AppButton size="xs" variant="ghost" icon="trash" @click="removeLine(index)" />
            </div>
            <div class="mt-2 grid grid-cols-3 gap-2">
              <AppInput
                :model-value="line.fontSize"
                label="Размер"
                type="number"
                size="sm"
                :min="5"
                :max="72"
                @update:model-value="updateLine(index, { fontSize: Number($event) || 10 })"
              />
              <AppInput
                :model-value="line.letterSpacing"
                label="Интервал"
                type="number"
                size="sm"
                :step="0.1"
                @update:model-value="updateLine(index, { letterSpacing: Number($event) || 0 })"
              />
              <AppSelect
                :model-value="line.align"
                label="Выравн."
                size="sm"
                :options="[
                  { value: 'left', label: 'Лево' },
                  { value: 'center', label: 'Центр' },
                  { value: 'right', label: 'Право' },
                ]"
                @update:model-value="updateLine(index, { align: $event as 'left' | 'center' | 'right' })"
              />
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <AppButton
                size="xs"
                :variant="line.bold ? 'primary' : 'subtle'"
                icon="bold"
                @click="updateLine(index, { bold: !line.bold })"
              >
                Жирный
              </AppButton>
              <AppButton
                size="xs"
                :variant="line.italic ? 'primary' : 'subtle'"
                icon="italic"
                @click="updateLine(index, { italic: !line.italic })"
              >
                Курсив
              </AppButton>
              <AppColorPicker
                compact
                :model-value="line.color ?? template.color"
                @update:model-value="updateLine(index, { color: $event })"
              />
              <AppButton
                v-if="line.color"
                size="xs"
                variant="ghost"
                @click="updateLine(index, { color: null })"
              >
                Сбросить цвет
              </AppButton>
            </div>
          </div>
        </div>

        <!-- Круговой текст -->
        <div v-show="tab === 'circle'" class="space-y-3">
          <AppSection title="Текст по кругу" icon="circle">
            <AppToggle
              v-model="template.circularText.enabled"
              label="Включить круговой текст"
              hint="Доступно для круглых и овальных печатей"
            />
            <AppInput
              v-model="template.circularText.text"
              label="Верхняя дуга"
              size="sm"
            />
            <AppToggle
              v-model="template.circularText.splitBottom"
              label="Разделить на верхнюю и нижнюю дугу"
            />
            <AppInput
              v-if="template.circularText.splitBottom"
              v-model="template.circularText.bottomText"
              label="Нижняя дуга"
              size="sm"
            />
            <div class="grid grid-cols-2 gap-2">
              <AppInput
                v-model="template.circularText.fontSize"
                label="Размер, pt"
                type="number"
                size="sm"
                :min="5"
                :max="36"
              />
              <AppInput
                v-model="template.circularText.radius"
                label="Радиус, pt (0 — авто)"
                type="number"
                size="sm"
                :min="0"
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <AppInput
                v-model="template.circularText.letterSpacing"
                label="Интервал"
                type="number"
                size="sm"
                :step="0.1"
              />
              <AppInput
                v-model="template.circularText.startAngle"
                label="Начальный угол"
                type="number"
                size="sm"
                :step="5"
              />
            </div>
          </AppSection>
        </div>

        <!-- Логотип -->
        <div v-show="tab === 'logo'" class="space-y-3">
          <AppSection title="Логотип или иконка" icon="image">
            <div v-if="template.logo" class="space-y-2">
              <div class="flex items-center gap-3">
                <span
                  class="checker-bg flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  <img :src="template.logo.src" alt="Логотип" class="h-full w-full object-contain" />
                </span>
                <div class="flex flex-col gap-1">
                  <AppButton size="sm" icon="refresh" @click="uploadLogo">Заменить</AppButton>
                  <AppButton size="sm" icon="trash" variant="ghost" @click="removeLogo">
                    Удалить
                  </AppButton>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <AppInput
                  v-model="template.logo.width"
                  label="Ширина, pt"
                  type="number"
                  size="sm"
                  :min="4"
                />
                <AppInput
                  v-model="template.logo.height"
                  label="Высота, pt"
                  type="number"
                  size="sm"
                  :min="4"
                />
                <AppInput
                  v-model="template.logo.offsetX"
                  label="Смещение X"
                  type="number"
                  size="sm"
                />
                <AppInput
                  v-model="template.logo.offsetY"
                  label="Смещение Y"
                  type="number"
                  size="sm"
                />
              </div>
              <AppSlider
                v-model="template.logo.opacity"
                label="Прозрачность логотипа"
                :min="0.1"
                :max="1"
                :step="0.05"
                :precision="2"
              />
            </div>
            <div v-else class="space-y-2">
              <AppButton size="sm" icon="upload" block @click="uploadLogo">
                Загрузить изображение
              </AppButton>
              <p class="text-[11px] text-slate-400">
                Поддерживаются PNG, JPEG и SVG. SVG преобразуется в PNG при вставке.
              </p>
            </div>
          </AppSection>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('stampEditor')">Отмена</AppButton>
      <AppButton icon="save" :loading="isSaving" @click="saveToLibrary">
        Сохранить в библиотеку
      </AppButton>
      <AppButton variant="primary" icon="check" @click="insertIntoDocument">
        {{ targetObjectId ? 'Применить' : 'Вставить на страницу' }}
      </AppButton>
    </template>
  </AppModal>
</template>
