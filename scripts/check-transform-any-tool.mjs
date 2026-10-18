/**
 * Проверка трансформации объекта без переключения на инструмент «Выбор».
 *
 *   1. Нарисовали прямоугольник — он остался выделенным, и его можно растянуть
 *      за ручку, не переключая инструмент;
 *   2. Нажатие на ручку не создаёт новый объект;
 *   3. Поворот за круглую ручку тоже работает при активном инструменте;
 *   4. Текст, созданный инструментом «Текст», тянется за край и растягивается;
 *   5. Рисование на пустом месте по-прежнему создаёт новые объекты.
 *
 * Запуск: node scripts/check-transform-any-tool.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9375 });

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

/** Тянет указатель из точки в точку (медленно, чтобы Konva успевала). */
async function drag(from, to, steps = 8) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * step) / steps),
      y: Math.round(from.y + ((to.y - from.y) * step) / steps),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(800);
}

/** Экранная позиция ручки трансформера по имени. */
async function anchorPoint(name) {
  return cdp.evaluate(`(() => {
    const stage = window.__PDF_EDITOR_STAGE__;
    const transformer = stage.findOne((node) => node.name && node.name() === 'transformer');
    const anchor = transformer ? transformer.findOne(${JSON.stringify(name)}) : null;
    if (!anchor) return null;
    const rect = stage.container().getBoundingClientRect();
    const absolute = anchor.getAbsolutePosition();
    return { x: Math.round(rect.left + absolute.x), y: Math.round(rect.top + absolute.y) };
  })()`);
}

