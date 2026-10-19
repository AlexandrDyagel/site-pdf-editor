<script setup lang="ts">
/** Параметры активного инструмента. */
import { computed } from 'vue';
import { TOOL_DEFINITIONS } from '@/constants';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useFontsStore } from '@/stores/fonts';
import AppSection from '@/components/ui/AppSection.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppToggle from '@/components/ui/AppToggle.vue';

const editor = useEditorStore();
const settings = useSettingsStore();
const library = useLibraryStore();
const ui = useUiStore();
const objects = useObjectsStore();
const pdf = usePdfStore();
const fonts = useFontsStore();

const toolInfo = computed(
  () => TOOL_DEFINITIONS.find((tool) => tool.id === editor.tool) ?? TOOL_DEFINITIONS[0],
);

/** У линий и стрелок заливки нет — цвет и толщина относятся к самой линии. */
const isLineTool = computed(() => editor.tool === 'line' || editor.tool === 'arrow');
const shapeColorLabel = computed(() => (isLineTool.value ? 'Цвет линии' : 'Цвет обводки'));
const shapeWidthLabel = computed(() => (isLineTool.value ? 'Толщина линии' : 'Толщина обводки'));

/** Подсказка про Shift — своя для каждого инструмента. */
const shapeHintTail = computed(() => {
  switch (editor.tool) {
    case 'triangle':
      return 'треугольник с равными сторонами (правильный треугольник)';
    case 'ellipse':
      return 'круг';
    case 'rect':
      return 'квадрат';
    case 'polygon':
      return 'многоугольник, вписанный в квадрат';
    case 'line':
    case 'arrow':
      return 'ровную линию под 45°';
    default:
      return '';
  }
});

/** Есть ли для текущего инструмента подсказка про Shift. */
const shapeHint = computed(() => shapeHintTail.value.length > 0);

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: font.name,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

function onFontChange(fontId: string | number | null): void {
  if (typeof fontId !== 'string') return;
  editor.toolOptions.text.fontId = fontId;
  editor.toolOptions.text.fontFamily = fonts.familyOf(fontId);
  void fonts.ensureFontLoadedFor(fontId);
}

const stampOptions = computed(() =>
  library.stamps.map((template) => ({ value: template.id, label: template.name })),
);

const sealOptions = computed(() =>
  library.seals.map((template) => ({ value: template.id, label: template.name })),
);

const signatureOptions = computed(() =>
  library.signatures.map((template) => ({ value: template.id, label: template.name })),
);

