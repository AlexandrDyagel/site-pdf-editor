/**
 * Проверка корректора «как ведёшь — так и заливается».
 *
 *   1. штрих идёт точно по пути указателя (без «утягивания» и хвоста):
 *      заливка есть во всех точках пути, включая последнюю;
 *   2. заливка не уходит далеко за конец штриха;
 *   3. ломаная (зигзаг) заливается целиком, без «дыр» на поворотах;
 *   4. в объекте сохранены все опорные точки пути.
 *
 * Запуск: node scripts/check-eraser-drag.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const WIDTH = 22;
/** Зигзаг «ёлочкой», как в жалобе: несколько резких поворотов. */
const PATH = [
  { x: 130, y: 240 },
  { x: 185, y: 180 },
  { x: 240, y: 240 },
  { x: 295, y: 180 },
  { x: 350, y: 240 },
];
/** Прямоугольник известного цвета под штрихом: по нему видно заливку. */
const RECT = { x: 100, y: 150, width: 300, height: 130, fill: '#22cc88' };

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9413 });

async function screenPoint(x, y) {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + ${x} * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + ${y} * app.editor.zoom),
    };
  })()`);
}

try {
  await sleep(3000);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(400);
  }
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(5000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(5000);

  console.log('\n1. Рисуем зигзаг корректором');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const rect = factory.createShapeObject('rect', {
      page: 0,
      x: ${RECT.x}, y: ${RECT.y}, width: ${RECT.width}, height: ${RECT.height},
      defaults: { stroke: null, strokeWidth: 0, fill: ${JSON.stringify(RECT.fill)} },
    });
    app.objects.add([rect], 'тест');
    app.objects.select([]);
    app.editor.setTool('eraser');
    app.editor.toolOptions.eraser.width = ${WIDTH};
    app.editor.toolOptions.eraser.color = '#ffffff';
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(700);

  const first = await screenPoint(PATH[0].x, PATH[0].y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  // Ведём по сегментам с шагом ~8 px — как настоящая мышь.
  for (let segment = 1; segment < PATH.length; segment += 1) {
    const from = await screenPoint(PATH[segment - 1].x, PATH[segment - 1].y);
    const to = await screenPoint(PATH[segment].x, PATH[segment].y);
    const steps = 10;
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(25);
    }
  }
  const last = await screenPoint(PATH[PATH.length - 1].x, PATH[PATH.length - 1].y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);

  const object = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects.find((item) => item.type === 'drawing');
    if (!object) return null;
    const stroke = object.payload.strokes[0];
    const lastPoint = stroke.points[stroke.points.length - 1];
    return {
      type: object.type,
      points: stroke.points.length,
      width: stroke.width,
      last: { x: Number(lastPoint.x.toFixed(1)), y: Number(lastPoint.y.toFixed(1)) },
      origin: { x: Number(object.x.toFixed(1)), y: Number(object.y.toFixed(1)) },
    };
  })()`);
  console.log('  объект:', JSON.stringify(object));
  check('штрих создан', object?.type === 'drawing', String(object?.type));
  check('сохранено много опорных точек пути', (object?.points ?? 0) > 30, String(object?.points));

  // Последняя точка должна совпадать с местом, где отпустили мышь.
  const expectedLastX = PATH[PATH.length - 1].x - (object?.origin.x ?? 0);
  const expectedLastY = PATH[PATH.length - 1].y - (object?.origin.y ?? 0);
  check(
    'конец штриха там, где отпустили мышь',
    Math.abs((object?.last.x ?? 0) - expectedLastX) < 6 &&
      Math.abs((object?.last.y ?? 0) - expectedLastY) < 6,
    `конец ${JSON.stringify(object?.last)}, ожидалось ≈ (${expectedLastX.toFixed(1)}, ${expectedLastY.toFixed(1)})`,
  );

  console.log('\n2. Заливка по всему пути');
  // Сэмплируем цвет в точках вдоль пути: корректор белый, значит текст исчез.
  const coverage = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const path = ${JSON.stringify(PATH)};
    const step = 9;
    const samples = [];
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const count = Math.max(1, Math.round(length / step));
      for (let part = 0; part <= count; part += 1) {
        const t = part / count;
        samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      }
    }
    const background = document.querySelectorAll('canvas')[0];
    const objects = document.querySelectorAll('canvas')[1];
    const zoom = app.editor.zoom;
    const composite = document.createElement('canvas');
    composite.width = background.width;
    composite.height = background.height;
    const ctx = composite.getContext('2d');
    ctx.drawImage(background, 0, 0);
    ctx.drawImage(objects, 0, 0);
    let white = 0;
    let covered = 0;
    for (const sample of samples) {
      const px = Math.round(app.editor.pan.x + sample.x * zoom);
      const py = Math.round(app.editor.pan.y + sample.y * zoom);
      if (px < 0 || py < 0 || px >= composite.width || py >= composite.height) continue;
      covered += 1;
      const data = ctx.getImageData(px, py, 1, 1).data;
      if (data[0] > 235 && data[1] > 235 && data[2] > 235) white += 1;
    }
    // Точка далеко за концом штриха — там заливки быть не должно.
    const beyond = path[path.length - 1];
    const beyondPx = Math.round(app.editor.pan.x + (beyond.x + ${WIDTH}) * zoom);
    const beyondPy = Math.round(app.editor.pan.y + beyond.y * zoom);
    const beyondData = ctx.getImageData(beyondPx, beyondPy, 1, 1).data;
    const beyondWhite = beyondData[0] > 245 && beyondData[1] > 245 && beyondData[2] > 245;
    return { samples: samples.length, covered, white, ratio: covered ? white / covered : 0, beyondWhite };
  })()`);
  console.log('  покрытие:', JSON.stringify(coverage));
  check('путь залит полностью (без дыр и хвоста)', coverage.ratio > 0.97, `${(coverage.ratio * 100).toFixed(1)}% из ${coverage.covered}`);
  check('за концом штриха ничего не залито', coverage.beyondWhite === false);

  console.log('\n3. Штрих описан одинаковой шириной');
  const widths = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/strokeService.ts');
    const object = window.__PDF_EDITOR__.objects.objects.find((item) => item.type === 'drawing');
    const stroke = object.payload.strokes[0];
    const outline = service.getStrokeOutline(stroke);
    // Ширина в нескольких сечениях: разброс не должен быть заметным.
    const measures = [];
    for (let index = 0; index < 5; index += 1) {
      const t = 0.15 + index * 0.18;
      const x = stroke.points[Math.floor((stroke.points.length - 1) * t)];
      if (!x) continue;
      const near = outline.filter((point) => Math.abs(point.x - x.x) < 3);
      if (near.length < 2) continue;
      const ys = near.map((point) => point.y);
      measures.push(Math.max(...ys) - Math.min(...ys));
    }
    return measures;
  })()`);
  console.log('  ширины в сечениях:', JSON.stringify(widths.map((value) => Number(value.toFixed(1)))));
  check(
    'ширина штриха постоянная',
    widths.length > 0 && Math.max(...widths) - Math.min(...widths) < WIDTH * 0.5,
    JSON.stringify(widths),
  );

  await cdp.screenshot(resolvePath(TMP, 'eraser-drag.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
