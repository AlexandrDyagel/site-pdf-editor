/**
 * Хранилище шрифтов: встроенные шрифты с кириллицей + пользовательские TTF/OTF.
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { FontAsset, GlyphCoverageResult } from '@/types';
import { DEFAULT_FONT_ID } from '@/constants';
import { clearTextMeasureCache } from '@/utils/textLayout';
import { ensureMetrics } from '@/services/textRenderService';
import { fontService, describeFace } from '@/services/fontService';

export const useFontsStore = defineStore('fonts', () => {
  const fonts = ref<FontAsset[]>([]);
  const isLoading = ref(false);
  const isUploading = ref(false);
  const error = ref<string | null>(null);
  const loadedOnce = ref(false);

  const cyrillicFonts = computed(() => fonts.value.filter((font) => font.supportsCyrillic));
  const userFonts = computed(() => fonts.value.filter((font) => font.source === 'user'));
  const defaultFont = computed(
    () => fonts.value.find((font) => font.id === DEFAULT_FONT_ID) ?? fonts.value[0],
  );

  /** Загрузка манифеста и всех начертаний. */
  async function load(force = false): Promise<void> {
    if (isLoading.value) return;
    isLoading.value = true;
    error.value = null;
    try {
      await fontService.loadAll(force);
      fonts.value = fontService.list();
      await fontService.preloadAll();
      fonts.value = fontService.list();
      loadedOnce.value = true;
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      isLoading.value = false;
    }
  }

  function byId(id: string | undefined): FontAsset | undefined {
    if (!id) return undefined;
    return fonts.value.find((font) => font.id === id) ?? fontService.get(id);
  }

  /** Семейство шрифта (для canvas/Konva). */
  function familyOf(id: string | undefined): string {
    return byId(id)?.family ?? byId(DEFAULT_FONT_ID)?.family ?? 'PT Sans';
  }

  /** Загрузка пользовательского шрифта. */
  async function uploadFont(file: File): Promise<FontAsset> {
    isUploading.value = true;
    error.value = null;
    try {
      const asset = await fontService.addUserFont(file);
      await fontService.ensureFacesLoaded(asset.id);
      clearTextMeasureCache();
      fonts.value = fontService.list();
      return asset;
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
      error.value = message;
      throw new Error(message);
    } finally {
      isUploading.value = false;
    }
  }

  /** Удаление пользовательского шрифта. */
  async function removeFont(id: string): Promise<void> {
    await fontService.removeUserFont(id);
    clearTextMeasureCache();
    fonts.value = fontService.list();
  }

  /** Проверка покрытия глифов. */
  async function checkCoverage(
    fontId: string,
    text: string,
    bold = false,
    italic = false,
  ): Promise<GlyphCoverageResult> {
    return fontService.checkCoverage(fontId, text, bold, italic);
  }

  /** Гарантировать загрузку начертания и метрик (для корректной раскладки). */
  async function ensureFontLoadedFor(
    fontId: string,
    bold = false,
    italic = false,
  ): Promise<void> {
    const asset = byId(fontId);
    if (!asset) return;
    await fontService.ensureFacesLoaded(asset.id);
    await ensureMetrics(asset.id, bold, italic);
  }

  /** Названия начертаний шрифта для интерфейса. */
  function faceLabels(fontId: string): string[] {
    const asset = byId(fontId);
    if (!asset) return [];
    return Object.keys(asset.faces)
      .sort()
      .map((key) => describeFace(key));
  }

  /** Есть ли у шрифта курсивное начертание. */
  function hasItalic(fontId: string): boolean {
    const asset = byId(fontId);
    if (!asset) return false;
    return Object.keys(asset.faces).some((key) => key.endsWith('italic'));
  }

  /** Есть ли у шрифта жирное начертание. */
  function hasBold(fontId: string): boolean {
    const asset = byId(fontId);
    if (!asset) return false;
    return Object.keys(asset.faces).some((key) => key.startsWith('700') || key.startsWith('900'));
  }

  return {
    fonts,
    isLoading,
    isUploading,
    error,
    loadedOnce,
    cyrillicFonts,
    userFonts,
    defaultFont,
    load,
    byId,
    familyOf,
    faceLabels,
    uploadFont,
    removeFont,
    checkCoverage,
    ensureFontLoadedFor,
    hasItalic,
    hasBold,
  };
});
