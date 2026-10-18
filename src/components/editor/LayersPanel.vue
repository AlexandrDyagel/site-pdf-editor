<script setup lang="ts">
/**
 * Панель слоёв: список объектов текущей страницы и групп.
 *
 * Группы показываются строкой с иконкой папки (как в Photoshop), их можно
 * сворачивать. Клик по группе выделяет все её объекты на холсте, правая
 * кнопка мыши открывает общее контекстное меню («Сгруппировать», «Удалить»).
 */
import { computed, ref } from 'vue';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import type { EditorObject } from '@/types';
import { layerAccentColor, layerDetail, layerLabels, layerName } from '@/utils/layers';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const objects = useObjectsStore();
const editor = useEditorStore();
const ui = useUiStore();
const pdf = usePdfStore();

/** Объекты страницы: сверху — самые «верхние» слои. */
const layers = computed(() => objects.forPage(editor.currentPage).slice().reverse());

/**
 * Подписи слоёв: имя из «Служебного», иначе название инструмента + номер для
 * одинаковых («Эллипс 1», «Прямоугольник 2»). Нумеруем снизу вверх, поэтому
 * новые объекты сверху не сбивают номера у уже существующих.
 */
const labels = computed(() => layerLabels(objects.forPage(editor.currentPage)));

/** Свёрнутые группы (по id группы). */
const collapsedGroups = ref<Set<string>>(new Set());

/** Строка списка: либо объект, либо группа объектов. */
interface LayerRow {
  key: string;
  kind: 'object' | 'group';
  groupId: string | null;
  title: string;
  objects: EditorObject[];
  depth: number;
  collapsed: boolean;
  zIndex: number;
}

function label(objectId: string): string {
  const obj = objects.byId(objectId);
  if (!obj) return '';
  return labels.value.get(objectId) ?? layerName(obj);
}

/** Подсказка строки: название + содержимое (текст, название штампа). */
function hint(objectId: string): string {
  const obj = objects.byId(objectId);
  if (!obj) return '';
  const detail = layerDetail(obj);
  const base = label(objectId);
  return detail ? `${base} · ${detail}` : base;
}

/** Цвет индикатора слоя. */
function accent(objectId: string): string | null {
  const obj = objects.byId(objectId);
  return obj ? layerAccentColor(obj) : null;
}

const typeIcons: Record<string, string> = {
  text: 'type',
  image: 'image',
  shape: 'square',
  drawing: 'brush',
  signature: 'signature',
  stamp: 'stamp',
  whiteout: 'whiteout',
  highlight: 'highlight',
};

/**
 * Строки списка: группы собираются в одну строку, их объекты — вложенными
 * (если группа развёрнута). Порядок — как у слоёв, сверху вниз.
 */
const rows = computed<LayerRow[]>(() => {
  const pageObjects = objects.forPage(editor.currentPage);
  const topFirst = pageObjects.slice().reverse();

  // Названия групп: нумеруем по порядку появления снизу вверх.
  const groupNames = new Map<string, string>();
  let groupIndex = 0;
  for (const obj of pageObjects) {
    if (obj.groupId && !groupNames.has(obj.groupId)) {
      groupIndex += 1;
      groupNames.set(obj.groupId, `Группа ${groupIndex}`);
    }
  }

  const result: LayerRow[] = [];
  const emitted = new Set<string>();
  for (const obj of topFirst) {
    if (obj.groupId) {
      if (emitted.has(obj.groupId)) continue;
      emitted.add(obj.groupId);
      const members = topFirst.filter((item) => item.groupId === obj.groupId);
      const collapsed = collapsedGroups.value.has(obj.groupId);
      result.push({
        key: `group-${obj.groupId}`,
        kind: 'group',
        groupId: obj.groupId,
        title: groupNames.get(obj.groupId) ?? 'Группа',
        objects: members,
        depth: 0,
        collapsed,
        zIndex: Math.max(...members.map((item) => item.zIndex)),
      });
      if (!collapsed) {
        for (const member of members) {
          result.push({
            key: member.id,
            kind: 'object',
            groupId: obj.groupId,
            title: label(member.id),
            objects: [member],
            depth: 1,
            collapsed: false,
            zIndex: member.zIndex,
          });
        }
      }
      continue;
    }
    result.push({
      key: obj.id,
      kind: 'object',
      groupId: null,
      title: label(obj.id),
      objects: [obj],
      depth: 0,
      collapsed: false,
      zIndex: obj.zIndex,
    });
  }
  return result;
});

