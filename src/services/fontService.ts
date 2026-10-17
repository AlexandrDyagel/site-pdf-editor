/**
 * ============================================================================
 *  Сервис шрифтов.
 * ============================================================================
 *
 *  Отвечает за:
 *   1. загрузку встроенных TTF-шрифтов с поддержкой кириллицы;
 *   2. регистрацию шрифтов в браузере (FontFace API), чтобы канвас и Konva
 *      рисовали теми же глифами, что будут встроены в PDF;
 *   3. подготовку шрифтов для pdf-lib (`@pdf-lib/fontkit`);
 *   4. проверку покрытия глифов (чтобы русский текст не превращался в «□□□»);
 *   5. приём пользовательских TTF/OTF-шрифтов с сохранением в IndexedDB.
 */

import fontkit, { type FontkitFont } from '@pdf-lib/fontkit';
import type { PDFDocument } from 'pdf-lib';
import { FONT_MANIFEST_PATH } from '@/constants';
import type { FontAsset, FontFaceDescriptor, GlyphCoverageResult } from '@/types';
import { uniqueChars } from '@/utils/encoding';
import { clearTextMeasureCache } from '@/utils/textLayout';
import { storageService } from '@/services/storageService';
import { isSubsetSafe } from '@/services/fontSubsetCheck';

/** Ключ начертания. */
export function faceKey(weight: number, style: 'normal' | 'italic'): string {
  return `${weight}-${style}`;
}

/**
 * Шрифты, подмножества которых повреждены (глифы пропадают).
 * Значения получены проверкой `scripts/check-font-subsets.mjs`.
 * Список нужен как страховка: если манифест окажется устаревшим
 * (например, закешированным браузером), шрифт всё равно встроится целиком.
 */
const SUBSET_UNSAFE_FONT_IDS = new Set(['inter', 'noto-sans', 'pt-mono']);

/** Нужно ли встраивать шрифт целиком (без подмножества). */
function needsFullEmbedding(asset: FontAsset): boolean {
  // У пользовательских шрифтов подмножество включаем только после автопроверки
  // при загрузке (fontSubsetCheck): старые записи без флага встраиваются целиком.
  if (asset.source === 'user') return asset.subsetSafe !== true;
  if (typeof asset.subsetSafe === 'boolean') return !asset.subsetSafe;
  return SUBSET_UNSAFE_FONT_IDS.has(asset.id);
}

/** Название начертания для интерфейса. */
export function describeFace(key: string): string {
  const [weightRaw, style] = key.split('-');
  const weight = Number(weightRaw);
  const weightLabel =
    weight >= 700 ? 'Жирный' : weight >= 500 ? 'Полужирный' : weight <= 300 ? 'Тонкий' : 'Обычный';
  const styleLabel = style === 'italic' ? ' курсив' : '';
  return `${weightLabel}${styleLabel}`;
}

/** Пользовательский шрифт в хранилище. */
interface StoredUserFont {
  id: string;
  name: string;
  family: string;
  createdAt: string;
  /** Проверено ли, что шрифт корректно встраивается подмножеством. */
  subsetSafe?: boolean;
  faces: {
    key: string;
    weight: number;
    style: 'normal' | 'italic';
    fileName: string;
    bytes: ArrayBuffer;
  }[];
}

export class FontService {
  private readonly assets = new Map<string, FontAsset>();
  private readonly facePromises = new Map<string, Promise<FontFace | null>>();
  private readonly objectUrls = new Map<string, string>();
  private readonly fontkitFonts = new Map<string, FontkitFont | null>();
  private readonly bytesCache = new Map<string, ArrayBuffer>();
  private manifestPromise: Promise<FontAsset[]> | null = null;
  private metadataFlag = false;

  /** Базовый URL приложения (учитывает base в vite config). */
  baseUrl(): string {
    const base = import.meta.env.BASE_URL || '/';
    return base.endsWith('/') ? base : `${base}/`;
  }

