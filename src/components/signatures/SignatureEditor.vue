<script setup lang="ts">
/**
 * Редактор подписи: рисование от руки, сохранение в библиотеку,
 * вставка в документ, экспорт в PNG/SVG.
 */
import { computed, ref, watch } from 'vue';
import type { SignatureTemplate, StrokeData } from '@/types';
import { createId } from '@/utils/id';
import { strokesToSvg } from '@/services/strokeService';
import { renderStrokesPreview } from '@/services/imageExportService';
import { createSignatureObject } from '@/services/objectFactory';
import { downloadText } from '@/utils/download';
import { useUiStore } from '@/stores/ui';
import { useLibraryStore } from '@/stores/library';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import InkEditor from '@/components/signatures/InkEditor.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppSection from '@/components/ui/AppSection.vue';

const ui = useUiStore();
const library = useLibraryStore();
const objects = useObjectsStore();
const editor = useEditorStore();

const WIDTH = 420;
const HEIGHT = 160;

const ink = ref<InstanceType<typeof InkEditor> | null>(null);

const strokes = ref<StrokeData[]>([]);
const name = ref('Моя подпись');
const color = ref('#111827');
const strokeWidth = ref(2.6);
const existingId = ref<string | null>(null);
const targetObjectId = ref<string | null>(null);
const saving = ref(false);

const isOpen = computed({
  get: () => ui.modals.signatureEditor,
  set: (value: boolean) => {
    if (value) ui.openModal('signatureEditor');
    else ui.closeModal('signatureEditor');
  },
});

/** Загрузка данных при открытии окна. */
watch(
  () => ui.modals.signatureEditor,
  (open) => {
    if (!open) return;
    const payload = ui.modalPayload;
    const signatureId = typeof payload.signatureId === 'string' ? payload.signatureId : null;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : null;
    targetObjectId.value = objectId;

    const template = signatureId ? library.signatureById(signatureId) : undefined;
    if (template) {
      strokes.value = JSON.parse(JSON.stringify(template.strokes)) as StrokeData[];
      name.value = template.name;
      color.value = template.color;
      strokeWidth.value = template.strokeWidth;
      existingId.value = template.id;
      return;
    }

    strokes.value = [];
    name.value = `Подпись ${new Date().toLocaleDateString('ru-RU')}`;
    color.value = '#111827';
    strokeWidth.value = 2.6;
    existingId.value = null;
  },
);

const hasStrokes = computed(() => strokes.value.length > 0);

/** Собрать шаблон подписи. */
function buildTemplate(): SignatureTemplate {
  const now = new Date().toISOString();
  return {
    id: existingId.value ?? createId('signature'),
    name: name.value.trim() || 'Подпись',
    strokes: JSON.parse(JSON.stringify(strokes.value)) as StrokeData[],
    designWidth: WIDTH,
    designHeight: HEIGHT,
    color: color.value,
    strokeWidth: strokeWidth.value,
    svg: strokesToSvg(strokes.value, WIDTH, HEIGHT),
    png: renderStrokesPreview(strokes.value, WIDTH, HEIGHT, 2),
    createdAt: now,
    updatedAt: now,
    tags: [],
    preview: null,
  };
}

