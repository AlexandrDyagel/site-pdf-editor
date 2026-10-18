/**
 * Перетаскивание файлов в окно приложения: PDF, изображения, шрифты, проекты.
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { isImageFile } from '@/utils/image';
import { looksLikePdf } from '@/utils/pdf';
import { parseJson } from '@/utils/encoding';
import { createImageObject } from '@/services/objectFactory';
import { readImageFile } from '@/services/fileService';
import { usePdfDocument } from '@/composables/usePdfDocument';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useFontsStore } from '@/stores/fonts';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';

export function useDragAndDrop(): {
  isDragging: Ref<boolean>;
  dropFiles: (files: FileList | File[]) => Promise<void>;
} {
  const isDragging = ref(false);
  const documents = usePdfDocument();
  const objects = useObjectsStore();
  const editor = useEditorStore();
  const fonts = useFontsStore();
  const library = useLibraryStore();
  const ui = useUiStore();

  let dragCounter = 0;

  function onDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragCounter += 1;
    isDragging.value = true;
  }

  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    isDragging.value = true;
  }

  function onDragLeave(): void {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) isDragging.value = false;
  }

  function onDrop(event: DragEvent): void {
    // Если файл уже принял конкретный компонент (зона загрузки), повторно
    // открывать его нельзя: иначе документ открывался дважды и появлялись
    // два тоста «Документ открыт».
    if (event.defaultPrevented) {
      dragCounter = 0;
      isDragging.value = false;
      return;
    }
    event.preventDefault();
    dragCounter = 0;
    isDragging.value = false;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) void dropFiles(files);
  }

  /** Обработка перетащенных файлов. */
  async function dropFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    for (const file of list) {
      try {
        if (isImageFile(file)) {
          const image = await readImageFile(file);
          const width = Math.min(image.naturalWidth, editor.pageSize.width * 0.5);
          const scale = width / Math.max(1, image.naturalWidth);
          const target = {
            x: (editor.pageSize.width - width) / 2,
            y: editor.pageSize.height * 0.25,
          };
          objects.add(
            [
              createImageObject({
                page: editor.currentPage,
                x: target.x,
                y: target.y,
                width,
                height: image.naturalHeight * scale,
                src: image.src,
                mimeType: image.mimeType,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                alt: file.name,
              }),
            ],
            'Добавление изображения',
          );
          continue;
        }

        if (/\.(ttf|otf)$/i.test(file.name)) {
          const asset = await fonts.uploadFont(file);
          ui.notify.success('Шрифт добавлен', `${asset.name}${asset.supportsCyrillic ? ' · кириллица ✓' : ''}`);
          continue;
        }

        if (/\.json$/i.test(file.name)) {
          const text = await file.text();
          const parsed = parseJson<{ objects?: unknown[]; items?: unknown[]; schemaVersion?: number }>(text);
          if (Array.isArray(parsed.objects)) {
            await documents.openProject(file);
          } else if (Array.isArray(parsed.items)) {
            const result = await library.importJson(text);
            ui.notify.success(
              'Библиотека импортирована',
              `добавлено: ${result.added}, обновлено: ${result.updated}`,
            );
          } else {
            ui.notify.error('Неизвестный JSON-файл', 'Ожидается проект или библиотека.');
          }
          continue;
        }

        // Остальное считаем PDF.
        await documents.openFile(file);
      } catch (error) {
        ui.notify.error(
          'Не удалось обработать файл',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    void looksLikePdf(new Uint8Array());
  }

  onMounted(() => {
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  });

  return { isDragging, dropFiles };
}
