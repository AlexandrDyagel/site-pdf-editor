/**
 * ============================================================================
 *  Проверка ключевой логики без браузера.
 * ============================================================================
 *
 *  Запуск:  pnpm verify
 *
 *  Скрипт собирается esbuild'ом (алиас `@` → `src`) и выполняется в Node.
 *  Проверяются самые критичные вещи, ошибки в которых приводят к «съехавшим»
 *  аннотациям или к «кракозябрам»:
 *    - конвертация координат для всех поворотов страницы и смещённого MediaBox;
 *    - положение объектов при векторном экспорте в PDF (эмуляция матриц pdf-lib);
 *    - определение и декодирование кодировок (UTF-8, windows-1251, koi8-r);
 *    - перенос строк текста;
 *    - контуры рукописных штрихов и SVG-пути.
 */

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import fontsManifest from '../public/fonts/fonts.json';
import {
  getDisplaySize,
  getPdfObjectRotation,
  konvaToPdfCoordinates,
  localPointToPdf,
  normalizeObjectToPage,
  pdfToKonvaCoordinates,
  quarterTurns,
  remapObjectsForPageRotation,
  scaleObjectForExport,
  getTransformForPage,
  type PageGeometry,
} from '@/utils/coordinates';
import { decodeAuto, detectEncoding, encodeUtf8, buildCsv, sanitizeFileName } from '@/utils/encoding';
import { wrapText } from '@/utils/textLayout';
import { layerAccentColor, layerBaseName, layerLabels, layerName } from '@/utils/layers';
import { normalizeSides, polygonPath, polygonVertices } from '@/utils/shapePath';
import { getStrokeOutline, outlineToPath, strokesToSvg } from '@/services/strokeService';
import type { EditorObject, ShapeKind, StrokeData } from '@/types';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function close(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance;
}

/* ==========================================================================
 *  1. Конвертация координат
 * ========================================================================== */

console.log('\n1. Конвертация координат (Konva ↔ PDF)');

const geometries: PageGeometry[] = [
  { width: 595.28, height: 841.89, rotation: 0 },
  { width: 595.28, height: 841.89, rotation: 90 },
  { width: 595.28, height: 841.89, rotation: 180 },
  { width: 595.28, height: 841.89, rotation: 270 },
  { width: 612, height: 792, rotation: 90, originX: 20, originY: 15 },
];

for (const geometry of geometries) {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 250 },
    { x: 595.28, y: 841.89 },
  ];
  let ok = true;
  for (const point of points) {
    const pdf = konvaToPdfCoordinates(point.x, point.y, geometry);
    const back = pdfToKonvaCoordinates(pdf.x, pdf.y, geometry);
    if (!close(back.x, point.x, 1e-6) || !close(back.y, point.y, 1e-6)) ok = false;
  }
  check(
    `round-trip для rotation=${geometry.rotation}, origin=(${geometry.originX ?? 0}, ${geometry.originY ?? 0})`,
    ok,
  );

  // Углы страницы должны попадать в границы MediaBox.
  const corners = [
    { x: 0, y: 0 },
    { x: getDisplaySize(geometry.width, geometry.height, geometry.rotation).width, y: 0 },
    {
      x: getDisplaySize(geometry.width, geometry.height, geometry.rotation).width,
      y: getDisplaySize(geometry.width, geometry.height, geometry.rotation).height,
    },
    { x: 0, y: getDisplaySize(geometry.width, geometry.height, geometry.rotation).height },
  ];
  const inBox = corners.every((corner) => {
    const pdf = konvaToPdfCoordinates(corner.x, corner.y, geometry);
    return (
      close(pdf.x, geometry.originX ?? 0, 1e-6) ||
      close(pdf.x, (geometry.originX ?? 0) + geometry.width, 1e-6)
    ) && (
      close(pdf.y, geometry.originY ?? 0, 1e-6) ||
      close(pdf.y, (geometry.originY ?? 0) + geometry.height, 1e-6)
    );
  });
  check(`углы страницы внутри MediaBox (rotation=${geometry.rotation})`, inBox);
}

// Ожидаемые значения для контрольного примера (rotation 0, A4).
const a4: PageGeometry = { width: 595.28, height: 841.89, rotation: 0 };
const topLeft = konvaToPdfCoordinates(0, 0, a4);
check('A4: левый верхний угол → (0, 841.89)', close(topLeft.x, 0) && close(topLeft.y, 841.89));
const bottomRight = konvaToPdfCoordinates(595.28, 841.89, a4);
check('A4: правый нижний угол → (595.28, 0)', close(bottomRight.x, 595.28) && close(bottomRight.y, 0));