const documentFontsUsed = computed(() => {
  const ids = new Set<string>();
  for (const obj of objects.objects) {
    if (obj.type === 'text') ids.add(obj.payload.fontId);
    if (obj.type === 'stamp') ids.add(obj.payload.template.fontId);
  }
  return Array.from(ids).map((id) => fonts.byId(id)?.name ?? id);
});
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <div class="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <p class="text-[13px] font-medium text-slate-800 dark:text-slate-100">
        {{ toolInfo.label }}
      </p>
      <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ toolInfo.hint }}</p>
    </div>

    <!-- Кисть / маркер / корректор -->
    <AppSection v-if="editor.isDrawingTool" title="Параметры рисования" icon="brush">
      <template v-if="editor.tool === 'brush'">
        <AppColorPicker v-model="editor.toolOptions.draw.color" label="Цвет" />
        <AppSlider
          v-model="editor.toolOptions.draw.width"
          label="Толщина"
          unit="pt"
          :min="0.2"
          :max="40"
          :step="0.1"
          :precision="1"
        />
        <AppSlider
          v-model="editor.toolOptions.draw.opacity"
          label="Прозрачность"
          :min="0.1"
          :max="1"
          :step="0.05"
          :precision="2"
        />
        <AppToggle v-model="editor.toolOptions.draw.smooth" label="Сглаживание линий" />
      </template>

      <template v-else-if="editor.tool === 'marker'">
        <AppColorPicker v-model="editor.toolOptions.marker.color" label="Цвет маркера" />
        <AppSlider
          v-model="editor.toolOptions.marker.width"
          label="Толщина"
          unit="pt"
          :min="0.2"
          :max="60"
          :step="0.1"
          :precision="1"
        />
        <AppSlider
          v-model="editor.toolOptions.marker.opacity"
          label="Прозрачность"
          :min="0.05"
          :max="0.8"
          :step="0.05"
          :precision="2"
        />
        <p class="text-[11px] text-slate-400">
          Маркер рисует полупрозрачной линией и подходит для выделения текста поверх PDF.
        </p>
      </template>

      <template v-else-if="editor.tool === 'smart-eraser'">
        <AppToggle
          :model-value="editor.toolOptions.smartEraser.autoColor !== false"
          label="Под цвет бумаги"
          @update:model-value="editor.toolOptions.smartEraser.autoColor = $event"
        />
        <AppColorPicker
          v-model="editor.toolOptions.smartEraser.color"
          :label="editor.toolOptions.smartEraser.autoColor !== false ? 'Цвет заливки (вручную)' : 'Цвет заливки'"
        />
        <AppSlider
          v-model="editor.toolOptions.smartEraser.width"
          label="Ширина штриха"
          unit="pt"
          :min="0.2"
          :max="80"
          :step="0.1"
          :precision="1"
        />
        <AppSlider
          v-model="editor.toolOptions.smartEraser.threshold"
          label="Порог светлого"
          unit=""
          :min="0"
          :max="255"
          :step="5"
        />
        <p class="text-[11px] text-slate-400">
          Закрашивает только участки светлее порога (по умолчанию 170), поэтому тёмный текст
          остаётся нетронутым. Меньше порог — закрашивается больше, включая серый фон.
        </p>
      </template>

      <template v-else>
        <AppSlider
          v-model="editor.toolOptions.eraser.width"
          label="Ширина корректора"
          unit="pt"
          :min="0.2"
          :max="80"
          :step="0.1"
          :precision="1"
        />
        <AppColorPicker v-model="editor.toolOptions.eraser.color" label="Цвет закрашивания" />
        <p class="text-[11px] text-slate-400">
          Корректор закрашивает область цветом фона (по умолчанию белым). Это векторный
          объект: его можно перемещать, масштабировать и удалять.
        </p>
      </template>
    </AppSection>

    <!-- Фигуры -->
    <AppSection v-else-if="editor.isShapeTool" title="Параметры фигуры" icon="square">
      <AppColorPicker
        :label="shapeColorLabel"
        allow-null
        :model-value="editor.toolOptions.shape.stroke ?? ''"
        @update:model-value="editor.toolOptions.shape.stroke = $event || null"
      />
      <AppSlider
        v-model="editor.toolOptions.shape.strokeWidth"
        :label="shapeWidthLabel"
        unit="pt"
        :min="0"
        :max="20"
        :step="0.5"
        :precision="1"
      />
      <AppColorPicker
        v-if="editor.tool !== 'line' && editor.tool !== 'arrow'"
        :model-value="editor.toolOptions.shape.fill ?? ''"
        label="Заливка"
        allow-null
        @update:model-value="editor.toolOptions.shape.fill = $event || null"
      />
      <template v-if="editor.tool === 'whiteout'">
        <AppColorPicker v-model="editor.toolOptions.whiteout.color" label="Цвет закрашивания" />
      </template>
      <template v-if="editor.tool === 'highlight'">
        <AppColorPicker v-model="editor.toolOptions.highlight.color" label="Цвет выделения" />
      </template>
      <template v-if="editor.tool === 'rect' || editor.tool === 'triangle' || editor.tool === 'polygon'">
        <AppSlider
          v-model="editor.toolOptions.shape.cornerRadius"
          label="Скругление углов"
          unit="pt"
          :min="0"
          :max="40"
          :step="1"
        />
      </template>
      <template v-if="editor.tool === 'polygon'">
        <AppSlider
          v-model="editor.toolOptions.shape.sides"
          label="Количество углов"
          :min="3"
          :max="12"
          :step="1"
        />
      </template>
      <template v-if="editor.tool === 'arrow'">
        <AppSelect
          v-model="editor.toolOptions.shape.arrowHead"
          label="Наконечники"
          size="sm"
          :options="[
            { value: 'end', label: 'На конце' },
            { value: 'both', label: 'С двух сторон' },
            { value: 'none', label: 'Без наконечника' },
          ]"
        />
      </template>
      <p
        v-if="shapeHint"
        class="mt-1 flex items-start gap-2 rounded-lg border border-brand-200/80 bg-brand-50/80 px-2 py-1.5 text-[11px] leading-snug text-brand-800 dark:border-brand-500/30 dark:bg-brand-600/10 dark:text-brand-200"
        data-testid="shift-hint"
      >
        <span
          class="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-brand-500/15 text-brand-600 dark:bg-brand-400/20 dark:text-brand-200"
        >
          <AppIcon name="keyboard" :size="11" />
        </span>
        <span>
          Зажмите
          <kbd
            class="mx-px rounded border border-brand-300/80 bg-white px-1 py-px font-mono text-[10px] font-semibold text-brand-700 shadow-sm dark:border-brand-400/40 dark:bg-slate-900 dark:text-brand-200"
            >Shift</kbd
          >, чтобы получить {{ shapeHintTail }}
        </span>
      </p>
    </AppSection>

    <!-- Текст -->
    <AppSection v-else-if="editor.tool === 'text'" title="Параметры текста" icon="type">
      <AppSelect
        label="Шрифт"
        size="sm"
        :model-value="editor.toolOptions.text.fontId"
        :options="fontOptions"
        @update:model-value="onFontChange"
      />
      <AppInput
        v-model="editor.toolOptions.text.fontSize"
        label="Размер, pt"
        type="number"
        size="sm"
        :min="4"
        :max="400"
      />
      <AppColorPicker v-model="editor.toolOptions.text.color" label="Цвет" />
      <AppSelect
        v-model="editor.toolOptions.text.align"
        label="Выравнивание"
        size="sm"
        :options="[
          { value: 'left', label: 'По левому краю' },
          { value: 'center', label: 'По центру' },
          { value: 'right', label: 'По правому краю' },
          { value: 'justify', label: 'По ширине' },
        ]"
      />
      <div class="flex gap-2">
        <AppButton
          size="sm"
          icon="bold"
          :active="editor.toolOptions.text.bold"
          @click="editor.toolOptions.text.bold = !editor.toolOptions.text.bold"
        >
          Жирный
        </AppButton>
        <AppButton
          size="sm"
          icon="italic"
          :active="editor.toolOptions.text.italic"
          @click="editor.toolOptions.text.italic = !editor.toolOptions.text.italic"
        >
          Курсив
        </AppButton>
      </div>
      <p class="text-[11px] text-slate-400">
        Кликните по странице, чтобы добавить текст. Alt + клик по тексту из PDF — заменить
        его (корректурный слой).
      </p>
    </AppSection>

    <!-- Штампы и печати -->
    <AppSection
      v-else-if="editor.tool === 'stamp' || editor.tool === 'seal'"
      title="Штампы и печати"
      icon="stamp"
    >
      <AppSelect
        v-if="editor.tool === 'stamp'"
        v-model="editor.toolOptions.lastStampId"
        label="Выбранный штамп"
        size="sm"
        placeholder="Выберите штамп"
        :options="stampOptions"
      />
      <AppSelect
        v-else
        v-model="editor.toolOptions.lastStampId"
        label="Выбранная печать"
        size="sm"
        placeholder="Выберите печать"
        :options="sealOptions"
      />
      <AppButton size="sm" icon="plus" block @click="ui.openModal('stampEditor')">
        Создать новый штамп
      </AppButton>
      <p class="text-[11px] text-slate-400">
        Клик по странице поставит выбранный штамп. Перенести на все страницы можно из панели
        свойств.
      </p>
    </AppSection>

    <!-- Подписи -->
    <AppSection v-else-if="editor.tool === 'signature'" title="Подписи" icon="signature">
      <AppSelect
        v-model="editor.toolOptions.lastSignatureId"
        label="Выбранная подпись"
        size="sm"
        placeholder="Выберите подпись"
        :options="signatureOptions"
      />
      <AppButton size="sm" icon="plus" block @click="ui.openModal('signatureEditor')">
        Нарисовать подпись
      </AppButton>
      <p class="text-[11px] text-slate-400">
        Клик по странице поставит подпись. Её можно двигать, масштабировать и поворачивать.
      </p>
    </AppSection>

    <!-- Изображения -->
    <AppSection v-else-if="editor.tool === 'image'" title="Изображение" icon="image">
      <AppButton size="sm" icon="upload" block @click="ui.openModal('imageLibrary')">
        Выбрать из библиотеки
      </AppButton>
      <p class="text-[11px] text-slate-400">
        Кликните по странице — откроется диалог выбора файлов. Можно перетащить изображение
        прямо в окно.
      </p>
    </AppSection>

    <!-- Выделение/навигация -->
    <AppSection v-else title="Выделение и вид" icon="cursor">
      <AppToggle
        :model-value="settings.settings.snapToObjects"
        label="Привязка к объектам"
        hint="Края и центры выравниваются друг по другу"
        @update:model-value="settings.update({ snapToObjects: $event })"
      />
      <AppToggle
        :model-value="settings.settings.snapToGrid"
        label="Привязка к сетке"
        @update:model-value="settings.update({ snapToGrid: $event })"
      />
      <AppToggle
        :model-value="settings.settings.showGrid"
        label="Показывать сетку"
        @update:model-value="settings.update({ showGrid: $event })"
      />
      <AppInput
        :model-value="settings.settings.gridSize"
        label="Шаг сетки, pt"
        type="number"
        size="sm"
        :min="2"
        :max="200"
        @update:model-value="settings.update({ gridSize: Number($event) || 10 })"
      />
      <div class="flex flex-wrap gap-1">
        <AppButton size="sm" @click="objects.selectAll(editor.currentPage)">Выбрать всё</AppButton>
        <AppButton size="sm" variant="ghost" @click="objects.clearSelection()">Снять</AppButton>
      </div>
    </AppSection>

    <!-- Сведения о документе -->
    <AppSection title="Документ" icon="info" :default-open="false">
      <p class="text-[11px] text-slate-400">
        Файл: {{ pdf.fileName || '—' }}<br />
        Страниц: {{ pdf.pageCount }} · Объектов: {{ objects.objects.length }}<br />
        Шрифты в документе: {{ documentFontsUsed.length > 0 ? documentFontsUsed.join(', ') : '—' }}
      </p>
      <AppButton size="sm" icon="settings" block @click="ui.openModal('documentInfo')">
        Свойства документа
      </AppButton>
    </AppSection>
  </div>
</template>
