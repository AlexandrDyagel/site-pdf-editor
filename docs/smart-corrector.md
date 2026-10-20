# «Умный корректор»: проектирование и реализация

Документ описывает инструмент, который стирает **фон** внутри мазка, сохраняя
**текст**, в браузерном PDF-редакторе (Vue 3 + TypeScript + Tailwind + Konva +
pdf-lib). Часть описанного уже реализована в этом репозитории — ссылки на файлы
даны по коду.

---

## 1. Реализуемость в браузере

### 1.1 Что реально работает только на клиенте

| Задача | Клиент | Комментарий |
| --- | --- | --- |
| Рендер страницы в canvas | да | pdf.js (`pdfService.renderPage`), dpi от 72 до ~500 |
| Рисование мазка, предпросмотр | да | Konva, отдельный overlay-слой |
| Бинаризация ROI, морфология, CC | да | чистый JS/Canvas или OpenCV.js (wasm) |
| Лёгкая модель сегментации | да | ONNX Runtime Web (wasm SIMD / WebGPU), 1–5 МБ |
| Вставка изображения/плашки в PDF | да | pdf-lib: `drawImage`, `drawRectangle`, `drawSvgPath` |
| Удаление объектов исходного PDF | **нет** | pdf-lib не редактирует content streams произвольно |
| Полный OCR-пайплайн | да, но медленно | tesseract.js: секунды на страницу, 10–30 МБ wasm+данных |

Вывод: **всё, что нужно для задачи, выполняется в браузере**. Сервер нужен только
если понадобится «тяжёлая» модель сегментации (>20 МБ) или пакетная обработка
сотен страниц.

### 1.2 Ограничения pdf-lib

- Нет API «удалить нарисованное в content stream». Есть только **добавление**:
  текст, изображения, прямоугольники, пути, ссылки, аннотации.
- Нет soft mask / transfer function в content model, но **прозрачность PNG через
  SMask** работает: `embedPng` + `drawImage` даёт корректную альфу.
- Не умеет менять существующий текст (только рисовать новый своим шрифтом).
- Шрифты нужно встраивать (для кириллицы — TTF через `@pdf-lib/fontkit`).
- Координаты — точки PDF, начало координат **снизу слева**, поворот страницы
  хранится отдельно (`page.getRotation()`), MediaBox ≠ CropBox бывает.

Следствие: инструмент **не удаляет фон из исходного PDF**, а **перекрывает его**
новым слоем (изображение с альфой или плашка). Это честный, предсказуемый и
обратимый (undo) путь.

### 1.3 Три типа PDF и что для них делать

**a) Сканированный PDF (страница — один большой растр).**

Идеальный случай: фон и текст — пиксели одного изображения. Отделяем текст
бинаризацией, фон заливаем тоном бумаги, результат кладём картинкой с альфой.
Текст в таком PDF и так не редактируемый, потерь нет.

**b) Цифровой PDF (векторный текст + векторный фон).**

Фон (заливки, линии, водяные знаки) — операторы content stream. Убрать их, не
тронув текст, средствами pdf-lib нельзя. Реалистичные компромиссы:

1. **Перекрыть**: белая (или «под бумагу») плашка + при необходимости
   растеризованный фрагмент текста поверх. Просто, но текст перестаёт быть
   выделяемым **внутри области**.
2. **Растеризация ROI**: отрендерить область, обработать, вставить изображение
   поверх исходного текста. Текст остаётся в файле под картинкой (поиск/копирование
   всё ещё работают), но визуально это растр.
3. **Полное редактирование content stream** — отдельный тяжёлый путь (свой парсер
   операторов, отслеживание `q/Q`, `cm`, `TJ`), выходит за рамки pdf-lib; в MVP не
   берём.

**c) Смешанный PDF** (растровая подложка + векторные подписи/штампы): работает как
(а), но перед обработкой стоит «запечь» область (отрендерить всё, что над
подложкой) — иначе векторные элементы под маской останутся видны.

---

## 2. Архитектура

