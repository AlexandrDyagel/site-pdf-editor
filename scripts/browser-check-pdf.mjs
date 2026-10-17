/**
 * Открывает указанный PDF в редакторе (headless-браузер), делает скриншот
 * и измеряет заполнение строк пикселями — так видно, какие шрифты
 * отрисовались полностью, а какие потеряли глифы.
 *
 * Запуск: node scripts/browser-check-pdf.mjs <файл.pdf> [имя-скриншота]
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const file = resolvePath(process.argv[2] ?? '.tmp/font-test.pdf');
const shot = process.argv[3] ?? 'font-test.png';
const base64 = (await readFile(file)).toString('base64');

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9336 });

try {
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'проверка.pdf', { type: 'application/pdf' });
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
  await sleep(2500);

  // Считаем «черноту» по горизонтальным полосам — где строки текста.
  const bands = await cdp.evaluate(`(() => {
    const canvas = document.querySelectorAll('canvas')[0];
    const ctx = canvas.getContext('2d');
    const app = window.__PDF_EDITOR__;
    const toCanvas = (px, py) => ({
      x: Math.round(app.editor.pan.x + px * app.editor.zoom),
      y: Math.round(app.editor.pan.y + py * app.editor.zoom),
    });
    const result = [];
    // Строки рисовались с шагом 80 pt начиная с y=780-22.
    const labels = ['PT Sans','PT Mono','DejaVu Sans','Noto Sans','Roboto','Inter'];
    for (let i = 0; i < labels.length; i += 1) {
      const top = toCanvas(40, 780 - i * 80 + 4);
      const bottom = toCanvas(40, 780 - i * 80 - 18);
      const width = Math.round(320 * app.editor.zoom);
      const height = Math.max(1, top.y - bottom.y);
      const data = ctx.getImageData(Math.max(0, top.x), Math.max(0, bottom.y), width, height).data;
      let dark = 0;
      let columns = 0;
      let lastColumnDark = false;
      for (let p = 0; p < width; p += 2) {
        let columnDark = false;
        for (let q = 0; q < height; q += 1) {
          const index = ((q * width) + Math.min(p, width - 1)) * 4;
          if (data[index] < 120) { dark += 1; columnDark = true; }
        }
        if (columnDark) { columns += 1; lastColumnDark = true; }
        void lastColumnDark;
      }
      result.push({ font: labels[i], darkPixels: dark, darkColumns: columns * 2 });
    }
    return result;
  })()`);

  console.log('Заполнение строк (по шрифтам):');
  for (const band of bands) console.log(`  ${band.font.padEnd(12)} тёмных пикселей: ${String(band.darkPixels).padStart(6)}, колонок с текстом: ${band.darkColumns}`);
  console.log('Скриншот:', await cdp.screenshot(resolvePath('.tmp', shot)));
} catch (error) {
  console.error('Ошибка:', error);
} finally {
  close();
}
