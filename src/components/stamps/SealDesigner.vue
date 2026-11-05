<script setup lang="ts">
/**
 * Конструктор круглой печати (оттиска).
 *
 * Идея: слева — большое живое превью с зумом и маркерами, справа — настройки.
 * Печать рисуется тем же кодом, что и объект на странице / экспорт в PDF
 * (`computeStampLayout` + `paintStampLayout`), поэтому «что вижу — то и
 * вставлю»: оттиск не меняется после нажатия «Добавить на документ».
 *
 * Что настраивается:
 *   - диаметр 30–60 мм и кольца: количество, толщина, расстояние между ними;
 *   - верхняя и нижняя дуги: текст, шрифт, кегль, трекинг, межсловный
 *     интервал, угол дуги (ползунком или маркерами), радиус;
 *   - центр: до трёх строк, логотип PNG/SVG, разделительная окружность;
 *   - краска: цвет, прозрачность и «неидеальность» (неровность, зерно,
 *     второй прокат) с воспроизводимым зерном.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SealArcText, StampTemplate, StampTextLine } from '@/types';
import { SEAL_COLORS } from '@/constants';
import { createId } from '@/utils/id';
import {
  SEAL_MAX_MM,
  SEAL_MAX_RINGS,
  SEAL_MIN_MM,
  createSealRing,
  createSealSettings,
  normalizeSealSettings,
  sealDiameterMm,
  sealDiameterPx,
  sealSettingsFromTemplate,
} from '@/services/sealRenderService';
import { createSealTemplate, createStampLine } from '@/services/stampRenderService';
import { createStampObject } from '@/services/objectFactory';
import { useUiStore } from '@/stores/ui';
import { useLibraryStore } from '@/stores/library';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useFontsStore } from '@/stores/fonts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppTabs from '@/components/ui/AppTabs.vue';
import SealPreview from '@/components/stamps/SealPreview.vue';
import SealArcControls from '@/components/stamps/SealArcControls.vue';

const ui = useUiStore();
const library = useLibraryStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const fonts = useFontsStore();

const template = ref<StampTemplate>(createSealTemplate());
const targetObjectId = ref<string | null>(null);
const tab = ref('rings');
const zoom = ref(3);
const isSaving = ref(false);

const isOpen = computed({
  get: () => ui.modals.sealDesigner,
  set: (value: boolean) => {
    if (value) ui.openModal('sealDesigner');
    else ui.closeModal('sealDesigner');
  },
});

const tabs = [
  { id: 'rings', label: 'Кольца', icon: 'circle' },
  { id: 'arcs', label: 'Дуги', icon: 'type' },
  { id: 'center', label: 'Центр', icon: 'seal' },
  { id: 'ink', label: 'Краска', icon: 'sliders' },
];

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: font.name,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

/** Настройки печати (они всегда есть у открытого конструктора). */
const seal = computed(() => template.value.seal ?? createSealSettings());

/** Диаметр в пикселях — реальный размер объекта на странице. */
const diameterPx = computed(() => sealDiameterPx(seal.value.diameterMm));

/** Максимальный радиус дуги, px. */
const maxArcRadius = computed(() => Math.round(diameterPx.value / 2));

/* ======================== Открытие/инициализация ======================== */

/**
 * Приводит шаблон к виду печати: гарантирует настройки, форму и размер.
 * Диаметр берём из фактического размера шаблона — печать, которую уже
 * растянули на странице, открывается с честными миллиметрами.
 */
function withSealSettings(source: StampTemplate): StampTemplate {
  const plain = JSON.parse(JSON.stringify(source)) as StampTemplate;
  const size = Math.max(8, Math.min(plain.width, plain.height));
  const settings = normalizeSealSettings(plain.seal ?? sealSettingsFromTemplate(plain));
  settings.diameterMm = Math.round(
    Math.min(SEAL_MAX_MM, Math.max(SEAL_MIN_MM, sealDiameterMm(size))) * 10,
  ) / 10;
  const px = sealDiameterPx(settings.diameterMm);
  return {
    ...plain,
    kind: 'seal',
    shape: 'round',
    seal: settings,
    width: px,
    height: px,
  };
}