```
Кonva stage
 ├─ background layer  ← pdf.js render (страница)
 ├─ objects layer     ← объекты редактора (в т.ч. маски «умного корректора»)
 └─ overlay layer     ← черновик мазка, рамка, курсор-круг

SmartCorrectorTool (composable)
 ├─ черновик штриха (points, width, цвет)
 ├─ getStrokeOutline(points, width)   → замкнутый полигон (perfect-freehand)
 ├─ bbox = bounds(outline) + margin(width/2 + 1pt)
 ├─ ROI: pageCanvas = renderPage(page, scale) → вырезать bbox
 ├─ postMessage в воркер: { roiBitmap, strokeMask, settings }
 ├─ воркер: бинаризация → маска текста → фон залит тоном бумаги → PNG blob
 ├─ preview: Konva.Image (маска) поверх страницы
 └─ apply: объект `drawing` с payload.smart + маска в кэше

PDF export (pdfExportService)
 └─ drawSmartMaskObject: getSmartMask(scale=600/72) → embedPng → page.drawImage
```

Ключевая идея: **это объект редактора**, а не «одноразовая операция». Поэтому
undo/redo, слои, удаление, прозрачность и повторный экспорт работают бесплатно.

---

## 3. Computer Vision: сравнение и выбор

| Подход | Плюсы | Минусы | Вывод |
| --- | --- | --- | --- |
| **Классика** (Otsu/Sauvola/адаптивный порог, морфология, CC) | 5–30 мс на ROI, 0 КБ моделей, предсказуемо | ломается на текстурном фоне и цветном тексте | **основной** |
| **OCR** (tesseract.js, text detection) | даёт боксы слов/строк | секунды, 10–30 МБ, только печатный текст, ошибки на сканах | вспомогательный |
| **Нейросеть-сегментация** (U-Net / DeepLabV3+ / SAM-lite) | устойчива к сложному фону | 1–20 МБ, нужен ONNX/TF.js, WebGPU не у всех | **запасной / v2** |

**Рекомендация для продакшена**

1. Основной: **классический пайплайн** — адаптивный порог (локальное среднее,
   окно ≈ 1/8 высоты ROI) + правило «цветное — это не текст» (насыщенность) +
   морфология + фильтр мелких компонентов.
2. Запасной: **ONNX Runtime Web + компактная U-Net**:
   - архитектура: MobileNetV3-Small / EfficientNet-Lite0 encoder + U-Net decoder
     (text/no-text), вход 512×512, выход probability map;
   - размер: 1.5–4 МБ в int8 (квантование `onnxruntime-tools`), 0.6–1.5 МБ при
     дистилляции под 256×256;
   - формат: **ONNX (int8, opset 13+)**, при желании TF.js-конверсия;
   - запуск: `onnxruntime-web` с `executionProviders: ['webgpu','wasm']`,
     fallback на wasm SIMD;
   - только ROI: тайлинг 512×512 с перекрытием 32 px, инференс по тайлам
     последовательно (или 2–3 параллельно), маска склеивается в координатах ROI.

---

## 4. Пошаговый план

1. **UI**: инструмент `smart-eraser` в панели, курсор-круг, панель опций
   (режимы «стереть всё» / «по цвету пипетки» / «порог светлого», ширина,
   разброс цвета).
2. **Konva**: overlay-слой, черновик штриха, круглый курсор, `finishGesture` →
   создание объекта.
3. **Геометрия**: штрих → `getStrokeOutline` (perfect-freehand) → полигон →
   bbox + margin → координаты страницы (pt).
4. **ROI**: `pdfService.renderPage(page, { scale })`, где `scale` = экспортный
   dpi / 72 (в репозитории 600/72, но не выше предела растеризации страницы —
   24 Мпикс), вырезание bbox с учётом поворота страницы.
5. **Worker**: передать `ImageBitmap` ROI и `ImageData` маски штриха
   (transferable), посчитать альфа-маску.
6. **Обработка**: сглаживание яркости 3×3, бинаризация, карта «цветного»
   (насыщенность + дилатация), защита текста, заливка локальным тоном бумаги.
7. **Постобработка**: морфологическое открытие/закрытие, удаление мелких
   компонентов, дилатация маски текста на 1–2 px, feathering альфы.
