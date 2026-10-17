<script setup lang="ts">
/** Справка по горячим клавишам. */
import { computed } from 'vue';
import { HOTKEYS, TOOL_DEFINITIONS } from '@/constants';
import { useUiStore } from '@/stores/ui';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';

const ui = useUiStore();

const isOpen = computed({
  get: () => ui.modals.shortcuts,
  set: (value: boolean) => (value ? ui.openModal('shortcuts') : ui.closeModal('shortcuts')),
});

const groups: { title: string; items: { keys: string; label: string }[] }[] = [
  {
    title: 'Файл',
    items: [
      { keys: HOTKEYS.open, label: 'Открыть PDF' },
      { keys: HOTKEYS.save, label: 'Сохранить PDF с аннотациями' },
      { keys: 'Ctrl + Shift + S', label: 'Открыть окно экспорта' },
      { keys: HOTKEYS.export, label: 'Экспорт' },
    ],
  },
  {
    title: 'Правка',
    items: [
      { keys: HOTKEYS.undo, label: 'Отменить' },
      { keys: HOTKEYS.redo, label: 'Повторить' },
      { keys: HOTKEYS.copy, label: 'Копировать' },
      { keys: HOTKEYS.paste, label: 'Вставить' },
      { keys: HOTKEYS.duplicate, label: 'Дублировать' },
      { keys: HOTKEYS.selectAll, label: 'Выделить всё на странице' },
      { keys: HOTKEYS.delete, label: 'Удалить выделенное' },
      { keys: 'Ctrl + G / Ctrl + Shift + G', label: 'Группировать / разгруппировать' },
      { keys: 'Ctrl + L', label: 'Заблокировать / разблокировать' },
      { keys: 'Стрелки', label: 'Сдвиг на 1 pt (Shift — на 10 pt)' },
      { keys: '[ / ]', label: 'Ниже / выше по слоям' },
    ],
  },
  {
    title: 'Страницы',
    items: [
      { keys: 'Alt + ← / →', label: 'Повернуть страницу влево / вправо' },
      { keys: 'PageUp / PageDown', label: 'Предыдущая / следующая страница' },
      { keys: 'Home / End', label: 'Первая / последняя страница' },
    ],
  },
  {
    title: 'Вид и навигация',
    items: [
      { keys: 'Колесо', label: 'Прокрутка страницы' },
      { keys: 'Ctrl + колесо', label: 'Зум под курсором' },
      { keys: 'Пробел + перетаскивание', label: 'Панорамирование' },
      { keys: 'Ctrl + 0', label: 'Вписать по ширине' },
      { keys: 'Ctrl + Shift + 0', label: 'Вписать страницу' },
      { keys: 'Ctrl + 1', label: 'Масштаб 100%' },
      { keys: 'PageUp / PageDown', label: 'Предыдущая / следующая страница' },
      { keys: 'Home / End', label: 'Первая / последняя страница' },
      { keys: 'Escape', label: 'Отменить черновик, снять выделение, закрыть окно' },
    ],
  },
];

const toolShortcuts = computed(() =>
  TOOL_DEFINITIONS.filter((tool) => tool.shortcut).map((tool) => ({
    keys: tool.shortcut ?? '',
    label: tool.label,
  })),
);
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Горячие клавиши"
    subtitle="Работайте быстрее — почти всё доступно с клавиатуры"
    icon="key"
    width="lg"
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <div v-for="group in groups" :key="group.title" class="space-y-1.5">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {{ group.title }}
        </p>
        <div
          v-for="item in group.items"
          :key="item.keys"
          class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60"
        >
          <span class="text-[12px] text-slate-600 dark:text-slate-300">{{ item.label }}</span>
          <kbd
            class="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
          >
            {{ item.keys }}
          </kbd>
        </div>
      </div>

      <div class="space-y-1.5 sm:col-span-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Инструменты
        </p>
        <div class="grid gap-1.5 sm:grid-cols-3">
          <div
            v-for="item in toolShortcuts"
            :key="item.keys"
            class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60"
          >
            <span class="text-[12px] text-slate-600 dark:text-slate-300">{{ item.label }}</span>
            <kbd
              class="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
            >
              {{ item.keys }}
            </kbd>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="primary" @click="ui.closeModal('shortcuts')">Понятно</AppButton>
    </template>
  </AppModal>
</template>
