/**
 * Проба: безопасно ли встраивать указанные шрифты подмножеством (subset: true).
 *
 * Строит два PDF (subset и full), открывает их в headless-браузере через pdf.js
 * и сравнивает количество тёмных пикселей в полосах текста. Сильное расхождение
 * означает повреждённые глифы.
 *
 * Запуск: node scripts/probe-subset.mjs [пути к ttf...]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const PROBE = 'Проверка кириллицы: Ёжик, №5 — тест Times New Roman';
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LINE_HEIGHT = 34;
const TOP = 800;

const args = process.argv.slice(2);
const fonts =
  args.length > 0
    ? args.map((path) => ({ label: path.split(/[\\/]/).pop(), path: resolvePath(path) }))
    : [
        { label: 'times.ttf', path: 'C:\\Windows\\Fonts\\times.ttf' },
        { label: 'timesbd.ttf', path: 'C:\\Windows\\Fonts\\timesbd.ttf' },
        { label: 'timesi.ttf', path: 'C:\\Windows\\Fonts\\timesi.ttf' },
        { label: 'timesbi.ttf', path: 'C:\\Windows\\Fonts\\timesbi.ttf' },
      ];

await mkdir(resolvePath('.tmp'), { recursive: true });

async function buildPdf(subset) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const positions = [];
  let y = TOP;
  for (const [index, item] of fonts.entries()) {
    const bytes = new Uint8Array(await readFile(item.path));
    const embedded = await doc.embedFont(bytes, { subset });
    page.drawText(`${index}: ${PROBE}`, { x: 40, y, size: 17, font: embedded, color: rgb(0, 0, 0) });
    positions.push({ index, y, label: item.label });
    y -= LINE_HEIGHT;
  }
  return { bytes: await doc.save(), positions };
}

async function measure(pdfBytes, positions, tag, port) {
  const base64 = Buffer.from(pdfBytes).toString('base64');
  const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port });
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
    await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToPage(); 'ok'`);
    await sleep(3000);
    const result = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const canvas = document.querySelectorAll('canvas')[0];
      const ctx = canvas.getContext('2d');
      const out = [];
      for (const item of ${JSON.stringify(positions)}) {
        const displayY = ${PAGE_HEIGHT} - item.y;
        const topPx = app.editor.pan.y + (displayY - 20) * app.editor.zoom;
        const bottomPx = app.editor.pan.y + (displayY + 4) * app.editor.zoom;
        const leftPx = app.editor.pan.x + 38 * app.editor.zoom;
        const widthPx = Math.round(470 * app.editor.zoom);
        const heightPx = Math.max(1, Math.round(bottomPx - topPx));
        const data = ctx.getImageData(Math.max(0, Math.round(leftPx)), Math.max(0, Math.round(topPx)), widthPx, heightPx).data;
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) dark += 1;
        }
        out.push({ index: item.index, dark });
      }
      return out;
    })()`);
    await cdp.screenshot(resolvePath('.tmp', `probe-subset-${tag}.png`));
    return result;
  } finally {
    close();
  }
}

const subsetPdf = await buildPdf(true);
const fullPdf = await buildPdf(false);
console.log(`Шрифтов: ${fonts.length}`);
console.log(
  `Размер: subset ${(subsetPdf.bytes.length / 1024).toFixed(0)} КБ, полное встраивание ${(fullPdf.bytes.length / 1024).toFixed(0)} КБ`,
);

const subsetMeasured = await measure(subsetPdf.bytes, subsetPdf.positions, 'subset', 9350);
const fullMeasured = await measure(fullPdf.bytes, fullPdf.positions, 'full', 9351);

const byIndex = (list) => new Map(list.map((item) => [item.index, item.dark]));
const subsetMap = byIndex(subsetMeasured);
const fullMap = byIndex(fullMeasured);

console.log('\nШрифт                          subset   полный   вывод');
const broken = [];
for (const [index, item] of fonts.entries()) {
  const a = subsetMap.get(index) ?? 0;
  const b = fullMap.get(index) ?? 0;
  const ratio = b > 0 ? a / b : 1;
  const ok = ratio > 0.75;
  if (!ok) broken.push(item.label);
  console.log(
    `${String(item.label).padEnd(30)} ${String(a).padStart(6)} ${String(b).padStart(8)}   ${ok ? 'ok' : 'СЛОМАНО'}`,
  );
}
console.log(`\nПроблемные: ${broken.join(', ') || 'нет'}`);
void writeFile;
