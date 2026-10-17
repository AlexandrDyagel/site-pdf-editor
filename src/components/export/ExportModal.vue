<script setup lang="ts">
/** Окно экспорта: формат, страницы, качество, метаданные. */
import { computed, watch } from 'vue';
import type { ExportFormat, PageRangeMode } from '@/types';
import { DPI_PRESETS, SCALE_PRESETS } from '@/constants';
import { useExportStore } from '@/stores/export';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import { useFontsStore } from '@/stores/fonts';
import { useSettingsStore } from '@/stores/settings';
import { useExport } from '@/composables/useExport';
import { formatBytes } from '@/utils/download';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';

const exporter = useExport();
const store = useExportStore();
const pdf = usePdfStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const ui = useUiStore();
const fonts = useFontsStore();
const settings = useSettingsStore();

/** Переход к управлению шрифтами: окно экспорта закрываем, чтобы не наслаивались. */
function openFonts(): void {
  ui.closeModal('export');
  ui.openModal('fonts');
}

const isOpen = computed({
  get: () => ui.modals.export,
  set: (value: boolean) => (value ? ui.openModal('export') : ui.closeModal('export')),
});

const formatGroups: { group: string; items: { value: ExportFormat; label: string; hint: string; icon: string }[] }[] = [
  {
    group: 'Документы',
    items: [
      {
        value: 'pdf',
        label: 'PDF с аннотациями',
        hint: 'Исходные страницы сохраняются, текст остаётся текстом, кириллица встроенными шрифтами',
        icon: 'file',
      },
      {
        value: 'pdf-flat',
        label: 'Плоский PDF',
        hint: 'Страницы растеризуются: правка аннотаций становится невозможной',
        icon: 'layers',
      },
      {
        value: 'docx',
        label: 'Word (DOCX)',
        hint: 'Страницы изображениями + текст аннотаций',
        icon: 'book',
      },
    ],
  },
  {
    group: 'Изображения',
    items: [
      { value: 'png', label: 'PNG', hint: 'Без потерь, поддерживает прозрачность', icon: 'image' },
      { value: 'jpeg', label: 'JPEG', hint: 'Небольшой размер, без прозрачности', icon: 'image' },
      { value: 'webp', label: 'WebP', hint: 'Современный формат с хорошим сжатием', icon: 'image' },
    ],
  },
  {
    group: 'Данные',
    items: [
      {
        value: 'json',
        label: 'Проект (JSON)',
        hint: 'Все объекты и (опционально) исходный PDF — проект можно открыть позже',
        icon: 'save',
      },
      {
        value: 'svg',
        label: 'SVG штампа/подписи',
        hint: 'Векторный экспорт выделенного объекта',
        icon: 'signature',
      },
      {
        value: 'library',
        label: 'Библиотека (JSON)',
        hint: 'Штампы, печати, подписи, рисунки и изображения',
        icon: 'book',
      },
    ],
  },
];

const currentFormat = computed(() => store.settings.format);
const needsPages = computed(() => !['json', 'library', 'svg'].includes(currentFormat.value));
const isImageFormat = computed(() => ['png', 'jpeg', 'webp'].includes(currentFormat.value));
const isPdfFormat = computed(() => ['pdf', 'pdf-flat'].includes(currentFormat.value));

const selectedLabel = computed(() => {
  const count = store.selectedCount;
  if (count === 0) return 'Страницы не выбраны';
  return count === pdf.pageCount ? `Все страницы (${count})` : `Выбрано страниц: ${count}`;
});

const transparencyAvailable = computed(() => currentFormat.value !== 'jpeg');

watch(
  () => ui.modals.export,
  (open) => {
    if (open) store.syncWithDocument();
  },
);

function selectFormat(format: ExportFormat): void {
  store.setFormat(format);
}

async function runExport(): Promise<void> {
  const result = await exporter.run();
  if (result.ok) {
    ui.notify.success('Экспорт готов', `${result.fileName} · ${formatBytes(result.size)}`);
  } else {
    ui.notify.error('Ошибка экспорта', result.error ?? 'Неизвестная ошибка');
  }
}

const pageOptions = computed(() =>
  pdf.pages.map((page) => ({ value: page.index + 1, label: `Страница ${page.index + 1}` })),
);

