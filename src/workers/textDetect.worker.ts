/**
 * Воркер детекции текста: PP-OCRv4 det (DBNet) через onnxruntime-web.
 *
 * Зачем воркер: инференс на wasm занимает сотни миллисекунд, в главном потоке это
 * заметный фриз. Здесь же он не блокирует ни рисование, ни прокрутку.
 *
 * Вход: RGBA-пиксели ROI (ImageData.data) + размеры.
 * Выход: маска текста 0/1 в тех же размерах (Uint8Array), переносится без копирования.
 */

// Важно: сборка «wasm» без WebGPU/jsep — иначе ORT тянет лишний 27 МБ бандл.
import * as ort from 'onnxruntime-web/wasm';

const MODEL_URL = '/models/text-det.onnx';
/** Длинная сторона входа: PP-OCRv4 det обучен на 960, больше не нужно. */
const MAX_SIDE = 960;
/** Порог вероятности «это текст» (DBNet отдаёт карту вероятностей). */
const TEXT_THRESHOLD = 0.3;

ort.env.wasm.wasmPaths = '/ort/';
// Потоки требуют COOP/COEP-заголовков; без них wasm обязан быть однопоточным.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/** Загружает модель один раз на воркер. */
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
}

interface DetectRequest {
  id: number;
  width: number;
  height: number;
  /** RGBA, 4 байта на пиксель. */
  pixels: Uint8ClampedArray;
}

self.onmessage = async (event: MessageEvent<DetectRequest>) => {
  // Запросы распознавания обслуживает отдельный слушатель ниже.
  if (Array.isArray((event.data as { boxes?: unknown }).boxes)) return;
  const { id, width, height, pixels } = event.data;
  try {
    const session = await getSession();

    // Масштаб: длинную сторону ограничиваем, размеры кратны 32 (требование сети).
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const inputWidth = Math.max(32, Math.round((width * scale) / 32) * 32);
    const inputHeight = Math.max(32, Math.round((height * scale) / 32) * 32);

    // RGBA -> NCHW float32 с нормализацией ImageNet (как в PaddleOCR).
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const data = new Float32Array(3 * inputWidth * inputHeight);
    for (let y = 0; y < inputHeight; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < inputWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor(x / scale));
        const source = (sourceY * width + sourceX) * 4;
        const position = y * inputWidth + x;
        for (let channel = 0; channel < 3; channel += 1) {
          data[channel * inputWidth * inputHeight + position] =
            (pixels[source + channel] / 255 - mean[channel]) / std[channel];
        }
      }
    }

    const tensor = new ort.Tensor('float32', data, [1, 3, inputHeight, inputWidth]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const map = output[session.outputNames[0]];
    const mapDims = map.dims as number[];
    const mapHeight = mapDims[mapDims.length - 2];
    const mapWidth = mapDims[mapDims.length - 1];
    const probabilities = map.data as Float32Array;

    // Карта вероятностей -> маска в размере ROI.
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const mapY = Math.min(mapHeight - 1, Math.floor((y * mapHeight) / height));
      for (let x = 0; x < width; x += 1) {
        const mapX = Math.min(mapWidth - 1, Math.floor((x * mapWidth) / width));
        if (probabilities[mapY * mapWidth + mapX] >= TEXT_THRESHOLD) {
          mask[y * width + x] = 1;
        }
      }
    }

    (self as unknown as Worker).postMessage({ id, ok: true, mask }, [mask.buffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (self as unknown as Worker).postMessage({ id, ok: false, error: message });
  }
};

/* ===================== Распознавание текста (PP-OCR rec) ===================== */

const RECOGNIZE_URL = '/models/text-rec.onnx';
const DICT_URL = '/models/rec-dict.json';
/** Высота входа распознавателя PP-OCR (фиксированная). */
const REC_HEIGHT = 48;

let recognizeSessionPromise: Promise<ort.InferenceSession> | null = null;
let dictionaryPromise: Promise<string[]> | null = null;

function getRecognizeSession(): Promise<ort.InferenceSession> {
  if (!recognizeSessionPromise) {
    recognizeSessionPromise = ort.InferenceSession.create(RECOGNIZE_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return recognizeSessionPromise;
}

function getDictionary(): Promise<string[]> {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch(DICT_URL).then((response) => response.json());
  }
  return dictionaryPromise;
}

interface RecognizeRequest {
  id: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  /** Прямоугольники строк в координатах ROI. */
  boxes: { x: number; y: number; width: number; height: number }[];
}

/** Одна строка: вырезаем, масштабируем по высоте 48 и прогоняем распознаватель. */
async function recognizeLine(
  session: ort.InferenceSession,
  dictionary: string[],
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  box: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(imageWidth, Math.ceil(box.x + box.width));
  const bottom = Math.min(imageHeight, Math.ceil(box.y + box.height));
  const sourceWidth = Math.max(1, right - left);
  const sourceHeight = Math.max(1, bottom - top);
  const targetHeight = REC_HEIGHT;
  const targetWidth = Math.max(
    8,
    Math.min(3200, Math.round((sourceWidth * targetHeight) / sourceHeight)),
  );

  // Билинейно масштабируем полосу в 3×48×W с нормализацией (x/255 - 0.5)/0.5.
  const data = new Float32Array(3 * targetHeight * targetWidth);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth));
      const source = (sourceY * imageWidth + sourceX) * 4;
      const position = y * targetWidth + x;
      for (let channel = 0; channel < 3; channel += 1) {
        data[channel * targetHeight * targetWidth + position] =
          (pixels[source + channel] / 255 - 0.5) / 0.5;
      }
    }
  }

  const tensor = new ort.Tensor('float32', data, [1, 3, targetHeight, targetWidth]);
  const output = await session.run({ [session.inputNames[0]]: tensor });
  const logits = output[session.outputNames[0]];
  const dims = logits.dims as number[];
  const steps = dims[dims.length - 2];
  const classes = dims[dims.length - 1];
  const values = logits.data as Float32Array;

  // CTC greedy decode: на каждом шаге берём класс с максимумом, повторы и blank
  // (последний индекс) отбрасываем.
  let text = '';
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    let best = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < classes; index += 1) {
      const score = values[step * classes + index];
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    // В PP-OCR класс 0 — это blank, символы идут со сдвигом на единицу.
    if (best === 0) {
      previous = -1;
      continue;
    }
    if (best === previous) continue;
    const character = dictionary[best - 1] ?? '';
    text += character;
    previous = best;
  }
  return text.trim();
}

self.addEventListener('message', async (event: MessageEvent<RecognizeRequest | DetectRequest>) => {
  const data = event.data as RecognizeRequest;
  if (!Array.isArray(data.boxes)) return;
  try {
    const [session, dictionary] = await Promise.all([getRecognizeSession(), getDictionary()]);
    const lines: string[] = [];
    for (const box of data.boxes) {
      if (box.width < 4 || box.height < 6) {
        lines.push('');
        continue;
      }
      lines.push(await recognizeLine(session, dictionary, data.pixels, data.width, data.height, box));
    }
    (self as unknown as Worker).postMessage({ id: data.id, ok: true, lines });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (self as unknown as Worker).postMessage({ id: data.id, ok: false, error: message });
  }
});
