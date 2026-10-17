<script setup lang="ts">
/** Свойства документа и создание нового файла. */
import { computed, ref, watch } from 'vue';
import { PAGE_SIZE_PRESETS } from '@/constants';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { usePdfDocument } from '@/composables/usePdfDocument';
import { formatBytes } from '@/utils/download';
import { describePageSize, ptToMm } from '@/utils/pdf';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSection from '@/components/ui/AppSection.vue';

const ui = useUiStore();
const pdf = usePdfStore();
const objects = useObjectsStore();
const documents = usePdfDocument();

const newPreset = ref('a4');
const pageCount = ref(1);

const isOpen = computed({
  get: () => ui.modals.documentInfo,
  set: (value: boolean) => (value ? ui.openModal('documentInfo') : ui.closeModal('documentInfo')),
});

watch(
  () => ui.modals.documentInfo,
  (open) => {
    if (!open) return;
    const preset = ui.modalPayload.preset;
    if (typeof preset === 'string') newPreset.value = preset;
  },
);

const fields: { key: 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer'; label: string; hint?: string }[] = [
  { key: 'title', label: 'Название', hint: 'Отображается в свойствах PDF' },
  { key: 'author', label: 'Автор' },
  { key: 'subject', label: 'Тема' },
  { key: 'keywords', label: 'Ключевые слова', hint: 'Через запятую' },
  { key: 'creator', label: 'Создатель' },
  { key: 'producer', label: 'Производитель' },
];

function updateMetadata(key: string, value: string | number | null): void {
  pdf.updateMetadata({ [key]: String(value ?? '') });
}

const pageInfo = computed(() => {
  const page = pdf.pages[0];
  if (!page) return null;
  return {
    pdf: `${Math.round(page.width)} × ${Math.round(page.height)} pt`,
    display: describePageSize(page.displayWidth, page.displayHeight),
    rotation: page.rotation,
    mm: `${Math.round(ptToMm(page.width))} × ${Math.round(ptToMm(page.height))} мм`,
  };
});

/** Создать новый документ (заменяет текущий — с подтверждением). */
async function createNew(): Promise<void> {
  if (pdf.isLoaded && objects.objects.length > 0) {
    const confirmed = await ui.askConfirm({
      title: 'Создать новый документ?',
      text: 'Несохранённые аннотации текущего документа будут потеряны.',
      confirmLabel: 'Создать',
      danger: true,
    });
    if (!confirmed) return;
  }
  documents.createBlankDocument(newPreset.value);
  ui.closeModal('documentInfo');
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Свойства документа"
    :subtitle="pdf.fileName || 'Документ не открыт'"
    icon="info"
    width="lg"
  >
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="space-y-3">
        <AppSection title="Метаданные PDF" icon="book">
          <AppInput
            v-for="field in fields"
            :key="field.key"
            :label="field.label"
            :hint="field.hint"
            size="sm"
            :model-value="pdf.metadata[field.key]"
            @update:model-value="updateMetadata(field.key, $event)"
          />
          <p class="text-[11px] leading-snug text-slate-400">
            Значения записываются в PDF и DOCX в Unicode — русский текст не искажается.
          </p>
        </AppSection>
      </div>

      <div class="space-y-3">
        <AppSection title="Сведения" icon="file">
          <dl class="space-y-1 text-[12px] text-slate-500 dark:text-slate-400">
            <div class="flex justify-between gap-2">
              <dt>Файл</dt>
              <dd class="truncate text-slate-700 dark:text-slate-200">{{ pdf.fileName || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt>Размер</dt>
              <dd>{{ pdf.fileSize ? formatBytes(pdf.fileSize) : '—' }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt>Страниц</dt>
              <dd>{{ pdf.pageCount }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt>Объектов</dt>
              <dd>{{ objects.objects.length }}</dd>
            </div>
            <div v-if="pageInfo" class="flex justify-between gap-2">
              <dt>Размер страницы</dt>
              <dd>{{ pageInfo.mm }} ({{ pageInfo.pdf }})</dd>
            </div>
            <div v-if="pageInfo?.rotation" class="flex justify-between gap-2">
              <dt>Поворот</dt>
              <dd>{{ pageInfo.rotation }}°</dd>
            </div>
            <div v-if="pdf.fingerprint" class="flex justify-between gap-2">
              <dt>Отпечаток</dt>
              <dd class="truncate font-mono text-[10px]">{{ pdf.fingerprint }}</dd>
            </div>
          </dl>
          <p v-if="pdf.isEncrypted" class="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            Документ зашифрован или имеет ограничения. Экспорт в PDF может быть неполным —
            при проблемах используйте экспорт в изображения.
          </p>
        </AppSection>

        <AppSection title="Новый документ" icon="plus">
          <AppSelect
            v-model="newPreset"
            label="Формат листа"
            size="sm"
            :options="PAGE_SIZE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))"
          />
          <AppInput
            v-model="pageCount"
            label="Количество листов"
            type="number"
            size="sm"
            :min="1"
            :max="50"
            hint="Пока поддерживается создание одного листа"
          />
          <AppButton icon="plus" variant="primary" block @click="createNew">
            Создать пустой документ
          </AppButton>
          <p class="text-[11px] leading-snug text-slate-400">
            Чистый лист удобен для создания штампов, подписей и печатей, а также для экспорта в
            PNG/DOCX без исходного PDF.
          </p>
        </AppSection>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('documentInfo')">Закрыть</AppButton>
    </template>
  </AppModal>
</template>
