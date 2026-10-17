/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * fontkit для pdf-lib. Пакет не поставляет собственных типов, поэтому
 * описываем минимальный структурный контракт, который нам реально нужен.
 */
declare module '@pdf-lib/fontkit' {
  export interface FontkitGlyph {
    id: number;
    codePoints: number[];
    advanceWidth: number;
  }
  export interface FontkitLayout {
    glyphs: FontkitGlyph[];
    positions: { xAdvance: number; yAdvance: number }[];
  }
  export interface FontkitFont {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    lineGap: number;
    familyName: string;
    subfamilyName: string;
    fullName?: string;
    postscriptName?: string;
    numGlyphs: number;
    characterSet: number[];
    hasGlyphForCodePoint(codePoint: number): boolean;
    layout(text: string): FontkitLayout;
    widthOfString?(text: string): number;
    getGlyph(id: number): unknown;
    bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  }
  export interface FontkitInstance {
    create(buffer: Uint8Array | ArrayBuffer, postscriptName?: string): FontkitFont;
  }
  const fontkit: FontkitInstance;
  export default fontkit;
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