8. **Preview**: `Konva.Image` с полученным PNG (или сразу `ImageBitmap`).
9. **Применение**: объект `drawing` + `payload.smart`; маска кэшируется по ключу
   (порог, цвет, разброс, режим, масштаб).
10. **PDF**: `embedPng` → `drawImage` с учётом поворота и CropBox.
11. **Undo/redo**: через существующую историю объектов (`objects.commit`).
12. **Производительность**: только bbox, даунскейл для превью, кэш масок,
    debounce перерисовки, прогресс в UI.

---

## 5. Скелет кода

### 5.1 Composable `useSmartCorrector.ts`

```ts
import { ref, shallowRef } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { createDrawingObject } from '@/services/objectFactory';
import { getSmartMask, clearSmartMaskCache } from '@/services/smartEraseService';
import type { StrokeData } from '@/types';

export function useSmartCorrector() {
  const editor = useEditorStore();
  const objects = useObjectsStore();
  const previewUrl = ref<string | null>(null);
  const busy = ref(false);
  const progress = ref(0);

  /** Черновик мазка -> объект «умного корректора» с готовой маской. */
  async function commitStroke(stroke: StrokeData): Promise<void> {
    const options = editor.toolOptions.smartEraser;
    const object = createDrawingObject([stroke], {
      page: editor.currentPage,
      smart: {
        threshold: options.threshold,
        color: options.color,
        autoColor: options.autoColor !== false,
        eraseAll: options.eraseAll === true,
        targetColor: options.targetColor ?? null,
        colorTolerance: options.colorTolerance ?? 22,
        mode: options.mode ?? 'erase-all',
      },
      name: 'Умный корректор',
    });
    if (!object) return;
    objects.add([object], 'Умный корректор');
    objects.commit('Умный корректор');
    clearSmartMaskCache(); // маска построится заново для нового объекта
    previewUrl.value = null;
  }

  /** Предпросмотр без применения: считаем маску и показываем PNG. */
  async function preview(stroke: StrokeData): Promise<void> {
    busy.value = true;
    progress.value = 0;
    try {
      const object = createDrawingObject([stroke], {
        page: editor.currentPage,
        smart: { ...editor.toolOptions.smartEraser, autoColor: true },
        name: 'preview',
      });
      if (!object) return;
      const canvas = await getSmartMask({ object, scale: 2 });
      previewUrl.value = canvas ? canvas.toDataURL('image/png') : null;
    } finally {
      busy.value = false;
      progress.value = 1;
    }
  }

  return { commitStroke, preview, previewUrl, busy, progress };
}
```

### 5.2 Панель инструмента (Tailwind)

```vue
<template>
  <div class="space-y-3 p-3">
    <div class="flex items-center justify-between">
      <span class="text-[11px] uppercase tracking-wide text-slate-400">Умный корректор</span>
      <span v-if="busy" class="text-[11px] text-sky-400">обработка… {{ Math.round(progress * 100) }}%</span>
    </div>

    <label class="block text-[11px] text-slate-400">Что делает мазок</label>
    <select v-model="mode" class="w-full rounded-lg bg-slate-800 px-2 py-1.5 text-sm text-slate-100">
      <option value="erase-all">Стереть всё под мазком</option>
      <option value="by-color">По цвету пипетки</option>
      <option value="keep-dark">Сохранять тёмное (порог)</option>
    </select>

    <template v-if="mode === 'by-color'">
      <button class="w-full rounded-lg bg-slate-700 px-2 py-1.5 text-sm" @click="pickColor">
        Взять пипеткой
      </button>
      <input
        v-model.number="tolerance"
        type="range"
        min="0"
        max="100"
        class="w-full accent-sky-500"
      />
      <p class="text-[11px] text-slate-500">Разброс близких цветов: {{ tolerance }} %</p>
    </template>

    <template v-else-if="mode === 'keep-dark'">
      <input v-model.number="threshold" type="range" min="0" max="255" class="w-full accent-sky-500" />
      <p class="text-[11px] text-slate-500">Порог светлого: {{ threshold }}</p>
    </template>

    <input v-model.number="width" type="range" min="0.2" max="80" step="0.1" class="w-full accent-sky-500" />
    <p class="text-[11px] text-slate-500">Ширина штриха: {{ width }} pt</p>
  </div>
</template>
```

