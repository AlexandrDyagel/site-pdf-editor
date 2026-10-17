<script setup lang="ts">
/**
 * Редактор произвольных рисунков: те же штрихи, что и у подписи,
 * но сохраняется как элемент библиотеки рисунков.
 */
import { computed, ref, watch } from 'vue';
import type { DrawingTemplate, StrokeData } from '@/types';
import { createId } from '@/utils/id';
import { strokesToSvg } from '@/services/strokeService';
import { renderStrokesPreview } from '@/services/imageExportService';
import { createDrawingObject } from '@/services/objectFactory';
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
const HEIGHT = 260;
const ink = ref<InstanceType<typeof InkEditor> | null>(null);

const strokes = ref<StrokeData[]>([]);
const name = ref('Рисунок');
const color = ref('#1d4ed8');
const strokeWidth = ref(3);
const existingId = ref<string | null>(null);
const targetObjectId = ref<string | null>(null);

const isOpen = computed({
  get: () => ui.modals.drawingEditor,
  set: (value: boolean) => {
    if (value) ui.openModal('drawingEditor');
    else ui.closeModal('drawingEditor');
  },
});

const hasStrokes = computed(() => strokes.value.length > 0);

watch(
  () => ui.modals.drawingEditor,
  (open) => {
    if (!open) return;
    const payload = ui.modalPayload;
    const drawingId = typeof payload.drawingId === 'string' ? payload.drawingId : null;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : null;
    targetObjectId.value = objectId;

    const template = drawingId ? (library.byId(drawingId)?.data as DrawingTemplate | undefined) : undefined;
    if (template) {
      strokes.value = JSON.parse(JSON.stringify(template.strokes)) as StrokeData[];
      name.value = template.name;
      existingId.value = template.id;
      return;
    }
    strokes.value = [];
    name.value = `Рисунок ${new Date().toLocaleTimeString('ru-RU').slice(0, 5)}`;
    existingId.value = null;
    void color.value;
    void strokeWidth.value;
  },
);

/** Сохранить рисунок в библиотеку. */
async function saveToLibrary(): Promise<void> {
  if (!hasStrokes.value) {
    ui.notify.warning('Рисунок пуст', 'Нарисуйте что-нибудь на полотне.');
    return;
  }
  const now = new Date().toISOString();
  const template: DrawingTemplate = {
    id: existingId.value ?? createId('drawing'),
    name: name.value.trim() || 'Рисунок',
    strokes: JSON.parse(JSON.stringify(strokes.value)) as StrokeData[],
    designWidth: WIDTH,
    designHeight: HEIGHT,
    createdAt: now,
    updatedAt: now,
    tags: [],
    preview: null,
  };
  try {
    await library.saveDrawing(template);
    existingId.value = template.id;
    library.activeType = 'drawing';
    ui.notify.success('Рисунок сохранён в библиотеку', template.name);
  } catch (error) {
    ui.notify.error(
      'Не удалось сохранить рисунок',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Вставить рисунок на страницу. */
function insertIntoDocument(): void {
  if (!hasStrokes.value) {
    ui.notify.warning('Рисунок пуст', 'Нарисуйте что-нибудь на полотне.');
    return;
  }
  if (targetObjectId.value) {
    objects.update(
      targetObjectId.value,
      {
        payload: {
          strokes: JSON.parse(JSON.stringify(strokes.value)),
          designWidth: WIDTH,
          designHeight: HEIGHT,
        },
      },
      'Обновление рисунка',
    );
    ui.notify.success('Рисунок обновлён');
  } else {
    const object = createDrawingObject(strokes.value, {
      page: editor.currentPage,
      name: name.value,
    });
    if (!object) return;
    object.x = editor.pageSize.width / 2 - object.width / 2;
    object.y = editor.pageSize.height / 2 - object.height / 2;
    objects.add([object], 'Добавление рисунка');
    ui.notify.success('Рисунок добавлен на страницу');
  }
  ui.closeModal('drawingEditor');
}

function exportSvg(): void {
  if (!hasStrokes.value) return;
  downloadText(
    strokesToSvg(strokes.value, WIDTH, HEIGHT),
    `${name.value.replace(/[\\/:*?"<>|]/g, '_')}.svg`,
    'image/svg+xml;charset=utf-8',
  );
}

function exportPng(): void {
  if (!hasStrokes.value) return;
  const link = document.createElement('a');
  link.href = renderStrokesPreview(strokes.value, WIDTH, HEIGHT, 3);
  link.download = `${name.value.replace(/[\\/:*?"<>|]/g, '_')}.png`;
  link.click();
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Редактор рисунка"
    subtitle="Свободное рисование от руки"
    icon="brush"
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
          <AppInput v-model="name" label="Название" size="sm" />
          <AppColorPicker v-model="color" label="Цвет" />
          <AppSlider v-model="strokeWidth" label="Толщина" unit="pt" :min="0.6" :max="24" :step="0.2" :precision="1" />
        </AppSection>
        <AppSection title="Экспорт" icon="download">
          <div class="flex gap-2">
            <AppButton size="sm" icon="file" :disabled="!hasStrokes" @click="exportSvg">SVG</AppButton>
            <AppButton size="sm" icon="image" :disabled="!hasStrokes" @click="exportPng">PNG</AppButton>
          </div>
        </AppSection>
      </div>
    </div>
    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('drawingEditor')">Отмена</AppButton>
      <AppButton icon="save" :disabled="!hasStrokes" @click="saveToLibrary">В библиотеку</AppButton>
      <AppButton variant="primary" icon="check" :disabled="!hasStrokes" @click="insertIntoDocument">
        {{ targetObjectId ? 'Применить' : 'Вставить на страницу' }}
      </AppButton>
    </template>
  </AppModal>
</template>
