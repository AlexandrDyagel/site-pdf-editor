/**
 * Проверка модели сегментации текста (PP-OCRv4 det / DBNet, onnxruntime-web).
 *
 *   1. файл модели и wasm-рантайм отдаются сервером;
 *   2. сервис сообщает, что модель доступна;
 *   3. инференс в воркере находит текст на синтетической картинке;
 *   4. движок «модель» строит маску для реального скана без ошибок;
 *   5. если модель выключена, работает классический адаптивный движок (фолбэк).
 *
 * Запуск: node scripts/check-text-model.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const scan = (await readFile(resolvePath(TMP, 'scan11.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9641 });

try {
  await sleep(8000);

  console.log('\n1. Файлы модели и рантайма');
  const files = await cdp.evaluate(`(async () => {
    const check = async (url) => {
      try {
        const response = await fetch(url, { method: 'HEAD' });
        return { url, ok: response.ok, size: Number(response.headers.get('content-length') ?? 0) };
      } catch (error) {
        return { url, ok: false, error: String(error) };
      }
    };
    return {
      model: await check('/models/text-det.onnx'),
      wasm: await check('/ort/ort-wasm-simd-threaded.wasm'),
    };
  })()`);
  console.log('  файлы:', JSON.stringify(files));
  check('модель лежит в public/models', files.model.ok === true && files.model.size > 1_000_000, JSON.stringify(files.model));
  check('wasm-рантайм скопирован', files.wasm.ok === true && files.wasm.size > 1_000_000, JSON.stringify(files.wasm));

  console.log('\n2. Сервис видит модель');
  const available = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/textDetectionService.ts');
    return service.isTextModelAvailable();
  })()`);
  check('модель доступна сервису', available === true, String(available));

  console.log('\n3. Инференс находит текст');
  await cdp.evaluate(`(async () => {
    window.__MODEL_STATE__ = { status: 'running' };
    const service = await import('/src/services/textDetectionService.ts');
    const width = 320;
    const height = 96;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let line = 0; line < 3; line += 1) {
      const top = 16 + line * 26;
      for (let y = top; y < top + 12; y += 1) {
        for (let x = 20; x < 300; x += 1) {
          if ((x >> 3) % 3 === 0) continue;
          const index = (y * width + x) * 4;
          pixels[index] = 20;
          pixels[index + 1] = 20;
          pixels[index + 2] = 20;
        }
      }
    }
    const empty = new Uint8ClampedArray(width * height * 4).fill(255);
    const started = performance.now();
    const textMask = await service.detectTextMask(pixels, width, height, 30_000);
    const blankMask = await service.detectTextMask(empty, width, height, 30_000);
    const count = (mask) => (mask ? mask.reduce((sum, value) => sum + (value ? 1 : 0), 0) : -1);
    window.__MODEL_STATE__ = {
      status: 'done',
      textCovered: count(textMask),
      blankCovered: count(blankMask),
      total: width * height,
      elapsed: Math.round(performance.now() - started),
      error: service.getLastTextModelError(),
    };
  })()`);
  let state = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(800);
    state = await cdp.evaluate(`window.__MODEL_STATE__ ?? null`);
    if (state && state.status && state.status !== 'running') break;
  }
  console.log('  инференс:', JSON.stringify(state));
  check('модель вернула маску', state !== null && state.status === 'done', JSON.stringify(state));
  check(
    'текст найден (больше 1 % площади)',
    (state?.textCovered ?? 0) > state.total * 0.01,
    JSON.stringify(state),
  );
  check(
    'пустой лист почти не размечен',
    (state?.blankCovered ?? 0) < (state?.total ?? 1) * 0.05,
    JSON.stringify(state),
  );
  check('ошибок модели нет', !state?.error, String(state?.error ?? ''));

  console.log('\n4. Движок «модель» строит маску для скана');
  const engineRun = await cdp.evaluate(`(async () => {
    const binary = atob(${JSON.stringify(scan)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, error: 'нет страницы загрузки' };
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'scan11.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  if (engineRun.ok) {
    await sleep(8000);
    await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
    await sleep(6000);
    const result = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      const factory = await import('/src/services/objectFactory.ts');
      const maskService = await import('/src/services/smartEraseService.ts');
      app.editor.fitToWidth();
      app.objects.clearAll(false);
      maskService.clearSmartMaskCache();
      const build = (engine) => factory.createDrawingObject([{
        tool: 'smart-eraser', color: '#ffffff', width: 46, opacity: 1, smooth: false,
        points: [
          { x: 95, y: 212, pressure: 0.5, time: 0 },
          { x: 175, y: 212, pressure: 0.5, time: 10 },
          { x: 255, y: 212, pressure: 0.5, time: 20 },
        ],
      }], {
        page: 0,
        smart: { threshold: 170, color: '#ffffff', autoColor: true, mode: 'keep-dark', engine },
        name: 'Очистка фона',
      });
      const measure = async (object) => {
        maskService.clearSmartMaskCache();
        const canvas = await maskService.getSmartMask({ object, scale: 300 / 72 });
        if (!canvas) return 0;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 120) opaque += 1;
        return opaque;
      };
      // Сколько тёмных пикселей текста закрашивает маска: должно быть 0.
      const inkStats = async (object) => {
        const { pdfService } = await import('/src/services/pdfService.ts');
        const scale = 300 / 72;
        maskService.clearSmartMaskCache();
        const mask = await maskService.getSmartMask({ object, scale });
        const maskData = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
        const rendered = await pdfService.renderPage(0, { scale, background: '#ffffff' });
        const pageData = rendered.canvas
          .getContext('2d')
          .getImageData(0, 0, rendered.canvas.width, rendered.canvas.height).data;
        const originX = Math.round(object.x * scale);
        const originY = Math.round(object.y * scale);
        let ink = 0;
        let killed = 0;
        for (let y = 0; y < mask.height; y += 1) {
          for (let x = 0; x < mask.width; x += 1) {
            const alpha = maskData[(y * mask.width + x) * 4 + 3];
            const index = ((originY + y) * rendered.canvas.width + (originX + x)) * 4;
            if (index < 0 || index >= pageData.length) continue;
            const lum =
              0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
            if (lum >= 120) continue;
            ink += 1;
            if (alpha > 200) killed += 1;
          }
        }
        return { ink, killed };
      };
      const modelObject = build('model');
      const adaptiveObject = build('adaptive');
      return {
        model: await measure(modelObject),
        adaptive: await measure(adaptiveObject),
        ink: await inkStats(modelObject),
        adaptiveInk: await inkStats(adaptiveObject),
        error: (await import('/src/services/textDetectionService.ts')).getLastTextModelError(),
      };
    })()`);
    console.log('  маски (пикселей):', JSON.stringify(result));
    check('маска моделью построена', (result.model ?? 0) > 1000, JSON.stringify(result));
    check('фолбэк на адаптивный движок работает', (result.adaptive ?? 0) > 100, JSON.stringify(result));
    check('ошибок модели при работе нет', !result.error, String(result.error ?? ''));
    console.log('  текст под маской (модель):', JSON.stringify(result.ink));
    // Допускаем доли процента на кромке букв (JPEG-шум), но не потерю текста.
    const killedShare = (stats) => (stats && stats.ink > 0 ? stats.killed / stats.ink : 1);
    check(
      'модель сохраняет текст (потери < 0.5 %)',
      killedShare(result.ink) < 0.005,
      JSON.stringify(result.ink),
    );
    check(
      'адаптивный движок тоже сохраняет текст',
      killedShare(result.adaptiveInk) < 0.005,
      JSON.stringify(result.adaptiveInk),
    );
  } else {
    failed += 1;
    console.error('  ✗ не удалось загрузить скан:', engineRun.error);
  }

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
