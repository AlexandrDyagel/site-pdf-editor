/**
 * Сквозная проверка рабочих сценариев в реальном браузере:
 *  1. загрузка PDF и отрисовка страницы;
 *  2. добавление русского текста (реальный клик + ввод с клавиатуры);
 *  3. вставка штампа из библиотеки;
 *  4. рисование от руки;
 *  5. undo / redo;
 *  6. экспорт PDF, PNG и проекта JSON;
 *  7. повторное открытие экспортированного PDF и проверка,
 *     что аннотация действительно попала в файл в нужное место.
 *
 * Запуск: node scripts/browser-workflow.mjs [url]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launchBrowser, report, sleep } from './lib/cdp.mjs';

const URL_APP = process.argv[2] ?? 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
const PDF_PATH = resolvePath(TMP, 'test.pdf');

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

if (!existsSync(PDF_PATH)) {
  console.error('Нет тестового PDF. Запустите: node scripts/make-test-pdf.mjs');
  process.exit(1);
}

await mkdir(TMP, { recursive: true });
const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9334 });

try {
  console.log('1. Загрузка документа');
  const base64 = (await readFile(PDF_PATH)).toString('base64');
  await cdp.evaluate(`window.__TEST_PDF = ${JSON.stringify(base64)}; 'ok'`);
  const injected = await cdp.evaluate(`(() => {
    const binary = atob(window.__TEST_PDF);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест-кириллица.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    if (!input) return 'нет input[type=file]';
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check('файл передан в приложение', injected === 'ok', injected);

  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);

  const initialState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      hasHook: Boolean(app),
      pages: app?.pdf.pageCount ?? 0,
      loaded: app?.pdf.isLoaded ?? false,
      objects: app?.objects.objects.length ?? -1,
      libraryItems: app?.library.items.length ?? 0,
      fonts: app?.fonts.fonts.length ?? 0,
    };
  })()`);
  console.log('   состояние:', JSON.stringify(initialState));
  check('доступ к сторам (dev-хук) есть', initialState.hasHook);
  check('документ загружен, 3 страницы', initialState.loaded && initialState.pages === 3);
  check('шрифты загружены', initialState.fonts >= 5, `шрифтов: ${initialState.fonts}`);
  check('библиотека заполнена образцами', initialState.libraryItems >= 4, `элементов: ${initialState.libraryItems}`);

  const canvasRect = await cdp.evaluate(`(() => {
    const canvas = document.querySelector('[data-testid=editor-canvas]');
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);

  /** Экранные координаты для точки страницы (pt). */
  async function screenPointFor(pageX, pageY) {
    const point = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      return {
        x: rect.left + app.editor.pan.x + ${pageX} * app.editor.zoom,
        y: rect.top + app.editor.pan.y + ${pageY} * app.editor.zoom,
      };
    })()`);
    return point;
  }

  console.log('\n2. Добавление русского текста (инструмент «Текст»)');
  // Ставим шрифтом по умолчанию PT Mono: его нет в исходном PDF, поэтому
  // по готовому файлу сразу видно, что приложение встроило свой шрифт.
  await cdp.evaluate(`window.__PDF_EDITOR__.settings.update({ defaultFontId: 'pt-mono' }); 'ok'`);
  await cdp.pressKey('t', 'KeyT', 84);
  await sleep(400);
  const toolAfterKey = await cdp.evaluate(`window.__PDF_EDITOR__.editor.tool`);
  check('горячая клавиша T выбрала инструмент «Текст»', toolAfterKey === 'text', toolAfterKey);

  const textPoint = await screenPointFor(120, 260);
  await cdp.click(textPoint.x, textPoint.y);
  await sleep(1200);

  const afterClick = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const obj = app.objects.objects[0];
    return {
      count: app.objects.objects.length,
      type: obj?.type ?? null,
      editing: Boolean(app.editor.editingTextId),
      textareas: document.querySelectorAll('textarea').length,
      rightTab: app.ui.rightTab,
    };
  })()`);
  check('клик создал текстовый объект', afterClick.count === 1 && afterClick.type === 'text', JSON.stringify(afterClick));
  check(
    'панель свойств показала поле редактирования текста',
    afterClick.textareas >= 1 && afterClick.rightTab === 'properties',
    JSON.stringify(afterClick),
  );

  await cdp.send('Input.insertText', { text: 'Проверка кириллицы: Ёжик, №5' });
  await sleep(900);

  const textState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const obj = app.objects.objects[0];
    return { text: obj?.payload.text ?? '', fontSize: obj?.payload.fontSize ?? 0, fontId: obj?.payload.fontId ?? '', family: obj?.payload.fontFamily ?? '' };
  })()`);
  check(
    'текст введён и сохранён в объекте',
    textState.text === 'Проверка кириллицы: Ёжик, №5',
    JSON.stringify(textState),
  );
  check(
    'использован выбранный шрифт с кириллицей (PT Mono)',
    textState.fontId === 'pt-mono',
    JSON.stringify(textState),
  );
  await cdp.screenshot(resolvePath(TMP, '10-text.png'));

  console.log('\n3. Вставка штампа из библиотеки');
  const stampResult = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const stamp = app.library.stamps[0];
    if (!stamp) return { ok: false, error: 'нет штампов в библиотеке' };
    const { createStampObject } = await import('/src/services/objectFactory.ts');
    const object = createStampObject(stamp, {
      page: app.editor.currentPage,
      x: 120,
      y: 420,
      templateId: stamp.id,
    });
    app.objects.add([object], 'Добавление штампа (проверка)');
    return { ok: true, name: stamp.name, kind: stamp.kind, count: app.objects.objects.length };
  })()`);
  check('штамп добавлен из библиотеки', stampResult.ok === true, JSON.stringify(stampResult));
  await sleep(600);
  const stampType = await cdp.evaluate(`window.__PDF_EDITOR__.objects.objects.map((o) => o.type).join(',')`);
  check('в документе есть текстовый объект и штамп', stampType.includes('text') && stampType.includes('stamp'), stampType);

  console.log('\n4. Рисование от руки (инструмент «Кисть»)');
  // Снимаем фокус с текстового поля: пока идёт ввод, горячие клавиши
  // намеренно не срабатывают (это ожидаемое поведение приложения).
  await cdp.evaluate(`document.activeElement?.blur?.(); 'ok'`);
  await sleep(200);
  await cdp.pressKey('b', 'KeyB', 66);
  await sleep(300);
  const brushTool = await cdp.evaluate(`window.__PDF_EDITOR__.editor.tool`);
  check('горячая клавиша B выбрала инструмент «Кисть»', brushTool === 'brush', brushTool);

  // Записываем события указателя на документе, чтобы видеть всю картину.
  await cdp.evaluate(`(() => {
    window.__EVENTS = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      document.addEventListener(type, () => window.__EVENTS.push(type), true);
    }
    return 'ok';
  })()`);

  // Точки внутри видимой области: высота холста 824 px при зуме ~1.8,
  // поэтому берём y не больше ~400 pt, иначе клик уйдёт за пределы окна.
  const drawStart = await screenPointFor(120, 330);
  const drawEnd = await screenPointFor(300, 380);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drawStart.x, y: drawStart.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drawStart.x, y: drawStart.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(120);
  const afterPress = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      tool: app.editor.tool,
      activeStroke: app.editor.activeStroke ? app.editor.activeStroke.points.length : null,
      viewOnly: app.editor.viewOnly,
      spacePressed: app.editor.spacePressed,
      events: (window.__EVENTS || []).slice(0, 6),
    };
  })()`);
  console.log('   после нажатия:', JSON.stringify(afterPress));

  for (let i = 1; i <= 10; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: drawStart.x + ((drawEnd.x - drawStart.x) * i) / 10,
      y: drawStart.y + ((drawEnd.y - drawStart.y) * i) / 10,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(20);
  }
  const midDrag = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      points: app.editor.activeStroke ? app.editor.activeStroke.points.length : null,
      events: (window.__EVENTS || []).length,
    };
  })()`);
  console.log('   во время рисования:', JSON.stringify(midDrag));

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drawEnd.x, y: drawEnd.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);
  const drawingCount = await cdp.evaluate(
    `window.__PDF_EDITOR__.objects.objects.filter((o) => o.type === 'drawing').length`,
  );
  check('штрих от руки создан', drawingCount === 1, `рисунков: ${drawingCount}`);
  await cdp.screenshot(resolvePath(TMP, '11-objects.png'));

  console.log('\n5. Undo / Redo');
  const beforeUndo = await cdp.evaluate(`window.__PDF_EDITOR__.objects.objects.length`);
  const undone = await cdp.evaluate(`window.__PDF_EDITOR__.objects.undo(), window.__PDF_EDITOR__.objects.objects.length`);
  check('undo удалил последний объект', undone === beforeUndo - 1, `${beforeUndo} → ${undone}`);
  const redone = await cdp.evaluate(`window.__PDF_EDITOR__.objects.redo(), window.__PDF_EDITOR__.objects.objects.length`);
  check('redo вернул объект', redone === beforeUndo, `${undone} → ${redone}`);

  console.log('\n6. Экспорт PDF');
  const pdfExport = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'all', includeAnnotations: true, includeOriginalContent: true });
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      ok: true,
      fileName: result.fileName,
      size: result.size,
      warnings: result.warnings,
      b64: btoa(binary),
    };
  })()`);
  check('экспорт PDF выполнен', pdfExport.ok === true, pdfExport.error ?? '');
  if (pdfExport.ok) {
    const exported = Buffer.from(pdfExport.b64, 'base64');
    await writeFile(resolvePath(TMP, 'exported.pdf'), exported);
    const doc = await PDFDocument.load(exported);
    check('в экспортированном PDF 3 страницы', doc.getPageCount() === 3, String(doc.getPageCount()));
    check('метаданные в Unicode', doc.getTitle() === 'Тестовый документ', String(doc.getTitle()));

    // Проверяем встраивание шрифтов по графу объектов pdf-lib
    // (сырые байты PDF сжаты объектными потоками, поэтому поиск строки не работает).
    const entries = Array.from(doc.context.enumerateIndirectObjects());
    let fontFiles = 0;
    const baseFonts = [];
    for (const [, obj] of entries) {
      const dict = obj?.dict ?? (typeof obj?.get === 'function' ? obj : null);
      if (!dict || typeof dict.get !== 'function') continue;
      const type = dict.get(PDFName.of('Type'));
      const subtype = dict.get(PDFName.of('Subtype'));
      const baseFont = dict.get(PDFName.of('BaseFont'));
      if (String(subtype) === '/FontFile2' || String(subtype) === '/FontFile3') fontFiles += 1;
      if (
        String(type) === '/FontDescriptor' &&
        (dict.get(PDFName.of('FontFile2')) || dict.get(PDFName.of('FontFile3')))
      ) {
        fontFiles += 1;
      }
      if (baseFont) baseFonts.push(String(baseFont));
    }
    const mono = baseFonts.filter((name) => /PTMono/i.test(name.replace(/\s/g, '')));
    console.log(
      `   объектов: ${entries.length}; шрифтовых программ: ${fontFiles}; шрифты: ${[...new Set(baseFonts)].join(', ')}`,
    );
    check('в PDF встроены файлы шрифтов', fontFiles >= 2, `шрифтовых программ: ${fontFiles}`);
    check(
      'в PDF встроен шрифт PT Mono, которого не было в исходном документе',
      mono.length > 0,
      `найдено: ${mono.join(', ') || 'ничего'}`,
    );
    check('размер вырос относительно исходного', exported.length > (await readFile(PDF_PATH)).length);
    console.log(`   файл: ${pdfExport.fileName}, ${(exported.length / 1024).toFixed(1)} КБ`);
    if (pdfExport.warnings?.length) console.log('   предупреждения:', pdfExport.warnings.join(' | '));
  }

  console.log('\n7. Экспорт PNG текущей страницы');
  const pngExport = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('png');
    app.exporter.update({ pageRange: 'current', dpi: 150, scale: 2, transparentBackground: false, zip: false, singleImage: false });
    const result = await app.exporter.run({ download: false });
    return { ok: result.ok, size: result.size, fileName: result.fileName, error: result.error };
  })()`);
  check('PNG создан', pngExport.ok === true && pngExport.size > 10000, JSON.stringify(pngExport));

  console.log('\n8. Экспорт проекта JSON');
  const projectExport = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const result = app.exporter.exportProject(true);
    return { ok: result.ok, size: result.size, fileName: result.fileName, objects: app.objects.objects.length };
  })()`);
  check('проект JSON сформирован', projectExport.ok === true && projectExport.size > 10000, JSON.stringify(projectExport));

  console.log('\n9. Обратное открытие экспортированного PDF: аннотация внутри файла');
  const exportedB64 = pdfExport.ok ? pdfExport.b64 : null;
  if (exportedB64) {
    // Запоминаем геометрию текстового объекта и экранные координаты до перезагрузки.
    const target = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const obj = app.objects.objects.find((o) => o.type === 'text');
      return obj ? { id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height } : null;
    })()`);

    await cdp.evaluate(`window.__EXPORTED_PDF = ${JSON.stringify(exportedB64)}; 'ok'`);
    await cdp.send('Page.navigate', { url: URL_APP });
    await sleep(4000);
    // Внимание: после перехода страница загружается заново, поэтому данные
    // передаём в контекст уже новой страницы.
    const injectedAgain = await cdp.evaluate(`(() => {
      const binary = atob(${JSON.stringify(exportedB64)});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'экспорт.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      if (!input) return 'нет input[type=file]';
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    check('экспортированный PDF передан в приложение', injectedAgain === 'ok', String(injectedAgain));
    await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
    await sleep(6500);
    await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
    await sleep(2500);

    const pixels = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      const canvas = document.querySelectorAll('canvas')[0];
      const ctx = canvas.getContext('2d');
      const toCanvas = (px, py) => ({
        x: Math.round(app.editor.pan.x + px * app.editor.zoom),
        y: Math.round(app.editor.pan.y + py * app.editor.zoom),
      });
      const box = ${JSON.stringify(target)};
      const topLeft = toCanvas(box.x, box.y);
      const bottomRight = toCanvas(box.x + box.width, box.y + box.height);
      const width = Math.max(1, bottomRight.x - topLeft.x);
      const height = Math.max(1, bottomRight.y - topLeft.y);
      const data = ctx.getImageData(topLeft.x, topLeft.y, width, height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) dark += 1;
      }
      const stampBox = toCanvas(120, 420);
      const stampData = ctx.getImageData(stampBox.x, stampBox.y, 120, 60).data;
      let stampInk = 0;
      for (let i = 0; i < stampData.length; i += 4) {
        if (stampData[i] < 200) stampInk += 1;
      }
      void rect;
      return { darkPixelsInTextArea: dark, coloredPixelsInStampArea: stampInk, zoom: app.editor.zoom };
    })()`);
    console.log('   пиксели:', JSON.stringify(pixels));
    // Порог подобран по измерениям: полная строка из 26 символов даёт
    // больше 1000 тёмных пикселей, повреждённое подмножество — около 140.
    check(
      'русский текст полностью присутствует в готовом PDF',
      pixels.darkPixelsInTextArea > 500,
      `тёмных пикселей: ${pixels.darkPixelsInTextArea}`,
    );
    check(
      'штамп присутствует в готовом PDF',
      pixels.coloredPixelsInStampArea > 100,
      `пикселей штампа: ${pixels.coloredPixelsInStampArea}`,
    );
    await cdp.screenshot(resolvePath(TMP, '12-reopened.png'));
  }

  console.log('\n10. Интерфейс на русском и состояния');
  const uiText = await cdp.evaluate(`document.body.innerText`);
  check('интерфейс на русском', /Страницы|Библиотека|Свойства|Экспорт/.test(uiText));
  check('нет английских подписей кнопок', !/\bSave\b|\bExport\b|\bOpen file\b/.test(uiText));
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  report(cdp, { requireNoErrors: false });
  close();
}

console.log(`\nСценариев пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