async function objectsState() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      tool: app.editor.tool,
      count: app.objects.objects.length,
      objects: app.objects.objects.map((object) => ({
        type: object.type,
        x: Number(object.x.toFixed(1)),
        y: Number(object.y.toFixed(1)),
        width: Number(object.width.toFixed(1)),
        height: Number(object.height.toFixed(1)),
        rotation: Number(object.rotation.toFixed(1)),
      })),
      transformerListening: (() => {
        const stage = window.__PDF_EDITOR_STAGE__;
        const transformer = stage.findOne((node) => node.name && node.name() === 'transformer');
        return transformer ? transformer.listening() : null;
      })(),
    };
  })()`);
}

try {
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
  await sleep(6000);
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('rect');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(800);

  console.log('\n1. Прямоугольник: инструмент остаётся активным');
  await drag(await screenPoint(160, 140), await screenPoint(320, 250));
  const afterDraw = await objectsState();
  console.log('  после рисования:', JSON.stringify(afterDraw));
  check('создан один прямоугольник', afterDraw.count === 1 && afterDraw.objects[0].type === 'shape', JSON.stringify(afterDraw.objects));
  check('инструмент «Прямоугольник» остался активным', afterDraw.tool === 'rect', afterDraw.tool);
  check('ручки трансформера активны при этом инструменте', afterDraw.transformerListening === true, String(afterDraw.transformerListening));

  console.log('\n2. Растягивание за ручку без переключения инструмента');
  const rightAnchor = await anchorPoint('.middle-right');
  check('найдена правая ручка', rightAnchor !== null);
  if (rightAnchor) {
    await drag(rightAnchor, { x: rightAnchor.x + 120, y: rightAnchor.y });
    const afterResize = await objectsState();
    console.log('  после растягивания:', JSON.stringify(afterResize.objects));
    check('объект не создался заново', afterResize.count === 1, String(afterResize.count));
    check(
      'ширина увеличилась',
      afterResize.objects[0].width > afterDraw.objects[0].width + 40,
      `${afterDraw.objects[0].width} → ${afterResize.objects[0].width}`,
    );
    check('инструмент всё ещё «Прямоугольник»', afterResize.tool === 'rect', afterResize.tool);
  }

  console.log('\n3. Поворот за круглую ручку');
  const rotateAnchor = await anchorPoint('.rotater');
  check('найдена ручка поворота', rotateAnchor !== null);
  if (rotateAnchor) {
    const center = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const object = app.objects.objects[0];
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      return {
        x: Math.round(rect.left + app.editor.pan.x + (object.x + object.width / 2) * app.editor.zoom),
        y: Math.round(rect.top + app.editor.pan.y + (object.y + object.height / 2) * app.editor.zoom),
      };
    })()`);
    // Тянем ручку поворота по дуге вокруг центра.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rotateAnchor.x, y: rotateAnchor.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await sleep(120);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rotateAnchor.x, y: rotateAnchor.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    const radius = Math.hypot(rotateAnchor.x - center.x, rotateAnchor.y - center.y);
    for (let step = 1; step <= 8; step += 1) {
      const angle = -Math.PI / 2 + (step * Math.PI) / 16;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(center.x + Math.cos(angle) * radius),
        y: Math.round(center.y + Math.sin(angle) * radius),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(40);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(center.x + Math.cos(-Math.PI / 2 + Math.PI / 2) * radius), y: Math.round(center.y + Math.sin(-Math.PI / 2 + Math.PI / 2) * radius), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(900);
    const afterRotate = await objectsState();
    console.log('  после поворота:', JSON.stringify(afterRotate.objects));
    check('объект не создался заново при повороте', afterRotate.count === 1, String(afterRotate.count));
    check(
      'угол поворота изменился',
      Math.abs(afterRotate.objects[0].rotation) > 5,
      String(afterRotate.objects[0].rotation),
    );
    check('инструмент по-прежнему «Прямоугольник»', afterRotate.tool === 'rect', afterRotate.tool);
  }

  console.log('\n4. Текст: тянем за край, инструмент «Текст» активен');
  const textCreated = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    const text = factory.createTextObject({
      page: 0, x: 160, y: 330, width: 90, height: 22, text: 'Тяни за край', autoHeight: true,
      defaults: {
        fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111827',
        bold: false, italic: false, align: 'left', lineHeight: 1.25, letterSpacing: 0,
      },
    });
    app.objects.add([text], 'тест');
    app.objects.select([text.id]);
    app.editor.setTool('text');
    document.activeElement?.blur?.();
    return { id: text.id, width: Number(text.width.toFixed(1)) };
  })()`);
  await sleep(1100);
  const textAnchor = await anchorPoint('.middle-right');
  check('найдена правая ручка текста', textAnchor !== null);
  if (textAnchor) {
    await drag(textAnchor, { x: textAnchor.x + 150, y: textAnchor.y });
    const afterTextResize = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const object = app.objects.byId(${JSON.stringify(textCreated.id)});
      const stage = window.__PDF_EDITOR_STAGE__;
      const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === ${JSON.stringify(textCreated.id)});
      return {
        tool: app.editor.tool,
        count: app.objects.objects.length,
        width: object ? Number(object.width.toFixed(1)) : null,
        scaleX: node ? Number(node.scaleX().toFixed(3)) : null,
      };
    })()`);
    console.log('  после растягивания текста:', JSON.stringify(afterTextResize));
    check('текст растянулся', afterTextResize.width !== null && afterTextResize.width > textCreated.width + 40, `${textCreated.width} → ${afterTextResize.width}`);
    check('масштаб узла сброшен', afterTextResize.scaleX === 1, String(afterTextResize.scaleX));
    check('новый объект не создан', afterTextResize.count === 1, String(afterTextResize.count));
    check('инструмент «Текст» активен', afterTextResize.tool === 'text', afterTextResize.tool);
  }

  console.log('\n5. Рисование на пустом месте продолжает работать');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    app.editor.setTool('rect');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(700);
  await drag(await screenPoint(160, 140), await screenPoint(300, 230));
  await drag(await screenPoint(360, 330), await screenPoint(500, 430));
  const afterTwo = await objectsState();
  console.log('  после двух фигур:', JSON.stringify(afterTwo.objects));
  check('инструментом нарисованы две фигуры', afterTwo.count === 2, String(afterTwo.count));

  await cdp.screenshot(resolvePath(TMP, 'transform-any-tool.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