### 5.3 Слой Konva для мазка

```ts
import Konva from 'konva';

export function createDraftStrokeView(layer: Konva.Layer) {
  const shape = new Konva.Shape({
    listening: false,
    sceneFunc: (ctx, node) => {
      const raw = ctx._context as CanvasRenderingContext2D;
      raw.save();
      raw.lineCap = 'round';
      raw.lineJoin = 'round';
      raw.strokeStyle = 'rgba(56,189,248,0.35)';
      raw.lineWidth = node.getAttr('strokeWidth') ?? 20;
      raw.beginPath();
      const points: { x: number; y: number }[] = node.getAttr('points') ?? [];
      points.forEach((point, index) => {
        if (index === 0) raw.moveTo(point.x, point.y);
        else raw.lineTo(point.x, point.y);
      });
      raw.stroke();
      raw.restore();
    },
  });
  layer.add(shape);
  return {
    update(points: { x: number; y: number }[], width: number) {
      shape.setAttrs({ points, strokeWidth: width });
      layer.batchDraw();
    },
    clear() {
      shape.setAttrs({ points: [] });
      layer.batchDraw();
    },
  };
}
```

### 5.4 Штрих → маска/полигон и ROI

```ts
import { getStrokeOutline } from '@/services/strokeService';
import { boundsOfPoints } from '@/utils/geometry';
import { pdfService } from '@/services/pdfService';

/** Полигон штриха в координатах страницы (pt). */
export function strokeToPolygon(stroke: StrokeData) {
  return getStrokeOutline(stroke); // perfect-freehand outline
}

/** Bounding box области с запасом на полштриха. */
export function strokeBounds(stroke: StrokeData) {
  const outline = strokeToPolygon(stroke);
  const box = boundsOfPoints(outline);
  const margin = Math.max(1, stroke.width / 2 + 1);
  return {
    x: Math.max(0, box.x - margin),
    y: Math.max(0, box.y - margin),
    width: box.width + margin * 2,
    height: box.height + margin * 2,
  };
}

/** ROI страницы в нужном масштабе (px/px) и вырезанный фрагмент. */
export async function extractRoi(pageIndex: number, rect: { x: number; y: number; width: number; height: number }, scale: number) {
  const rendered = await pdfService.renderPage(pageIndex, { scale, background: '#ffffff' });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(
    rendered.canvas,
    Math.round(rect.x * scale),
    Math.round(rect.y * scale),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}
```

### 5.5 Воркер обработки

```ts
// smartCorrector.worker.ts
type Message = {
  roi: ImageBitmap;
  mask: ImageData;
  settings: { threshold: number; targetColor: string | null; tolerance: number; mode: 'erase-all' | 'by-color' | 'keep-dark' };
};

self.onmessage = async (event: MessageEvent<Message>) => {
  const { roi, mask, settings } = event.data;
  const canvas = new OffscreenCanvas(roi.width, roi.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(roi, 0, 0);
  const page = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // 1. Сглаженная яркость 3×3 (шум скана).
  const luminance = boxBlur(toLuminance(page.data, canvas.width, canvas.height), canvas.width, canvas.height);

  // 2. Решение по каждому пикселю маски.
  const output = ctx.createImageData(canvas.width, canvas.height);
  const cover = mask.data;
  for (let index = 0; index < cover.length; index += 4) {
    if (cover[index + 3] < 110) continue;
    const erase = shouldErase(settings, page.data, luminance, index);
    if (!erase) continue;
    output.data[index] = paper.r;
    output.data[index + 1] = paper.g;
    output.data[index + 2] = paper.b;
    output.data[index + 3] = 255;
  }

  // 3. Морфология и feathering...
  ctx.putImageData(output, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  (self as unknown as Worker).postMessage({ ok: true, blob }, []);
};
```

### 5.6 Preview и применение в Konva

```ts
export async function applyMaskToStage(group: Konva.Group, blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const image = new Konva.Image({ image: bitmap, x: 0, y: 0, width: group.width(), height: group.height() });
  group.add(image);
  group.getLayer()?.batchDraw();
}
```

### 5.7 Сохранение в PDF (pdf-lib)

