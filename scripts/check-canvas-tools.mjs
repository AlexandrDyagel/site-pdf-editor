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

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
