import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9381 });
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
  const info = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const assets = (app.fonts.fonts || []).filter((font) => font.supportsCyrillic);
    const objects = [];
    assets.forEach((asset, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const text = factory.createTextObject({
        page: 0,
        x: 60 + column * 250,
        y: 30 + row * 34,
        width: 240,
        height: 24,
        text: asset.name + ' — Ёжик №5',
        autoHeight: true,
        defaults: {
          fontId: asset.id,
          fontFamily: asset.name,
          fontSize: 13,
          color: '#111827',
          bold: false,
          italic: false,
          align: 'left',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
      });
      objects.push(text);
    });
    app.objects.add(objects, 'тест');
    app.objects.select([]);
    app.editor.setZoom(1.4);
    for (const asset of assets) await app.fonts.ensureFontLoadedFor(asset.id);
    return { count: assets.length };
  })()`);
  await sleep(3000);
  await cdp.screenshot(resolvePath(TMP, 'fonts-sheet.png'));
  console.log('семейств на листе:', info.count);
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
