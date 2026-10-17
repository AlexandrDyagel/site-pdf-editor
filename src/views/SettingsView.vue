<script setup lang="ts">
/** Настройки приложения. */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { DPI_PRESETS, HISTORY_LIMIT } from '@/constants';
import { useSettingsStore } from '@/stores/settings';
import { useFontsStore } from '@/stores/fonts';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { storageService } from '@/services/storageService';
import { formatBytes } from '@/utils/download';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';

const router = useRouter();
const settings = useSettingsStore();
const fonts = useFontsStore();
const library = useLibraryStore();
const ui = useUiStore();

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: `${font.name}${font.supportsCyrillic ? '' : ' — без кириллицы'}`,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

async function resetSettings(): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Сбросить настройки?',
    text: 'Все параметры вернутся к значениям по умолчанию. Библиотека и проекты сохранятся.',
    confirmLabel: 'Сбросить',
    danger: true,
  });
  if (!confirmed) return;
  settings.reset();
  ui.notify.success('Настройки сброшены');
}

async function showStorage(): Promise<void> {
  const estimate = await storageService.estimate();
  if (!estimate) {
    ui.notify.info('Оценка хранилища недоступна в этом браузере');
    return;
  }
  ui.notify.info(
    'Использование хранилища',
    `Занято: ${formatBytes(estimate.usage)} из ${formatBytes(estimate.quota)}`,
  );
}