const rotated90 = getTransformForPage({ width: 595.28, height: 841.89, rotation: 90 });
check(
  'rotation=90: размеры меняются местами',
  close(rotated90.displayWidth, 841.89) && close(rotated90.displayHeight, 595.28),
);

check('поворот объекта: pageRotation − objectRotation', getPdfObjectRotation(a4, 30) === 330);
check('поворот объекта на странице 90°', getPdfObjectRotation({ ...a4, rotation: 90 }, 0) === 90);

/* ==========================================================================
 *  2. Положение объекта при векторном экспорте
 * ========================================================================== */

console.log('\n2. Векторный экспорт: положение объекта на странице PDF');

/**
 * Эмуляция того, что делает pdf-lib: `translate(x, y)`, затем `rotate(θ)`,
 * затем примитив строится в локальных координатах в диапазоне [0, w] × [0, h]
 * (для прямоугольника — от переданной точки вправо и вверх).
 */
function pdfLibRectCorners(
  position: { x: number; y: number },
  width: number,
  height: number,
  rotateDegrees: number,
): { x: number; y: number }[] {
  const radians = (rotateDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const local = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  return local.map((point) => ({
    x: position.x + point.x * cos - point.y * sin,
    y: position.y + point.x * sin + point.y * cos,
  }));
}

/** Ожидаемые углы объекта в системе редактора (поворот вокруг левого верхнего угла). */
function expectedDisplayCorners(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
): { x: number; y: number }[] {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((point) => ({
    x: x + point.x * cos - point.y * sin,
    y: y + point.x * sin + point.y * cos,
  }));
}

for (const geometry of geometries) {
  for (const objectRotation of [0, 25, 90]) {
    const object = {
      x: 120,
      y: 200,
      width: 140,
      height: 60,
      rotation: objectRotation,
      opacity: 1,
    };

    // Позиция, которую мы передаём в pdf-lib: левый нижний угол в локальной
    // системе (Y вверх) — localPointToPdf(0, height).
    const position = localPointToPdf(0, object.height, object, geometry);
    const rotate = getPdfObjectRotation(geometry, object.rotation);
    const pdfCorners = pdfLibRectCorners(position, object.width, object.height, rotate);

    const expected = expectedDisplayCorners(
      object.x,
      object.y,
      object.width,
      object.height,
      object.rotation,
    );

    // Сравниваем в системе редактора и допускаем перестановку обхода углов.
    const actualDisplay = pdfCorners.map((corner) =>
      pdfToKonvaCoordinates(corner.x, corner.y, geometry),
    );

    let matched = true;
    for (const corner of actualDisplay) {
      const found = expected.some(
        (item) => close(item.x, corner.x, 0.01) && close(item.y, corner.y, 0.01),
      );
      if (!found) matched = false;
    }

    check(
      `объект (rotation=${geometry.rotation}, obj=${objectRotation}) совпадает с предпросмотром`,
      matched,
      `actual=${actualDisplay.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(' ')}`,
    );
  }
}

/* ==========================================================================
 *  3. Кодировки
 * ========================================================================== */

console.log('\n3. Кодировки и «кракозябры»');

// «Привет» в windows-1251
const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
// «Привет» в koi8-r
const koi8 = new Uint8Array([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);

const utf8 = encodeUtf8('Привет, мир! Ёжик №5');
check('UTF-8 декодируется без потерь', decodeAuto(utf8).text === 'Привет, мир! Ёжик №5');
check('UTF-8 определяется', detectEncoding(utf8) === 'utf-8');
check('windows-1251 определяется', detectEncoding(cp1251) === 'windows-1251');
check('windows-1251 декодируется в «Привет»', decodeAuto(cp1251).text === 'Привет');
check('koi8-r определяется', detectEncoding(koi8) === 'koi8-r');
check('koi8-r декодируется в «Привет»', decodeAuto(koi8).text === 'Привет');

const csv = buildCsv([
  ['Файл', 'Автор'],
  ['Отчёт; с точкой с запятой', 'Иванов И. И.'],
]);
check('CSV содержит BOM UTF-8', csv.charCodeAt(0) === 0xfeff);
check('CSV экранирует разделитель', csv.includes('"Отчёт; с точкой с запятой"'));
check('имя файла очищается', sanitizeFileName('отчёт: 2025/01*?.pdf') === 'отчёт_ 2025_01__.pdf');

/* ==========================================================================
 *  4. Раскладка текста
 * ========================================================================== */

console.log('\n4. Раскладка текста');

const longText =
  'Съешь ещё этих мягких французских булок, да выпей чаю. Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.';
const lines = wrapText(longText, {
  fontFamily: 'PT Sans',
  fontSize: 12,
  bold: false,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.25,
}, 200);

check('текст разбит на несколько строк', lines.length > 3);
check(
  'переносы не теряют слова',
  lines.join(' ').replace(/\s+/g, ' ').trim() === longText.replace(/\s+/g, ' ').trim(),
);
check('явные переводы строк сохраняются', wrapText('первая\nвторая', {
  fontFamily: 'PT Sans',
  fontSize: 12,
  bold: false,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.25,
}, 300).length === 2);

/* ==========================================================================
 *  5. Штрихи от руки
 * ========================================================================== */

console.log('\n5. Рукописные штрихи');

const stroke: StrokeData = {
  tool: 'brush',
  color: '#111827',
  width: 3,
  opacity: 1,
  smooth: true,
  points: Array.from({ length: 40 }, (_, index) => ({
    x: index * 4,
    y: 40 + Math.sin(index / 3) * 12,
    pressure: 0.5,
  })),
};

const outline = getStrokeOutline(stroke);
check('контур штриха содержит точки', outline.length > 20);
const path = outlineToPath(outline, true);
check('SVG-путь начинается с M и закрывается Z', path.startsWith('M ') && path.trim().endsWith('Z'));
check('SVG-путь не содержит неподдерживаемых команд', !/[AaHhVvSsTtQq]/.test(path));
const svg = strokesToSvg([stroke], 200, 90);
check('SVG подписи объявляет UTF-8', svg.includes('encoding="UTF-8"'));
check('SVG подписи содержит путь', svg.includes('<path'));

/* ==========================================================================
 *  6. Нормализация и масштабирование объектов
 * ========================================================================== */console.log('\n6. Нормализация объектов');

const normalized = normalizeObjectToPage(
  { x: -50, y: -20, width: 100, height: 50, rotation: -370, opacity: 1.4 },
  a4,
  { clampToPage: true },
);
check('координаты не выходят за пределы страницы', normalized.x >= -100 && normalized.y >= -50);
check('поворот нормализован в 0..360', normalized.rotation === 350);
check('прозрачность ограничена единицей', normalized.opacity === 1);

const scaled = scaleObjectForExport(
  {
    x: 100,
    y: 100,
    width: 50,
    height: 20,
    rotation: 0,
    opacity: 1,
    payload: { fontSize: 12, strokeWidth: 2, padding: 2 },
  },
  2,
);
check('масштаб геометрии при экспорте', close(scaled.x, 200) && close(scaled.width, 100));
check('масштаб размеров в payload', (scaled.payload as { fontSize: number }).fontSize === 24);

/* ==========================================================================
 *  7. Поворот страницы: объекты остаются на своих местах
 * ========================================================================== */

console.log('\n7. Поворот страницы и перенос объектов');

const rotationCases = [
  { from: 0, delta: 90 },
  { from: 0, delta: 180 },
  { from: 0, delta: 270 },
  { from: 90, delta: 90 },
  { from: 90, delta: 180 },
  { from: 270, delta: 90 },
  { from: 180, delta: 270 },
];

for (const item of rotationCases) {
  const from: PageGeometry = { width: 595.28, height: 841.89, rotation: item.from };
  const to: PageGeometry = { ...from, rotation: (item.from + item.delta) % 360 };
  const object = {
    id: 'obj',
    x: 120,
    y: 200,
    width: 140,
    height: 60,
    rotation: 30,
    opacity: 1,
  };
  const [patch] = remapObjectsForPageRotation([object], from, to);
  const anchorBefore = konvaToPdfCoordinates(object.x, object.y, from);
  const anchorAfter = konvaToPdfCoordinates(patch.patch.x, patch.patch.y, to);
  const sameAnchor =
    close(anchorBefore.x, anchorAfter.x, 0.01) && close(anchorBefore.y, anchorAfter.y, 0.01);
  const pdfRotationBefore = getPdfObjectRotation(from, object.rotation);
  const pdfRotationAfter = getPdfObjectRotation(to, patch.patch.rotation);
  const sameOrientation =
    ((pdfRotationBefore - pdfRotationAfter) % 360 + 360) % 360 === 0;

  check(
    `поворот ${item.from}° → ${to.rotation}°: объект не смещается по странице`,
    sameAnchor,
    `точка привязки: (${anchorBefore.x.toFixed(1)}, ${anchorBefore.y.toFixed(1)}) → (${anchorAfter.x.toFixed(1)}, ${anchorAfter.y.toFixed(1)})`,
  );
  check(
    `поворот ${item.from}° → ${to.rotation}°: ориентация объекта сохраняется`,
    sameOrientation,
    `угол в PDF: ${pdfRotationBefore}° → ${pdfRotationAfter}°`,
  );
}

// Полный цикл из четырёх поворотов возвращает объект в исходное положение.
{
  let geometry: PageGeometry = { width: 595.28, height: 841.89, rotation: 0 };
  let object = { id: 'obj', x: 120, y: 200, width: 140, height: 60, rotation: 30, opacity: 1 };
  for (let i = 0; i < 4; i += 1) {
    const next: PageGeometry = { ...geometry, rotation: (geometry.rotation + 90) % 360 };
    const [patch] = remapObjectsForPageRotation([object], geometry, next);
    object = { ...object, ...patch.patch };
    geometry = next;
  }
  check(
    'четыре поворота по 90° возвращают объект в исходное положение',
    close(object.x, 120, 0.05) && close(object.y, 200, 0.05) && close(object.rotation, 30, 0.05),
    `получилось (${object.x}; ${object.y}) при ${object.rotation}°`,
  );
}

// Собственный поворот объекта складывается с поворотом страницы.
{
  const from: PageGeometry = { width: 595.28, height: 841.89, rotation: 90 };
  const to: PageGeometry = { ...from, rotation: 180 };
  const object = { id: 'obj', x: 300, y: 150, width: 80, height: 40, rotation: 45, opacity: 1 };
  const [patch] = remapObjectsForPageRotation([object], from, to);
  check(
    'собственный поворот объекта складывается с поворотом страницы',
    close((((patch.patch.rotation % 360) + 360) % 360), 135, 0.01),
    `стало ${patch.patch.rotation}°`,
  );
  check('угол поворота страницы округляется к 90°', quarterTurns(93) === 90 && quarterTurns(-90) === 270);
}

/* ==========================================================================
 *  8. Шрифты и запись кириллицы в PDF (pdf-lib + fontkit)
 * ========================================================================== */

console.log('\n8. Шрифты и запись кириллицы в PDF');

const publicFontsDir = resolvePath(process.cwd(), 'public', 'fonts');
const manifest = fontsManifest as {
  fonts: {
    id: string;
    name: string;
    supportsCyrillic: boolean;
    faces: Record<string, { url: string }>;
  }[];
};

check('манифест шрифтов содержит шрифты', manifest.fonts.length >= 5);

for (const asset of manifest.fonts) {
  const faceEntries = Object.entries(asset.faces);
  const missing = faceEntries.filter(
    (entry) => !existsSync(resolvePath(publicFontsDir, entry[1].url)),
  );
  check(
    `файлы шрифта «${asset.name}» на месте (${faceEntries.length} начертаний)`,
    missing.length === 0,
    missing.map((entry) => entry[1].url).join(', '),
  );
}

/** Проверка покрытия кириллицы через fontkit. */
const ptSansPath = resolvePath(publicFontsDir, 'PT_Sans-Web-Regular.ttf');
const ptSansBytes = new Uint8Array(await readFile(ptSansPath));
const ptSans = fontkit.create(ptSansBytes);
check(
  'PT Sans содержит русские буквы и «ё»',
  ['А', 'я', 'ё', 'Ё', 'Ж', '№'].every((char) =>
    ptSans.hasGlyphForCodePoint(char.codePointAt(0) ?? 0),
  ),
);

// Документ с кириллицей: шрифт обязательно встраивается.
const pdf = await PDFDocument.create();
pdf.registerFontkit(fontkit);
const embedded = await pdf.embedFont(ptSansBytes, { subset: true });
const page = pdf.addPage([595.28, 841.89]);
page.drawText('Проверка кириллицы: Ёжик, №5 — тест', {
  x: 50,
  y: 700,
  size: 12,
  font: embedded,
  color: rgb(0, 0, 0),
  rotate: degrees(0),
});
page.drawRectangle({ x: 50, y: 650, width: 100, height: 20, color: rgb(1, 0, 0) });
pdf.setTitle('Отчёт за январь');
pdf.setAuthor('Иванов И. И.');
pdf.setSubject('Проверка кодировки');
const bytes = await pdf.save();
check('PDF с кириллицей создаётся без ошибок', bytes.byteLength > 1000);
check(
  'ширина русского текста вычисляется встроенным шрифтом',
  embedded.widthOfTextAtSize('Привет', 12) > 20,
);

const reloaded = await PDFDocument.load(bytes);
check('метаданные сохраняются в Unicode', reloaded.getTitle() === 'Отчёт за январь');
check('страница сохраняется', reloaded.getPageCount() === 1);

// Стандартный шрифт без кириллицы обязан упасть — именно поэтому приложение
// всегда встраивает TTF.
let standardFontFailed = false;
try {
  const plain = await PDFDocument.create();
  const helvetica = await plain.embedFont(StandardFonts.Helvetica);
  plain.addPage([200, 200]).drawText('Привет', { x: 10, y: 100, size: 12, font: helvetica });
  await plain.save();
} catch {
  standardFontFailed = true;
}
check('стандартный Helvetica не кодирует кириллицу (ожидаемая ошибка)', standardFontFailed);

/* ==========================================================================
 *  9. Подписи слоёв: названия по инструменту, нумерация и цвет
 * ========================================================================== */

console.log('\n9. Подписи слоёв и цветовые индикаторы');

let objectSeq = 0;
function baseObject(zIndex: number) {
  objectSeq += 1;
  return {
    id: `obj-${objectSeq}`,
    page: 0,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}
function makeShape(
  kind: ShapeKind,
  fill: string | null,
  stroke: string,
  zIndex: number,
): EditorObject {
  return {
    ...baseObject(zIndex),
    type: 'shape',
    payload: {
      kind,
      stroke,
      strokeWidth: 1,
      fill,
      dash: [],
      cornerRadius: 0,
      arrowHead: 'none',
      points: [0, 0, 1, 1],
    },
  };
}
function makeWhiteout(color: string, zIndex: number): EditorObject {
  return { ...baseObject(zIndex), type: 'whiteout', payload: { color, solid: true } };
}

check('эллипс называется «Эллипс»', layerBaseName(makeShape('ellipse', null, '#000', 1)) === 'Эллипс');
check(
  'прямоугольник называется «Прямоугольник»',
  layerBaseName(makeShape('rect', null, '#000', 1)) === 'Прямоугольник',
);
check('линия называется «Линия»', layerBaseName(makeShape('line', null, '#000', 1)) === 'Линия');
check('стрелка называется «Стрелка»', layerBaseName(makeShape('arrow', null, '#000', 1)) === 'Стрелка');
check('закрашивание называется «Закрашивание»', layerBaseName(makeWhiteout('#ffffff', 1)) === 'Закрашивание');

const single = [makeShape('ellipse', '#ff0000', '#000000', 1)];
const singleLabels = layerLabels(single);
check('единственная фигура без номера', singleLabels.get(single[0].id) === 'Эллипс', singleLabels.get(single[0].id));

const pair = [
  makeShape('rect', '#ff0000', '#000000', 1),
  makeShape('rect', '#00ff00', '#000000', 2),
];
const pairLabels = layerLabels(pair);
check(
  'одинаковые фигуры нумеруются снизу вверх',
  pairLabels.get(pair[0].id) === 'Прямоугольник 1' && pairLabels.get(pair[1].id) === 'Прямоугольник 2',
  `${pairLabels.get(pair[0].id)} / ${pairLabels.get(pair[1].id)}`,
);

const mixed = [
  makeShape('rect', '#ff0000', '#000000', 1),
  makeShape('ellipse', '#0000ff', '#000000', 2),
  makeShape('rect', '#ff0000', '#000000', 3),
];
const mixedLabels = layerLabels(mixed);
check(
  'разные фигуры не смешиваются в нумерации',
  mixedLabels.get(mixed[0].id) === 'Прямоугольник 1' &&
    mixedLabels.get(mixed[1].id) === 'Эллипс' &&
    mixedLabels.get(mixed[2].id) === 'Прямоугольник 2',
  [...mixedLabels.values()].join(' / '),
);

check(
  'индикатор цвета берёт заливку фигуры',
  layerAccentColor(makeShape('rect', '#e11d48', '#000000', 1)) === '#e11d48',
);
check(
  'без заливки индикатор берёт обводку',
  layerAccentColor(makeShape('rect', null, '#16a34a', 1)) === '#16a34a',
);
check(
  'прозрачная заливка не попадает в индикатор',
  layerAccentColor(makeShape('ellipse', 'transparent', '#2563eb', 1)) === '#2563eb',
);
check('у закрашивания индикатор — его цвет', layerAccentColor(makeWhiteout('#ffffff', 1)) === '#ffffff');

// Переименование объекта (раздел «Служебное») должно попадать в подписи слоёв.
const renamedObject = makeShape('rect', '#ff0000', '#000000', 1);
check('без имени название — по инструменту', layerName(renamedObject) === 'Прямоугольник');
check(
  'пользовательское имя главнее названия инструмента',
  layerName({ ...renamedObject, name: '  Схема зала  ' }) === 'Схема зала',
  layerName({ ...renamedObject, name: '  Схема зала  ' }),
);
check(
  'пустое имя не ломает название',
  layerName({ ...renamedObject, name: '   ' }) === 'Прямоугольник',
);

const renamedPair = [
  { ...makeShape('rect', null, '#000', 1), name: 'Схема' },
  { ...makeShape('ellipse', null, '#000', 2), name: 'Схема' },
  makeShape('rect', null, '#000', 3),
];
const renamedLabels = layerLabels(renamedPair);
check(
  'одинаковые пользовательские имена нумеруются',
  renamedLabels.get(renamedPair[0].id) === 'Схема 1' &&
    renamedLabels.get(renamedPair[1].id) === 'Схема 2' &&
    renamedLabels.get(renamedPair[2].id) === 'Прямоугольник',
  [...renamedLabels.values()].join(' / '),
);

/* ==========================================================================
 *  10. Многоугольники и треугольники
 * ========================================================================== */

console.log('\n10. Путь многоугольника');

check('треугольник — три вершины', polygonVertices(100, 80, 3).length === 3);
check('шестиугольник — шесть вершин', polygonVertices(100, 80, 6).length === 6);
check('сторон не бывает меньше трёх', polygonVertices(100, 80, 1).length === 3);
check('слишком большое число сторон ограничено', normalizeSides(999) === 24);
check('число сторон округляется', normalizeSides(5.4) === 5);
check('по умолчанию пять сторон', normalizeSides(undefined) === 5);

const triangleVertices = polygonVertices(100, 100, 3);
check(
  'первая вершина треугольника — сверху по центру',
  Math.abs(triangleVertices[0].x - 50) < 0.01 && Math.abs(triangleVertices[0].y) < 0.01,
  JSON.stringify(triangleVertices[0]),
);
check(
  'вершины не выходят за рамку',
  polygonVertices(100, 60, 7).every(
    (point) => point.x >= -0.01 && point.x <= 100.01 && point.y >= -0.01 && point.y <= 60.01,
  ),
);

const plainPolygon = polygonPath(100, 80, 6, 0);
check('путь без скругления начинается с M', plainPolygon.startsWith('M '));
check('путь без скругления замыкается', plainPolygon.trim().endsWith('Z'));
check('без скругления нет кривых', !plainPolygon.includes('Q'), plainPolygon);
check(
  'у шестиугольника без скругления пять отрезков',
  (plainPolygon.match(/ L /g) ?? []).length === 5,
  String((plainPolygon.match(/ L /g) ?? []).length),
);

const roundedPolygon = polygonPath(100, 80, 6, 10);
check(
  'скругление добавляет по кривой на угол',
  (roundedPolygon.match(/ Q /g) ?? []).length === 6,
  String((roundedPolygon.match(/ Q /g) ?? []).length),
);
check(
  'скругление треугольника тоже работает',
  (polygonPath(100, 80, 3, 8).match(/ Q /g) ?? []).length === 3,
);

const flippedPolygon = polygonPath(100, 80, 3, 0, true);
const uprightPolygon = polygonPath(100, 80, 3, 0, false);
check(
  'flipY переворачивает путь для системы PDF',
  flippedPolygon !== uprightPolygon && flippedPolygon.includes('80'),
  flippedPolygon,
);
check(
  'flipY сохраняет форму (те же расстояния по X)',
  polygonVertices(100, 80, 3, true).every(
    (point, index) => Math.abs(point.x - polygonVertices(100, 80, 3)[index].x) < 0.01,
  ),
);
check(
  'без скругления путь состоит из чисел и команд',
  /^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+)* Z$/.test(plainPolygon),
  plainPolygon,
);

/* ==========================================================================
 *  Итог
 * ========================================================================== */

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
