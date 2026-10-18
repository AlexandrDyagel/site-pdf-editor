import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9383 });
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
  const point = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('text');
    document.activeElement?.blur?.();
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + 320 * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + 300 * app.editor.zoom),
    };
  })()`);
  await sleep(700);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
  await cdp.send('Input.insertText', { text: 'Центр текста' });
  await sleep(900);
  // Красная точка ровно в месте клика — по ней видно, что текст центрируется.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const stage = window.__PDF_EDITOR_STAGE__;
    const layer = stage.getLayers()[1];
    const marker = new window.Konva.Circle({ x: 320, y: 300, radius: 2.5, fill: '#e11d48', listening: false });
    layer.add(marker);
    layer.draw();
    void app;
    return 'ok';
  })()`);
  await sleep(600);
  await cdp.screenshot(resolvePath(TMP, 'text-center.png'));
  console.log('Скриншот сохранён');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