watch(
  () => ui.modals.sealDesigner,
  async (open) => {
    if (!open) return;
    const payload = ui.modalPayload;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : null;
    const templateId = typeof payload.templateId === 'string' ? payload.templateId : null;
    targetObjectId.value = objectId;

    let source: StampTemplate | null = null;
    if (objectId) {
      const object = objects.byId(objectId);
      if (object?.type === 'stamp') source = object.payload.template;
    }
    if (!source && templateId) source = library.stampById(templateId) ?? null;

    template.value = withSealSettings(source ?? createSealTemplate());
    tab.value = 'rings';
    zoom.value = fitZoomValue();
    await nextTick();
  },
);

/** Зум, при котором печать занимает ~380 px превью. */
function fitZoomValue(): number {
  const size = Math.max(24, Math.min(template.value.width, template.value.height));
  return Math.min(4, Math.max(1, Math.round((380 / size) * 4) / 4));
}

function fitZoom(): void {
  zoom.value = fitZoomValue();
}

function setZoom(value: number): void {
  zoom.value = Math.min(6, Math.max(0.5, Math.round(value * 100) / 100));
}

/** Отладочный хук для автотестов (только dev-сборка). */
watch(
  () => template.value,
  (value) => {
    if (import.meta.env.DEV) {
      (window as unknown as { __SEAL_DESIGNER__?: StampTemplate }).__SEAL_DESIGNER__ = value;
    }
  },
  { deep: true, immediate: true },
);

/* ======================== Кольца ======================== */

function setDiameter(value: number): void {
  const settings = template.value.seal;
  if (!settings) return;
  const clamped = Math.min(SEAL_MAX_MM, Math.max(SEAL_MIN_MM, Math.round(value * 10) / 10));
  settings.diameterMm = clamped;
  const px = sealDiameterPx(clamped);
  template.value.width = px;
  template.value.height = px;
  // Если печать перестала помещаться в окно превью — подбираем зум заново,
  // иначе на 60 мм видна только середина оттиска.
  if (zoom.value * px > 400) zoom.value = fitZoomValue();
}

function setRingCount(count: number): void {
  const settings = template.value.seal;
  if (!settings) return;
  const current = settings.rings.length;
  if (count === current) return;
  if (count > current) {
    for (let index = current; index < count; index += 1) {
      // Наружное кольцо толще остальных — как у настоящих печатей.
      settings.rings.push(createSealRing(index === 1 ? 1.3 : 1, 4));
    }
  } else {
    settings.rings.splice(count);
  }
}

/* ======================== Дуги ======================== */

function onSpanChange(side: 'top' | 'bottom', angle: number): void {
  const settings = template.value.seal;
  if (!settings) return;
  const arc = side === 'top' ? settings.arcTop : settings.arcBottom;
  arc.spanAngle = angle;
}

/* ======================== Центр ======================== */

function addCenterLine(): void {
  if (template.value.lines.length >= 3) return;
  template.value.lines.push(createStampLine('Новая строка', { fontSize: 9 }));
}

function removeCenterLine(index: number): void {
  template.value.lines = template.value.lines.filter((_, position) => position !== index);
}

function updateCenterLine(index: number, patch: Partial<StampTextLine>): void {
  template.value.lines = template.value.lines.map((line, position) =>
    position === index ? { ...line, ...patch } : line,
  );
}

/** Загрузка логотипа в центр печати. */
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
}

/* ======================== Пресеты ======================== */