function clearLibrary(): void {
  void (async () => {
    const confirmed = await ui.askConfirm({
      title: 'Очистить всю библиотеку?',
      text: 'Будут удалены все штампы, печати, подписи, рисунки и изображения из локального хранилища.',
      confirmLabel: 'Очистить',
      danger: true,
    });
    if (!confirmed) return;
    for (const type of ['stamp', 'seal', 'signature', 'drawing', 'image'] as const) {
      await library.clearType(type);
    }
    ui.notify.success('Библиотека очищена');
  })();
}
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <header class="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div class="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
        <div class="flex items-center gap-2.5">
          <AppButton size="icon" variant="ghost" icon="chevronLeft" @click="router.back()" />
          <div>
            <p class="text-[15px] font-semibold">Настройки</p>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              Параметры сохраняются в этом браузере
            </p>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <AppButton
            size="icon"
            variant="ghost"
            :icon="settings.isDark ? 'sun' : 'moon'"
            @click="settings.toggleTheme()"
          />
          <AppButton size="sm" variant="ghost" icon="file" @click="router.push('/')">
            На главную
          </AppButton>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <AppSection title="Интерфейс" icon="settings">
        <div class="grid gap-3 sm:grid-cols-2">
          <AppSelect
            :model-value="settings.settings.theme"
            label="Тема"
            size="sm"
            :options="[
              { value: 'system', label: 'Как в системе' },
              { value: 'light', label: 'Светлая' },
              { value: 'dark', label: 'Тёмная' },
            ]"
            @update:model-value="settings.setTheme($event as never)"
          />
          <AppSelect
            :model-value="settings.settings.canvasBackground"
            label="Фон рабочей области"
            size="sm"
            :options="[
              { value: 'dark', label: 'Тёмный' },
              { value: 'light', label: 'Светлый' },
              { value: 'checker', label: 'Шахматный' },
            ]"
            @update:model-value="settings.update({ canvasBackground: $event as never })"
          />
        </div>
        <AppToggle
          :model-value="settings.settings.tooltips"
          label="Показывать подсказки"
          @update:model-value="settings.update({ tooltips: $event })"
        />
        <AppToggle
          :model-value="settings.settings.compactPanels"
          label="Компактные панели"
          @update:model-value="settings.update({ compactPanels: $event })"
        />
      </AppSection>

      <AppSection title="Редактор" icon="cursor">
        <div class="grid gap-3 sm:grid-cols-2">
          <AppInput
            :model-value="settings.settings.gridSize"
            label="Шаг сетки, pt"
            type="number"
            size="sm"
            :min="2"
            :max="200"
            @update:model-value="settings.update({ gridSize: Number($event) || 10 })"
          />
          <AppInput
            :model-value="settings.settings.historyLimit"
            label="Глубина истории"
            type="number"
            size="sm"
            :min="10"
            :max="500"
            hint="Количество шагов отмены"
            @update:model-value="settings.update({ historyLimit: Number($event) || HISTORY_LIMIT })"
          />
        </div>
        <AppToggle
          :model-value="settings.settings.showGrid"
          label="Показывать сетку"
          @update:model-value="settings.update({ showGrid: $event })"
        />
        <AppToggle
          :model-value="settings.settings.snapToObjects"
          label="Привязка к объектам"
          @update:model-value="settings.update({ snapToObjects: $event })"
        />
        <AppToggle
          :model-value="settings.settings.snapToGrid"
          label="Привязка к сетке"
          @update:model-value="settings.update({ snapToGrid: $event })"
        />
        <AppInput
          :model-value="settings.settings.autosaveInterval"
          label="Автосохранение проекта, мс (0 — выключено)"
          type="number"
          size="sm"
          :min="0"
          :step="15000"
          hint="Проект сохраняется локально в фоне"
          @update:model-value="settings.update({ autosaveInterval: Number($event) || 0 })"
        />
        <AppInput
          :model-value="settings.settings.pageCacheLimit"
          label="Кэш страниц"
          type="number"
          size="sm"
          :min="1"
          :max="40"
          hint="Сколько отрисованных страниц держать в памяти"
          @update:model-value="settings.update({ pageCacheLimit: Number($event) || 8 })"
        />
      </AppSection>

      <AppSection title="Текст по умолчанию" icon="type">
        <AppSelect
          :model-value="settings.settings.defaultFontId"
          label="Шрифт"
          size="sm"
          :options="fontOptions"
          @update:model-value="settings.update({ defaultFontId: String($event) })"
        />
        <div class="grid gap-3 sm:grid-cols-2">
          <AppInput
            :model-value="settings.settings.defaultTextSize"
            label="Размер, pt"
            type="number"
            size="sm"
            :min="4"
            :max="200"
            @update:model-value="settings.update({ defaultTextSize: Number($event) || 14 })"
          />
          <AppColorPicker
            :model-value="settings.settings.defaultTextColor"
            label="Цвет текста"
            @update:model-value="settings.update({ defaultTextColor: $event })"
          />
        </div>
        <AppButton size="sm" icon="upload" @click="ui.openModal('fonts')">
          Управление шрифтами ({{ fonts.fonts.length }})
        </AppButton>
      </AppSection>

      <AppSection title="Инструменты" icon="palette">
        <div class="grid gap-3 sm:grid-cols-2">
          <AppColorPicker
            :model-value="settings.settings.defaultStrokeColor"
            label="Цвет линий и рисунков"
            @update:model-value="settings.update({ defaultStrokeColor: $event })"
          />
          <AppInput
            :model-value="settings.settings.defaultStrokeWidth"
            label="Толщина линии, pt"
            type="number"
            size="sm"
            :min="0.5"
            :max="40"
            :step="0.5"
            @update:model-value="settings.update({ defaultStrokeWidth: Number($event) || 2 })"
          />
          <AppColorPicker
            :model-value="settings.settings.defaultHighlightColor"
            label="Цвет выделения"
            @update:model-value="settings.update({ defaultHighlightColor: $event })"
          />
          <AppColorPicker
            :model-value="settings.settings.defaultWhiteoutColor"
            label="Цвет закрашивания"
            @update:model-value="settings.update({ defaultWhiteoutColor: $event })"
          />
        </div>
      </AppSection>

      <AppSection title="Экспорт" icon="download">
        <div class="grid gap-3 sm:grid-cols-2">
          <AppSelect
            :model-value="settings.settings.defaultDpi ?? 150"
            label="DPI по умолчанию"
            size="sm"
            :options="DPI_PRESETS.map((dpi) => ({ value: dpi, label: `${dpi} dpi` }))"
            @update:model-value="settings.update({ defaultDpi: Number($event) })"
          />
          <AppInput
            :model-value="settings.settings.largeFileThresholdMb"
            label="Предупреждать о файлах больше, МБ"
            type="number"
            size="sm"
            :min="1"
            :max="500"
            @update:model-value="settings.update({ largeFileThresholdMb: Number($event) || 60 })"
          />
        </div>
        <AppToggle
          :model-value="settings.settings.checkGlyphs"
          label="Проверять поддержку символов шрифтом"
          hint="Перед экспортом PDF приложение предупредит, если в шрифте нет нужных символов"
          @update:model-value="settings.update({ checkGlyphs: $event })"
        />
        <AppToggle
          :model-value="settings.settings.warnLargeFiles"
          label="Предупреждать о больших файлах"
          @update:model-value="settings.update({ warnLargeFiles: $event })"
        />
        <AppToggle
          :model-value="settings.settings.rasterizeComplexStamps"
          label="Растеризовать сложные штампы"
          hint="Полезно, если в PDF требуется абсолютно точное совпадение с предпросмотром"
          @update:model-value="settings.update({ rasterizeComplexStamps: $event })"
        />
      </AppSection>

      <AppSection title="Библиотека и хранилище" icon="book">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div
            v-for="(count, type) in library.counts"
            :key="type"
            class="rounded-lg bg-slate-50 px-2 py-1.5 text-center dark:bg-slate-800/60"
          >
            <p class="font-mono text-[13px] text-slate-700 dark:text-slate-200">{{ count }}</p>
            <p class="text-[10px] text-slate-400">{{ type }}</p>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <AppButton size="sm" icon="book" @click="ui.openModal('fonts')">Шрифты</AppButton>
          <AppButton size="sm" icon="image" @click="ui.openModal('imageLibrary')">
            Изображения
          </AppButton>
          <AppButton size="sm" icon="folder" @click="ui.openModal('projects')">Проекты</AppButton>
          <AppButton size="sm" icon="info" variant="ghost" @click="showStorage">
            Занято в браузере
          </AppButton>
          <AppButton size="sm" icon="trash" variant="ghost" @click="clearLibrary">
            Очистить библиотеку
          </AppButton>
        </div>
        <p v-if="!library.persistent" class="text-[11px] text-amber-600">
          IndexedDB недоступен — библиотека хранится только в памяти до перезагрузки страницы.
        </p>
      </AppSection>

      <AppSection title="Приватность" icon="lock">
        <div class="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-[11px] leading-snug text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <AppIcon name="lock" :size="15" class="mt-0.5 shrink-0" />
          <div class="space-y-1">
            <p>Файлы пользователя не отправляются на сервер: PDF разбирается и сохраняется в браузере.</p>
            <p>Содержимое документов не логируется в консоль.</p>
            <p>Объектные URL освобождаются после использования, чтобы не текла память.</p>
            <p>Приложение корректно предупреждает о защищённых и повреждённых файлах.</p>
          </div>
        </div>
      </AppSection>

      <div class="flex justify-between pb-8">
        <AppButton variant="ghost" icon="refresh" @click="resetSettings">
          Сбросить настройки
        </AppButton>
        <AppButton variant="primary" icon="check" @click="router.push('/')">
          Готово
        </AppButton>
      </div>
    </main>
  </div>
</template>
