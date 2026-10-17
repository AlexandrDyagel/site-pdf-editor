/**
 * ============================================================================
 *  Экспорт в DOCX (Word).
 * ============================================================================
 *
 *  Документ строится пакетом `docx` (все строки — Unicode, кириллица
 *  сохраняется без «кракозябр»), а страницы вставляются изображениями
 *  в высоком разрешении. Дополнительно в документ добавляется текст
 *  аннотаций, чтобы его можно было искать и копировать.
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type {
  EditorObject,
  ExportResult,
  ExportSettings,
  StampPayload,
  TextPayload,
} from '@/types';
import type { PageGeometry } from '@/utils/coordinates';
import { buildExportFileName, resolveSelectedPages } from '@/utils/export';
import { formatDateTime } from '@/utils/date';
import { renderPagesImageList, type ImageExportInput } from '@/services/imageExportService';

/** Входные данные экспорта в DOCX. */
export interface DocxExportInput extends Omit<ImageExportInput, 'settings'> {
  settings: ExportSettings;
  /** Название документа. */
  documentTitle?: string;
}

/** Цвет из #rrggbb в формат docx (без решётки). */
function docxColor(hex: string): string {
  return (hex || '#000000').replace('#', '').toUpperCase().slice(0, 6);
}

/** Текстовые аннотации страницы в виде абзацев. */
function annotationParagraphs(objects: readonly EditorObject[], pageIndex: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const pageObjects = objects
    .filter((obj) => obj.page === pageIndex && obj.visible)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  for (const obj of pageObjects) {
    if (obj.type === 'text') {
      const payload = obj.payload as TextPayload;
      if (!payload.text.trim()) continue;
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: payload.text,
              bold: payload.bold,
              italics: payload.italic,
              size: Math.max(12, Math.round(payload.fontSize * 2)),
              color: docxColor(payload.color),
              font: payload.fontFamily,
            }),
          ],
          spacing: { after: 80 },
        }),
      );
    } else if (obj.type === 'stamp') {
      const payload = obj.payload as StampPayload;
      const lines = payload.template.lines
        .map((line) => line.text.trim())
        .filter(Boolean)
        .join(' / ');
      if (!lines) continue;
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${payload.template.kind === 'seal' ? 'Печать' : 'Штамп'}: ${lines}]`,
              italics: true,
              size: 20,
              color: '555555',
            }),
          ],
          spacing: { after: 80 },
        }),
      );
    } else if (obj.type === 'whiteout') {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: '[закрашенная область]',
              size: 18,
              color: '888888',
            }),
          ],
          spacing: { after: 60 },
        }),
      );
    } else if (obj.type === 'signature') {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: '[подпись]', size: 18, color: '888888' })],
          spacing: { after: 60 },
        }),
      );
    }
  }
  return paragraphs;
}

/** Экспорт в DOCX. */
export async function exportDocx(input: DocxExportInput): Promise<ExportResult> {
  const { settings } = input;
  const fileName = buildExportFileName(settings, 'docx');
  const warnings: string[] = [];
  try {
    const selected = resolveSelectedPages(settings, input.pageGeometry.length, input.currentPage ?? 0);
    if (selected.length === 0) throw new Error('Не выбрано ни одной страницы');

    // Страницы рендерим как PNG без прозрачности — так их корректно
    // воспринимают Word и LibreOffice.
    const list = await renderPagesImageList({
      ...input,
      settings: {
        ...settings,
        format: 'png',
        transparentBackground: false,
        zip: false,
        singleImage: false,
      },
    });
    warnings.push(...list.warnings);

    const title = input.documentTitle?.trim() || settings.metadata.title.trim() || settings.fileName;
    const children: Paragraph[] = [
      new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 160 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `Экспортировано из «PDF Редактор»: ${formatDateTime(new Date())}`,
            size: 18,
            color: '666666',
          }),
        ],
        spacing: { after: 240 },
      }),
    ];

    for (let position = 0; position < list.pages.length; position += 1) {
      const page = list.pages[position];
      if (position > 0) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      children.push(
        new Paragraph({
          text: `Страница ${page.index + 1}`,
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 120 },
        }),
      );

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        page.canvas.toBlob((blob) => resolve(blob), 'image/png'),
      );
      if (pngBlob) {
        const bytes = new Uint8Array(await pngBlob.arrayBuffer());
        const maxWidth = 600;
        const ratio = Math.min(1, maxWidth / page.width);
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: bytes,
                transformation: {
                  width: Math.max(1, Math.round(page.width * ratio)),
                  height: Math.max(1, Math.round(page.height * ratio)),
                },
              }),
            ],
            spacing: { after: 160 },
          }),
        );
      } else {
        warnings.push(`Страницу ${page.index + 1} не удалось преобразовать в изображение.`);
      }

      const annotations = annotationParagraphs(input.objects, page.index);
      if (annotations.length > 0) {
        children.push(
          new Paragraph({
            text: 'Текстовые аннотации страницы',
            heading: HeadingLevel.HEADING_3,
            spacing: { after: 100 },
          }),
          ...annotations,
        );
      }
    }

    const doc = new Document({
      creator: settings.metadata.creator || 'PDF Редактор',
      title,
      description: settings.metadata.subject,
      sections: [{ properties: {}, children }],
    });

    const blob = await Packer.toBlob(doc);
    return { ok: true, fileName, size: blob.size, blob, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      fileName,
      size: 0,
      blob: new Blob([], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      warnings,
      error: message,
    };
  }
}