const presets: { label: string; build: () => StampTemplate }[] = [
  {
    label: 'Организация',
    build: () => createSealTemplate(),
  },
  {
    label: 'ИП',
    build: () =>
      createSealTemplate({
        name: 'Печать ИП',
        lines: [
          createStampLine('ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', { fontSize: 7, bold: true }),
          createStampLine('Иванов И. И.', { fontSize: 10, bold: true }),
        ],
        seal: createSealSettings({
          rings: [createSealRing(2.2, 0), createSealRing(1.1, 3.5)],
          arcTop: { ...createSealSettings().arcTop, text: 'ИНН 770123456789 · ОГРНИП 320770000000001' },
          arcBottom: { ...createSealSettings().arcBottom, text: 'г. Москва' },
        }),
      }),
  },
  {
    label: 'Только кольца',
    build: () =>
      createSealTemplate({
        name: 'Пустая печать',
        lines: [],
        seal: createSealSettings({
          rings: [createSealRing(2.6, 0), createSealRing(1.2, 4), createSealRing(1, 3)],
          arcTop: { ...createSealSettings().arcTop, enabled: false, text: '' },
          arcBottom: { ...createSealSettings().arcBottom, enabled: false, text: '' },
        }),
      }),
  },
];

/** Применить образец: сохраняем идентификатор (если печать уже существует). */
function applyPreset(builder: () => StampTemplate): void {
  const next = builder();
  template.value = withSealSettings({ ...next, id: template.value.id || createId('seal'), name: next.name });
  zoom.value = fitZoomValue();
}

/* ======================== Сохранение и вставка ======================== */

/** Сборка «чистого» шаблона без реактивных Proxy. */
function collectTemplate(): StampTemplate {
  const plain = JSON.parse(JSON.stringify(template.value)) as StampTemplate;
  const settings = normalizeSealSettings(plain.seal ?? sealSettingsFromTemplate(plain));
  const px = sealDiameterPx(settings.diameterMm);
  const now = new Date().toISOString();
  return {
    ...plain,
    id: plain.id || createId('seal'),
    kind: 'seal',
    shape: 'round',
    seal: settings,
    width: px,
    height: px,
    name: plain.name?.trim() || 'Печать',
    createdAt: plain.createdAt || now,
    updatedAt: now,
  };
}

