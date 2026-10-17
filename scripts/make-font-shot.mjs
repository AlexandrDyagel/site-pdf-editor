/**
 * Скриншот: окно «Шрифты» с загруженным Times New Roman (4 начертания)
 * и текстом на странице, набранным этим шрифтом.
 *
 * Запуск: node scripts/make-font-shot.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const files = [];
for (const name of ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf']) {
  files.push({ name, b64: (await readFile(resolvePath(`C:\\Windows\\Fonts\\${name}`))).toString('base64') });
}

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9352 });

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
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  const uploaded = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    let id = null;
    for (const item of ${JSON.stringify(files)}) {
      const binary = atob(item.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const asset = await app.fonts.uploadFont(new File([bytes], item.name, { type: 'font/ttf' }));
      id = asset.id;
    }
    const factory = await import('/src/services/objectFactory.ts');
    const family = app.fonts.familyOf(id);
    // Размещаем в свободной правой части видимой области страницы.
    const make = (y, text, extra) => factory.createTextObject({
      page: 0, x: 350, y, width: 230, height: 22, autoHeight: true, text,
      defaults: { fontId: id, fontFamily: family, fontSize: 12.5, color: '#111111', ...extra },
    });
    app.objects.add([
      make(140, 'Times New Roman', {}),
      make(168, 'Жирный: Ёжик, Ёлка, №12', { bold: true }),
      make(196, 'Курсив: электрификация', { italic: true }),
    ], 'демо шрифта');
    app.objects.select([]);
    app.ui.openModal('fonts');
    return { id, family, faces: app.fonts.faceLabels(id), subsetSafe: app.fonts.byId(id).subsetSafe };
  })()`);
  console.log('Загружено:', JSON.stringify(uploaded));
  await sleep(2000);
  // Прокручиваем окно к загруженному шрифту (он в конце списка).
  await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return 'нет окна';
    const scrollables = Array.from(dialog.querySelectorAll('*')).filter(
      (element) => element.scrollHeight > element.clientHeight + 20,
    );
    for (const element of scrollables) element.scrollTop = element.scrollHeight;
    return 'ok';
  })()`);
  await sleep(800);
  await cdp.screenshot(resolvePath(TMP, 'font-modal.png'));

  // Отдельный кадр рабочей области без окна — видно сам текст.
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeModal('fonts'); 'ok'`);
  await sleep(1200);
  await cdp.screenshot(resolvePath(TMP, 'font-page.png'));
} catch (error) {
  console.error('ОШИБКА:', error);
  process.exitCode = 1;
} finally {
  close();
}