```ts
import { BlendMode, degrees, PDFDocument } from 'pdf-lib';

/** Объект «умного корректора» -> картинка с альфой поверх страницы. */
export async function drawSmartMask(page: PDFPage, maskCanvas: HTMLCanvasElement, frame: Frame) {
  const pngBytes = await new Promise<Uint8Array>((resolve) => {
    maskCanvas.toBlob(async (blob) => {
      resolve(new Uint8Array(await blob!.arrayBuffer()));
    }, 'image/png');
  });
  const image = await page.doc.embedPng(pngBytes);
  const bottomLeft = frame.toPdf(0, frame.height); // переворот оси Y
  page.drawImage(image, {
    x: bottomLeft.x,
    y: bottomLeft.y,
    width: frame.width,
    height: frame.height,
    rotate: degrees(frame.rotate), // поворот страницы/объекта
    opacity: 1,
    blendMode: BlendMode.Normal,
  });
}
```

---

## 6. pdf-lib: как применять результат

**Что умеем и не умеем**

| Действие | pdf-lib |
| --- | --- |
| Узнать размеры страницы | `page.getSize()`, `page.getMediaBox()`, `page.getCropBox()` |
| Добавить изображение | `embedPng` / `embedJpg` + `drawImage` |
| Добавить белую/бумажную плашку | `page.drawRectangle({ x, y, width, height, color, opacity })` |
| Векторный путь | `drawSvgPath` |
| Аннотация с appearance | только вручную (проще рисовать в контент) |
| Удалить исходный фон/текст | **нет** |

**Координаты: Konva ↔ PDF**

```
PDF:  x_pdf = x_pt
      y_pdf = pageHeight_pt - y_pt - height_pt        (переворот Y)

Konva (display): x_pt = (x_display - pan.x) / zoom
                 y_pt = (y_display - pan.y) / zoom
```

При повороте страницы (`page.getRotation().angle ∈ {0,90,180,270}`) координаты
считаются в системе **отображаемого** поворота: объект хранит `page`, а экспорт
применяет `frameOf(obj, geometryOfPdfPage(page))`, где `anchor` уже учитывает
`/Rotate` — иначе всё уезжает при повороте.

**Три способа применить результат**

1. **Растр с альфой поверх страницы** (реализовано): маска-картинка
   `width×height` объекта, `drawImage` с прозрачностью. Векторный текст остаётся
   в файле под маской (поиск работает), визуально фон удалён.
2. **Плашка + растр текста**: если нужно «убрать» и сам текст в цифровом PDF —
   сначала `drawRectangle` цветом бумаги, затем растр текста.
3. **Замена области** (для сканов): то же, что (1), но маску можно рисовать без
   прозрачности — она полностью перекрывает участок.

**Риски**

- потеря выделяемости текста, если перекрыть его растром (частично компенсируется
  пп. 1 — текст остаётся в content stream);
- дублирование текста, если положить растр текста **и** оставить исходный видимым
  (маска должна перекрывать плотно, без щелей);
- нарушение z-order — новые объекты всегда сверху, перекрыть «часть» страницы
  корректно можно только областью;
- прозрачность: pdf-lib корректно создаёт SMask только для PNG с альфой;
- координаты: MediaBox/CropBox и `/Rotate` — самая частая причина «съехало»;
- размер файла: маска 600 dpi для большого мазка даёт сотни КБ; разумный предел —
  24 Мпикс на маску и сжатие (Flate по умолчанию).

---

## 7. Производительность

- **Только bbox** мазка, никогда не вся страница.
- **Разрешение**: превью — 1–2 px/pt, экспорт — 300–600 dpi (но ≤ 8 px/pt и
  ≤ 24 Мпикс на страницу; при превышении масштаб уменьшается — иначе pdf.js
  отдаёт картинку меньше заказанной и маска «съезжает»).
- **Web Worker** для обработки, `OffscreenCanvas` внутри воркера,
  `ImageBitmap` + `postMessage(..., [transfer])`.
- **Throttle** предпросмотра: 100–150 мс, отмена устаревших задач (`AbortController`
  или номер поколения).