async function saveToLibrary(): Promise<void> {
  isSaving.value = true;
  try {
    const value = collectTemplate();
    template.value = value;
    await library.saveStamp(value);
    library.activeType = 'seal';
    ui.notify.success('Печать сохранена в библиотеку', value.name);
  } catch (error) {
    ui.notify.error(
      'Не удалось сохранить печать',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    isSaving.value = false;
  }
}

/** «Добавить на документ» / «Применить» для уже стоящей печати. */
async function insertIntoDocument(): Promise<void> {
  const value = collectTemplate();
  template.value = value;

  // Библиотека — вторична: даже если хранилище недоступно, печать встанет.
  try {
    await library.saveStamp(value);
    library.activeType = 'seal';
  } catch (error) {
    ui.notify.warning(
      'Печать не сохранена в библиотеку',
      `${error instanceof Error ? error.message : String(error)} — объект добавлен только на страницу.`,
    );
  }

  if (targetObjectId.value) {
    objects.update(
      targetObjectId.value,
      { payload: { templateId: value.id, template: value } },
      'Обновление печати',
    );
    ui.notify.success('Печать обновлена на странице');
  } else {
    const object = createStampObject(value, {
      page: editor.currentPage,
      x: editor.pageSize.width / 2 - value.width / 2,
      y: editor.pageSize.height / 2 - value.height / 2,
      templateId: value.id,
    });
    objects.add([object], 'Добавление печати');
    ui.notify.success('Печать добавлена на страницу', 'Переместите, поверните или растяните её на холсте');
  }

  editor.toolOptions.lastStampId = value.id;
  ui.closeModal('sealDesigner');
}

onBeforeUnmount(() => {
  if (import.meta.env.DEV) {
    delete (window as unknown as { __SEAL_DESIGNER__?: StampTemplate }).__SEAL_DESIGNER__;
  }
});

/** Ссылка на дугу для панели настроек. */
const arcTop = computed<SealArcText>(() => seal.value.arcTop);
const arcBottom = computed<SealArcText>(() => seal.value.arcBottom);
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Конструктор печати"
    subtitle="Круглый оттиск: кольца, текст по дугам, центр и «мокрая» краска"
    icon="seal"
    width="xl"
  >
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]" data-testid="seal-designer">
      <!-- ======================= Превью ======================= -->
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span
              class="rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              data-testid="seal-size-label"
            >
              {{ seal.diameterMm }} мм · {{ Math.round(diameterPx) }} px
            </span>
            <span class="text-[11px] text-slate-400">
              {{ seal.rings.length }} кольца · {{ seal.arcTop.text ? 'верх' : '—' }} /
              {{ seal.arcBottom.text ? 'низ' : '—' }}
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <AppButton size="xs" variant="ghost" icon="zoomOut" @click="setZoom(zoom - 0.25)" />
            <input
              v-model.number="zoom"
              data-testid="seal-zoom"
              type="range"
              min="0.5"
              max="6"
              step="0.25"
              class="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand-600 dark:bg-slate-700"
            />
            <AppButton size="xs" variant="ghost" icon="zoomIn" @click="setZoom(zoom + 0.25)" />
            <span class="w-12 text-center font-mono text-[11px] text-slate-500">
              {{ Math.round(zoom * 100) }}%
            </span>
            <AppButton size="xs" variant="ghost" @click="fitZoom">Вписать</AppButton>
          </div>
        </div>

        <!-- Большое превью: печать видно целиком, при зуме появляется прокрутка -->
        <div
          class="checker-bg relative flex h-[430px] items-center justify-center overflow-auto rounded-xl border border-slate-200 p-4 dark:border-slate-700"
          data-testid="seal-preview-box"
        >
          <SealPreview
            :template="template"
            :zoom="zoom"
            @span-change="onSpanChange"
          />
        </div>

        <p class="text-[11px] text-slate-400">
          Маркеры на дугах тянутся мышью — так текст растягивается по окружности.
          Колесо мыши над превью не масштабирует, используйте ползунок зума.
        </p>

        <!-- Цвет: пресеты + произвольный -->
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Цвет
          </span>
          <button
            v-for="color in SEAL_COLORS"
            :key="color"
            type="button"
            class="h-6 w-6 rounded-md ring-1 ring-inset ring-slate-900/15 transition-transform hover:scale-110"
            :class="template.color.toLowerCase() === color.toLowerCase() ? 'outline outline-2 outline-offset-1 outline-brand-500' : ''"
            :style="{ backgroundColor: color }"
            :title="color"
            :data-testid="`seal-color-${color.replace('#', '')}`"
            @click="template.color = color"
          />
          <div class="w-36">
            <AppColorPicker compact :model-value="template.color" @update:model-value="template.color = $event" />
          </div>
        </div>

        <div class="space-y-1.5">
          <p class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Образцы
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
      </div>

      <!-- ======================= Настройки ======================= -->
      <div class="space-y-3">
        <AppInput v-model="template.name" label="Название печати" size="sm" />
        <AppTabs v-model="tab" :items="tabs" />

        <!-- Кольца -->
        <div v-show="tab === 'rings'" class="space-y-3">
          <AppSection title="Размер" icon="circle">
            <AppSlider
              :model-value="seal.diameterMm"
              label="Диаметр"
              unit="мм"
              :min="SEAL_MIN_MM"
              :max="SEAL_MAX_MM"
              :step="0.5"
              :precision="1"
              data-testid="seal-diameter"
              @update:model-value="setDiameter(Number($event))"
            />
            <p class="text-[11px] text-slate-400">
              1 px = 1 pt: {{ Math.round(diameterPx) }} px на странице — ровно этот размер
              попадёт в PDF.
            </p>
          </AppSection>

          <AppSection title="Кольца" icon="circle">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Количество
              </span>
              <div class="flex gap-1">
                <AppButton
                  v-for="count in SEAL_MAX_RINGS"
                  :key="count"
                  size="xs"
                  :variant="seal.rings.length === count ? 'primary' : 'subtle'"
                  :data-testid="`seal-rings-${count}`"
                  @click="setRingCount(count)"
                >
                  {{ count }}
                </AppButton>
              </div>
            </div>

            <div
              v-for="(ring, index) in seal.rings"
              :key="`ring-${index}`"
              class="rounded-lg border border-slate-200 p-2 dark:border-slate-700"
            >
              <AppSlider
                :model-value="ring.width"
                :label="`Толщина кольца ${index + 1}`"
                unit="px"
                :min="0.4"
                :max="8"
                :step="0.1"
                :precision="1"
                @update:model-value="ring.width = Number($event)"
              />
              <AppSlider
                v-if="index > 0"
                :model-value="ring.gap"
                label="Расстояние до кольца"
                unit="px"
                :min="0.5"
                :max="16"
                :step="0.1"
                :precision="1"
                @update:model-value="ring.gap = Number($event)"
              />
            </div>
          </AppSection>

          <AppSection title="Разделитель центра" icon="minus">
            <AppToggle v-model="seal.divider.enabled" label="Окружность между дугами и центром" />
            <template v-if="seal.divider.enabled">
              <AppSlider
                :model-value="seal.divider.radius"
                label="Радиус (0 — по содержимому)"
                unit="px"
                :min="0"
                :max="maxArcRadius"
                :step="0.5"
                :precision="1"
                @update:model-value="seal.divider.radius = Number($event)"
              />
              <AppSlider
                :model-value="seal.divider.width"
                label="Толщина разделителя"
                unit="px"
                :min="0.2"
                :max="4"
                :step="0.1"
                :precision="1"
                @update:model-value="seal.divider.width = Number($event)"
              />
            </template>
          </AppSection>
        </div>

        <!-- Дуги -->
        <div v-show="tab === 'arcs'" class="space-y-3">
          <SealArcControls
            :arc="arcTop"
            side="top"
            title="Верхняя дуга"
            hint="Читается слева направо по часовой стрелке"
            :font-options="fontOptions"
            :max-radius="maxArcRadius"
          />
          <SealArcControls
            :arc="arcBottom"
            side="bottom"
            title="Нижняя дуга"
            hint="Буквы стоят макушкой к центру"
            :font-options="fontOptions"
            :max-radius="maxArcRadius"
          />
        </div>

        <!-- Центр -->
        <div v-show="tab === 'center'" class="space-y-3">
          <AppSection title="Текст в центре (до 3 строк)" icon="type">
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-slate-400">Строки центрируются автоматически</span>
              <AppButton
                size="xs"
                icon="plus"
                :disabled="template.lines.length >= 3"
                data-testid="seal-add-line"
                @click="addCenterLine"
              >
                Строка
              </AppButton>
            </div>

            <div
              v-for="(line, index) in template.lines"
              :key="line.id"
              class="space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700"
            >
              <div class="flex items-center gap-1.5">
                <AppInput
                  :model-value="line.text"
                  size="sm"
                  placeholder="Текст строки"
                  class="flex-1"
                  @update:model-value="updateCenterLine(index, { text: String($event ?? '') })"
                />
                <AppButton
                  size="xs"
                  variant="ghost"
                  icon="trash"
                  title="Удалить строку"
                  @click="removeCenterLine(index)"
                />
              </div>
              <div class="flex items-center gap-2">
                <AppInput
                  :model-value="line.fontSize"
                  label="Размер"
                  type="number"
                  size="sm"
                  :min="4"
                  :max="24"
                  @update:model-value="updateCenterLine(index, { fontSize: Number($event) || 9 })"
                />
                <AppButton
                  size="sm"
                  :variant="line.bold ? 'primary' : 'subtle'"
                  icon="bold"
                  @click="updateCenterLine(index, { bold: !line.bold })"
                >
                  Жирный
                </AppButton>
              </div>
            </div>
          </AppSection>

          <AppSection title="Логотип или герб" icon="image">
            <div v-if="template.logo" class="space-y-2">
              <div class="flex items-center gap-3">
                <span
                  class="checker-bg flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  <img :src="template.logo.src" alt="Логотип" class="h-full w-full object-contain" />
                </span>
                <div class="flex flex-col gap-1">
                  <AppButton size="sm" icon="refresh" @click="uploadLogo">Заменить</AppButton>
                  <AppButton size="sm" icon="trash" variant="ghost" @click="removeLogo">Удалить</AppButton>
                </div>
              </div>
              <AppSlider
                v-model="template.logo.opacity"
                label="Прозрачность логотипа"
                :min="0.1"
                :max="1"
                :step="0.05"
                :precision="2"
              />
              <p class="text-[11px] text-slate-400">
                Логотип вписывается в центр автоматически, сохраняя пропорции. Поддерживаются
                PNG, JPEG и SVG.
              </p>
            </div>
            <div v-else class="space-y-2">
              <AppButton size="sm" icon="upload" block @click="uploadLogo">
                Загрузить логотип
              </AppButton>
              <p class="text-[11px] text-slate-400">
                PNG, JPEG или SVG. Изображение ставится в центр, текст остаётся вокруг.
              </p>
            </div>
          </AppSection>
        </div>

        <!-- Краска и эффекты -->
        <div v-show="tab === 'ink'" class="space-y-3">
          <AppSection title="Интенсивность" icon="palette">
            <AppColorPicker v-model="template.color" label="Цвет оттиска" :presets="SEAL_COLORS" />
            <AppSlider
              v-model="template.opacity"
              label="Прозрачность оттиска"
              :min="0.15"
              :max="1"
              :step="0.05"
              :precision="2"
              data-testid="seal-opacity"
            />
            <p class="text-[11px] text-slate-400">
              Для «свежей» печати достаточно 0.75–0.9: бумага должна просвечивать.
            </p>
          </AppSection>

          <AppSection title="Неидеальность" icon="sliders">
            <AppToggle
              v-model="seal.ink.enabled"
              label="Эффект живой печати"
              hint="Неровные края, отдельные точки краски и второй прокат"
              data-testid="seal-ink-toggle"
            />
            <template v-if="seal.ink.enabled">
              <AppSlider
                :model-value="seal.ink.roughness"
                label="Неровность контуров"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.roughness = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.grain"
                label="Зернистость"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.grain = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.doubleStrike"
                label="Второй прокат"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.doubleStrike = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.strikeOffset"
                label="Смещение проката"
                unit="px"
                :min="0"
                :max="3"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.strikeOffset = Number($event)"
              />
              <div class="flex items-end gap-2">
                <AppInput
                  :model-value="seal.ink.seed"
                  label="Зерно (seed)"
                  type="number"
                  size="sm"
                  class="flex-1"
                  @update:model-value="seal.ink.seed = Math.trunc(Number($event) || 1337)"
                />
                <AppButton
                  size="sm"
                  icon="refresh"
                  title="Другой рисунок краски"
                  @click="seal.ink.seed = Math.floor(Math.random() * 100000) + 1"
                >
                  Другой
                </AppButton>
              </div>
              <p class="text-[11px] text-slate-400">
                Рисунок краски воспроизводим: при одном и том же зерне оттиск на холсте и в
                PDF одинаковый.
              </p>
            </template>
          </AppSection>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('sealDesigner')">Отмена</AppButton>
      <AppButton icon="save" :loading="isSaving" @click="saveToLibrary">
        Сохранить в библиотеку
      </AppButton>
      <AppButton variant="primary" icon="check" data-testid="seal-insert" @click="insertIntoDocument">
        {{ targetObjectId ? 'Применить' : 'Добавить на документ' }}
      </AppButton>
    </template>
  </AppModal>
</template>
