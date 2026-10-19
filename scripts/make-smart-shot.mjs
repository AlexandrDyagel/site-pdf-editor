import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9405 });
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
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('smart-eraser');
    app.editor.toolOptions.smartEraser.color = '#e11d48';
    app.editor.toolOptions.smartEraser.threshold = 200;
    app.editor.toolOptions.smartEraser.width = 26;
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1200);
  const point = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + 140 * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + 150 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + step * 34, y: point.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(45);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 272, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(2500);
  // Возвращаемся на вкладку «Инструмент» и наводим курсор на холст.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearSelection();
    app.editor.setTool('smart-eraser');
    app.ui.setRightTab('tool');
    return 'ok';
  })()`);
  await sleep(1200);
  const hover = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + 380 * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + 250 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(700);
  await cdp.screenshot(resolvePath(TMP, 'smart-eraser-panel.png'));
  console.log('Скриншот сохранён');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
