/**
 * Регрессионные проверки двух сценариев, о которых сообщил пользователь:
 *
 *  1. КОРРЕКТОР
 *     a) штрих, уходящий за пределы холста, не должен обрываться и теряться;
 *     b) закрашенное должно полностью исчезать в сохранённом PDF
 *        (проверяется по пикселям после повторного открытия файла).
 *
 *  2. ПЕЧАТЬ
 *     новая печать, созданная в конструкторе, должна сохраняться в библиотеку
 *     и добавляться на страницу документа (через реальные клики по кнопкам).
 *
 * Запуск: node scripts/check-corrector.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
const PAGE_HEIGHT = 841.89;
const TEXT_BAND = { x1: 45, x2: 215, y1: 470, y2: 492 };

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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9345 });

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

/** Экранная точка для координат PDF (страница без поворота). */
async function screenPoint(pdfX, pdfY) {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + ${pdfX} * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + (${PAGE_HEIGHT} - ${pdfY}) * app.editor.zoom),
    };
  })()`);
}

/** Количество «чернил» в полосе текста на растре открытого PDF. */
async function inkInTextBand() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const ctx = document.querySelectorAll('canvas')[0].getContext('2d');
    const toCanvas = (x, y) => ({
      x: Math.round(app.editor.pan.x + x * app.editor.zoom),
      y: Math.round(app.editor.pan.y + (${PAGE_HEIGHT} - y) * app.editor.zoom),
    });
    const a = toCanvas(${TEXT_BAND.x1}, ${TEXT_BAND.y2});
    const b = toCanvas(${TEXT_BAND.x2}, ${TEXT_BAND.y1});
    const data = ctx.getImageData(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y)).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink += 1;
    }
    return ink;
  })()`);
}

async function drag(from, to, steps = 20) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(14);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

try {
  await openDocument(source, 'тест-кириллица.pdf');
  const inkBefore = await inkInTextBand();

  /* ---------------- 1. Корректор ---------------- */

  console.log('\n1. Корректор: штрих за пределами холста');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('eraser');
    app.editor.toolOptions.eraser.width = 16;
    return 'ok';
  })()`);
  await sleep(300);

  const canvas = await cdp.evaluate(`(() => {
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  })()`);

  // Первый штрих: начинается в холсте и уходит далеко за его правый край.
  const startOutside = { x: canvas.right - 140, y: canvas.top + 180 };
  const endOutside = { x: canvas.right + 200, y: canvas.top + 250 };
  await drag(startOutside, endOutside, 24);
  await sleep(900);

  const outside = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const drawings = app.objects.objects.filter((o) => o.type === 'drawing');
    return {
      hanging: Boolean(app.editor.activeStroke),
      count: drawings.length,
      points: drawings[0] ? drawings[0].payload.strokes[0].points.length : 0,
      width: drawings[0] ? Math.round(drawings[0].width) : 0,
      zoom: app.editor.zoom,
    };
  })()`);
  check('штрих за краем холста не «зависает»', outside.hanging === false, JSON.stringify(outside));
  check('штрих за краем холста создан', outside.count === 1, `рисунков: ${outside.count}`);
  // Ожидаемая длина = весь жест: 340 экранных пикселей, переведённых в точки.
  const expectedWidth = Math.round((endOutside.x - startOutside.x) / outside.zoom);
  check(
    'штрих записан целиком (не обрезан по краю холста)',
    Math.abs(outside.width - expectedWidth) <= 8,
    `ширина штриха: ${outside.width} pt, ожидалось ≈${expectedWidth} pt`,
  );

  console.log('\n2. Корректор: результат в сохранённом PDF');
  // Второй штрих: закрашиваем полосу с латинским текстом.
  const strokeStart = await screenPoint(40, 481);
  const strokeEnd = await screenPoint(220, 481);
  await drag(strokeStart, strokeEnd, 24);
  await sleep(900);

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
    return { ok: true, b64: btoa(binary), warnings: result.warnings };
  })()`);
  check('экспорт PDF выполнен', exported.ok === true, exported.error ?? '');
  if (!exported.ok) throw new Error(exported.error);

  await writeFile(resolvePath(TMP, 'corrector-exported.pdf'), Buffer.from(exported.b64, 'base64'));
  await cdp.send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  await openDocument(exported.b64, 'экспорт-корректор.pdf');
  const inkAfter = await inkInTextBand();
  check(
    'закрашенный текст исчез в готовом PDF',
    inkAfter <= 8,
    `«чернил» в полосе: ${inkBefore} → ${inkAfter}`,
  );

  /* ---------------- 3. Печать через интерфейс ---------------- */

  console.log('\n3. Печать: сохранение в библиотеку и вставка на страницу');
  const beforeSeals = await cdp.evaluate(`window.__PDF_EDITOR__.library.items.filter((i) => i.type === 'seal').length`);
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('stampEditor', { kind: 'seal' }); 'ok'`);
  await sleep(2200);
  const clicked = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().includes('Вставить на страницу'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('кнопка «Вставить на страницу» доступна', clicked === true);
  await sleep(2500);

  const sealState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      seals: app.library.items.filter((i) => i.type === 'seal').length,
      hasStampObject: app.objects.objects.some((o) => o.type === 'stamp'),
    };
  })()`);
  check('печать сохранена в библиотеку', sealState.seals === beforeSeals + 1, `печатей: ${beforeSeals} → ${sealState.seals}`);
  check('печать добавлена на страницу', sealState.hasStampObject === true);

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