  /** Абсолютный URL файла шрифта. */
  faceUrl(asset: FontAsset, face: FontFaceDescriptor): string {
    if (/^(data:|blob:|https?:)/i.test(face.url)) return face.url;
    const prefix = asset.source === 'bundled' ? 'fonts/' : '';
    return `${this.baseUrl()}${prefix}${face.url.replace(/^\.?\//, '')}`;
  }

  /** Все известные шрифты. */
  list(): FontAsset[] {
    return Array.from(this.assets.values());
  }

  /** Шрифт по идентификатору. */
  get(id: string): FontAsset | undefined {
    return this.assets.get(id);
  }

  /** Шрифт с поддержкой кириллицы (fallback для русского текста). */
  getCyrillicFont(preferredId?: string): FontAsset | undefined {
    const preferred = preferredId ? this.assets.get(preferredId) : undefined;
    if (preferred?.supportsCyrillic) return preferred;
    return this.list().find((font) => font.supportsCyrillic) ?? this.list()[0];
  }

  /** Ручная регистрация шрифта (используется стором шрифтов). */
  register(asset: FontAsset): void {
    this.assets.set(asset.id, asset);
  }

  /**
   * Загрузка манифеста встроенных шрифтов + пользовательских шрифтов
   * из IndexedDB. Повторные вызовы переиспользуют результат.
   */
  async loadAll(force = false): Promise<FontAsset[]> {
    if (this.manifestPromise && !force) return this.manifestPromise;
    this.manifestPromise = (async () => {
      await this.loadBundledManifest();
      await this.loadUserFonts();
      return this.list();
    })();
    return this.manifestPromise;
  }

