/**
 * Проверка курсора-кружка (корректор, кисть, маркер) и вставки изображений.
 *
 *   1. У корректора вместо крестика — кружок по размеру кисти;
 *   2. при изменении размера кисти кружок меняется;
 *   3. для остальных инструментов остаётся крестик, кружок скрывается;
 *   4. добавленная картинка действительно рисуется (а не только рамкой);
 *   5. картинка попадает в сохранённый PDF.
 *
 * Запуск: node scripts/check-canvas-tools.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9362 });

/**
 * Сколько раз в потоке первой страницы PDF цвет обводки задаётся указанным
 * цветом. Надёжнее пиксельного замера: проверяет сам файл, а не его отрисовку.
 */
async function countStrokeColorSets(pdfBytes, hex) {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const streams = [];
  const walk = (ref) => {
    const value = ref && ref.constructor?.name === 'PDFRef' ? doc.context.lookup(ref) : ref;
    if (value instanceof PDFRawStream) {
      try {
        streams.push(zlib.inflateSync(Buffer.from(value.contents)).toString('latin1'));
      } catch {
        streams.push(Buffer.from(value.contents).toString('latin1'));
      }
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i += 1) walk(value.get(i));
    }
  };
  walk(page.node.get(PDFName.of('Contents')));

  const toHex = (parts) =>
    `#${parts
      .map((part) => Math.round(Number(part) * 255).toString(16).padStart(2, '0'))
      .join('')}`;

  const text = streams.join('\n');
  const strokeColors = [...text.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+RG/g)].map((match) =>
    toHex([match[1], match[2], match[3]]),
  );
  return strokeColors.filter((color) => color === hex.toLowerCase()).length;
}

async function openDocument(data = base64, name = 'тест.pdf') {
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(data)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(5000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);
}

/** Наведение указателя в центр рабочей области. */
async function hoverCanvas() {
  const point = await cdp.evaluate(`(() => {
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(320);
  return point;
}

/** Состояние курсора-кружка. */
async function cursorState() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const wrapper = document.querySelector('[data-testid=editor-canvas]');
    const ring = document.querySelector('[data-testid=brush-cursor]');
    const rect = ring ? ring.getBoundingClientRect() : null;
    return {
      tool: app.editor.tool,
      zoom: Number(app.editor.zoom.toFixed(3)),
      cursor: getComputedStyle(wrapper).cursor,
      ring: rect
        ? {
            width: Number(rect.width.toFixed(1)),
            height: Number(rect.height.toFixed(1)),
            radius: getComputedStyle(ring).borderRadius,
          }
        : null,
    };
  })()`);
}

