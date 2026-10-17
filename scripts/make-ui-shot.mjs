/**
 * Скриншоты для ответа: кнопка шрифтов на панели и окно экспорта с разделом «Шрифты».
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9355 });

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

  // Окно экспорта: прокручиваем правую колонку до раздела «Шрифты».
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('export'); 'ok'`);
  await sleep(2000);
  await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return 'нет окна';
    const scrollables = Array.from(dialog.querySelectorAll('*'))
      .filter((element) => element.scrollHeight > element.clientHeight + 20);
    for (const element of scrollables) element.scrollTop = element.scrollHeight;
    return 'ok';
  })()`);
  await sleep(800);
  await cdp.screenshot(resolvePath(TMP, 'font-ui-export.png'));

  // Панель инструментов: кнопка шрифтов (верхний правый блок).
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
