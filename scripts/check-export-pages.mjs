/**
 * Проверка растрового экспорта и DOCX: объекты не должны переезжать на
 * соседние страницы.
 *
 *   1. Объект, добавленный на первую страницу, попадает только в её растр;
 *   2. На остальных страницах объектов нет (раньше объекты рисовались на всех);
 *   3. Экспорт PNG/JPEG/WebP и DOCX проходит без ошибок;
 *   4. При включённом исходном содержимом объекты первой страницы не появляются
 *      на второй.
 *
 * Запуск: node scripts/check-export-pages.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9368 });

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

  console.log('\n1. Объект только на первой странице');
  const setup = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    // Плотная заливка — чтобы растровый экспорт было легко измерить.
    const shape = factory.createShapeObject('rect', {
      page: 0, x: 120, y: 120, width: 220, height: 160,
      defaults: { stroke: '#dc2626', strokeWidth: 4, fill: '#dc2626' },
    });
    app.objects.add([shape], 'тест');
    app.objects.select([]);
    return {
      pages: app.pdf.pageCount,
      objects: app.objects.objects.map((object) => ({ page: object.page, type: object.type })),
    };
  })()`);
  console.log('  страниц:', setup.pages, 'объекты:', JSON.stringify(setup.objects));
  check('в документе три страницы', setup.pages === 3, String(setup.pages));
  check('объект добавлен только на первую страницу', setup.objects.length === 1 && setup.objects[0].page === 0);

  console.log('\n2. Растр по страницам');
  const rendered = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/imageExportService.ts');
    const app = window.__PDF_EDITOR__;
    const pages = await service.renderPagesImageList({
      settings: {
        ...app.exporter.settings,
        format: 'png',
        pageRange: 'all',
        includeAnnotations: true,
        includeOriginalContent: false,
        transparentBackground: false,
        zip: false,
      },
      objects: app.objects.objects,
      pageGeometry: app.pdf.pages.map((_, index) => app.pdf.geometry(index)),
      currentPage: 0,
      renderOriginalPage: () => Promise.resolve(null),
    });
    // «Чернила» = непустые пиксели на белом фоне.
    return pages.pages.map((page) => {
      const ctx = page.canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, page.canvas.width, page.canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 10 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) ink += 1;
      }
      return { index: page.index, ink };
    });
  })()`);
  console.log('  чернил по страницам:', JSON.stringify(rendered));
  check('на страницах есть растр', Array.isArray(rendered) && rendered.length === 3, JSON.stringify(rendered));
  check('объект есть на первой странице', rendered[0]?.ink > 1000, JSON.stringify(rendered[0] ?? null));
  check(
    'на второй странице объектов нет',
    rendered[1]?.ink === 0,
    JSON.stringify(rendered[1] ?? null),
  );
  check(
    'на третьей странице объектов нет',
    rendered[2]?.ink === 0,
    JSON.stringify(rendered[2] ?? null),
  );

  console.log('\n3. Экспорт PNG / JPEG / WebP / DOCX');
  for (const format of ['png', 'jpeg', 'webp', 'docx']) {
    const result = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      app.exporter.setFormat(${JSON.stringify(format)});
      const res = await app.exporter.run({ download: false });
      return { ok: res.ok, error: res.error ?? null, fileName: res.fileName ?? null, size: res.size ?? 0 };
    })()`);
    console.log(`  ${format}:`, JSON.stringify(result));
    check(`экспорт ${format} выполнен`, result.ok === true && result.size > 0, result.error ?? '');
  }

  console.log('\n4. С исходным содержимым страниц');
  const withOriginal = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/imageExportService.ts');
    const app = window.__PDF_EDITOR__;
    const pages = await service.renderPagesImageList({
      settings: {
        ...app.exporter.settings,
        format: 'png',
        pageRange: 'all',
        includeAnnotations: true,
        includeOriginalContent: true,
        transparentBackground: false,
        zip: false,
      },
      objects: app.objects.objects,
      pageGeometry: app.pdf.pages.map((_, index) => app.pdf.geometry(index)),
      currentPage: 0,
      renderOriginalPage: (index, scale) => app.pdf.renderOriginalPage(index, scale, false),
    });
    return pages.pages.map((page) => {
      const ctx = page.canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, page.canvas.width, page.canvas.height).data;
      let red = 0;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 10 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) ink += 1;
        if (data[i] > 140 && data[i + 1] < 90 && data[i + 2] < 90) red += 1;
      }
      return { index: page.index, ink, red };
    });
  })()`);
  console.log('  страницы с исходным содержимым:', JSON.stringify(withOriginal));
  check('исходное содержимое отрисовано на всех страницах', withOriginal.every((page) => page.ink > 0), JSON.stringify(withOriginal));
  check(
    'объект первой страницы не появился на второй',
    withOriginal[1].red < withOriginal[0].red / 4,
    JSON.stringify(withOriginal),
  );

  await cdp.screenshot(resolvePath(TMP, 'export-pages.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
