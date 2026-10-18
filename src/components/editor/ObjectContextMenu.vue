<script setup lang="ts">
/**
 * Контекстное меню объектов (правая кнопка мыши).
 *
 * Меню одно для холста и панели «Слои»: открывается через `ui.openContextMenu`,
 * поэтому действия и их доступность везде одинаковые.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '@/stores/ui';
import { useObjectsStore } from '@/stores/objects';
import AppIcon from '@/components/ui/AppIcon.vue';

const ui = useUiStore();
const objects = useObjectsStore();

const root = ref<HTMLElement | null>(null);
const position = ref({ left: 0, top: 0 });

const open = computed(() => ui.contextMenu !== null);
const ids = computed(() => ui.contextMenu?.ids ?? []);
const title = computed(() => ui.contextMenu?.title ?? '');
const canGroup = computed(() => ids.value.length >= 2 && hasUngrouped());
const canUngroup = computed(() => ids.value.some((id) => Boolean(objects.byId(id)?.groupId)));

/** Есть ли среди выделенных объекты вне групп (группировать есть что). */
function hasUngrouped(): boolean {
  const objectsInGroups = ids.value.filter((id) => Boolean(objects.byId(id)?.groupId));
  return ids.value.length - objectsInGroups.length >= 1 || objectsInGroups.length >= 2;
}

/** Позиционирование с учётом краёв окна. */
async function place(): Promise<void> {
  if (!open.value || !ui.contextMenu) return;
  position.value = { left: ui.contextMenu.x, top: ui.contextMenu.y };
  await nextTick();
  const element = root.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - 8;
  const maxTop = window.innerHeight - rect.height - 8;
  position.value = {
    left: Math.max(8, Math.min(ui.contextMenu.x, maxLeft)),
    top: Math.max(8, Math.min(ui.contextMenu.y, maxTop)),
  };
}

watch(
  () => ui.contextMenu,
  () => {
    void place();
  },
);

function close(): void {
  ui.closeContextMenu();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const element = root.value;
  if (element && event.target instanceof Node && element.contains(event.target)) return;
  close();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!open.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}

function onScroll(): void {
  if (open.value) close();
}

function doGroup(): void {
  if (!canGroup.value) return;
  objects.group([...ids.value]);
  close();
}

function doUngroup(): void {
  objects.ungroup([...ids.value]);
  close();
}

function doRemove(): void {
  objects.remove([...ids.value]);
  close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onScroll);
});
</script>

<template>
  <div
    v-if="open"
    ref="root"
    class="fixed z-[230] w-56 animate-fade-in overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-floating dark:border-slate-700 dark:bg-slate-900"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    role="menu"
    data-testid="object-context-menu"
    @contextmenu.prevent
  >
    <p
      v-if="title"
      class="truncate border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 dark:border-slate-800"
    >
      {{ title }}
    </p>

    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
      :class="
        canGroup
          ? 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
          : 'cursor-not-allowed text-slate-300 dark:text-slate-600'
      "
      :disabled="!canGroup"
      data-context-action="group"
      @click="doGroup"
    >
      <AppIcon name="folderPlus" :size="14" />
      Сгруппировать
    </button>

    <button
      v-if="canUngroup"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      data-context-action="ungroup"
      @click="doUngroup"
    >
      <AppIcon name="folderOpen" :size="14" />
      Разгруппировать
    </button>

    <div class="my-1 border-t border-slate-100 dark:border-slate-800" />

    <button
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-rose-600 transition-colors hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
      data-context-action="remove"
      @click="doRemove"
    >
      <AppIcon name="trash" :size="14" />
      Удалить
    </button>
  </div>
</template>