- **Кэш**: маска по ключу `(объект, порог, цвет, разброс, режим, масштаб)`,
  отрендеренная страница — по `(page, scale)`.
- **Очередь**: 1–2 задачи параллельно, остальное `requestIdleCallback`.
- **UI**: прогресс по этапам («рендер страницы» → «маска» → «очистка»), отмена.
- Замеры в этом репозитории: мазок 200×46 pt, 600 dpi → маска 1733×408, обработка
  ~40–80 мс на десктопе; экспорт PDF с маской +140 КБ.

---

## 8. Постобработка маски

1. **Сглаживание яркости** 3×3 до бинаризации — убирает «соль и перец».
2. **Морфологическое открытие** карты «тёмного» (радиус ≈ 0.25 pt) — мелкие
   острова перестают защищаться как текст.
3. **Удаление мелких компонентов** (connected components, площадь < 20 px) и
   закрытие мелких дырок (closing радиусом 2 px).
4. **Дилатация маски текста** на 1–2 px — сохраняет сглаженные края глифов
   (важно: без неё буквы «худеют»).
5. **Feathering**: альфа = 1 внутри, линейный спад к 0 на 1 px по кромке — но
   только там, где это не даёт тёмной каймы (при перекрытии тёмного контента
   лучше бинарная альфа).
6. **Сохранение резкости текста**: сам текст не сглаживаем, маску — только по
   внешней кромке.
7. **Полупрозрачные участки** (водяные знаки): трактуем как цветной контент и
   стираем целиком, если насыщенность выше порога.
8. **Цветная кайма вокруг букв** (JPEG-ореол): карта «цветного» расширяется на
   0.5 pt, поэтому ореол уходит вместе с печатью.

---

## 9. Граничные случаи

| Случай | Что делать |
| --- | --- |
| Текст сливается с фоном | повысить/понизить порог, режим «по цвету пипетки»; предложить пользователю подсказку «фон слишком тёмный» |
| Фон — фотография с текстурами | порог по локальному среднему + фильтр компонентов; при провале — модель (v2) |
| Рукописный текст | считать частью текста (тёмное, низкая насыщенность) — сохранять |
| Таблицы и линии | линии — «не текст»: стираются в режиме «стереть всё», сохраняются в «порог» (они тёмные) |
| Слишком большая область | ограничить 24 Мпикс, предупредить в UI, обрабатывать тайлами |
| Прерывистый мазок | каждый штрих — свой объект, либо объединить в один (bbox по всем точкам) |
| Страница повёрнута | координаты через `geometryOfPdfPage` + `/Rotate` |
| Масштаб/transform PDF | работать в точках страницы, а не в пикселях экрана |
| Konva ≠ PDF | единая функция `displayToPdf` и обратная, тест на 90/180/270 |
| Нет WebGPU/OffscreenCanvas/WASM | фолбэк: main thread + `ImageBitmap`, без модели; ONNX → wasm SIMT; при отсутствии wasm — только классика |

---

## 10. Итог

- **Архитектура**: объект-«умный корректор» в редакторе, маска-картинка с альфой,
  pdf-lib рисует её поверх страницы; undo/redo и слои — бесплатно.
- **Ограничения**: pdf-lib не удаляет исходный контент; фон перекрывается, а не
  вырезается; векторный текст в цифровом PDF остаётся под маской.
- **CV**: основная — классика (адаптивный порог + насыщенность + морфология),
  запасная — ONNX U-Net (~2 МБ int8, 512×512, только ROI).
- **MVP за 1–2 дня**: мазок → bbox → pdf.js ROI → бинаризация → маска → preview →
  `embedPng` + `drawImage`; режим «стереть всё» как самый предсказуемый.
- **Позже**: ONNX-модель, OCR-ассистент, тайлинг больших областей, WebGPU-инференс,
  серверный fallback для батча.

**npm-пакеты**: `pdfjs-dist`, `pdf-lib`, `@pdf-lib/fontkit`, `konva`,
`perfect-freehand`, `onnxruntime-web` (v2), опционально `tesseract.js` (OCR),
`opencv.js`/`@techstark/opencv-js` (если хочется готовых морфологии и CC),
`idb` (кэш проектов), `jszip` (пакетный экспорт).
