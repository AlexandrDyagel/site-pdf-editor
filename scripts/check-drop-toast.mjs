/**
 * Проверка перетаскивания файла: документ должен открываться один раз.
 *
 * Раньше событие drop обрабатывали и зона загрузки, и глобальный обработчик,
 * поэтому документ открывался дважды и появлялись два тоста «Документ открыт».
 *
 *   1. На главной странице при перетаскивании — один тост;
 *   2. В пустом редакторе — тоже один тост.
 *
 * Запуск: node scripts/check-drop-toast.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9366 });

/** Имитация перетаскивания PDF-файла на зону загрузки. */
async function dropPdf() {
  return cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест.pdf', { type: 'application/pdf' });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    const zone = document.querySelector('.border-dashed');
    if (!zone) return { ok: false, error: 'нет зоны загрузки' };
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    zone.dispatchEvent(event);
    return { ok: true, defaultPrevented: event.defaultPrevented };
  })()`);
}

/** Сколько тостов «Документ открыт» сейчас в сторе и в DOM. */
async function countToasts() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const inStore = app.ui.toasts.filter((toast) => toast.title === 'Документ открыт').length;
    const inDom = Array.from(document.querySelectorAll('body *')).filter(
      (element) => element.children.length === 0 && (element.textContent || '').trim() === 'Документ открыт',
    ).length;
    return { inStore, inDom };
  })()`);
}

try {
  console.log('\n1. Главная страница');
  await sleep(3000);
  const droppedHome = await dropPdf();
  console.log('  событие drop:', JSON.stringify(droppedHome));
  check('зона загрузки обработала drop', droppedHome.ok === true, droppedHome.error ?? '');
  await sleep(3500);
  const homeToasts = await countToasts();
  const homePages = await cdp.evaluate(`window.__PDF_EDITOR__.pdf.pageCount`);
  console.log('  тосты:', JSON.stringify(homeToasts), 'страниц:', homePages);
  check('документ открылся', homePages > 0, String(homePages));
  check('на главной — один тост «Документ открыт»', homeToasts.inStore === 1, JSON.stringify(homeToasts));
  check('в DOM тоже один тост', homeToasts.inDom === 1, JSON.stringify(homeToasts));

  console.log('\n2. Пустой редактор');
  await cdp.send('Page.reload', {});
  await sleep(4000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(4000);
  const editorReady = await cdp.evaluate(`Boolean(document.querySelector('.border-dashed'))`);
  check('в пустом редакторе есть зона загрузки', editorReady === true);

  const droppedEditor = await dropPdf();
  console.log('  событие drop:', JSON.stringify(droppedEditor));
  await sleep(3500);
  const editorToasts = await countToasts();
  const editorPages = await cdp.evaluate(`window.__PDF_EDITOR__.pdf.pageCount`);
  console.log('  тосты:', JSON.stringify(editorToasts), 'страниц:', editorPages);
  check('документ открылся в редакторе', editorPages > 0, String(editorPages));
  check('в редакторе — один тост «Документ открыт»', editorToasts.inStore === 1, JSON.stringify(editorToasts));

  // Перетаскивание в обычном режиме (по холсту) тоже должно работать.
  console.log('\n3. Перетаскивание на холст редактора');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.clearToasts(); 'ok'`);
  const droppedCanvas = await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'второй.pdf', { type: 'application/pdf' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector('[data-testid=editor-canvas]');
    if (!target) return { ok: false, error: 'нет холста' };
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    target.dispatchEvent(event);
    return { ok: true };
  })()`);
  await sleep(3500);
  const canvasToasts = await countToasts();
  console.log('  событие drop:', JSON.stringify(droppedCanvas), 'тосты:', JSON.stringify(canvasToasts));
  check('перетаскивание на холст обрабатывается', canvasToasts.inStore >= 1, JSON.stringify(canvasToasts));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
