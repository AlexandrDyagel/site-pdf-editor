/** Сохраняет картинку курсора поворота, чтобы проверить её вид. */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9374 });

try {
  await sleep(3000);
  const dataUrl = await cdp.evaluate(`(async () => {
    const module = await import('/src/utils/cursors.ts');
    return module.ROTATE_CURSOR;
  })()`);
  const base64 = String(dataUrl).match(/base64,([^")]+)/)?.[1] ?? '';
  await writeFile(resolvePath(TMP, 'rotate-cursor.png'), Buffer.from(base64, 'base64'));
  console.log('Размер картинки курсора:', base64.length, 'символов base64');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}
