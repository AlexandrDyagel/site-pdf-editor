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

  console.log('\n5. Положение объектов в растре при dpi 144');
  const inkBox = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/imageExportService.ts');
    const app = window.__PDF_EDITOR__;
    const pages = await service.renderPagesImageList({
      settings: {
        ...app.exporter.settings,
        format: 'png',
        pageRange: 'current',
        includeAnnotations: true,
        includeOriginalContent: false,
        transparentBackground: false,
        dpi: 144,
        zip: false,
      },
      objects: app.objects.objects,
      pageGeometry: app.pdf.pages.map((_, index) => app.pdf.geometry(index)),
      currentPage: 0,
      renderOriginalPage: () => Promise.resolve(null),
    });
    const canvas = pages.pages[0].canvas;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (data[index + 3] > 10 && (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const object = app.objects.objects[0];
    return {
      size: { width: canvas.width, height: canvas.height },
      ink: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      expected: { x: object.x * 2, y: object.y * 2, width: object.width * 2, height: object.height * 2 },
    };
  })()`);
  console.log('  рамка объекта в растре:', JSON.stringify(inkBox));
  check(
    'объект стоит на своём месте при dpi 144 (не в левом верхнем углу)',
    inkBox.ink.x >= inkBox.expected.x - 6 &&
      inkBox.ink.y >= inkBox.expected.y - 6 &&
      Math.abs(inkBox.ink.width - inkBox.expected.width) < 12 &&
      Math.abs(inkBox.ink.height - inkBox.expected.height) < 12,
    JSON.stringify(inkBox),
  );

  console.log('\n6. Ориентация фигур в PDF');
  const triangleExport = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    const shape = factory.createShapeObject('triangle', {
      page: 0, x: 100, y: 100, width: 200, height: 100,
      defaults: { stroke: '#dc2626', strokeWidth: 2, fill: '#fde68a' },
    });
    app.objects.add([shape], 'тест');
    app.objects.select([]);
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    const geometry = app.pdf.geometry(0);
    return { ok: true, b64: btoa(binary), pageHeight: geometry.height };
  })()`);
  check('экспорт PDF с треугольником выполнен', triangleExport.ok === true, triangleExport.error ?? '');

  if (triangleExport.ok) {
    const zlib = await import('node:zlib');
    const pdfLib = await import('pdf-lib');
    const doc = await pdfLib.PDFDocument.load(Buffer.from(triangleExport.b64, 'base64'));
    const page = doc.getPage(0);
    const streams = [];
    const walk = (ref) => {
      const value = ref && ref.constructor?.name === 'PDFRef' ? doc.context.lookup(ref) : ref;
      if (value instanceof pdfLib.PDFRawStream) {
        try {
          streams.push(zlib.inflateSync(Buffer.from(value.contents)).toString('latin1'));
        } catch {
          streams.push(Buffer.from(value.contents).toString('latin1'));
        }
      } else if (value instanceof pdfLib.PDFArray) {
        for (let i = 0; i < value.size(); i += 1) walk(value.get(i));
      }
    };
    walk(page.node.get(pdfLib.PDFName.of('Contents')));
    const text = streams.join('\n');

    // Блок-треугольник: один «m», два «l» и замыкание «h».
    let vertices = null;
    let anchor = null;
    for (const block of text.split(/\nq\n/g)) {
      const moves = block.match(/^([\d.-]+) ([\d.-]+) m$/gm) ?? [];
      const lines = block.match(/^([\d.-]+) ([\d.-]+) l$/gm) ?? [];
      if (moves.length !== 1 || lines.length !== 2 || !/^h$/m.test(block)) continue;
      const cm = block.match(/^1 0 0 1 ([\d.-]+) ([\d.-]+) cm$/m);
      if (!cm) continue;
      anchor = { x: Number(cm[1]), y: Number(cm[2]) };
      vertices = [...moves, ...lines].map((line) => {
        const parts = line.split(' ');
        return { x: Number(parts[0]), y: Number(parts[1]) };
      });
      break;
    }

    if (anchor && vertices) {
      // pdf-lib переворачивает Y внутри drawSvgPath: (x, y) → (anchor.x + x, anchor.y - y).
      const pdfPoints = vertices.map((point) => ({ x: anchor.x + point.x, y: anchor.y - point.y }));
      const apex = pdfPoints.reduce((best, point) => (point.y > best.y ? point : best), pdfPoints[0]);
      const base = pdfPoints.filter((point) => point !== apex);
      console.log('  вершины в PDF:', JSON.stringify(pdfPoints.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }))));
      check(
        'вершина треугольника сверху (фигура не перевёрнута)',
        Math.abs(apex.y - (triangleExport.pageHeight - 100)) < 1.5,
        `y вершины ${apex.y.toFixed(2)}, ожидалось ${(triangleExport.pageHeight - 100).toFixed(2)}`,
      );
      check(
        'основание треугольника снизу',
        base.every((point) => Math.abs(point.y - (triangleExport.pageHeight - 200)) < 1.5),
        JSON.stringify(base.map((point) => Number(point.y.toFixed(2)))),
      );
      check('вершина по центру рамки', Math.abs(apex.x - 200) < 1.5, `x вершины ${apex.x.toFixed(2)}`);
    } else {
      check('в PDF найден путь треугольника', false, 'блок не найден');
    }
  }

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
