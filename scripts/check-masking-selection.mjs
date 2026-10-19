/**
 * Проверка правил выделения закрашенных участков (корректор / умный корректор).
 *
 *   1. после штриха объект не становится активным (нет рамки);
 *   2. кликом на холсте его нельзя выделить;
 *   3. рамкой выделения и Ctrl+A — тоже нельзя;
 *   4. в панели «Слои» он выбирается, и тогда появляется рамка (трансформер);
 *   5. обычные объекты по-прежнему выделяются кликом.
 *
 * Запуск: node scripts/check-masking-selection.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9417 });

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

async function clickAt(point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(600);
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

  console.log('\n1. Штрих корректором не становится активным');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('eraser');
    app.editor.toolOptions.eraser.width = 18;
    app.editor.toolOptions.eraser.color = '#ffffff';
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(600);
  const from = await screenPoint(140, 210);
  const to = await screenPoint(360, 210);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + ((to.x - from.x) * step) / 8), y: from.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);

  const afterStroke = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const transformer = window.__PDF_EDITOR_STAGE__.findOne((node) => node.name && node.name() === 'transformer');
    return {
      objects: app.objects.objects.length,
      type: object ? object.type : null,
      erasable: object ? Boolean(object.payload.erasable) : null,
      selected: [...app.objects.selectedIds],
      transformerNodes: transformer ? transformer.nodes().length : 0,
      transformerVisible: transformer ? transformer.visible() : null,
    };
  })()`);
  console.log('  после штриха:', JSON.stringify(afterStroke));
  check('штрих создан', afterStroke.objects === 1 && afterStroke.type === 'drawing', JSON.stringify(afterStroke));
  check('закрашенный участок не выделен', afterStroke.selected.length === 0, JSON.stringify(afterStroke.selected));
  check(
    'рамки нет',
    afterStroke.transformerNodes === 0 || afterStroke.transformerVisible === false,
    JSON.stringify(afterStroke),
  );

  console.log('\n2. Клик на холсте по закрашенному');
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
  await sleep(500);
  await clickAt(await screenPoint(250, 210));
  const afterClick = await cdp.evaluate(`(() => [...window.__PDF_EDITOR__.objects.selectedIds])()`);
  console.log('  выделено после клика:', JSON.stringify(afterClick));
  check('клик не выделяет закрашенный участок', afterClick.length === 0, JSON.stringify(afterClick));

  console.log('\n3. Рамка выделения и Ctrl+A');
  const start = await screenPoint(100, 170);
  const end = await screenPoint(420, 250);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(start.x + ((end.x - start.x) * step) / 6), y: Math.round(start.y + ((end.y - start.y) * step) / 6), button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
  const afterMarquee = await cdp.evaluate(`(() => [...window.__PDF_EDITOR__.objects.selectedIds])()`);
  console.log('  выделено рамкой:', JSON.stringify(afterMarquee));
  check('рамка не выделяет закрашенный участок', afterMarquee.length === 0, JSON.stringify(afterMarquee));

  const afterSelectAll = await cdp.evaluate(`(() => {
    window.__PDF_EDITOR__.objects.selectAll();
    return [...window.__PDF_EDITOR__.objects.selectedIds];
  })()`);
  console.log('  выделено через Ctrl+A:', JSON.stringify(afterSelectAll));
  check('Ctrl+A не выделяет закрашенный участок', afterSelectAll.length === 0, JSON.stringify(afterSelectAll));

  console.log('\n4. Выделение через «Слои»');
  await cdp.evaluate(`(() => {
    window.__PDF_EDITOR__.objects.clearSelection();
    window.__PDF_EDITOR__.ui.setRightTab('layers');
    return 'ok';
  })()`);
  await sleep(900);
  const rowClicked = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const row = right ? right.querySelector('[data-layer-id]') : null;
    if (!row) return { ok: false, label: null };
    const label = row.querySelector('[data-layer-label]');
    const button = label ? label.closest('button') : null;
    if (!button) return { ok: false, label: null };
    button.click();
    return { ok: true, label: (label.textContent || '').trim() };
  })()`);
  await sleep(900);
  const afterLayers = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const transformer = window.__PDF_EDITOR_STAGE__.findOne((node) => node.name && node.name() === 'transformer');
    return {
      selected: [...app.objects.selectedIds],
      transformerNodes: transformer ? transformer.nodes().length : 0,
      transformerVisible: transformer ? transformer.visible() : null,
    };
  })()`);
  console.log('  строка слоя:', JSON.stringify(rowClicked), '→', JSON.stringify(afterLayers));
  check('строка «Слоёв» кликабельна', rowClicked.ok === true);
  check('название слоя — корректор', rowClicked.label === 'Корректор', String(rowClicked.label));
  check('из «Слоёв» участок выделяется', afterLayers.selected.length === 1, JSON.stringify(afterLayers.selected));
  check(
    'после выбора из «Слоёв» появляется рамка',
    afterLayers.transformerNodes === 1 && afterLayers.transformerVisible === true,
    JSON.stringify(afterLayers),
  );

  console.log('\n5. Обычные объекты выделяются как раньше');
  const normal = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearSelection();
    const rect = factory.createShapeObject('rect', {
      page: 0, x: 120, y: 260, width: 120, height: 80,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill: '#dbeafe' },
    });
    app.objects.add([rect], 'тест');
    app.objects.clearSelection();
    app.editor.setTool('select');
    return rect.id;
  })()`);
  await sleep(800);
  await clickAt(await screenPoint(180, 300));
  const normalSelected = await cdp.evaluate(`(() => [...window.__PDF_EDITOR__.objects.selectedIds])()`);
  console.log('  выделено после клика по прямоугольнику:', JSON.stringify(normalSelected));
  check('прямоугольник выделяется кликом', normalSelected.includes(normal), JSON.stringify(normalSelected));

  await cdp.screenshot(resolvePath(TMP, 'masking-selection.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
