/**
 * Автоматическая проверка подмножеств (subset) для каждого начертания
 * встроенных шрифтов.
 *
 * Что делает:
 *  1. строит два PDF — со встраиванием подмножествами и с полным встраиванием,
 *     в каждом по строке на каждое начертание (начертания раскладываются по
 *     страницам, чтобы проверялись все, а не только первые 14);
 *  2. открывает оба PDF в headless-браузере (pdf.js) и считает количество
 *     тёмных пикселей в полосе каждой строки на каждой странице;
 *  3. сравнивает результаты: сильное расхождение означает, что подмножество
 *     повреждено и шрифт нельзя встраивать с subset: true.
 *
 * Запуск: node scripts/check-font-subsets.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const manifest = JSON.parse(await readFile(resolvePath('public/fonts/fonts.json'), 'utf8'));
const PROBE = 'Проверка кириллицы: Ёжик, №5 — тест';
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LINE_HEIGHT = 34;
const TOP = 800;
/** Сколько строк помещается на страницу (с запасом). */
const PER_PAGE = Math.floor((TOP - 60) / LINE_HEIGHT);

/** Список начертаний: [семейство, ключ, файл]. */
const faces = [];
for (const asset of manifest.fonts) {
  for (const [key, face] of Object.entries(asset.faces)) {
    faces.push({ id: asset.id, name: asset.name, key, file: face.url });
  }
}

await mkdir(resolvePath('.tmp'), { recursive: true });

/** Строит PDF со строками-образцами (начертания — по страницам). */
async function buildPdf(subset) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const pages = [];
  const positions = [];

  const pageFor = (index) => {
    const pageIndex = Math.floor(index / PER_PAGE);
    if (!pages[pageIndex]) pages[pageIndex] = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    return pageIndex;
  };

  for (const [index, face] of faces.entries()) {
    const pageIndex = pageFor(index);
    const row = index % PER_PAGE;
    const y = TOP - row * LINE_HEIGHT;
    const bytes = new Uint8Array(await readFile(resolvePath('public/fonts', face.file)));
    const embedded = await doc.embedFont(bytes, { subset });
    pages[pageIndex].drawText(`${index}: ${PROBE}`, {
      x: 40,
      y,
      size: 17,
      font: embedded,
      color: rgb(0, 0, 0),
    });
    positions.push({ index, page: pageIndex, y, label: `${face.name} ${face.key}` });
  }
  return { bytes: await doc.save(), positions, pageCount: pages.length };
}

/** Измеряет тёмные пиксели в полосе каждой строки через браузер. */
async function measure(pdfBytes, positions, pageCount, tag) {
  const base64 = Buffer.from(pdfBytes).toString('base64');
  const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9337 + (tag === 'full' ? 1 : 0) });
  try {
    await cdp.evaluate(`(() => {
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], '${tag}.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
    await sleep(6000);

    const out = [];
    for (let page = 0; page < pageCount; page += 1) {
      await cdp.evaluate(`(() => {
        const app = window.__PDF_EDITOR__;
        app.editor.setCurrentPage(${page});
        app.editor.fitToPage();
        return 'ok';
      })()`);
      await sleep(2500);
      const rows = await cdp.evaluate(`(() => {
        const app = window.__PDF_EDITOR__;
        const canvas = document.querySelectorAll('canvas')[0];
        const ctx = canvas.getContext('2d');
        const positions = ${JSON.stringify(positions.filter((item) => item.page === page))};
        const pageHeight = ${PAGE_HEIGHT};
        const result = [];
        for (const item of positions) {
          // PDF-координата (снизу) → экранная (сверху) → пиксели canvas.
          const displayY = pageHeight - item.y;
          const topPx = app.editor.pan.y + (displayY - 20) * app.editor.zoom;
          const bottomPx = app.editor.pan.y + (displayY + 4) * app.editor.zoom;
          const leftPx = app.editor.pan.x + 38 * app.editor.zoom;
          const widthPx = Math.round(420 * app.editor.zoom);
          const heightPx = Math.max(1, Math.round(bottomPx - topPx));
          const data = ctx.getImageData(
            Math.max(0, Math.round(leftPx)),
            Math.max(0, Math.round(topPx)),
            widthPx,
            heightPx,
          ).data;
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) dark += 1;
          }
          result.push({ index: item.index, dark });
        }
        return result;
      })()`);
      out.push(...rows);
    }
    await cdp.screenshot(resolvePath('.tmp', `font-subset-${tag}.png`));
    return out;
  } finally {
    close();
  }
}

const subsetPdf = await buildPdf(true);
const fullPdf = await buildPdf(false);
console.log(`Начертаний: ${faces.length}, страниц в проверочном PDF: ${subsetPdf.pageCount}`);
console.log(
  `Размер с подмножествами: ${(subsetPdf.bytes.length / 1024).toFixed(0)} КБ, без: ${(fullPdf.bytes.length / 1024).toFixed(0)} КБ`,
);

const subsetMeasured = await measure(subsetPdf.bytes, subsetPdf.positions, subsetPdf.pageCount, 'subset');
const fullMeasured = await measure(fullPdf.bytes, fullPdf.positions, fullPdf.pageCount, 'full');

const byIndex = (list) => new Map(list.map((item) => [item.index, item.dark]));
const subsetMap = byIndex(subsetMeasured);
const fullMap = byIndex(fullMeasured);

console.log('\nНачертание                     subset   полный   вывод');
const broken = [];
for (const face of faces) {
  const index = faces.indexOf(face);
  const a = subsetMap.get(index) ?? 0;
  const b = fullMap.get(index) ?? 0;
  const ratio = b > 0 ? a / b : 1;
  const ok = ratio > 0.75;
  if (!ok) broken.push(`${face.id}:${face.key}`);
  console.log(
    `${(face.name + ' ' + face.key).padEnd(30)} ${String(a).padStart(6)} ${String(b).padStart(8)}   ${ok ? 'ok' : 'СЛОМАНО'}`,
  );
}

console.log(`\nПроблемные начертания (${broken.length}): ${broken.join(', ') || 'нет'}`);
console.log('Скриншоты: .tmp/font-subset-subset.png и .tmp/font-subset-full.png');
