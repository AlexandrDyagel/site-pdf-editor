<script setup lang="ts">
/**
 * ============================================================================
 *  Панель «История».
 * ============================================================================
 *
 *  Показывает ленту действий: сверху — самые старые, ниже — текущее состояние,
 *  ещё ниже — отменённые действия, которые можно вернуть («будущее»). Клик по
 *  строке переносит документ в это состояние, поэтому не нужно нажимать
 *  «Отменить» много раз подряд.
 */

import { computed, nextTick, ref, watch } from 'vue';
import { useHistoryStore } from '@/stores/history';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

interface HistoryRow {
  key: string;
  kind: 'past' | 'current' | 'future';
  label: string;
  at: number | null;
  /** Сколько шагов отменить (для past) или повторить (для future). */
  steps: number;
  depth: number;
}

const history = useHistoryStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const ui = useUiStore();

const list = ref<HTMLElement | null>(null);

/** Время в формате ЧЧ:ММ:СС. */
function timeOf(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString('ru-RU', { hour12: false });
}

/**
 * Лента состояний: старые действия → текущее состояние → отменённые действия.
 * `steps` — сколько раз нажать «отменить»/«повторить», чтобы попасть в строку.
 */
const rows = computed<HistoryRow[]>(() => {
  const past = history.past;
  const future = history.future;
  const items: HistoryRow[] = [];

  past.forEach((entry, index) => {
    items.push({
      key: `past-${index}-${entry.at}`,
      kind: 'past',
      label: entry.label,
      at: entry.at,
      steps: past.length - index,
      depth: index,
    });
  });

  items.push({
    key: 'current',
    kind: 'current',
    label: 'Текущее состояние',
    at: null,
    steps: 0,
    depth: past.length,
  });

  future.forEach((entry, index) => {
    items.push({
      key: `future-${index}-${entry.at}`,
      kind: 'future',
      label: entry.label,
      at: entry.at,
      steps: index + 1,
      depth: past.length + index + 1,
    });
  });

  return items;
});

const canUndo = computed(() => history.past.length > 0);
const canRedo = computed(() => history.future.length > 0);
const nextUndo = computed(() => history.past[history.past.length - 1]?.label ?? '');
const nextRedo = computed(() => history.future[history.future.length - 1]?.label ?? '');

/** Переход к состоянию по клику на строку. */
function goTo(row: HistoryRow): void {
  if (row.kind === 'current') return;
  if (row.kind === 'past') {
    for (let step = 0; step < row.steps; step += 1) objects.undo();
    ui.notify.info('История', `Возврат: ${row.label}`);
    return;
  }
  for (let step = 0; step < row.steps; step += 1) objects.redo();
  ui.notify.info('История', `Повторено: ${row.label}`);
}

function undo(): void {
  if (!canUndo.value) return;
  objects.undo();
}

function redo(): void {
  if (!canRedo.value) return;
  objects.redo();
}

/** Прокручиваем к текущему состоянию при каждом изменении. */
watch(
  () => [history.past.length, history.future.length, editor.currentPage],
  async () => {
    await nextTick();
    const current = list.value?.querySelector('[data-history-current]');
    current?.scrollIntoView({ block: 'nearest' });
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-1 border-b border-slate-200 px-2 py-2 dark:border-slate-800">
      <AppTooltip :text="canUndo ? `Отменить: ${nextUndo}` : 'Нечего отменять'">
        <AppButton
          icon="undo"
          size="sm"
          variant="subtle"
          data-history-undo
          :disabled="!canUndo"
          @click="undo"
        >
          Отменить
        </AppButton>
      </AppTooltip>
      <AppTooltip :text="canRedo ? `Повторить: ${nextRedo}` : 'Нечего повторять'">
        <AppButton
          icon="redo"
          size="sm"
          variant="subtle"
          data-history-redo
          :disabled="!canRedo"
          @click="redo"
        >
          Повторить
        </AppButton>
      </AppTooltip>
    </div>

    <div v-if="rows.length <= 1" class="flex-1">
      <AppEmptyState
        icon="history"
        title="История пуста"
        text="Здесь появятся ваши действия: добавление объектов, правки текста, порядок слоёв и прочее."
      />
    </div>

    <div v-else ref="list" class="min-h-0 flex-1 overflow-y-auto p-2">
      <ol class="flex flex-col gap-0.5">
        <li v-for="row in rows" :key="row.key">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
            :class="[
              row.kind === 'current'
                ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-200'
                : row.kind === 'future'
                  ? 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
            ]"
            :data-history-row="row.kind"
            :data-history-label="row.label"
            :data-history-current="row.kind === 'current' ? 'true' : undefined"
            :title="
              row.kind === 'current'
                ? 'Текущее состояние документа'
                : row.kind === 'past'
                  ? `Вернуться в состояние перед действием «${row.label}»`
                  : `Повторить действие «${row.label}»`
            "
            :disabled="row.kind === 'current'"
            @click="goTo(row)"
          >
            <span class="shrink-0">
              <AppIcon
                :name="row.kind === 'current' ? 'check' : row.kind === 'past' ? 'undo' : 'redo'"
                :size="14"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12px]">{{ row.label }}</span>
              <span v-if="row.at" class="block text-[10px] text-slate-400">{{ timeOf(row.at) }}</span>
            </span>
            <span
              v-if="row.kind === 'current'"
              class="shrink-0 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 dark:text-brand-200"
            >
              сейчас
            </span>
          </button>
        </li>
      </ol>
    </div>

    <div
      class="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-800"
    >
      <span>Шагов: {{ history.past.length }} из {{ history.limit }}</span>
      <span v-if="history.future.length > 0">отменено: {{ history.future.length }}</span>
      <span v-else>Ctrl+Z / Ctrl+Shift+Z</span>
    </div>
  </div>
</template>
