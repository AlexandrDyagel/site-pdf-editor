/**
 * Скриншоты интерфейса для демонстрации:
 *   - кнопка шрифтов на панели и раздел «Шрифты» в окне экспорта;
 *   - разделы боковых панелей: перенос строк и растягивание панелей.
 *
 * Запуск: node scripts/make-ui-shot.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9357 });

/** Загрузка документа и переход в редактор. */
async function openDocument() {
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
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(1500);
}

/** Тянем границу панели. */
async function drag(side, deltaX) {
  const label = side === 'left' ? 'левой' : 'правой';
  const point = await cdp.evaluate(`(() => {
    const handle = document.querySelector('[aria-label="Изменить ширину ${label} панели"]');
    const box = handle.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 220) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 12; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x + (deltaX * i) / 12,
      y: point.y,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + deltaX, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
}

try {
  await cdp.evaluate(`localStorage.removeItem('pdf-editor:panel-widths'); 'ok'`);
  await openDocument();

  // 1. Исходная ширина: разделы переносятся на вторую строку.
  await cdp.screenshot(resolvePath(TMP, 'layout-narrow.png'));

  // 2. Растянутые панели: разделы встают в один ряд.
  await drag('right', -190);
  await drag('left', 200);
  await cdp.evaluate(`(() => {
    const tabs = document.querySelectorAll('[role=tab]');
    return tabs.length;
  })()`);
  await cdp.screenshot(resolvePath(TMP, 'layout-wide.png'));

  // 3. Скриншоты окна экспорта с разделом «Шрифты».
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('export'); 'ok'`);
  await sleep(1800);
  await cdp.screenshot(resolvePath(TMP, 'font-ui-export.png'));
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeAllModals(); 'ok'`);
  await sleep(800);
  await cdp.screenshot(resolvePath(TMP, 'font-ui-toolbar.png'));

  console.log('Скриншоты готовы');
} catch (error) {
  console.error('ОШИБКА:', error);
  process.exitCode = 1;
} finally {
  close();
}
