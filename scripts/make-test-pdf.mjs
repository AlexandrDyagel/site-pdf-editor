/**
 * Генерирует тестовый PDF для отладки в браузере:
 * 3 страницы (портрет, поворот /Rotate 90, A5), кириллица встроенным TTF,
 * реальный текстовый слой (виден pdf.js), фигуры и метаданные.
 *
 * Запуск: node scripts/make-test-pdf.mjs [выходной файл]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const outFile = resolvePath(process.argv[2] ?? '.tmp/test.pdf');
const fontPath = resolvePath('public/fonts/PT_Sans-Web-Regular.ttf');
const boldPath = resolvePath('public/fonts/PT_Sans-Web-Bold.ttf');

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const regular = await doc.embedFont(new Uint8Array(await readFile(fontPath)), { subset: true });
const bold = await doc.embedFont(new Uint8Array(await readFile(boldPath)), { subset: true });

// Страница 1: A4, кириллица, фигуры.
const page1 = doc.addPage([595.28, 841.89]);
page1.drawText('Тестовый документ «Кириллица»', {
  x: 50,
  y: 780,
  size: 20,
  font: bold,
  color: rgb(0.1, 0.1, 0.3),
});
const lines = [
  'Съешь ещё этих мягких французских булок, да выпей чаю.',
  'Широкая электрификация южных губерний даст мощный толчок',
  'подъёму сельского хозяйства. Ёжик, Ёлка, №12, 100 % — тест.',
  '',
  'Вторая строка текстового слоя для проверки замены текста.',
];
lines.forEach((line, index) => {
  page1.drawText(line, {
    x: 50,
    y: 740 - index * 22,
    size: 12,
    font: regular,
    color: rgb(0.1, 0.1, 0.1),
  });
});
page1.drawRectangle({
  x: 50,
  y: 520,
  width: 200,
  height: 90,
  borderColor: rgb(0.8, 0.1, 0.1),
  borderWidth: 2,
});
page1.drawText('Прямоугольник в исходном PDF', {
  x: 60,
  y: 590,
  size: 10,
  font: regular,
  color: rgb(0.8, 0.1, 0.1),
});

// Страница 2: ландшафт с поворотом страницы 90.
const page2 = doc.addPage([841.89, 595.28]);
page2.setRotation(degrees(90));
page2.drawText('Страница с поворотом /Rotate 90', {
  x: 60,
  y: 520,
  size: 16,
  font: bold,
  color: rgb(0.1, 0.3, 0.1),
});
page2.drawText('Проверка координат объектов на повёрнутой странице.', {
  x: 60,
  y: 490,
  size: 11,
  font: regular,
  color: rgb(0.2, 0.2, 0.2),
});

// Страница 3: A5.
const page3 = doc.addPage([419.53, 595.28]);
page3.drawText('Страница A5', { x: 40, y: 540, size: 16, font: bold });
page3.drawText('Короткая страница для проверки масштаба.', {
  x: 40,
  y: 510,
  size: 11,
  font: regular,
});

// Стандартный шрифт для английского текста (проверка стандартных шрифтов pdf.js).
const helvetica = await doc.embedFont(StandardFonts.Helvetica);
page1.drawText('Latin text with standard font', {
  x: 50,
  y: 480,
  size: 11,
  font: helvetica,
  color: rgb(0.3, 0.3, 0.6),
});

doc.setTitle('Тестовый документ');
doc.setAuthor('Проверка PDF Редактора');
doc.setSubject('Кириллица, поворот страницы, несколько размеров');
doc.setKeywords(['тест', 'кириллица', 'pdf']);

const bytes = await doc.save({ useObjectStreams: true });
await mkdir(resolvePath('.tmp'), { recursive: true });
await writeFile(outFile, bytes);
console.log(`Готово: ${outFile} (${(bytes.byteLength / 1024).toFixed(1)} КБ, страниц: 3)`);
