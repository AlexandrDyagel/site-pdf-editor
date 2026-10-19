/**
 * Проверка тонких штрихов: у кисти, маркера, корректора и умного корректора
 * ширина опускается до 0.2 pt, и штрих действительно рисуется тонким
 * (контур не «раздувается» минимумом в 0.4–0.5 pt).
 *
 * Запуск: node scripts/check-stroke-width.mjs
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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9411 });

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

  console.log('\n1. Ползунки ширины пускают 0.2 pt');
  const sliders = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const result = {};
    for (const tool of ['brush', 'marker', 'eraser', 'smart-eraser']) {
      app.editor.setTool(tool);
      app.ui.setRightTab('tool');
      app.__toolProbe = tool;
      result[tool] = null;
    }
    return result;
  })()`);
  void sliders;

  for (const tool of ['brush', 'marker', 'eraser', 'smart-eraser']) {
    await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      app.editor.setTool(${JSON.stringify(tool)});
      app.ui.setRightTab('tool');
      return 'ok';
    })()`);
    await sleep(700);
    const mins = await cdp.evaluate(`(() => {
      const ranges = Array.from(document.querySelectorAll('input[type=range]'));
      return ranges.map((input) => Number(input.getAttribute('min')));
    })()`);
    console.log(`  ${tool}: минимумы ползунков = ${JSON.stringify(mins)}`);
    check(`${tool}: есть ползунок с минимумом 0.2 pt`, mins.includes(0.2), JSON.stringify(mins));
  }

  console.log('\n2. Контур тонкого штриха не раздувается');
  const outline = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/strokeService.ts');
    const measure = (width) => {
      const outline = service.getStrokeOutline({
        tool: 'brush',
        color: '#000000',
        width,
        opacity: 1,
        points: [
          { x: 0, y: 0, pressure: 0.5, time: 0 },
          { x: 20, y: 0, pressure: 0.5, time: 10 },
          { x: 40, y: 0, pressure: 0.5, time: 20 },
        ],
        smooth: false,
      });
      const ys = outline.map((point) => point.y);
      return { width, height: Math.max(...ys) - Math.min(...ys), points: outline.length };
    };
    return [measure(0.2), measure(0.5), measure(8)];
  })()`);
  console.log('  контуры:', JSON.stringify(outline));
  const thin = outline.find((item) => item.width === 0.2);
  check('штрих 0.2 pt тоньше 0.6 pt', thin.height < 0.6, `высота ${thin.height.toFixed(2)}`);
  check(
    'толстый штрих по-прежнему толстый',
    outline.find((item) => item.width === 8).height > 4,
    JSON.stringify(outline),
  );

  console.log('\n3. Тонкий штрих рисуется и сохраняется в объекте');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('brush');
    app.editor.toolOptions.draw.width = 0.2;
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(600);
  const start = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + 150 * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + 300 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + step * 30, y: start.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 180, y: start.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);

  const drawn = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    return object ? { type: object.type, width: object.payload.strokes[0].width, strokes: object.payload.strokes.length } : null;
  })()`);
  console.log('  объект:', JSON.stringify(drawn));
  check('штрих создан', drawn?.type === 'drawing', String(drawn?.type));
  check('ширина штриха 0.2 pt сохранена', Math.abs((drawn?.width ?? 0) - 0.2) < 0.001, String(drawn?.width));

  await cdp.screenshot(resolvePath(TMP, 'stroke-width.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
