/**
 * Проверка доступа к окну «Шрифты» с разных страниц.
 *
 * Пользователь сообщил: кнопка «Управление шрифтами» в настройках ничего не
 * делает, а окно открывается позже — при входе в редактор. Причина: окно было
 * смонтировано только в редакторе. Здесь проверяется, что:
 *   1. кнопка в настройках открывает окно сразу;
 *   2. после закрытия окно не всплывает при входе в редактор;
 *   3. в редакторе есть кнопка шрифтов на панели инструментов;
 *   4. в окне экспорта есть переход «Управление шрифтами»;
 *   5. с главной страницы окно тоже открывается;
 *   6. горячая клавиша Ctrl+Shift+F работает.
 *
 * Запуск: node scripts/check-font-ui.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9353 });

/** Состояние окон и наличие диалога «Шрифты» в DOM. */
async function state() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const dialogs = Array.from(document.querySelectorAll('[role=dialog]'));
    const fontsDialog = dialogs.find((dialog) => /Шрифты/.test(dialog.textContent || ''));
    return {
      fonts: Boolean(app?.ui.modals.fonts),
      shortcuts: Boolean(app?.ui.modals.shortcuts),
      exporter: Boolean(app?.ui.modals.export),
      fontsDialogVisible: Boolean(fontsDialog),
      dialogs: dialogs.length,
      path: location.hash,
    };
  })()`);
}

/** Клик по кнопке с заданным текстом (или по атрибуту title). */
async function clickByText(text, scope = 'document') {
  return cdp.evaluate(`(() => {
    const root = ${scope === 'header' ? "document.querySelector('header') || document" : 'document'};
    const button = Array.from(root.querySelectorAll('button'))
      .find((element) => (element.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Клик по кнопке внутри окна, в заголовке которого есть подстрока. */
async function clickInDialog(dialogPattern, text) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const clicked = await cdp.evaluate(`(() => {
      const dialog = Array.from(document.querySelectorAll('[role=dialog]'))
        .find((element) => new RegExp(${JSON.stringify(dialogPattern)}).test(element.textContent || ''));
      if (!dialog) return false;
      const button = Array.from(dialog.querySelectorAll('button'))
        .find((element) => (element.textContent || '').includes(${JSON.stringify(text)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (clicked) return true;
    await sleep(400);
  }
  return false;
}

/** Клик по кнопке внутри окна «Шрифты». */
async function clickInFontsDialog(text) {
  return clickInDialog('Шрифты', text);
}

async function clickByTitle(title) {
  return cdp.evaluate(`(() => {
    const button = document.querySelector('button[title=' + ${JSON.stringify(JSON.stringify(title))} + ']');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

try {
  console.log('\n1. Настройки: кнопка «Управление шрифтами»');
  await cdp.evaluate(`location.hash = '#/settings'; 'ok'`);
  await sleep(2500);
  const beforeSettings = await state();
  const clicked = await clickByText('Управление шрифтами');
  await sleep(1200);
  const afterSettings = await state();
  check('кнопка найдена в настройках', clicked === true);
  check('окно шрифтов открылось сразу', afterSettings.fonts === true && afterSettings.fontsDialogVisible === true, JSON.stringify(afterSettings));
  check('до нажатия окно было закрыто', beforeSettings.fonts === false);

  console.log('\n2. Закрытие окна и переход в редактор');
  const closed = await clickInFontsDialog('Готово');
  await sleep(900);
  const afterClose = await state();
  check('окно закрывается кнопкой «Готово»', closed === true && afterClose.fonts === false, JSON.stringify(afterClose));

  // Загружаем документ с главной страницы (там есть область перетаскивания).
  await cdp.evaluate(`location.hash = '#/'; 'ok'`);
  await sleep(2500);
  const loaded = await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    if (!input) return 'нет поля файла';
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check('документ загружен с главной страницы', loaded === 'ok', String(loaded));
  await sleep(5000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(5000);
  const loadedState = await cdp.evaluate(`(() => ({
    pages: window.__PDF_EDITOR__.pdf.pageCount,
    isLoaded: window.__PDF_EDITOR__.pdf.isLoaded,
    path: location.hash,
  }))()`);
  console.log('  документ в редакторе:', JSON.stringify(loadedState));
  check('редактор открылся с документом', loadedState.isLoaded === true && loadedState.pages > 0, JSON.stringify(loadedState));
  const editorState = await state();
  console.log('  состояние в редакторе:', JSON.stringify(editorState));
  check('окно шрифтов не всплывает само в редакторе', editorState.fonts === false && editorState.fontsDialogVisible === false, JSON.stringify(editorState));

  console.log('\n3. Редактор: кнопка шрифтов на панели инструментов');
  const toolbarClicked = await clickByTitle('Шрифты');
  await sleep(1200);
  const afterToolbar = await state();
  check('кнопка «Шрифты» есть на панели и работает', toolbarClicked === true && afterToolbar.fonts === true, JSON.stringify(afterToolbar));
  await cdp.screenshot(resolvePath(TMP, 'font-ui-toolbar.png'));

  console.log('\n4. Окно экспорта: переход к управлению шрифтами');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeAllModals(); 'ok'`);
  await sleep(600);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await sleep(1500);
  const exportState = await state();
  check('окно экспорта открылось по Ctrl+E', exportState.exporter === true, JSON.stringify(exportState));

  // Диагностика: какие кнопки видны в окне экспорта.
  const exportButtons = await cdp.evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('[role=dialog]'));
    return {
      dialogs: dialogs.map((d) => (d.textContent || '').trim().slice(0, 40)),
      buttons: dialogs.flatMap((dialog) =>
        Array.from(dialog.querySelectorAll('button')).map((b) => (b.textContent || '').trim().slice(0, 40)),
      ),
    };
  })()`);
  console.log('  кнопки в окне экспорта:', JSON.stringify(exportButtons));

  const fontsFromExport = await clickInDialog('Экспорт', 'Управление шрифтами');
  console.log('  клик по «Управление шрифтами»:', fontsFromExport);
  await sleep(1200);
  const afterExportFonts = await state();
  check('из окна экспорта открывается управление шрифтами', fontsFromExport === true && afterExportFonts.fonts === true, JSON.stringify(afterExportFonts));
  check('окно экспорта при этом закрылось', afterExportFonts.exporter === false, JSON.stringify(afterExportFonts));

  console.log('\n5. Главная страница: кнопка «Шрифты»');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeAllModals(); location.hash = '#/'; 'ok'`);
  await sleep(2500);
  const startState = await state();
  check('при переходе на главную окна закрылись', startState.fonts === false, JSON.stringify(startState));
  const startClicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('header button[title="Шрифты"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const afterStart = await state();
  check('с главной страницы окно шрифтов открывается', startClicked === true && afterStart.fonts === true, JSON.stringify(afterStart));

  console.log('\n6. Горячая клавиша Ctrl+Shift+F');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeAllModals(); 'ok'`);
  await sleep(500);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F', code: 'KeyF', modifiers: 10, windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F', code: 'KeyF', modifiers: 10, windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 });
  await sleep(1200);
  const afterHotkey = await state();
  check('Ctrl+Shift+F открывает окно шрифтов', afterHotkey.fonts === true, JSON.stringify(afterHotkey));

  console.log('\n7. Окно экспорта без открытого документа');
  // Перезагружаем приложение: документ не загружен, редактор показывает пустое состояние.
  await cdp.send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(3500);
  const emptyEditor = await cdp.evaluate(`(() => ({
    isLoaded: window.__PDF_EDITOR__.pdf.isLoaded,
    path: location.hash,
  }))()`);
  console.log('  редактор без документа:', JSON.stringify(emptyEditor));
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('export'); 'ok'`);
  await sleep(1500);
  const emptyExport = await cdp.evaluate(`(() => {
    const dialog = Array.from(document.querySelectorAll('[role=dialog]'))
      .find((element) => /Экспорт/.test(element.textContent || ''));
    if (!dialog) return { dialog: false };
    const buttons = Array.from(dialog.querySelectorAll('button'))
      .map((element) => (element.textContent || '').trim())
      .filter(Boolean);
    return { dialog: true, buttons };
  })()`);
  console.log('  кнопки в пустом окне экспорта:', JSON.stringify(emptyExport.buttons));
  check(
    'в пустом окне экспорта есть кнопка «Шрифты»',
    emptyExport.dialog === true && (emptyExport.buttons || []).includes('Шрифты'),
    JSON.stringify(emptyExport.buttons),
  );
  const fontsFromEmpty = await clickInDialog('Экспорт', 'Шрифты');
  await sleep(1200);
  const afterEmpty = await state();
  check('из пустого окна экспорта открывается управление шрифтами', fontsFromEmpty === true && afterEmpty.fonts === true, JSON.stringify(afterEmpty));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