function togglePage(page: number): void {
  const list = new Set(store.settings.pages);
  if (list.has(page)) list.delete(page);
  else list.add(page);
  store.update({ pages: Array.from(list).sort((a, b) => a - b) });
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Экспорт документа"
    :subtitle="`${pdf.fileName || 'Документ'} · ${selectedLabel}`"
    icon="download"
    width="xl"
  >
    <div v-if="!pdf.isLoaded" class="py-6">
      <AppEmptyState
        icon="file"
        title="Документ не открыт"
        text="Загрузите PDF-файл или создайте новый документ, чтобы экспортировать результат."
      />
    </div>

    <div v-else class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <!-- Формат -->
      <div class="space-y-4">
        <div v-for="group in formatGroups" :key="group.group" class="space-y-2">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {{ group.group }}
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="item in group.items"
              :key="item.value"
              type="button"
              class="flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-colors"
              :class="
                currentFormat === item.value
                  ? 'border-brand-400 bg-brand-50 dark:border-brand-500/60 dark:bg-brand-600/15'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60'
              "
              @click="selectFormat(item.value)"
            >
              <span
                class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                :class="
                  currentFormat === item.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                "
              >
                <AppIcon :name="item.icon" :size="15" />
              </span>
              <span class="min-w-0">
                <span class="block text-[12px] font-medium text-slate-800 dark:text-slate-100">
                  {{ item.label }}
                </span>
                <span class="mt-0.5 block text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                  {{ item.hint }}
                </span>
              </span>
            </button>
          </div>
        </div>

        <!-- Параметры страниц -->
        <AppSection v-if="needsPages" title="Страницы" icon="layers">
          <AppSelect
            :model-value="store.settings.pageRange"
            size="sm"
            :options="[
              { value: 'all', label: 'Все страницы' },
              { value: 'current', label: 'Только текущая' },
              { value: 'custom', label: 'Выбранные страницы' },
            ]"
            @update:model-value="store.update({ pageRange: $event as PageRangeMode })"
          />
          <div v-if="store.settings.pageRange === 'custom'" class="flex flex-wrap gap-1">
            <button
              v-for="page in pageOptions"
              :key="page.value"
              type="button"
              class="h-7 min-w-7 rounded-md px-1.5 text-[11px] font-medium transition-colors"
              :class="
                store.settings.pages.includes(page.value)
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
              "
              @click="togglePage(page.value)"
            >
              {{ page.value }}
            </button>
          </div>
          <p class="text-[11px] text-slate-400">{{ selectedLabel }}</p>
        </AppSection>

        <!-- Параметры растра -->
        <AppSection v-if="isImageFormat || store.settings.rasterize" title="Качество изображения" icon="image">
          <div class="grid grid-cols-2 gap-2">
            <AppSelect
              :model-value="store.settings.dpi ?? 0"
              label="DPI"
              size="sm"
              :options="[
                { value: 0, label: 'По масштабу' },
                ...DPI_PRESETS.map((dpi) => ({ value: dpi, label: `${dpi} dpi` })),
              ]"
              @update:model-value="store.update({ dpi: Number($event) === 0 ? null : Number($event) })"
            />
            <AppSelect
              :model-value="store.settings.scale"
              label="Масштаб"
              size="sm"
              :options="SCALE_PRESETS.map((scale) => ({ value: scale, label: `${scale}×` }))"
              @update:model-value="store.update({ scale: Number($event) })"
            />
          </div>
          <AppSlider
            v-if="currentFormat === 'jpeg' || currentFormat === 'webp'"
            :model-value="store.settings.quality"
            label="Качество"
            :min="0.4"
            :max="1"
            :step="0.02"
            :precision="2"
            @update:model-value="store.update({ quality: $event })"
          />
          <AppToggle
            v-if="transparencyAvailable"
            :model-value="store.settings.transparentBackground"
            label="Прозрачный фон"
            hint="PNG и WebP поддерживают прозрачность"
            @update:model-value="store.update({ transparentBackground: $event })"
          />
          <p class="text-[11px] text-slate-400">
            Размер страницы: {{ Math.round(editor.pageSize.width) }} × {{ Math.round(editor.pageSize.height) }} pt
            → {{ Math.round(editor.pageSize.width * store.settings.scale) }} ×
            {{ Math.round(editor.pageSize.height * store.settings.scale) }} px
          </p>
        </AppSection>

        <!-- Содержимое -->
        <AppSection title="Содержимое" icon="layers">
          <AppToggle
            :model-value="store.settings.includeOriginalContent"
            label="Исходные страницы PDF"
            hint="Если выключить — останутся только аннотации на чистом листе"
            @update:model-value="store.update({ includeOriginalContent: $event })"
          />
          <AppToggle
            :model-value="store.settings.includeAnnotations"
            label="Аннотации редактора"
            :hint="`Объектов на документе: ${objects.totalVisible}`"
            @update:model-value="store.update({ includeAnnotations: $event })"
          />
          <AppToggle
            v-if="currentFormat === 'pdf'"
            :model-value="store.settings.flatten"
            label="Встроить аннотации в страницы"
            hint="Аннотации становятся частью содержимого PDF"
            @update:model-value="store.update({ flatten: $event })"
          />
          <AppToggle
            v-if="currentFormat === 'pdf'"
            :model-value="store.settings.compressImages"
            label="Сжимать изображения"
            hint="PNG перекодируются в JPEG (прозрачность теряется)"
            @update:model-value="store.update({ compressImages: $event })"
          />
          <AppToggle
            v-if="isImageFormat"
            :model-value="store.settings.zip"
            label="Упаковать в ZIP"
            hint="Для нескольких страниц архив создаётся автоматически"
            @update:model-value="store.update({ zip: $event })"
          />
          <AppToggle
            v-if="isImageFormat"
            :model-value="store.settings.singleImage"
            label="Одно длинное изображение"
            hint="Все страницы склеиваются вертикально"
            @update:model-value="store.update({ singleImage: $event })"
          />
          <AppToggle
            v-if="currentFormat === 'json'"
            :model-value="true"
            label="Встроить исходный PDF"
            hint="Проект станет самодостаточным (файл больше на ~33%)"
          />
        </AppSection>

        <!-- Метаданные -->
        <AppSection
          v-if="isPdfFormat || currentFormat === 'docx'"
          title="Метаданные документа"
          icon="book"
        >
          <AppInput
            :model-value="store.settings.metadata.title"
            label="Название"
            size="sm"
            @update:model-value="store.updateMetadata({ title: String($event ?? '') })"
          />
          <AppInput
            :model-value="store.settings.metadata.author"
            label="Автор"
            size="sm"
            @update:model-value="store.updateMetadata({ author: String($event ?? '') })"
          />
          <AppInput
            :model-value="store.settings.metadata.subject"
            label="Тема"
            size="sm"
            @update:model-value="store.updateMetadata({ subject: String($event ?? '') })"
          />
          <AppInput
            :model-value="store.settings.metadata.keywords"
            label="Ключевые слова"
            size="sm"
            hint="Через запятую"
            @update:model-value="store.updateMetadata({ keywords: String($event ?? '') })"
          />
        </AppSection>
      </div>

      <!-- Правая колонка: итог -->
      <div class="space-y-3">
        <AppSection title="Имя файла" icon="file">
          <AppInput v-model="store.settings.fileName" size="sm" />
          <p class="text-[11px] text-slate-400">
            Расширение подставится автоматически. Русские буквы в имени сохраняются.
          </p>
        </AppSection>

        <AppSection title="Что будет экспортировано" icon="info">
          <ul class="space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <li>• Страниц: {{ store.selectedCount }} из {{ pdf.pageCount }}</li>
            <li>• Объектов: {{ objects.totalVisible }}</li>
            <li v-if="isPdfFormat">
              • Шрифты встраиваются с поддержкой кириллицы
            </li>
            <li v-if="isPdfFormat">
              • Текст остаётся текстом{{ store.settings.rasterize ? ' (кроме плоского режима)' : '' }}
            </li>
            <li v-if="pdf.isEncrypted" class="text-amber-600">
              • Документ зашифрован: экспорт PDF может быть неполным
            </li>
          </ul>
        </AppSection>

        <AppSection title="Шрифты" icon="font">
          <p class="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
            Основной шрифт: <strong>{{ fonts.familyOf(settings.settings.defaultFontId) }}</strong>.
            Можно загрузить свой TTF/OTF (например, Times New Roman) — он появится в списке
            шрифтов инструмента «Текст» и будет встроен в PDF с поддержкой кириллицы.
          </p>
          <AppButton size="sm" icon="font" block @click="openFonts">
            Управление шрифтами ({{ fonts.fonts.length }})
          </AppButton>
        </AppSection>

        <AppSection v-if="store.preflightWarnings.length > 0" title="Предупреждения" icon="alert">
          <ul class="space-y-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
            <li v-for="(warning, index) in store.preflightWarnings" :key="index">• {{ warning }}</li>
          </ul>
        </AppSection>

        <AppSection v-if="store.lastResult" title="Последний экспорт" icon="check">
          <p class="text-[11px] text-slate-500 dark:text-slate-400">
            {{ store.lastResult.fileName }}<br />
            {{ store.lastResult.ok ? formatBytes(store.lastResult.size) : store.lastResult.error }}
          </p>
          <AppButton
            v-if="store.lastResult.ok"
            size="sm"
            icon="download"
            block
            @click="store.downloadLast()"
          >
            Скачать снова
          </AppButton>
        </AppSection>
      </div>
    </div>

    <template #footer>
      <!-- Кнопка шрифтов доступна всегда: даже когда документ ещё не открыт
           и вместо настроек экспорта показывается пустое состояние. -->
      <AppButton variant="ghost" icon="font" @click="openFonts">Шрифты</AppButton>
      <AppButton variant="ghost" @click="ui.closeModal('export')">Закрыть</AppButton>
      <AppButton
        variant="primary"
        icon="download"
        :loading="store.isExporting"
        :disabled="!store.canExport"
        @click="runExport"
      >
        Экспортировать
      </AppButton>
    </template>
  </AppModal>
</template>