  /** Загрузка манифеста встроенных шрифтов. */
  private async loadBundledManifest(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl()}${FONT_MANIFEST_PATH}`, {
        // Манифест влияет на корректность встраивания шрифтов, поэтому
        // не берём его из кеша без проверки актуальности.
        cache: 'no-cache',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as { fonts?: FontAsset[] };
      for (const asset of manifest.fonts ?? []) {
        this.assets.set(asset.id, { ...asset, source: 'bundled', loaded: false });
      }
    } catch {
      // Резервный вариант: минимальный набор описаний (файлы уже в public/fonts).
      const fallback: FontAsset[] = [
        {
          id: 'pt-sans',
          name: 'PT Sans',
          family: 'PT Sans',
          source: 'bundled',
          supportsCyrillic: true,
          faces: {
            '400-normal': { weight: 400, style: 'normal', url: 'PT_Sans-Web-Regular.ttf' },
            '700-normal': { weight: 700, style: 'normal', url: 'PT_Sans-Web-Bold.ttf' },
          },
        },
        {
          id: 'dejavu-sans',
          name: 'DejaVu Sans',
          family: 'DejaVu Sans',
          source: 'bundled',
          supportsCyrillic: true,
          faces: {
            '400-normal': { weight: 400, style: 'normal', url: 'DejaVuSans.ttf' },
            '700-normal': { weight: 700, style: 'normal', url: 'DejaVuSans-Bold.ttf' },
          },
        },
      ];
      for (const asset of fallback) this.assets.set(asset.id, asset);
    }
  }

  /** Восстановление пользовательских шрифтов из IndexedDB. */
  async loadUserFonts(): Promise<void> {
    try {
      const stored = await storageService.assetGetAll<StoredUserFont>('font:');
      for (const item of stored) {
        const faces: Record<string, FontFaceDescriptor> = {};
        for (const face of item.faces) {
          const url = this.createObjectUrl(face.bytes);
          faces[face.key] = {
            weight: face.weight,
            style: face.style,
            url,
            fileName: face.fileName,
          };
          this.bytesCache.set(`${item.id}:${face.key}`, face.bytes);
        }
        this.assets.set(item.id, {
          id: item.id,
          name: item.name,
          family: item.family,
          source: 'user',
          supportsCyrillic: true,
          faces,
          loaded: true,
          // Флаг проверки подмножества сохраняется вместе со шрифтом.
          subsetSafe: item.subsetSafe === true,
        });
      }
    } catch {
      /* IndexedDB может быть недоступен (приватный режим) — не критично */
    }
  }

  private createObjectUrl(bytes: ArrayBuffer): string {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'font/ttf' }));
    this.objectUrls.set(url, url);
    return url;
  }

  /** Регистрация всех начертаний шрифта в браузере. */
  async ensureFacesLoaded(fontId: string): Promise<FontAsset | undefined> {
    const asset = this.assets.get(fontId);
    if (!asset) return undefined;
    await Promise.all(Object.keys(asset.faces).map((key) => this.loadFace(asset, key)));
    const loaded = Object.keys(asset.faces).every((key) => this.facePromises.has(`${fontId}:${key}`));
    asset.loaded = loaded;
    return asset;
  }

  /** Загрузка одного начертания (FontFace API). */
  loadFace(asset: FontAsset, key: string): Promise<FontFace | null> {
    const cacheKey = `${asset.id}:${key}`;
    const cached = this.facePromises.get(cacheKey);
    if (cached) return cached;
    const face = asset.faces[key];
    if (!face) {
      const empty = Promise.resolve(null);
      this.facePromises.set(cacheKey, empty);
      return empty;
    }
    const promise = (async (): Promise<FontFace | null> => {
      if (typeof FontFace === 'undefined') return null;
      try {
        const fontFace = new FontFace(asset.family, `url("${this.faceUrl(asset, face)}")`, {
          weight: String(face.weight),
          style: face.style,
          display: 'swap',
        });
        await fontFace.load();
        document.fonts.add(fontFace);
        return fontFace;
      } catch {
        return null;
      }
    })();
    this.facePromises.set(cacheKey, promise);
    return promise;
  }

  /** Ожидание загрузки всех шрифтов (для корректной раскладки текста). */
  async preloadAll(): Promise<void> {
    const list = this.list();
    await Promise.all(list.map((asset) => this.ensureFacesLoaded(asset.id)));
    clearTextMeasureCache();
  }

  /** Байты шрифта для указанного начертания. */
  async getFontBytes(
    fontId: string,
    bold = false,
    italic = false,
  ): Promise<{ bytes: ArrayBuffer; key: string; asset: FontAsset }> {
    const asset = this.assets.get(fontId) ?? this.getCyrillicFont(fontId);
    if (!asset) throw new Error('Шрифт не найден');
    const key = this.pickFaceKey(asset, bold, italic);
    const cacheKey = `${asset.id}:${key}`;
    const cached = this.bytesCache.get(cacheKey);
    if (cached) return { bytes: cached, key, asset };

    const face = asset.faces[key];
    if (!face) throw new Error(`Для шрифта «${asset.name}» не найдено начертание ${key}`);
    const response = await fetch(this.faceUrl(asset, face));
    if (!response.ok) throw new Error(`Не удалось загрузить файл шрифта «${asset.name}»`);
    const bytes = await response.arrayBuffer();
    this.bytesCache.set(cacheKey, bytes);
    return { bytes, key, asset };
  }

  /** Выбор наиболее подходящего начертания. */
  pickFaceKey(asset: FontAsset, bold: boolean, italic: boolean): string {
    const wanted = faceKey(bold ? 700 : 400, italic ? 'italic' : 'normal');
    if (asset.faces[wanted]) return wanted;
    const alt: string[] = [
      faceKey(bold ? 700 : 400, 'normal'),
      faceKey(400, italic ? 'italic' : 'normal'),
      faceKey(400, 'normal'),
      faceKey(700, 'normal'),
    ];
    for (const key of alt) if (asset.faces[key]) return key;
    return Object.keys(asset.faces)[0] ?? wanted;
  }

  /** fontkit-шрифт (для метрик, проверки глифов и встраивания). */
  async getFontkitFont(fontId: string, bold = false, italic = false): Promise<FontkitFont> {
    const { bytes, key } = await this.getFontBytes(fontId, bold, italic);
    const cacheKey = `${fontId}:${key}`;
    if (this.fontkitFonts.has(cacheKey)) {
      const cached = this.fontkitFonts.get(cacheKey);
      if (cached) return cached;
    }
    const created = fontkit.create(new Uint8Array(bytes));
    this.fontkitFonts.set(cacheKey, created);
    return created;
  }

  /** Метрики шрифта (нужны для согласования базовых линий с PDF). */
  async getMetrics(
    fontId: string,
    bold = false,
    italic = false,
  ): Promise<{ unitsPerEm: number; ascent: number; descent: number } | null> {
    try {
      const font = await this.getFontkitFont(fontId, bold, italic);
      return { unitsPerEm: font.unitsPerEm, ascent: font.ascent, descent: font.descent };
    } catch {
      return null;
    }
  }

  /**
   * Проверка покрытия глифов: какие символы текста отсутствуют в шрифте.
   * Критично для кириллицы — если глифов нет, текст в PDF станет «□□□».
   */
  async checkCoverage(
    fontId: string,
    text: string,
    bold = false,
    italic = false,
  ): Promise<GlyphCoverageResult> {
    const chars = uniqueChars(text).filter((ch) => ch.trim().length > 0);
    if (chars.length === 0) return { supported: true, missing: [] };
    try {
      const font = await this.getFontkitFont(fontId, bold, italic);
      const missing: string[] = [];
      for (const ch of chars) {
        const codePoint = ch.codePointAt(0) ?? 0;
        const has =
          typeof font.hasGlyphForCodePoint === 'function'
            ? font.hasGlyphForCodePoint(codePoint)
            : Array.isArray(font.characterSet) && font.characterSet.includes(codePoint);
        if (!has) missing.push(ch);
      }
      return { supported: missing.length === 0, missing };
    } catch {
      // Если проверить не удалось — не блокируем работу.
      return { supported: true, missing: [] };
    }
  }

  /** Регистрация fontkit в pdf-lib документе. */
  registerFontkit(pdfDoc: PDFDocument): void {
    if (this.metadataFlag) {
      // registerFontkit идемпотентен, но лишний вызов не нужен.
    }
    const register = pdfDoc.registerFontkit.bind(pdfDoc) as (value: unknown) => void;
    register(fontkit);
    this.metadataFlag = true;
  }

  /**
   * Встраивание шрифта в PDF-документ с кэшированием.
   *
   * Важно: подмножества pdf-lib повреждают часть шрифтов (глифы пропадают).
   * Для шрифтов с `subsetSafe: false` выполняется полное встраивание — файл
   * больше, зато кириллица гарантированно корректна. Значения флага получены
   * автоматической проверкой `scripts/check-font-subsets.mjs`.
   */
  async embedFont(
    pdfDoc: PDFDocument,
    cache: Map<string, import('pdf-lib').PDFFont>,
    fontId: string,
    bold = false,
    italic = false,
  ): Promise<{ font: import('pdf-lib').PDFFont; key: string; asset: FontAsset }> {
    const { bytes, key, asset } = await this.getFontBytes(fontId, bold, italic);
    const full = needsFullEmbedding(asset);
    const cacheKey = `${asset.id}:${key}:${full ? 'full' : 'subset'}`;
    const existing = cache.get(cacheKey);
    if (existing) return { font: existing, key, asset };
    const font = await pdfDoc.embedFont(bytes, { subset: !full });
    cache.set(cacheKey, font);
    return { font, key, asset };
  }

  /**
   * Приём пользовательского шрифта (TTF/OTF).
   *
   * Один файл — одно начертание. Все начертания с одинаковым названием семейства
   * собираются в один шрифт: загрузите times.ttf, timesbd.ttf, timesi.ttf и
   * timesbi.ttf — получится «Times New Roman» с обычным, жирным, курсивом и
   * жирным курсивом, и редактор сам подберёт нужное начертание.
   */
  async addUserFont(file: File): Promise<FontAsset> {
    if (file.size === 0) throw new Error('Файл шрифта пуст');
    if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name) && !/font|ttf|otf/i.test(file.type)) {
      throw new Error('Ожидается файл шрифта TTF или OTF');
    }

    const bytes = await file.arrayBuffer();
    let font: FontkitFont;
    try {
      font = fontkit.create(new Uint8Array(bytes));
    } catch {
      throw new Error('Не удалось прочитать файл шрифта. Поддерживаются TTF и OTF.');
    }

    const family = (
      font.familyName ||
      file.name.replace(/\.[^.]+$/, '') ||
      'Пользовательский шрифт'
    ).trim();

    // Название начертания бывает локализованным («Обычный», «Жирный»),
    // поэтому смотрим ещё полное и PostScript-имя файла.
    const styleSource = [font.subfamilyName, font.fullName, font.postscriptName, file.name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isBold = /bold|black|heavy|semibold|demibold|жирн|чёрн|черн/.test(styleSource);
    const isItalic = /italic|oblique|курсив|наклон/.test(styleSource);
    const weight = isBold
      ? /black|heavy|чёрн|черн/.test(styleSource)
        ? 900
        : 700
      : /medium/.test(styleSource)
        ? 500
        : /light|thin/.test(styleSource)
          ? 300
          : 400;
    const style: 'normal' | 'italic' = isItalic ? 'italic' : 'normal';

    // Идентификатор — по СЕМЕЙСТВУ, а не по начертанию: иначе каждый файл
    // (обычный/жирный/курсив) попадал бы в отдельный шрифт в списке.
    const slug =
      family
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'font';
    const id = `user-${slug}`;
    const key = faceKey(weight, style);
    const url = this.createObjectUrl(bytes);

    const existing = this.assets.get(id);
    const faces: Record<string, FontFaceDescriptor> = {
      ...(existing?.faces ?? {}),
      [key]: { weight, style, url, fileName: file.name },
    };
    // Кириллица и безопасность подмножества проверяются параллельно:
    // вторая проверка рендерит пробный PDF, поэтому её результат может
    // позволить встраивать шрифт компактно (см. fontSubsetCheck).
    const [cyrillic, subsetSafe] = await Promise.all([
      this.detectCyrillic(bytes),
      isSubsetSafe(bytes),
    ]);

    const asset: FontAsset = {
      id,
      name: family,
      family,
      source: 'user',
      supportsCyrillic: cyrillic,
      faces,
      loaded: false,
      size: (existing?.size ?? 0) + file.size,
      license: 'Загружен пользователем',
      // true — шрифт проверен и корректно встраивается подмножеством;
      // false — встраиваем целиком, чтобы глифы не пропали.
      subsetSafe,
    };
    this.assets.set(id, asset);
    this.bytesCache.set(`${id}:${key}`, bytes);

    // Сохраняем в IndexedDB, чтобы шрифт был доступен после перезагрузки.
    const stored = (await storageService.assetGet<StoredUserFont>(`font:${id}`)) ?? {
      id,
      name: family,
      family,
      createdAt: new Date().toISOString(),
      faces: [],
    };
    stored.faces = [
      ...stored.faces.filter((item) => item.key !== key),
      { key, weight, style, fileName: file.name, bytes },
    ];
    stored.subsetSafe = subsetSafe;
    await storageService.assetPut(`font:${id}`, stored);

    await this.loadFace(asset, key);
    clearTextMeasureCache();
    return asset;
  }

  /** Удаление пользовательского шрифта. */
  async removeUserFont(id: string): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset || asset.source !== 'user') return;
    for (const key of Object.keys(asset.faces)) {
      this.facePromises.delete(`${id}:${key}`);
      this.bytesCache.delete(`${id}:${key}`);
      this.fontkitFonts.delete(`${id}:${key}`);
      const url = asset.faces[key]?.url;
      if (url && this.objectUrls.has(url)) {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(url);
      }
    }
    this.assets.delete(id);
    await storageService.assetDelete(`font:${id}`);
    clearTextMeasureCache();
  }

  /** Проверка наличия кириллицы в шрифте. */
  private async detectCyrillic(bytes: ArrayBuffer): Promise<boolean> {
    try {
      const font = fontkit.create(new Uint8Array(bytes));
      const probes = ['А', 'Я', 'ё', 'Ж', 'ы'];
      return probes.every((ch) =>
        typeof font.hasGlyphForCodePoint === 'function'
          ? font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0)
          : true,
      );
    } catch {
      return true;
    }
  }
}

/** Единственный экземпляр сервиса шрифтов. */
export const fontService = new FontService();
