/**
 * Детекция текста моделью (PP-OCRv4 det / DBNet) в воркере.
 *
 * Сервис не обязательный: если модели нет (файл не положили) или браузер не
 * смог поднять wasm, возвращаем `null`, и вызывающий код продолжает работать
 * классическим движком. Поэтому «Умный корректор» и «Очистка фона» работают
 * всегда, а модель — улучшение, а не зависимость.
 */

/** Статус модели: не проверяли / есть / нет. */
let availability: boolean | null = null;
let availabilityPromise: Promise<boolean> | null = null;

/** Путь к модели: можно подменить своим файлом в public/models. */
const MODEL_URL = '/models/text-det.onnx';

interface Pending {
  resolve: (value: Uint8Array | null) => void;
  reject: (error: Error) => void;
  timer: number;
}

/** Прямоугольник строки в координатах области. */
export interface TextLineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const recognizePending = new Map<number, { resolve: (lines: string[] | null) => void; timer: number }>();
let recognizeRequestId = 0;

let worker: Worker | null = null;
/** Последняя ошибка модели — для диагностики и подсказки в интерфейсе. */
let lastError: string | null = null;
let requestId = 0;
const pending = new Map<number, Pending>();

/** Есть ли файл модели на сервере (кэшируется). */
export function isTextModelAvailable(): Promise<boolean> {
  if (availability !== null) return Promise.resolve(availability);
  if (!availabilityPromise) {
    availabilityPromise = fetch(MODEL_URL, { method: 'HEAD' })
      .then((response) => {
        availability = response.ok;
        return response.ok;
      })
      .catch(() => {
        availability = false;
        return false;
      });
  }
  return availabilityPromise;
}

/** Создаёт воркер один раз. */
function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../workers/textDetect.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; mask?: Uint8Array; lines?: string[]; error?: string }>) => {
    const { id, ok, mask, lines, error } = event.data;
    const recognizeRequest = recognizePending.get(id);
    if (recognizeRequest) {
      recognizePending.delete(id);
      window.clearTimeout(recognizeRequest.timer);
      recognizeRequest.resolve(ok && Array.isArray(lines) ? lines : null);
      if (!ok && error) console.warn('[text-model]', error);
      return;
    }
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    window.clearTimeout(request.timer);
    if (ok && mask) request.resolve(mask);
    else {
      // Ошибка инференса — это не повод падать: работаем без модели.
      availability = false;
      lastError = error ?? 'неизвестная ошибка';
      request.resolve(null);
      if (error) console.warn('[text-model]', error);
    }
  };
  worker.onerror = (event) => {
    availability = false;
    lastError = event.message || 'ошибка воркера модели';
    for (const [id, request] of pending) {
      window.clearTimeout(request.timer);
      request.resolve(null);
      pending.delete(id);
    }
  };
  return worker;
}

/**
 * Маска текста для ROI.
 *
 * @param pixels RGBA-пиксели области (ImageData.data)
 * @returns 0/1 на пиксель или null, если модель недоступна/не справилась
 */
export async function detectTextMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  timeoutMs = 15_000,
): Promise<Uint8Array | null> {
  if (width < 8 || height < 8) return null;
  if (!(await isTextModelAvailable())) return null;
  const instance = ensureWorker();
  if (!instance) return null;

  return new Promise<Uint8Array | null>((resolve, reject) => {
    const id = (requestId += 1);
    const timer = window.setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    // Копия пикселей: ImageData живёт в главном потоке, передаём владение.
    const copy = new Uint8ClampedArray(pixels);
    instance.postMessage({ id, width, height, pixels: copy }, [copy.buffer]);
  });
}

/**
 * Распознаёт текст в строках области: возвращает массив строк в том же порядке,
 * что и переданные прямоугольники. null — модель недоступна или не справилась.
 */
export async function recognizeTextLines(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  boxes: TextLineBox[],
  timeoutMs = 25_000,
): Promise<string[] | null> {
  if (boxes.length === 0) return [];
  if (!(await isModelReady())) return null;
  const instance = ensureWorker();
  if (!instance) return null;

  return new Promise<string[] | null>((resolve) => {
    const id = (recognizeRequestId += 1);
    const timer = window.setTimeout(() => {
      recognizePending.delete(id);
      resolve(null);
    }, timeoutMs);
    recognizePending.set(id, { resolve, timer });
    const copy = new Uint8ClampedArray(pixels);
    instance.postMessage({ id, width, height, pixels: copy, boxes }, [copy.buffer]);
  });
}

/** Есть ли файл распознавателя (проверяется один раз). */
let recognizeModelReady: boolean | null = null;
async function isModelReady(): Promise<boolean> {
  if (recognizeModelReady !== null) return recognizeModelReady;
  try {
    const [model, dictionary] = await Promise.all([
      fetch('/models/text-rec.onnx', { method: 'HEAD' }),
      fetch('/models/rec-dict.json', { method: 'HEAD' }),
    ]);
    recognizeModelReady = model.ok && dictionary.ok;
  } catch {
    recognizeModelReady = false;
  }
  return recognizeModelReady;
}

/** Последняя ошибка модели (null — ошибок не было). */
export function getLastTextModelError(): string | null {
  return lastError;
}

/** Сброс статуса (для проверок и повторной попытки загрузки модели). */
export function resetTextModelState(): void {
  availability = null;
  availabilityPromise = null;
}

/** Останавливает воркер (при уходе со страницы редактора). */
export function disposeTextModelWorker(): void {
  worker?.terminate();
  worker = null;
  for (const [id, request] of pending) {
    window.clearTimeout(request.timer);
    request.resolve(null);
    pending.delete(id);
  }
}