/** Выделена ли строка (группа — когда выделены все её объекты). */
function isSelected(row: LayerRow): boolean {
  return row.objects.every((obj) => objects.selectedIds.includes(obj.id));
}

/** Строка подсвечена как часть выделения (хотя бы один объект). */
function isActive(row: LayerRow): boolean {
  return row.objects.some((obj) => objects.selectedIds.includes(obj.id));
}

function toggleGroup(row: LayerRow): void {
  const id = row.groupId;
  if (!id) return;
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
}

function onClickRow(row: LayerRow, event: MouseEvent): void {
  // Клик по группе выделяет все её объекты, клик по объекту — только его.
  if (row.kind === 'group') {
    objects.select(row.objects.map((obj) => obj.id));
    return;
  }
  objects.selectOne(row.objects[0].id, event.shiftKey);
}

/**
 * Двойной клик: у группы — свернуть/развернуть (как в Photoshop), у объекта —
 * перейти к его свойствам (и открыть правку текста).
 */
function onDblClickRow(row: LayerRow): void {
  if (row.kind === 'group') {
    toggleGroup(row);
    return;
  }
  const first = row.objects[0];
  objects.select([first.id]);
  if (first.type === 'text') editor.startTextEditing(first.id);
  ui.setRightTab('properties');
}

/** Правая кнопка мыши: контекстное меню для строки (или текущего выделения). */
function openRowMenu(event: MouseEvent, row: LayerRow): void {
  event.preventDefault();
  const ids = row.objects.map((obj) => obj.id);
  if (row.kind === 'group') {
    objects.select(ids);
  } else if (!ids.every((id) => objects.selectedIds.includes(id))) {
    objects.select(ids);
  }
  ui.openContextMenu({
    x: event.clientX,
    y: event.clientY,
    ids: [...objects.selectedIds],
    groupId: row.groupId,
    title: row.kind === 'group' ? `${row.title} · объектов: ${row.objects.length}` : hint(ids[0]),
  });
}

