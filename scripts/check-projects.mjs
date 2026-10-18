/**
 * Проверка сохранения проекта в браузере (кнопка «Сохранить»).
 *
 *   1. «Сохранить» пишет проект в IndexedDB (а не скачивает PDF);
 *   2. на главной странице проект появляется в блоке «Локальные проекты»;
 *   3. проект открывается обратно в редактор вместе с объектами;
 *   4. повторное сохранение обновляет тот же проект, а не создаёт второй.
 *
 * Запуск: node scripts/check-projects.mjs
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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9385 });

/** Очистка сохранённых проектов перед проверкой. */
async function clearProjects() {
  return cdp.evaluate(`(async () => {
    const { storageService } = await import('/src/services/storageService.ts');
    const list = await storageService.projectList();
    for (const project of list) await storageService.projectDelete(project.id);
    return list.length;
  })()`);
}

async function openTestPdf() {
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
}

/** Список проектов из IndexedDB. */
async function projectsFromDb() {
  return cdp.evaluate(`(async () => {
    const { storageService } = await import('/src/services/storageService.ts');
    return storageService.projectList();
  })()`);
}

async function clickSelector(selector) {
  return cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
}

try {
  await clearProjects();

  console.log('\n1. Сохранение проекта кнопкой «Сохранить»');
  await openTestPdf();
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const text = factory.createTextObject({
      page: 0, x: 120, y: 160, width: 200, height: 24, text: 'Проект сохраняется локально', autoHeight: true,
      defaults: {
        fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 15, color: '#111827',
        bold: false, italic: false, align: 'left', lineHeight: 1.25, letterSpacing: 0,
      },
    });
    app.objects.add([text], 'тест');
    app.objects.select([]);
    return 'ok';
  })()`);
  await sleep(900);

  const saveClicked = await clickSelector('[data-testid=toolbar-save]');
  check('кнопка «Сохранить» найдена в шапке', saveClicked === true);
  await sleep(1500);

  const saved = await projectsFromDb();
  console.log('  проекты после сохранения:', JSON.stringify(saved.map((item) => ({ id: item.id, name: item.fileName, objects: item.objects }))));
  check('в хранилище появился проект', saved.length === 1, String(saved.length));
  check('в проекте есть объект', saved[0]?.objects === 1, String(saved[0]?.objects));
  check('имя проекта — имя документа', saved[0]?.fileName === 'тест.pdf', String(saved[0]?.fileName));

  const toast = await cdp.evaluate(`(() => {
    const text = document.body.innerText || '';
    return text.includes('Проект сохранён в браузере') || text.includes('Проект обновлён');
  })()`);
  check('показано уведомление о сохранении', toast === true);

  console.log('\n2. Проект виден на главной странице');
  await cdp.evaluate(`location.hash = '#/'; 'ok'`);
  await sleep(1800);
  const home = await cdp.evaluate(`(() => {
    const text = document.body.innerText || '';
    return {
      hasProjectsBlock: text.includes('Локальные проекты'),
      hasProject: text.includes('тест.pdf'),
      hasObjects: text.includes('1 объектов') || text.includes('1 объект'),
      emptyText: text.includes('Сохраните документ в редакторе'),
    };
  })()`);
  console.log('  главная:', JSON.stringify(home));
  check('блок «Локальные проекты» есть', home.hasProjectsBlock === true);
  check('проект показан в списке', home.hasProject === true);
  check('пустое состояние исчезло', home.emptyText === false);

  console.log('\n3. Проект открывается обратно');
  const opened = await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((button) => (button.innerText || '').includes('тест.pdf'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  check('строка проекта кликабельна', opened === true);
  await sleep(4000);
  const restored = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      path: location.hash,
      objects: app.objects.objects.length,
      texts: app.objects.objects.map((object) => (object.payload && object.payload.text) || ''),
      projectId: app.pdf.currentProjectId,
    };
  })()`);
  console.log('  после открытия:', JSON.stringify(restored));
  check('открылся редактор', restored.path.includes('/editor'), restored.path);
  check('объекты восстановлены', restored.objects === 1, String(restored.objects));
  check('текст объекта совпадает', restored.texts[0] === 'Проект сохраняется локально', String(restored.texts[0]));
  check('документ связан с проектом', typeof restored.projectId === 'string', String(restored.projectId));

  console.log('\n4. Повторное сохранение обновляет проект');
  await clickSelector('[data-testid=toolbar-save]');
  await sleep(1500);
  const again = await projectsFromDb();
  console.log('  проектов после второго сохранения:', again.length);
  check('второго проекта не появилось', again.length === 1, String(again.length));

  await cdp.screenshot(resolvePath(TMP, 'projects-saved.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  await clearProjects().catch(() => {});
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
