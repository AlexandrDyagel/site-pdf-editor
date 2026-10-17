/**
 * Создаёт PDF, в котором одна и та же русская строка нарисована каждым
 * встроенным шрифтом (подмножествами). Используется для проверки того,
 * что подстановка шрифтов в PDF не ломает кириллицу.
 *
 * Запуск: node scripts/make-font-test-pdf.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const FONTS = [
  { file: 'PT_Sans-Web-Regular.ttf', label: 'PT Sans' },
  { file: 'PT_Mono-Regular.ttf', label: 'PT Mono' },
  { file: 'DejaVuSans.ttf', label: 'DejaVu Sans' },
  { file: 'NotoSans-Regular.ttf', label: 'Noto Sans' },
  { file: 'Roboto-Regular.ttf', label: 'Roboto' },
  { file: 'Inter-Regular.ttf', label: 'Inter' },
];

const TEXT = 'Проверка кириллицы: Ёжик, №5 — тест';
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const page = doc.addPage([595.28, 841.89]);

let y = 780;
for (const item of FONTS) {
  const bytes = new Uint8Array(await readFile(resolvePath('public/fonts', item.file)));
  const embedded = await doc.embedFont(bytes, { subset: true });
  page.drawText(item.label, {
    x: 40,
    y,
    size: 10,
    font: embedded,
    color: rgb(0.4, 0.4, 0.45),
  });
  page.drawText(TEXT, { x: 40, y: y - 22, size: 16, font: embedded, color: rgb(0, 0, 0) });
  const width = embedded.widthOfTextAtSize(TEXT, 16);
  console.log(`${item.label.padEnd(12)} ширина строки: ${width.toFixed(1)} pt`);
  y -= 80;
}

doc.setTitle('Проверка шрифтов');
await mkdir(resolvePath('.tmp'), { recursive: true });
const out = resolvePath('.tmp/font-test.pdf');
await writeFile(out, await doc.save());
console.log(`Готово: ${out}`);
