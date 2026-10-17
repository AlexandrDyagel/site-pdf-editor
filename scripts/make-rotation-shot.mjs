/**
 * Скриншот для демонстрации: страница, отсканированная боком, поворачивается,
 * аннотации остаются на своих местах.
 *
 * Запуск: node scripts/make-rotation-shot.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9347 });

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
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const stamp = await import('/src/services/stampRenderService.ts');
    const template = stamp.createStampTemplate({ name: 'СОГЛАСОВАНО' });
    app.objects.add([
      factory.createTextObject({
        page: 0, x: 80, y: 700, width: 220, height: 26,
        text: 'Подпись и дата',
        autoHeight: true,
        defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 15, color: '#1d4ed8' },
      }),
      factory.createStampObject(template, { page: 0, x: 120, y: 120, width: 150, height: 70 }),
    ], 'демонстрация');
    app.objects.select([]);
    return 'ok';
  })()`);
  await sleep(1200);

  const before = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return { rotation: app.pdf.geometry(0).rotation, display: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)] };
  })()`);
  console.log('До поворота:', JSON.stringify(before));
  await cdp.screenshot(resolvePath(TMP, 'rotation-before.png'));

  await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', modifiers: 1, windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', modifiers: 1, windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  await sleep(2000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  const after = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return { rotation: app.pdf.geometry(0).rotation, display: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)], objects: app.objects.objects.length };
  })()`);
  console.log('После поворота:', JSON.stringify(after));
  await cdp.screenshot(resolvePath(TMP, 'rotation-after.png'));
} catch (error) {
  console.error('ОШИБКА:', error);
  process.exitCode = 1;
} finally {
  close();
}