try {
  await openDocument();
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
  await sleep(500);

  console.log('\n1. Корректор: кружок вместо крестика');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('eraser');
    app.editor.toolOptions.eraser.width = 16;
    return 'ok';
  })()`);
  await hoverCanvas();
  const eraser16 = await cursorState();
  console.log('  курсор:', JSON.stringify(eraser16));
  check('системный курсор скрыт (не крестик)', eraser16.cursor === 'none', eraser16.cursor);
  check('кружок отрисован', eraser16.ring !== null);
  check('кружок круглый', eraser16.ring?.radius?.includes('50%') || eraser16.ring?.radius === '9999px', String(eraser16.ring?.radius));
  check(
    'размер кружка соответствует кисти 16 pt',
    Math.abs((eraser16.ring?.width ?? 0) - 16 * eraser16.zoom) <= 1.5,
    `кружок ${eraser16.ring?.width} px, ожидалось ${(16 * eraser16.zoom).toFixed(1)} px`,
  );
  await cdp.screenshot(resolvePath(TMP, 'cursor-eraser.png'));

  console.log('\n2. Изменение размера кисти меняет кружок');
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.toolOptions.eraser.width = 48; 'ok'`);
  await sleep(320);
  const eraser48 = await cursorState();
  check(
    'кружок вырос вместе с кистью (48 pt)',
    Math.abs((eraser48.ring?.width ?? 0) - 48 * eraser48.zoom) <= 1.5,
    `кружок ${eraser48.ring?.width} px, ожидалось ${(48 * eraser48.zoom).toFixed(1)} px`,
  );
  await cdp.screenshot(resolvePath(TMP, 'cursor-eraser-48.png'));

  await cdp.evaluate(`window.__PDF_EDITOR__.editor.toolOptions.eraser.width = 6; 'ok'`);
  await sleep(320);
  const eraser6 = await cursorState();
  check(
    'кружок уменьшился вместе с кистью (6 pt)',
    Math.abs((eraser6.ring?.width ?? 0) - 6 * eraser6.zoom) <= 1.5,
    `кружок ${eraser6.ring?.width} px, ожидалось ${(6 * eraser6.zoom).toFixed(1)} px`,
  );

  console.log('\n3. Кисть и маркер тоже с кружком');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.toolOptions.draw.width = 12;
    app.editor.setTool('brush');
    return 'ok';
  })()`);
  await sleep(320);
  const brush = await cursorState();
  check('у кисти кружок по размеру 12 pt', Math.abs((brush.ring?.width ?? 0) - 12 * brush.zoom) <= 1.5, `кружок ${brush.ring?.width} px`);

  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.toolOptions.marker.width = 20;
    app.editor.setTool('marker');
    return 'ok';
  })()`);
  await sleep(320);
  const marker = await cursorState();
  check('у маркера кружок по размеру 20 pt', Math.abs((marker.ring?.width ?? 0) - 20 * marker.zoom) <= 1.5, `кружок ${marker.ring?.width} px`);

  console.log('\n4. Другие инструменты: кружка нет, курсор крестик');
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('rect'); 'ok'`);
  await sleep(320);
  const rectTool = await cursorState();
  console.log('  курсор:', JSON.stringify(rectTool));
  check('у прямоугольника кружка нет', rectTool.ring === null);
  check('у прямоугольника курсор-крестик', rectTool.cursor === 'crosshair', rectTool.cursor);

  console.log('\n5. Кружок скрывается при уходе указателя');
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('eraser'); 'ok'`);
  await hoverCanvas();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(320);
  const left = await cursorState();
  check('вне рабочей области кружок скрыт', left.ring === null, JSON.stringify(left.ring));

  console.log('\n6. Добавление изображения');
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('select');
    app.objects.clearAll(false);
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(0, 0, 160, 100);
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.arc(80, 50, 34, 0, Math.PI * 2);
    ctx.fill();
    const src = canvas.toDataURL('image/png');
    const factory = await import('/src/services/objectFactory.ts');
    const object = factory.createImageObject({
      page: 0, x: 120, y: 300, width: 160, height: 100,
      src, mimeType: 'image/png', naturalWidth: 160, naturalHeight: 100, alt: 'тест.png',
    });
    app.objects.add([object], 'тест');
    app.objects.select([]);
    return { id: object.id, x: object.x, y: object.y, width: object.width, height: object.height };
  })()`);
  await sleep(1500);

  const painted = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const stage = window.__PDF_EDITOR_STAGE__;
    const node = stage.findOne((candidate) => candidate.getAttr && candidate.getAttr('objectId') === ${JSON.stringify(created.id)});
    const imageNode = node ? node.findOne('Image') : null;
    const ctx = document.querySelectorAll('canvas')[1].getContext('2d');
    const toCanvas = (x, y) => ({
      x: Math.round(app.editor.pan.x + x * app.editor.zoom),
      y: Math.round(app.editor.pan.y + y * app.editor.zoom),
    });
    const a = toCanvas(${created.x}, ${created.y});
    const b = toCanvas(${created.x + created.width}, ${created.y + created.height});
    const width = Math.max(1, b.x - a.x);
    const height = Math.max(1, b.y - a.y);
    const data = ctx.getImageData(a.x, a.y, width, height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i + 1] < 110 && data[i + 2] < 120 && data[i + 3] > 20) red += 1;
    }
    return {
      hasBitmap: Boolean(imageNode && imageNode.image()),
      bitmapSize: imageNode && imageNode.image() ? [imageNode.image().naturalWidth, imageNode.image().naturalHeight] : null,
      red,
      area: width * height,
    };
  })()`);
  console.log('  изображение:', JSON.stringify(painted));
  check('у узла есть битмап изображения', painted.hasBitmap === true, JSON.stringify(painted));
  check('изображение нарисовано на холсте', painted.red > painted.area * 0.5, `красных пикселей: ${painted.red} из ${painted.area}`);
  await cdp.screenshot(resolvePath(TMP, 'image-inserted.png'));

  console.log('\n7. Изображение попадает в сохранённый PDF');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary), size: result.size };
  })()`);
  check('экспорт PDF выполнен', exported.ok === true, exported.error ?? '');
  if (!exported.ok) throw new Error(exported.error);
  await writeFile(resolvePath(TMP, 'image-exported.pdf'), Buffer.from(exported.b64, 'base64'));

  await cdp.send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  await openDocument(exported.b64, 'изображение.pdf');
  const inPdf = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const ctx = document.querySelectorAll('canvas')[0].getContext('2d');
    const toCanvas = (x, y) => ({
      x: Math.round(app.editor.pan.x + x * app.editor.zoom),
      y: Math.round(app.editor.pan.y + y * app.editor.zoom),
    });
    const a = toCanvas(${created.x}, ${created.y});
    const b = toCanvas(${created.x + created.width}, ${created.y + created.height});
    const width = Math.max(1, b.x - a.x);
    const height = Math.max(1, b.y - a.y);
    const data = ctx.getImageData(a.x, a.y, width, height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i + 1] < 110 && data[i + 2] < 120) red += 1;
    }
    return { red, area: width * height };
  })()`);
  console.log('  в готовом PDF:', JSON.stringify(inPdf));
  check('изображение есть в готовом PDF', inPdf.red > inPdf.area * 0.5, `красных пикселей: ${inPdf.red} из ${inPdf.area}`);

  console.log('\n8. Фигуры: «Без цвета» и нулевая толщина обводки');

  /** Красные пиксели в прямоугольной области страницы (по умолчанию слой объектов). */
  async function redInRegion(region, layer = 1) {
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const ctx = document.querySelectorAll('canvas')[${layer}].getContext('2d');
      const toCanvas = (x, y) => ({
        x: Math.round(app.editor.pan.x + x * app.editor.zoom),
        y: Math.round(app.editor.pan.y + y * app.editor.zoom),
      });
      const a = toCanvas(${region.x}, ${region.y});
      const b = toCanvas(${region.x + region.width}, ${region.y + region.height});
      const width = Math.max(1, b.x - a.x);
      const height = Math.max(1, b.y - a.y);
      const data = ctx.getImageData(a.x, a.y, width, height).data;
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 140 && data[i + 1] < 110 && data[i + 2] < 120 && data[i + 3] > 20) red += 1;
      }
      return red;
    })()`);
  }

  // Области выбраны правее исходного красного прямоугольника тестового PDF
  // (он занимает x 50..250), иначе он попадал бы в подсчёт «красных» пикселей.
  const REGIONS = {
    rect: { x: 300, y: 80, width: 160, height: 80 },
    ellipse: { x: 300, y: 170, width: 160, height: 80 },
    line: { x: 300, y: 260, width: 160, height: 80 },
    arrow: { x: 300, y: 350, width: 160, height: 80 },
  };

  // Базовая линия: в этих областях чистого PDF красного быть не должно.
  const baseline = {};
  for (const [key, region] of Object.entries(REGIONS)) {
    baseline[key] = await redInRegion(region);
  }
  console.log('  красных пикселей в исходном PDF:', JSON.stringify(baseline));
  check(
    'области проверки свободны от красного в исходном PDF',
    Object.values(baseline).every((count) => count === 0),
    JSON.stringify(baseline),
  );

  const shapes = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const make = (kind, x, y) => factory.createShapeObject(kind, {
      page: 0, x, y, width: 160, height: 80, name: 'Фигура',
      defaults: { stroke: '#dc2626', strokeWidth: 3, fill: null },
    });
    const rect = make('rect', 300, 80);
    const ellipse = make('ellipse', 300, 170);
    const line = make('line', 300, 260);
    const arrow = make('arrow', 300, 350);
    app.objects.add([rect, ellipse, line, arrow], 'тест');
    app.objects.select([]);
    return { rect: rect.id, ellipse: ellipse.id, line: line.id, arrow: arrow.id };
  })()`);
  await sleep(1200);

  const withStroke = {};
  for (const [key, region] of Object.entries(REGIONS)) {
    withStroke[key] = await redInRegion(region);
  }
  console.log('  обводка 3 pt:', JSON.stringify(withStroke));
  check(
    'у всех фигур видна обводка 3 pt',
    Object.values(withStroke).every((count) => count > 20),
    JSON.stringify(withStroke),
  );

  // Толщина 0 — обводки быть не должно ни у одной фигуры.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    for (const object of app.objects.objects) app.objects.patchSilent(object.id, { payload: { strokeWidth: 0 } });
    return 'ok';
  })()`);
  await sleep(1200);
  const zeroWidth = {};
  for (const [key, region] of Object.entries(REGIONS)) {
    zeroWidth[key] = await redInRegion(region);
  }
  console.log('  толщина 0:', JSON.stringify(zeroWidth));
  check(
    'при толщине 0 обводка не рисуется',
    Object.values(zeroWidth).every((count) => count === 0),
    JSON.stringify(zeroWidth),
  );

  // «Без цвета» в палитре обводки: цвет сбрасывается в null, обводки нет.
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    for (const object of app.objects.objects) app.objects.patchSilent(object.id, { payload: { strokeWidth: 3 } });
    app.objects.select([${JSON.stringify(shapes.rect)}]);
    app.ui.setRightTab('properties');
    return 'ok';
  })()`);
  await sleep(1200);

  const pickerOpened = await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('aside button'));
    const picker = buttons.find((button) => {
      const label = button.parentElement?.querySelector('span');
      return label && label.textContent.trim() === 'Обводка';
    });
    if (!picker) return false;
    picker.click();
    return true;
  })()`);
  await sleep(700);
  const noColorClicked = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (element) => (element.textContent || '').trim() === 'Без цвета',
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1000);
  const afterNoColor = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.byId(${JSON.stringify(shapes.rect)});
    return { stroke: object.payload.stroke, strokeWidth: object.payload.strokeWidth };
  })()`);
  const noColorPixels = await redInRegion(REGIONS.rect);
  console.log('  после «Без цвета»:', JSON.stringify(afterNoColor), 'красных пикселей:', noColorPixels);
  check('палитра обводки имеет пункт «Без цвета»', pickerOpened === true && noColorClicked === true);
  check('«Без цвета» сбрасывает цвет обводки в null', afterNoColor.stroke === null, JSON.stringify(afterNoColor));
  check('без цвета обводка не рисуется', noColorPixels === 0, `красных пикселей: ${noColorPixels}`);

  // Ввод толщины 0 в поле «Толщина»: значение должно сохраниться, обводка исчезнуть.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.patchSilent(${JSON.stringify(shapes.rect)}, { payload: { stroke: '#dc2626' } });
    return 'ok';
  })()`);
  await sleep(700);
  const widthInput = await cdp.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('aside input[type=number]'));
    const field = inputs.find((input) => input.closest('label, div')?.textContent?.includes('Толщина'));
    if (!field) return false;
    field.focus();
    field.value = '0';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1000);
  const afterZeroInput = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.byId(${JSON.stringify(shapes.rect)});
    return { width: object.payload.strokeWidth, stroke: object.payload.stroke };
  })()`);
  const zeroInputPixels = await redInRegion(REGIONS.rect);
  console.log('  после ввода 0 в поле «Толщина»:', JSON.stringify(afterZeroInput), 'красных пикселей:', zeroInputPixels);
  check('поле «Толщина» найдено', widthInput === true);
  check('толщина 0 сохраняется из поля', afterZeroInput.width === 0, JSON.stringify(afterZeroInput));
  check('после ввода 0 обводка исчезает', zeroInputPixels === 0, `красных пикселей: ${zeroInputPixels}`);

  // В готовом PDF тоже не должно быть обводки. Приводим фигуры к исходному
  // состоянию: у прямоугольника цвет снят, у остальных — красная обводка 3 pt.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    for (const object of app.objects.objects) {
      const isRect = object.id === ${JSON.stringify(shapes.rect)};
      app.objects.patchSilent(object.id, {
        payload: { stroke: isRect ? null : '#dc2626', strokeWidth: 3 },
      });
    }
    return 'ok';
  })()`);
  await sleep(800);

  const payloadsBeforeExport = await cdp.evaluate(`(() => window.__PDF_EDITOR__.objects.objects.map((object) => ({
    type: object.type,
    kind: object.payload.kind ?? null,
    stroke: object.payload.stroke ?? null,
    width: object.payload.strokeWidth ?? null,
  })))()`);
  console.log('  объекты перед экспортом:', JSON.stringify(payloadsBeforeExport));

  const exportedShapes = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  check('экспорт фигур выполнен', exportedShapes.ok === true, exportedShapes.error ?? '');
  if (exportedShapes.ok) {
    // Смотрим сам PDF: сколько раз в потоке задаётся красная обводка.
    // Сейчас красная обводка только у эллипса, линии и стрелки — у прямоугольника
    // она снята («Без цвета»).
    const pdfBytes = Buffer.from(exportedShapes.b64, 'base64');
    await writeFile(resolvePath(TMP, 'shapes-exported.pdf'), pdfBytes);
    const redStrokes = await countStrokeColorSets(pdfBytes, '#dc2626');
    console.log(`  красных обводок в готовом PDF: ${redStrokes} (ожидалось 3 из 4 фигур)`);
    check('экспорт PDF выполнен', exportedShapes.ok === true);
    check(
      'у фигуры без цвета обводки в PDF нет',
      redStrokes === 3,
      `обводок задано: ${redStrokes}`,
    );

    // Контроль: если вернуть цвет всем фигурам, обводок станет четыре.
    const restored = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      for (const object of app.objects.objects) {
        if (object.type === 'shape') {
          app.objects.patchSilent(object.id, { payload: { stroke: '#dc2626', strokeWidth: 3 } });
        }
      }
      const result = await app.exporter.run({ download: false });
      if (!result.ok) return { ok: false, error: result.error };
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return { ok: true, b64: btoa(binary) };
    })()`);
    if (restored.ok) {
      const fullStrokes = await countStrokeColorSets(Buffer.from(restored.b64, 'base64'), '#dc2626');
      console.log(`  красных обводок после возврата цвета: ${fullStrokes}`);
      check('при заданном цвете обводка есть у всех фигур', fullStrokes === 4, `обводок задано: ${fullStrokes}`);
    }
  }

  // Параметры инструмента тоже умеют «Без цвета»: новая фигура не получает обводку.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    app.editor.toolOptions.shape.stroke = null;
    app.editor.setTool('rect');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(900);
  const drawPoint = await cdp.evaluate(`(() => {
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width * 0.35), y: Math.round(rect.top + rect.height * 0.4) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drawPoint.x, y: drawPoint.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drawPoint.x, y: drawPoint.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: drawPoint.x + step * 10,
      y: drawPoint.y + step * 6,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drawPoint.x + 80, y: drawPoint.y + 48, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);

  const newShape = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    return shape ? { stroke: shape.payload.stroke, width: shape.payload.strokeWidth } : null;
  })()`);
  console.log('  новая фигура с «Без цвета»:', JSON.stringify(newShape));
  check('фигура создана с параметрами инструмента', newShape !== null);
  check(
    'при «Без цвета» в параметрах инструмента обводки нет',
    newShape ? newShape.stroke === null : false,
    JSON.stringify(newShape),
  );

  // Нулевая толщина в параметрах инструмента тоже не должна подменяться дефолтом.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    app.editor.toolOptions.shape.stroke = '#dc2626';
    app.editor.toolOptions.shape.strokeWidth = 0;
    return 'ok';
  })()`);
  await sleep(800);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drawPoint.x, y: drawPoint.y + 120, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drawPoint.x, y: drawPoint.y + 120, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: drawPoint.x + step * 10,
      y: drawPoint.y + 120 + step * 6,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drawPoint.x + 60, y: drawPoint.y + 156, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1000);

  const zeroToolShape = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    return shape ? { stroke: shape.payload.stroke, width: shape.payload.strokeWidth } : null;
  })()`);
  console.log('  фигура с нулевой толщиной из параметров инструмента:', JSON.stringify(zeroToolShape));
  check(
    'нулевая толщина из параметров инструмента не заменяется значением по умолчанию',
    zeroToolShape ? zeroToolShape.width === 0 : false,
    JSON.stringify(zeroToolShape),
  );

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