/** Сохранить в библиотеку. */
async function saveToLibrary(): Promise<void> {
  if (!hasStrokes.value) {
    ui.notify.warning('Подпись пуста', 'Нарисуйте подпись на полотне.');
    return;
  }
  saving.value = true;
  try {
    const template = buildTemplate();
    await library.saveSignature(template);
    existingId.value = template.id;
    library.activeType = 'signature';
    ui.notify.success('Подпись сохранена', template.name);
  } catch (error) {
    ui.notify.error(
      'Не удалось сохранить подпись',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    saving.value = false;
  }
}

/** Вставить подпись в документ. */
async function insertIntoDocument(): Promise<void> {
  if (!hasStrokes.value) {
    ui.notify.warning('Подпись пуста', 'Нарисуйте подпись на полотне.');
    return;
  }
  const template = buildTemplate();
  // Ошибка сохранения в библиотеку не должна мешать вставке на страницу.
  try {
    await library.saveSignature(template);
    existingId.value = template.id;
  } catch (error) {
    ui.notify.warning(
      'Подпись не сохранена в библиотеку',
      `${error instanceof Error ? error.message : String(error)} — объект добавлен только на страницу.`,
    );
  }

  const object = createSignatureObject({
    page: editor.currentPage,
    x: editor.pageSize.width / 2 - WIDTH / 2,
    y: editor.pageSize.height * 0.7,
    width: WIDTH,
    height: HEIGHT,
    strokes: template.strokes,
    color: template.color,
    strokeWidth: template.strokeWidth,
    svg: template.svg ?? null,
    png: template.png ?? null,
    modelId: template.id,
    source: 'draw',
  });

  if (targetObjectId.value) {
    objects.update(
      targetObjectId.value,
      {
        payload: {
          strokes: template.strokes,
          designWidth: WIDTH,
          designHeight: HEIGHT,
          color: template.color,
          strokeWidth: template.strokeWidth,
          svg: template.svg ?? null,
          png: template.png ?? null,
        },
      },
      'Обновление подписи',
    );
    ui.notify.success('Подпись обновлена на странице');
  } else {
    objects.add([object], 'Добавление подписи');
    ui.notify.success('Подпись добавлена на страницу');
  }
  editor.toolOptions.lastSignatureId = template.id;
  ui.closeModal('signatureEditor');
}

/** Экспорт подписи в SVG. */
function exportSvg(): void {
  if (!hasStrokes.value) return;
  const svg = strokesToSvg(strokes.value, WIDTH, HEIGHT);
  downloadText(svg, `${name.value.replace(/[\\/:*?"<>|]/g, '_')}.svg`, 'image/svg+xml;charset=utf-8');
}

/** Экспорт подписи в PNG. */
function exportPng(): void {
  if (!hasStrokes.value) return;
  const dataUrl = renderStrokesPreview(strokes.value, WIDTH, HEIGHT, 3);
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `${name.value.replace(/[\\/:*?"<>|]/g, '_')}.png`;
  link.click();
}

/** Применить цвет/толщину ко всем штрихам. */
function applyColorToAll(): void {
  ink.value?.recolor(color.value);
}

function applyWidthToAll(): void {
  ink.value?.rescale(strokeWidth.value);
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Редактор подписи"
    subtitle="Нарисуйте подпись мышью, пальцем или стилусом"
    icon="signature"
    width="lg"
  >
    <div class="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div class="space-y-3">
        <InkEditor
          ref="ink"
          v-model="strokes"
          :width="WIDTH"
          :height="HEIGHT"
          :color="color"
          :stroke-width="strokeWidth"
        />
        <div class="flex flex-wrap gap-2">
          <AppButton size="sm" icon="undo" @click="ink?.undoStroke()">Отменить штрих</AppButton>
          <AppButton size="sm" icon="trash" variant="ghost" @click="ink?.clear()">Очистить</AppButton>
        </div>
      </div>

      <div class="space-y-2">
        <AppSection title="Параметры" icon="sliders">
          <AppInput v-model="name" label="Название" size="sm" placeholder="Например: Подпись директора" />
          <AppColorPicker v-model="color" label="Цвет чернил" />
          <AppSlider v-model="strokeWidth" label="Толщина" unit="pt" :min="0.6" :max="10" :step="0.2" :precision="1" />
          <div class="flex flex-wrap gap-2">
            <AppButton size="sm" variant="subtle" @click="applyColorToAll">Цвет всем штрихам</AppButton>
            <AppButton size="sm" variant="subtle" @click="applyWidthToAll">Толщина всем</AppButton>
          </div>
          <p class="text-[11px] leading-snug text-slate-400">
            Для тёмных областей используйте белый цвет — подпись останется читаемой.
          </p>
        </AppSection>

        <AppSection title="Экспорт подписи" icon="download">
          <div class="flex flex-wrap gap-2">
            <AppButton size="sm" icon="file" :disabled="!hasStrokes" @click="exportSvg">SVG</AppButton>
            <AppButton size="sm" icon="image" :disabled="!hasStrokes" @click="exportPng">PNG</AppButton>
          </div>
          <p class="text-[11px] text-slate-400">
            Подпись хранится как векторные штрихи и в PDF экспортируется без потери качества.
          </p>
        </AppSection>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('signatureEditor')">Отмена</AppButton>
      <AppButton icon="save" :loading="saving" :disabled="!hasStrokes" @click="saveToLibrary">
        Сохранить в библиотеку
      </AppButton>
      <AppButton variant="primary" icon="check" :disabled="!hasStrokes" @click="insertIntoDocument">
        {{ targetObjectId ? 'Применить' : 'Вставить на страницу' }}
      </AppButton>
    </template>
  </AppModal>
</template>
