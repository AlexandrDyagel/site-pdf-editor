/**
 * ============================================================================
 *  Отрисовка текущей страницы PDF в фоне сцены.
 * ============================================================================
 *
 *  Масштаб растеризации выбирается «ступенями» (1×, 1.5×, 2×, 3×, 4×, 6×),
 *  поэтому при плавном зуме страница не перерисовывается на каждый шаг —
 *  картинка просто масштабируется, а перерисовка происходит лишь при выходе
 *  за пределы текущей ступени. Отрисованные страницы кэшируются в pdfService.
 */

import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { usePdfStore } from '@/stores/pdf';
import { pdfService } from '@/services/pdfService';
import { extraPageRotation } from '@/utils/coordinates';

/** Ступени масштаба растеризации. */
const RENDER_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

export function usePdfPage(options: {
  setBackground: (image: CanvasImageSource | null, width: number, height: number) => void;
}): {
  render: () => Promise<void>;
  isRendering: ReturnType<typeof ref<boolean>>;
  renderScale: ReturnType<typeof ref<number>>;
} {
  const pdf = usePdfStore();
  const editor = useEditorStore();

  const isRendering = ref(false);
  const renderScale = ref(1);
  let requestToken = 0;
  let debounceTimer: number | null = null;

  const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  /** Выбор ступени масштаба под текущий зум. */
  function pickScale(zoom: number): number {
    const needed = Math.min(6, Math.max(0.5, zoom * devicePixelRatio));
    return RENDER_STEPS.find((step) => step >= needed) ?? RENDER_STEPS[RENDER_STEPS.length - 1];
  }

  /** Отрисовка страницы. */
  async function render(): Promise<void> {
    const index = editor.currentPage;
    const page = pdf.pages[index];
    const size = pdf.displaySize(index);

    // Подложка рисуется сразу — даже если PDF ещё не отрисован.
    options.setBackground(null, size.width, size.height);
    if (!page || !pdfService.getDocument()) return;

    const scale = pickScale(editor.zoom);
    renderScale.value = scale;
    const token = ++requestToken;
    isRendering.value = true;
    pdf.setPageStatus(index, 'rendering');

    try {
      const { canvas } = await pdfService.renderPageCached(index, {
        scale,
        // Подложка рисуется в итоговой ориентации страницы: без этого
        // неповёрнутый растр растягивался бы на альбомный холст.
        rotation: extraPageRotation(page),
      });
      if (token !== requestToken) return;
      options.setBackground(canvas, size.width, size.height);
      pdf.setPageStatus(index, 'ready');
      page.renderScale = scale;
    } catch (error) {
      if (token !== requestToken) return;
      pdf.setPageStatus(
        index,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (token === requestToken) isRendering.value = false;
    }
  }

  /** Перерисовка с задержкой (для зума). */
  function scheduleRender(delay = 180): void {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void render();
    }, delay);
  }

  watch(
    () => editor.currentPage,
    () => {
      void render();
      void pdf.ensureThumbnail(editor.currentPage);
    },
  );

  watch(
    () => pdf.isLoaded,
    () => {
      void render();
    },
  );

  // Поворот страницы (в том числе добавленный пользователем) требует
  // повторной растеризации: меняется и ориентация, и размеры полотна.
  watch(
    () => pdf.geometry(editor.currentPage).rotation,
    () => {
      void render();
      void pdf.ensureThumbnail(editor.currentPage);
    },
  );

  watch(
    () => pickScale(editor.zoom),
    () => scheduleRender(),
  );

  onMounted(() => {
    void render();
  });

  onBeforeUnmount(() => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  });

  return { render, isRendering, renderScale };
}
