import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9409 });
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
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const rect = factory.createShapeObject('rect', {
      page: 0, x: 240, y: 380, width: 120, height: 80,
      defaults: { stroke: null, strokeWidth: 0, fill: '#22cc88' },
    });
    app.objects.add([rect], 'тест');
    app.objects.select([]);
    app.editor.setTool('marker');
    app.ui.setRightTab('tool');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1200);
  await cdp.evaluate(`document.querySelector('[data-testid=color-trigger]').click(); 'ok'`);
  await sleep(700);
  await cdp.screenshot(resolvePath(TMP, 'eyedropper-palette.png'));
  await cdp.evaluate(`document.querySelector('[data-testid=color-eyedropper]').click(); 'ok'`);
  await sleep(700);
  const point = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + 300 * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + 420 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(600);
  await cdp.screenshot(resolvePath(TMP, 'eyedropper.png'));
  console.log('Скриншоты сохранены');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
