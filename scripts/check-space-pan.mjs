/**
 * Проверка панорамирования пробелом: пока пробел зажат, объекты на холсте не
 * выделяются и не перетаскиваются — тянется только холст.
 *
 *   1. объект под курсором не сдвигается;
 *   2. холст действительно прокручивается;
 *   3. выделение не меняется;
 *   4. после отпускания пробела объект снова перетаскивается (регресс-защита).
 *
 * Запуск: node scripts/check-space-pan.mjs
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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9577 });

async function drag(from, to) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * step) / 6),
      y: Math.round(from.y + ((to.y - from.y) * step) / 6),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(600);
}

try {
  await sleep(5000);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(500);
  }
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'тест.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(7000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);

  const setup = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const rect = factory.createShapeObject('rect', {
      page: 0, x: 120, y: 120, width: 200, height: 120,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill: '#dbeafe' },
    });
    app.objects.add([rect], 'тест');
    app.objects.select([rect.id]);
    app.editor.setTool('select');
    const box = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      id: rect.id,
      x: rect.x,
      y: rect.y,
      pan: { x: app.editor.pan.x, y: app.editor.pan.y },
      center: {
        x: Math.round(box.left + app.editor.pan.x + 220 * app.editor.zoom),
        y: Math.round(box.top + app.editor.pan.y + 180 * app.editor.zoom),
      },
    };
  })()`);
  console.log(`  объект: x=${setup.x}, y=${setup.y}; пан: ${setup.pan.x},${setup.pan.y}`);

  console.log('\n1. Пробел зажат — тянется холст, а не объект');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await sleep(500);
  const spaceState = await cdp.evaluate(
    `(() => ({ space: window.__PDF_EDITOR__.editor.spacePressed, panTool: window.__PDF_EDITOR__.editor.isPanTool }))()`,
  );
  check('пробел включает панорамирование', spaceState.space === true && spaceState.panTool === true, JSON.stringify(spaceState));

  const from = setup.center;
  await drag(from, { x: from.x + 120, y: from.y + 80 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await sleep(400);
  const afterPan = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = app.objects.objects[0];
    return { x: rect.x, y: rect.y, pan: { x: app.editor.pan.x, y: app.editor.pan.y }, selected: [...app.objects.selectedIds] };
  })()`);
  console.log(`  после: x=${Math.round(afterPan.x)}, y=${Math.round(afterPan.y)}; пан: ${afterPan.pan.x},${afterPan.pan.y}`);

  check(
    'объект под курсором не сдвинулся',
    Math.abs(afterPan.x - setup.x) < 0.5 && Math.abs(afterPan.y - setup.y) < 0.5,
    JSON.stringify({ before: { x: setup.x, y: setup.y }, after: { x: afterPan.x, y: afterPan.y } }),
  );
  check(
    'холст прокрутился',
    Math.abs(afterPan.pan.x - setup.pan.x) > 40 || Math.abs(afterPan.pan.y - setup.pan.y) > 30,
    JSON.stringify({ before: setup.pan, after: afterPan.pan }),
  );
  check(
    'выделение не изменилось',
    afterPan.selected.length === 1 && afterPan.selected[0] === setup.id,
    JSON.stringify(afterPan.selected),
  );

  console.log('\n2. Пробел отпущен — объект снова перетаскивается');
  const start = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = app.objects.objects[0];
    const box = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      center: {
        x: Math.round(box.left + app.editor.pan.x + (rect.x + rect.width / 2) * app.editor.zoom),
        y: Math.round(box.top + app.editor.pan.y + (rect.y + rect.height / 2) * app.editor.zoom),
      },
    };
  })()`);
  const dragged = await cdp.evaluate(`(() => window.__PDF_EDITOR__.editor.isPanTool)()`);
  check('панорамирование выключено', dragged === false, String(dragged));
  await drag(start.center, { x: start.center.x + 60, y: start.center.y + 40 });
  const afterDrag = await cdp.evaluate(`(() => {
    const rect = window.__PDF_EDITOR__.objects.objects[0];
    return { x: rect.x, y: rect.y };
  })()`);
  check(
    'объект перетащился мышью',
    Math.abs(afterDrag.x - start.x) > 5 || Math.abs(afterDrag.y - start.y) > 5,
    JSON.stringify({ before: { x: start.x, y: start.y }, after: afterDrag }),
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
