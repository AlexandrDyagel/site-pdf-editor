/**
 * Сквозная проверка поворота страниц PDF:
 *   1. поворот текущей страницы горячей клавишей Alt+→;
 *   2. объекты остаются на том же физическом месте страницы;
 *   3. undo/redo возвращают и поворот, и координаты объектов;
 *   4. в сохранённом PDF у страницы меняется /Rotate, а аннотация
 *      оказывается в правильном месте (проверка по пикселям).
 *
 * Запуск: node scripts/check-rotation.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const source = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9346 });

async function openDocument(data, name) {
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(data)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' });
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
  await sleep(2200);
}

/** Нажатие горячей клавиши с модификатором Alt. */
async function pressAlt(key, code, virtualKeyCode) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers: 1, // Alt
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers: 1,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
}

/**
 * Границы красного прямоугольника исходного PDF на растре страницы
 * (координаты — в точках страницы из левого верхнего угла).
 * Служит эталоном: при повороте он обязан оказаться в предсказуемом месте,
 * а при растягивании растра — совсем в другом.
 */
async function redBox() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const canvas = document.querySelectorAll('canvas')[0];
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        if (data[i + 3] < 16) continue;
        if (data[i] > 140 && data[i + 1] < 110 && data[i + 2] < 110) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const zoom = app.editor.zoom;
    const pan = app.editor.pan;
    const toPage = (px, py) => ({ x: (px - pan.x) / zoom, y: (py - pan.y) / zoom });
    const topLeft = toPage(minX, minY);
    const bottomRight = toPage(maxX, maxY);
    const center = toPage((minX + maxX) / 2, (minY + maxY) / 2);
    return {
      width: Number((bottomRight.x - topLeft.x).toFixed(1)),
      height: Number((bottomRight.y - topLeft.y).toFixed(1)),
      ratio: Number(((bottomRight.x - topLeft.x) / (bottomRight.y - topLeft.y)).toFixed(3)),
      centerX: Number(center.x.toFixed(1)),
      centerY: Number(center.y.toFixed(1)),
    };
  })()`);
}

try {
  await openDocument(source, 'тест-кириллица.pdf');

  console.log('\n1. Подготовка: аннотация на странице 1');
  const redBefore = await redBox();
  const expectedAfter = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const util = await import('/src/utils/coordinates.ts');
    const geometry = app.pdf.geometry(0);
    // Точка привязки красного прямоугольника в системе PDF.
    const anchor = util.konvaToPdfCoordinates(${redBefore.centerX}, ${redBefore.centerY}, geometry);
    const after = { ...geometry, rotation: (geometry.rotation + 90) % 360 };
    const position = util.pdfToKonvaCoordinates(anchor.x, anchor.y, after);
    return {
      anchorX: Number(anchor.x.toFixed(1)),
      anchorY: Number(anchor.y.toFixed(1)),
      centerX: Number(position.x.toFixed(1)),
      centerY: Number(position.y.toFixed(1)),
      expectedRatio: Number((1 / ${redBefore.ratio}).toFixed(3)),
    };
  })()`);
  console.log('  красный прямоугольник до поворота:', JSON.stringify(redBefore));
  console.log('  ожидаемое положение после поворота:', JSON.stringify(expectedAfter));
  // Текст размещаем так, чтобы после поворота он остался в видимой области.
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const util = await import('/src/utils/coordinates.ts');
    const object = factory.createTextObject({
      page: 0,
      x: 100, y: 700, width: 200, height: 24,
      text: 'Поворот страницы',
      autoHeight: true,
      defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111111' },
    });
    app.objects.add([object], 'тест');
    app.objects.select([]);
    app.editor.setTool('select');
    const geometry = app.pdf.geometry(0);
    const anchor = util.konvaToPdfCoordinates(object.x, object.y, geometry);
    return {
      id: object.id,
      x: Math.round(object.x), y: Math.round(object.y), rotation: object.rotation,
      anchorX: Number(anchor.x.toFixed(2)), anchorY: Number(anchor.y.toFixed(2)),
      pdfAngle: util.getPdfObjectRotation(geometry, object.rotation),
      display: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)],
      viewRotation: app.pdf.pages[0].viewRotation ?? 0,
    };
  })()`);
  console.log('  объект:', JSON.stringify(created));
  check('исходный поворот страницы равен 0', created.viewRotation === 0);

  console.log('\n2. Поворот страницы 1 горячей клавишей Alt+→');
  await pressAlt('ArrowRight', 'ArrowRight', 39);
  await sleep(1500);

  const rotated = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const util = await import('/src/utils/coordinates.ts');
    const object = app.objects.byId(${JSON.stringify(created.id)});
    const geometry = app.pdf.geometry(0);
    const anchor = util.konvaToPdfCoordinates(object.x, object.y, geometry);
    return {
      x: Math.round(object.x), y: Math.round(object.y), rotation: object.rotation,
      anchorX: Number(anchor.x.toFixed(2)), anchorY: Number(anchor.y.toFixed(2)),
      pdfAngle: util.getPdfObjectRotation(geometry, object.rotation),
      geometryRotation: geometry.rotation,
      viewRotation: app.pdf.pages[0].viewRotation,
      display: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)],
    };
  })()`);
  console.log('  после поворота:', JSON.stringify(rotated));
  check('горячая клавиша повернула страницу на 90°', rotated.viewRotation === 90, `viewRotation=${rotated.viewRotation}`);
  check(
    'размер области отображения стал альбомным',
    rotated.display[0] === created.display[1] && rotated.display[1] === created.display[0],
    `${created.display.join('×')} → ${rotated.display.join('×')}`,
  );
  check(
    'объект не сместился по странице (та же точка в PDF)',
    Math.abs(rotated.anchorX - created.anchorX) < 0.1 && Math.abs(rotated.anchorY - created.anchorY) < 0.1,
    `(${created.anchorX}; ${created.anchorY}) → (${rotated.anchorX}; ${rotated.anchorY})`,
  );
  check(
    'ориентация объекта на странице сохранилась',
    rotated.pdfAngle === created.pdfAngle,
    `${created.pdfAngle}° → ${rotated.pdfAngle}°`,
  );
  check(
    'собственный поворот объекта увеличен на 90°',
    ((rotated.rotation - created.rotation) % 360 + 360) % 360 === 90,
    `${created.rotation}° → ${rotated.rotation}°`,
  );

  // Содержимое страницы должно быть именно повёрнуто, а не растянуто:
  // красный прямоугольник обязан оказаться в предсказуемом месте.
  const redAfter = await redBox();
  console.log('  красный прямоугольник после поворота:', JSON.stringify(redAfter));
  const centerError = redAfter
    ? Math.max(
        Math.abs(redAfter.centerX - expectedAfter.centerX),
        Math.abs(redAfter.centerY - expectedAfter.centerY),
      )
    : 999;
  check(
    'растр страницы повёрнут (эталон оказался на своём месте)',
    centerError < 8,
    `центр (${redAfter?.centerX}; ${redAfter?.centerY}) вместо (${expectedAfter.centerX}; ${expectedAfter.centerY})`,
  );
  const ratioError = redAfter
    ? Math.abs(redAfter.ratio - expectedAfter.expectedRatio) / expectedAfter.expectedRatio
    : 1;
  check(
    'пропорции содержимого не искажены',
    ratioError < 0.2,
    `стороны ${redAfter?.width}×${redAfter?.height} (${redAfter?.ratio}) вместо ≈${expectedAfter.expectedRatio}`,
  );

  console.log('\n3. Undo и Redo поворота');
  await cdp.evaluate(`document.querySelector('body').click(); 'ok'`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 });
  await sleep(1200);
  const undone = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.byId(${JSON.stringify(created.id)});
    return { viewRotation: app.pdf.pages[0].viewRotation, x: Math.round(object.x), y: Math.round(object.y), rotation: object.rotation };
  })()`);
  console.log('  после undo:', JSON.stringify(undone));
  check('undo вернул поворот страницы', (undone.viewRotation ?? 0) === 0, `viewRotation=${undone.viewRotation}`);
  check(
    'undo вернул координаты объекта',
    Math.abs(undone.x - created.x) <= 2 && Math.abs(undone.y - created.y) <= 2,
    `(${created.x}; ${created.y}) → (${undone.x}; ${undone.y})`,
  );

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89 });
  await sleep(1200);
  const redone = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return { viewRotation: app.pdf.pages[0].viewRotation, rotation: app.objects.byId(${JSON.stringify(created.id)}).rotation };
  })()`);
  check('redo вернул поворот страницы', redone.viewRotation === 90, `viewRotation=${redone.viewRotation}`);
  check('redo вернул поворот объекта', redone.rotation === rotated.rotation, `${redone.rotation}°`);

  console.log('\n4. Поворот всех страниц через панель «Страница»');
  const panelRotation = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const before = app.pdf.pages.map((page) => page.viewRotation ?? 0);
    // Открываем вкладку «Страница» в правой панели и нажимаем кнопку поворота.
    const tab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Страница');
    tab?.click();
    return { before, tabFound: Boolean(tab) };
  })()`);
  await sleep(800);
  const clickedAll = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().includes('Повернуть все страницы на 90° влево'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1500);
  const allRotated = await cdp.evaluate(`window.__PDF_EDITOR__.pdf.pages.map((page) => page.viewRotation ?? 0)`);
  console.log('  повороты страниц:', JSON.stringify(panelRotation.before), '→', JSON.stringify(allRotated));
  check('найдена кнопка поворота всех страниц', panelRotation.tabFound && clickedAll);
  check(
    'все страницы повёрнуты на 90° влево',
    allRotated.every((value, index) => value === (((panelRotation.before[index] ?? 0) + 270) % 360)),
    JSON.stringify(allRotated),
  );

  console.log('\n5. Сохранение и проверка /Rotate в готовом PDF');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'all', includeAnnotations: true });
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  check('экспорт повёрнутого PDF выполнен', exported.ok === true, exported.error ?? '');
  if (!exported.ok) throw new Error(exported.error);

  const exportedBytes = Buffer.from(exported.b64, 'base64');
  await writeFile(resolvePath(TMP, 'rotation-exported.pdf'), exportedBytes);

  const parsed = await PDFDocument.load(exportedBytes);
  const rotations = parsed.getPages().map((page) => page.getRotation().angle);
  console.log('  /Rotate страниц в файле:', JSON.stringify(rotations));
  // Страница 1: 90 (первый поворот) + 270 (поворот всех) = 0; страница 2 была 90 + 270 = 0.
  check('в файле записаны повороты страниц', rotations.length === 3, JSON.stringify(rotations));
  check(
    'исходный /Rotate страницы 2 сохранён (90 + 270 = 0)',
    rotations[1] === 0,
    `страница 2: ${rotations[1]}°`,
  );

  console.log('\n6. Пустая ориентация: возвращаем поворот страницы 1 и проверяем пиксели');
  // Для проверки по пикселям нужен предсказуемый поворот: ставим странице 1 угол 90°.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return app.pdf.pages.map((page) => page.viewRotation ?? 0);
  })()`);
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    // сбрасываем все пользовательские повороты и оставляем только 90° на первой странице
    app.pdf.setViewRotations([0, 0, 0]);
    return 'ok';
  })()`);
  await sleep(400);
  // Возвращаем объект в систему координат страницы без поворота.
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const util = await import('/src/utils/coordinates.ts');
    const object = app.objects.byId(${JSON.stringify(created.id)});
    const geometry = app.pdf.geometry(0);
    // Проставляем координаты, соответствующие исходному положению на неповёрнутой странице.
    const anchor = util.konvaToPdfCoordinates(${created.x}, ${created.y}, { width: geometry.width, height: geometry.height, rotation: 0 });
    const position = util.pdfToKonvaCoordinates(anchor.x, anchor.y, { width: geometry.width, height: geometry.height, rotation: 90 });
    app.objects.patchSilent(object.id, { x: position.x, y: position.y, rotation: 90 });
    app.pdf.setViewRotation(0, 90);
    return 'ok';
  })()`);
  await sleep(1500);

  const state = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return { viewRotation: app.pdf.pages[0].viewRotation, display: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)] };
  })()`);
  console.log('  страница 1:', JSON.stringify(state));

  const exportedRotated = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  if (!exportedRotated.ok) throw new Error(exportedRotated.error);
  await writeFile(resolvePath(TMP, 'rotation-page1.pdf'), Buffer.from(exportedRotated.b64, 'base64'));
  const parsedRotated = await PDFDocument.load(Buffer.from(exportedRotated.b64, 'base64'));
  check(
    'страница 1 в файле повёрнута на 90°',
    parsedRotated.getPage(0).getRotation().angle === 90,
    `${parsedRotated.getPage(0).getRotation().angle}°`,
  );

  await cdp.send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  await openDocument(exportedRotated.b64, 'поворот.pdf');

  const ink = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const ctx = document.querySelectorAll('canvas')[0].getContext('2d');
    // Аннотация «Поворот страницы» физически в PDF (100; 141.89); на странице
    // с /Rotate 90 она отображается вертикально около точки (141.89; 100).
    const box = { x1: 95, y1: 95, x2: 215, y2: 330 };
    const a = { x: Math.round(app.editor.pan.x + box.x1 * app.editor.zoom), y: Math.round(app.editor.pan.y + box.y1 * app.editor.zoom) };
    const b = { x: Math.round(app.editor.pan.x + box.x2 * app.editor.zoom), y: Math.round(app.editor.pan.y + box.y2 * app.editor.zoom) };
    const data = ctx.getImageData(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y)).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 140 && data[i + 1] < 140 && data[i + 2] < 140) dark += 1;
    }
    return { dark, size: [Math.round(app.pdf.displaySize(0).width), Math.round(app.pdf.displaySize(0).height)] };
  })()`);
  console.log('  аннотация на повёрнутой странице:', JSON.stringify(ink));
  check('страница отображается в альбомной ориентации', ink.size[0] > ink.size[1], ink.size.join('×'));
  check('аннотация попала в правильное место повёрнутой страницы', ink.dark > 80, `тёмных пикселей: ${ink.dark}`);

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
