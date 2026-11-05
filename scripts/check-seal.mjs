/**
 * Проверка «Конструктора круглой печати».
 *
 * Проверяем всю цепочку, ради которой фича делалась:
 *   1. конструктор открывается из панели инструмента «Печать»;
 *   2. превью действительно нарисовано (а не пустой canvas);
 *   3. диаметр 30–60 мм переводится в px и меняет размер печати;
 *   4. количество и толщина колец настраиваются, геометрия пересчитывается;
 *   5. текст по дуге: правка текста, кегля и трекинг меняют раскладку;
 *   6. маркеры на превью растягивают дугу (spanAngle);
 *   7. цвет из пресета и прозрачность попадают в шаблон;
 *   8. «неидеальность» включается/выключается, рисунок краски воспроизводим;
 *   9. «Добавить на документ» создаёт объект нужного размера на странице;
 *  10. объект двигается, вращается, меняет прозрачность, дублируется и
 *      удаляется стандартными средствами редактора;
 *  11. экспорт PDF содержит векторные кольца и текст печати (не картинку).
 *
 * Запуск: pnpm check:seal
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const pdfBase64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9741 });

try {
  /* ------------------------------------------------ загрузка документа */
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(400);
  }
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(pdfBase64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'test.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(400);
    if (await cdp.evaluate(`Boolean(window.__PDF_EDITOR__?.pdfService)`)) break;
  }
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(1800);

  console.log('\n1. Конструктор открывается из панели «Печать»');
  const opened = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('seal');
    app.ui.setRightTab('tool');
    return 'ok';
  })()`);
  await sleep(600);
  const button = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=open-seal-designer]');
    if (!node) return { found: false };
    node.click();
    return { found: true, label: node.textContent.trim() };
  })()`);
  check('кнопка «Конструктор печати» есть в панели инструмента', button.found === true);
  check('подпись кнопки', (button.label ?? '').includes('Конструктор печати'), String(button.label));
  await sleep(1500);

  const initial = await cdp.evaluate(`(() => {
    const t = window.__SEAL_DESIGNER__;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const ctx = canvas?.getContext('2d');
    const data = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
    let painted = 0;
    if (data) for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
    return {
      open: Boolean(document.querySelector('[data-testid=seal-designer]')),
      template: t ? { width: t.width, height: t.height, mm: t.seal.diameterMm, rings: t.seal.rings.length } : null,
      painted,
      hasCanvas: Boolean(canvas),
      handles: document.querySelectorAll('[data-testid^=seal-handle-]').length,
      sizeLabel: document.querySelector('[data-testid=seal-size-label]')?.textContent.trim() ?? '',
    };
  })()`);
  check('окно конструктора открылось', initial.open === true);
  check('превью нарисовано', initial.hasCanvas === true && initial.painted > 2000, `пикселей: ${initial.painted}`);
  check('печать 40 мм = 113 px', initial.template?.mm === 40 && Math.abs(initial.template.width - 113.39) < 0.5,
    JSON.stringify(initial.template));
  check('по умолчанию два кольца', initial.template?.rings === 2, String(initial.template?.rings));
  check('в подписи размера есть миллиметры и пиксели', initial.sizeLabel.includes('40') && initial.sizeLabel.includes('113'),
    initial.sizeLabel);
  check('маркеры растяжения дуг показаны', initial.handles === 4, String(initial.handles));

  console.log('\n2. Диаметр и кольца');
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid=seal-diameter] input');
    input.value = '60';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const afterDiameter = await cdp.evaluate(`(() => {
    const t = window.__SEAL_DESIGNER__;
    return { mm: t.seal.diameterMm, width: t.width, height: t.height };
  })()`);
  check('60 мм = 170 px', afterDiameter.mm === 60 && Math.abs(afterDiameter.width - 170.08) < 0.6,
    JSON.stringify(afterDiameter));
  check('печать квадратная', Math.abs(afterDiameter.width - afterDiameter.height) < 0.01);

  const ringsAdded = await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-rings-3]').click();
    return 'ok';
  })()`);
  await sleep(500);
  const ringState = await cdp.evaluate(`(async () => {
    const seal = await import('/src/services/sealRenderService.ts');
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    return {
      count: t.seal.rings.length,
      radii: layout.seal.ink.rings.map((ring) => Math.round(ring.radius * 10) / 10),
      thickness: layout.seal.ink.rings.map((ring) => Math.round(ring.width * 10) / 10),
    };
  })()`);
  check('третье кольцо добавлено', ringState.count === 3, String(ringState.count));
  check('кольца идут от края внутрь', ringState.radii[0] > ringState.radii[1] && ringState.radii[1] > ringState.radii[2],
    JSON.stringify(ringState.radii));

  console.log('\n3. Текст по дуге');
  await cdp.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    tabs.find((node) => node.textContent.trim().startsWith('Дуги'))?.click();
    return 'ok';
  })()`);
  await sleep(400);
  const arcsBefore = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const layout = stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => app.fonts.familyOf(id));
    const top = layout.seal.arcs.find((arc) => arc.side === 'top');
    return { span: Math.abs(top.endAngle - top.startAngle), chars: top.chars.length, size: top.fontSize };
  })()`);
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid=seal-arc-top-text] input');
    input.value = 'АКЦИОНЕРНОЕ ОБЩЕСТВО РОМАШКА';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const arcsAfter = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const top = layout.seal.arcs.find((arc) => arc.side === 'top');
    return {
      text: t.seal.arcTop.text,
      chars: top.chars.length,
      span: Math.abs(top.endAngle - top.startAngle),
      first: top.chars[0] ? Math.round(top.chars[0].angle) : null,
    };
  })()`);
  check('текст верхней дуги обновился', arcsAfter.text === 'АКЦИОНЕРНОЕ ОБЩЕСТВО РОМАШКА', arcsAfter.text);
  check('глифы пересчитаны под новый текст', arcsAfter.chars !== arcsBefore.chars, `${arcsBefore.chars} → ${arcsAfter.chars}`);
  check('дуга не замыкается в кольцо', arcsAfter.span <= 340, `${arcsAfter.span.toFixed(1)}°`);

  const tracking = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const spanOf = () => {
      const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
      const top = layout.seal.arcs.find((arc) => arc.side === 'top');
      return Math.abs(top.endAngle - top.startAngle);
    };
    const before = spanOf();
    t.seal.arcTop.letterSpacing = 6;
    const after = spanOf();
    t.seal.arcTop.letterSpacing = 1.2;
    return { before, after };
  })()`);
  check('трекинг растягивает текст по дуге', tracking.after > tracking.before,
    `${tracking.before.toFixed(1)}° → ${tracking.after.toFixed(1)}°`);

  console.log('\n4. Маркеры растяжения');
  const handle = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=seal-handle-top-0]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, cx: canvas.x + canvas.width / 2, cy: canvas.y + canvas.height / 2, r: canvas.width / 2 };
  })()`);
  if (handle) {
    await cdp.drag(
      { x: handle.x, y: handle.y },
      { x: handle.cx - handle.r * 0.55, y: handle.cy - handle.r * 0.55 },
      10,
    );
    await sleep(600);
    const stretched = await cdp.evaluate(`(() => window.__SEAL_DESIGNER__.seal.arcTop.spanAngle)()`);
    check('маркер задал угол дуги', stretched > 20, `${stretched}°`);
  } else {
    check('маркер найден', false);
  }

  console.log('\n5. Цвет, прозрачность и фактура');
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-color-7c3aed]').click();
    return 'ok';
  })()`);
  await sleep(300);
  const color = await cdp.evaluate(`(() => window.__SEAL_DESIGNER__.color)()`);
  check('цвет из пресета применился', color === '#7c3aed', color);

  await cdp.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    tabs.find((node) => node.textContent.trim().startsWith('Краска'))?.click();
    return 'ok';
  })()`);
  await sleep(400);
  const inkBefore = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const layout = stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => app.fonts.familyOf(id));
    return {
      jitter: layout.seal.ink.rings.some((ring) => ring.points && ring.points.length > 0),
      specks: layout.seal.ink.specks.length,
      seed: window.__SEAL_DESIGNER__.seal.ink.seed,
    };
  })()`);
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-ink-toggle] button').click();
    return 'ok';
  })()`);
  await sleep(500);
  const inkOff = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const layout = stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => app.fonts.familyOf(id));
    return {
      enabled: window.__SEAL_DESIGNER__.seal.ink.enabled,
      jitter: layout.seal.ink.rings.some((ring) => ring.points && ring.points.length > 0),
      specks: layout.seal.ink.specks.length,
    };
  })()`);
  check('эффект включён: неровные кольца и зерно', inkBefore.jitter === true && inkBefore.specks > 10,
    JSON.stringify(inkBefore));
  check('эффект выключается: ровные кольца без зерна', inkOff.enabled === false && inkOff.jitter === false && inkOff.specks === 0,
    JSON.stringify(inkOff));
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-ink-toggle] button').click();
    const input = document.querySelector('[data-testid=seal-opacity] input');
    input.value = '0.8';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(500);
  const opacity = await cdp.evaluate(`(() => window.__SEAL_DESIGNER__.opacity)()`);
  check('прозрачность оттиска применилась', Math.abs(opacity - 0.8) < 0.001, String(opacity));

  const determinism = await cdp.evaluate(`(async () => {
    const seal = await import('/src/services/sealRenderService.ts');
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const parts = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const first = parts.seal.ink.specks.slice(0, 3).map((speck) => [speck.x.toFixed(2), speck.y.toFixed(2)]);
    const again = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const second = again.seal.ink.specks.slice(0, 3).map((speck) => [speck.x.toFixed(2), speck.y.toFixed(2)]);
    t.seal.ink.seed = 4242;
    const seeded = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id)).seal.ink.specks.slice(0, 3)
      .map((speck) => [speck.x.toFixed(2), speck.y.toFixed(2)]);
    t.seal.ink.seed = 1337;
    return { same: JSON.stringify(first) === JSON.stringify(second), different: JSON.stringify(first) !== JSON.stringify(seeded), count: parts.seal.ink.specks.length };
  })()`);
  check('рисунок краски воспроизводим (один seed — один оттиск)', determinism.same === true,
    JSON.stringify(determinism));
  check('другой seed — другой рисунок', determinism.different === true);

  console.log('\n6. Добавление на документ');
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-insert]').click();
    return 'ok';
  })()`);
  await sleep(1200);
  const inserted = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const objects = app.objects.objects.filter((item) => item.type === 'stamp');
    const object = objects[objects.length - 1];
    return object
      ? {
          id: object.id,
          width: object.width,
          height: object.height,
          kind: object.payload.template.kind,
          hasSeal: Boolean(object.payload.template.seal),
          color: object.payload.template.color,
          mm: object.payload.template.seal?.diameterMm,
          page: object.page,
          sealsInLibrary: app.library.seals.length,
          modalClosed: app.ui.modals.sealDesigner,
        }
      : null;
  })()`);
  check('печать добавлена на страницу', Boolean(inserted), 'объект не найден');
  check('размер объекта 60 мм', inserted && Math.abs(inserted.width - 170.08) < 0.6 && Math.abs(inserted.height - 170.08) < 0.6,
    JSON.stringify(inserted && [inserted.width, inserted.height]));
  check('объект — печать с настройками кольца/дуг', inserted?.kind === 'seal' && inserted?.hasSeal === true);
  check('цвет сохранился в объекте', inserted?.color === '#7c3aed', String(inserted?.color));
  check('печать сохранена в библиотеку', (inserted?.sealsInLibrary ?? 0) >= 1, String(inserted?.sealsInLibrary));
  check('конструктор закрылся после вставки', inserted?.modalClosed === false);

  console.log('\n7. Объект на странице: перемещение, поворот, прозрачность, дубли');
  const transformed = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const id = ${JSON.stringify(inserted?.id ?? '')};
    app.objects.update(id, { x: 120, y: 140, rotation: 15 }, 'тест');
    app.objects.setOpacity([id], 0.75);
    const object = app.objects.byId(id);
    const stage = app.pdfService ? null : null;
    return { x: object.x, y: object.y, rotation: object.rotation, opacity: object.opacity };
  })()`);
  check('печать перемещается', transformed.x === 120 && transformed.y === 140, JSON.stringify(transformed));
  check('печать поворачивается', transformed.rotation === 15, String(transformed.rotation));
  check('прозрачность объекта меняется', Math.abs(transformed.opacity - 0.75) < 0.001, String(transformed.opacity));

  // Масштаб: рамка трансформации меняет размер объекта, а геометрия печати
  // пересчитывается от него (кольца растут пропорционально).
  const scaled = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const stamp = await import('/src/services/stampRenderService.ts');
    const id = ${JSON.stringify(inserted?.id ?? '')};
    app.objects.update(id, { width: 340.16, height: 340.16 }, 'масштаб');
    const object = app.objects.byId(id);
    const fitted = stamp.fitStampTemplate(object.payload.template, object.width, object.height);
    const layout = stamp.computeStampLayout(fitted, (fontId) => app.fonts.familyOf(fontId));
    return { width: object.width, ring: layout.seal.ink.rings[0].radius, font: layout.seal.arcs[0].fontSize };
  })()`);
  check(
    'печать масштабируется: кольца растут вместе с объектом',
    Math.abs(scaled.ring - 166.4) < 2,
    `кольцо ${scaled.ring.toFixed(1)} при ширине ${scaled.width}`,
  );

  const duplicated = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const before = app.objects.objects.length;
    const copy = app.objects.duplicate([${JSON.stringify(inserted?.id ?? '')}]);
    const after = app.objects.objects.length;
    return { before, after, copyId: copy[0]?.id ?? null };
  })()`);
  check('печать дублируется', duplicated.after === duplicated.before + 1, JSON.stringify(duplicated));

  const removed = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.remove([${JSON.stringify(duplicated.copyId)}]);
    return app.objects.objects.length;
  })()`);
  check('копия удаляется', removed === duplicated.before, String(removed));

  console.log('\n8. Векторный экспорт в PDF');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([]);
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  check('PDF с печатью собран', exported.ok === true, exported.error ?? '');

  if (exported.ok) {
    const doc = await PDFDocument.load(Buffer.from(exported.b64, 'base64'));
    const streams = [];
    const walk = (ref) => {
      const value = ref && ref.constructor?.name === 'PDFRef' ? doc.context.lookup(ref) : ref;
      if (value instanceof PDFRawStream) {
        try {
          streams.push(inflateSync(Buffer.from(value.contents)).toString('latin1'));
        } catch {
          streams.push(Buffer.from(value.contents).toString('latin1'));
        }
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i += 1) walk(value.get(i));
      }
    };
    for (const page of doc.getPages()) walk(page.node.get(PDFName.of('Contents')));
    const content = streams.join('\n');

    // Кольца с «дрожанием» — это длинные ломаные: много операторов l.
    const lineOps = (content.match(/^[-\d.]+ [-\d.]+ l$/gm) ?? []).length;
    // Каждый глиф дуги и каждая строка центра — отдельный Tj.
    const textOps = (content.match(/Tj/g) ?? []).length;
    const fills = [...content.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) rg/g)].map((m) => m.slice(1, 4).map(Number));
    const purple = fills.some(
      ([r, g, b]) => Math.abs(r - 0.486) < 0.02 && Math.abs(g - 0.227) < 0.02 && Math.abs(b - 0.929) < 0.02,
    );

    console.log(`  в PDF: ${lineOps} отрезков контуров, ${textOps} текстовых операций`);
    check('кольца в PDF — векторные контуры', lineOps > 150, String(lineOps));
    check('текст печати остался текстом', textOps > 20, String(textOps));
    check('цвет печати попал в PDF', purple, JSON.stringify(fills.slice(0, 4)));
  }

  console.log('\n9. Повторное открытие печати из объекта (через «Свойства»)');
  const reopened = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.ui.closeAllModals();
    app.objects.select([${JSON.stringify(inserted?.id ?? '')}]);
    app.ui.setRightTab('properties');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const button = Array.from(document.querySelectorAll('button'))
      .find((node) => node.textContent.trim() === 'Редактировать');
    if (!button) return { open: false, error: 'кнопка «Редактировать» не найдена' };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const t = window.__SEAL_DESIGNER__;
    return {
      open: Boolean(document.querySelector('[data-testid=seal-designer]')),
      modal: app.ui.modals.sealDesigner,
      mm: t?.seal?.diameterMm,
      color: t?.color,
      rings: t?.seal?.rings?.length,
    };
  })()`);
  check('кнопка «Редактировать» открывает конструктор печати', reopened.open === true, JSON.stringify(reopened));
  check('настройки объекта подхватились', reopened.mm === 60 && reopened.color === '#7c3aed',
    JSON.stringify(reopened));

  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeModal('sealDesigner'); 'ok'`);
  await sleep(800);
  await cdp.screenshot(resolvePath(TMP, 'seal-on-page.png'));

  console.log('\n--- Ошибки консоли ---');
  console.log(cdp.errors.length === 0 ? '(нет)' : cdp.errors.join('\n'));
  if (cdp.errors.length > 0) process.exitCode = 1;
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