async function removeRow(row: LayerRow): Promise<void> {
  const ids = row.objects.map((obj) => obj.id);
  if (row.kind === 'group') {
    const confirmed = await ui.askConfirm({
      title: 'Удалить группу?',
      text: `${row.title}: объектов ${row.objects.length}`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (confirmed) objects.remove(ids, 'Удаление группы');
    return;
  }
  const confirmed = await ui.askConfirm({
    title: 'Удалить объект?',
    text: row.title,
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (confirmed) objects.remove(ids);
}

/** Все объекты строки видимы / заблокированы. */
function allVisible(row: LayerRow): boolean {
  return row.objects.every((obj) => obj.visible);
}

function allLocked(row: LayerRow): boolean {
  return row.objects.every((obj) => obj.locked);
}

/**
 * Сдвиг слоя на одну позицию.
 *
 * Кнопки всегда активны: если слой уже на самом верху или в самом низу,
 * пользователь получает понятное сообщение, а не «мёртвую» кнопку без
 * подсказки (у отключённых кнопок подсказка не показывается и клик не
 * срабатывает — именно это выглядело как «не работает»).
 */
function moveLayer(row: LayerRow, direction: 1 | -1, index: number): void {
  if (direction > 0 && index === 0) {
    ui.notify.info('Слой уже наверху', 'Выше на этой странице слоёв нет.');
    return;
  }
  if (direction < 0 && index === rows.value.length - 1) {
    ui.notify.info('Слой уже внизу', 'Ниже на этой странице слоёв нет.');
    return;
  }
  const ids = row.objects.map((obj) => obj.id);
  if (direction > 0) objects.bringForward(ids);
  else objects.sendBackward(ids);
}

/** Сдвиг выделенных слоёв (кнопки внизу панели). */
function moveSelected(direction: 1 | -1): void {
  if (!objects.hasSelection) {
    ui.notify.info('Слой не выбран', 'Нажмите на строку слоя — или на объект на странице.');
    return;
  }
  if (direction > 0) objects.bringForward();
  else objects.sendBackward();
}

/** Перенос выделенных на самый верх / в самый низ. */
function moveSelectedToEdge(edge: 'front' | 'back'): void {
  if (!objects.hasSelection) {
    ui.notify.info('Слой не выбран', 'Нажмите на строку слоя — или на объект на странице.');
    return;
  }
  if (edge === 'front') objects.bringToFront();
  else objects.sendToBack();
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Слои страницы {{ editor.currentPage + 1 }}
      </span>
      <span class="font-mono text-[11px] text-slate-400">{{ layers.length }}</span>
    </div>

    <div v-if="layers.length === 0" class="flex-1">
      <AppEmptyState
        compact
        icon="layers"
        title="Слоёв пока нет"
        text="Добавьте текст, фигуру, подпись или штамп — объект появится в списке."
      >
        <AppButton size="sm" icon="book" @click="ui.setLeftTab('library')">
          Открыть библиотеку
        </AppButton>
      </AppEmptyState>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="(row, index) in rows"
        :key="row.key"
        :data-layer-id="row.kind === 'object' ? row.objects[0].id : undefined"
        :data-group-id="row.kind === 'group' ? row.groupId ?? undefined : undefined"
        :data-layer-kind="row.kind"
        class="group flex items-center gap-1.5 border-b border-slate-100 py-1.5 pr-2 transition-colors dark:border-slate-800/60"
        :class="[
          isSelected(row)
            ? 'bg-brand-50 dark:bg-brand-600/15'
            : isActive(row)
              ? 'bg-brand-50/60 dark:bg-brand-600/10'
              : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          row.kind === 'group' ? 'border-l-2 border-l-brand-300 dark:border-l-brand-500/60' : '',
          row.depth > 0 ? 'border-l border-l-slate-200 dark:border-l-slate-700' : '',
        ]"
        :style="{ paddingLeft: row.depth > 0 ? '20px' : '6px' }"
        @contextmenu="openRowMenu($event, row)"
      >
        <!-- Свернуть/развернуть группу -->
        <button
          v-if="row.kind === 'group'"
          type="button"
          class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
          :title="row.collapsed ? 'Развернуть группу' : 'Свернуть группу'"
          data-group-toggle
          @click.stop="toggleGroup(row)"
        >
          <AppIcon :name="row.collapsed ? 'chevronRight' : 'chevronDown'" :size="12" />
        </button>
        <span v-else-if="row.depth > 0" class="w-4 shrink-0" />

        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          :title="row.kind === 'group' ? `${row.title} · объектов: ${row.objects.length}` : hint(row.objects[0].id)"
          @click="onClickRow(row, $event)"
          @dblclick="onDblClickRow(row)"
        >
          <!-- Группа: значок папки. Объект: индикатор цвета или значок типа -->
          <span
            v-if="row.kind === 'group'"
            class="flex h-[15px] w-[15px] shrink-0 items-center justify-center text-amber-500 dark:text-amber-400"
          >
            <AppIcon :name="row.collapsed ? 'folder' : 'folderOpen'" :size="15" />
          </span>
          <span
            v-else-if="accent(row.objects[0].id)"
            class="flex h-[15px] w-[15px] shrink-0 items-center justify-center"
            :title="accent(row.objects[0].id) ?? ''"
          >
            <span
              data-layer-color
              class="block h-3 w-3 rounded-full ring-1 ring-slate-300 dark:ring-slate-600"
              :style="{ backgroundColor: accent(row.objects[0].id) ?? 'transparent' }"
            />
          </span>
          <span v-else class="text-slate-400">
            <AppIcon :name="typeIcons[row.objects[0].type] ?? 'square'" :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span
              data-layer-label
              class="block truncate text-[12px]"
              :class="
                row.kind === 'group'
                  ? 'font-medium text-slate-800 dark:text-slate-100'
                  : 'text-slate-700 dark:text-slate-200'
              "
            >
              {{ row.title }}
            </span>
            <span class="block truncate text-[10px] text-slate-400">
              <template v-if="row.kind === 'group'">
                объектов: {{ row.objects.length }}
              </template>
              <template v-else>
                z={{ row.zIndex }} · {{ Math.round(row.objects[0].width) }}×{{
                  Math.round(row.objects[0].height)
                }}
                pt
              </template>
            </span>
          </span>
        </button>

        <div class="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <!-- Порядок слоя: сразу из списка, без выделения объекта -->
          <AppTooltip text="Выше (ближе к зрителю)">
            <AppButton
              icon="moveUp"
              size="xs"
              variant="ghost"
              title="Выше"
              :class="{ 'opacity-40': index === 0 }"
              @click="moveLayer(row, 1, index)"
            />
          </AppTooltip>
          <AppTooltip text="Ниже (дальше от зрителя)">
            <AppButton
              icon="moveDown"
              size="xs"
              variant="ghost"
              title="Ниже"
              :class="{ 'opacity-40': index === rows.length - 1 }"
              @click="moveLayer(row, -1, index)"
            />
          </AppTooltip>
          <AppTooltip :text="allVisible(row) ? 'Скрыть' : 'Показать'">
            <AppButton
              :icon="allVisible(row) ? 'eye' : 'eyeOff'"
              size="xs"
              variant="ghost"
              @click="objects.setVisible(row.objects.map((obj) => obj.id), !allVisible(row))"
            />
          </AppTooltip>
          <AppTooltip :text="allLocked(row) ? 'Разблокировать' : 'Заблокировать'">
            <AppButton
              :icon="allLocked(row) ? 'lock' : 'unlock'"
              size="xs"
              variant="ghost"
              @click="objects.setLocked(row.objects.map((obj) => obj.id), !allLocked(row))"
            />
          </AppTooltip>
          <AppTooltip text="Удалить">
            <AppButton icon="trash" size="xs" variant="ghost" @click="removeRow(row)" />
          </AppTooltip>
        </div>
      </div>
    </div>

    <div
      v-if="layers.length > 0"
      class="flex items-center gap-1 border-t border-slate-200 px-2 py-1.5 dark:border-slate-800"
    >
      <AppTooltip text="Поверх всех выделенных" shortcut="]">
        <AppButton
          icon="front"
          size="sm"
          variant="ghost"
          title="Поверх всех"
          @click="moveSelectedToEdge('front')"
        />
      </AppTooltip>
      <AppTooltip text="Поднять выделенные">
        <AppButton
          icon="moveUp"
          size="sm"
          variant="ghost"
          title="Поднять"
          @click="moveSelected(1)"
        />
      </AppTooltip>
      <AppTooltip text="Опустить выделенные">
        <AppButton
          icon="moveDown"
          size="sm"
          variant="ghost"
          title="Опустить"
          @click="moveSelected(-1)"
        />
      </AppTooltip>
      <AppTooltip text="Позади всех выделенных" shortcut="[">
        <AppButton
          icon="back"
          size="sm"
          variant="ghost"
          title="Позади всех"
          @click="moveSelectedToEdge('back')"
        />
      </AppTooltip>
      <div class="flex-1" />
      <AppButton
        size="sm"
        variant="ghost"
        icon="trash"
        :disabled="!objects.hasSelection"
        @click="objects.remove(objects.selectedIds)"
      >
        Удалить
      </AppButton>
    </div>

    <div
      v-if="pdf.isLoaded"
      class="border-t border-slate-200 px-3 py-2 text-[10px] text-slate-400 dark:border-slate-800"
    >
      Всего объектов в документе: {{ objects.objects.length }}
    </div>
  </div>
</template>
