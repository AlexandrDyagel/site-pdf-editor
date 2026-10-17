/**
 * ============================================================================
 *  Проверка безопасности встраивания шрифта подмножеством.
 * ============================================================================
 *
 *  pdf-lib умеет встраивать только использованные глифы (subset), и это сильно
 *  уменьшает PDF: Times New Roman — 67 КБ вместо 2,4 МБ. Но для части шрифтов
 *  подмножество повреждается (проверено на Inter, Noto Sans, PT Mono: глифы
 *  пропадают или заменяются), поэтому нельзя включать subset «всем подряд».
 *
 *  Решение: при загрузке пользовательского шрифта делаем пробный PDF дважды —
 *  с подмножеством и с полным встраиванием одной и той же строки, — растрируем
 *  оба через pdf.js и сравниваем «чернила». Совпало — шрифт можно встраивать
 *  подмножеством; не совпало (или проверить не удалось) — встраиваем целиком.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { pdfService } from '@/services/pdfService';

/** Строка-проба: кириллица, латиница, цифры, знаки и «ё». */
const PROBE = 'Съешь ещё этих мягких булок, Ёжик, №12 — Test 2024!?';

/** Результат сравнения двух растров. */
interface InkProfile {
  total: number;
  columns: number[];
}

/** Профиль «чернил» по колонкам — ловит и полную потерю, и частичную. */
function inkProfile(canvas: HTMLCanvasElement): InkProfile {
  const ctx = canvas.getContext('2d');
  const columns = new Array<number>(64).fill(0);
  if (!ctx) return { total: 0, columns };
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index] < 128 && data[index + 1] < 128 && data[index + 2] < 128) {
        total += 1;
        columns[Math.min(63, Math.floor((x / width) * 64))] += 1;
      }
    }
  }
  return { total, columns };
}

/** Сравнение профилей: общий объём и распределение по колонкам. */
function profilesMatch(a: InkProfile, b: InkProfile): boolean {
  const max = Math.max(a.total, b.total);
  // Пустой растр (шрифт вообще не отрисовался) — считать безопасным нельзя.
  if (max < 80) return false;
  if (Math.abs(a.total - b.total) / max > 0.05) return false;
  const columnMax = Math.max(...a.columns, ...b.columns, 1);
  for (let i = 0; i < a.columns.length; i += 1) {
    if (Math.abs(a.columns[i] - b.columns[i]) / columnMax > 0.25) return false;
  }
  return true;
}

/** Собирает пробный PDF с одной строкой. */
async function buildProbe(bytes: ArrayBuffer, subset: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Типы @pdf-lib/fontkit и pdf-lib расходятся, приведение безопасно:
  // так же регистрируется fontkit и при настоящем экспорте.
  const register = doc.registerFontkit.bind(doc) as (value: unknown) => void;
  register(fontkit);
  const page = doc.addPage([460, 120]);
  const font = await doc.embedFont(new Uint8Array(bytes), { subset });
  page.drawText(PROBE, { x: 12, y: 52, size: 18, font, color: rgb(0, 0, 0) });
  return doc.save();
}

/**
 * Можно ли встраивать шрифт подмножеством.
 * Любая ошибка трактуется как «нельзя» — надёжность важнее размера файла.
 */
export async function isSubsetSafe(bytes: ArrayBuffer): Promise<boolean> {
  try {
    const [subsetPdf, fullPdf] = await Promise.all([
      buildProbe(bytes, true),
      buildProbe(bytes, false),
    ]);
    const [subsetCanvas, fullCanvas] = await Promise.all([
      pdfService.renderBytesToCanvas(subsetPdf, 2),
      pdfService.renderBytesToCanvas(fullPdf, 2),
    ]);
    return profilesMatch(inkProfile(subsetCanvas), inkProfile(fullCanvas));
  } catch {
    return false;
  }
}
