import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9378 });
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
  await cdp.send('Input.insertText', { text: 'Текст от курсора' });
  await sleep(800);
  // Кроп вокруг места клика для наглядности.
  await cdp.screenshot(resolvePath(TMP, 'text-caret.png'), {
    clip: { x: point.x - 120, y: point.y - 60, width: 420, height: 160, scale: 2 },
  });
  console.log('Скриншот сохранён');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
