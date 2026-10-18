/**
 * Проверка файлов встроенных шрифтов и обновление манифеста.
 *
 * Сами файлы готовит `scripts/tools/prepare-bundled-fonts.py` (скачивает из
 * репозитория Google Fonts и закрепляет вариативные шрифты на весах 400/700).
 * Этот скрипт:
 *   • проверяет, что каждый файл — TrueType с таблицей `glyf` и с кириллицей
 *     (иначе PDF-экспорт через fontkit не сможет его встроить);
 *   • дописывает/обновляет семейства в `public/fonts/fonts.json`.
 *
 * Запуск: node scripts/install-bundled-fonts.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import fontkit from '@pdf-lib/fontkit';

const FONTS_DIR = resolvePath('public/fonts');
const MANIFEST = resolvePath(FONTS_DIR, 'fonts.json');

/** Семейства: id, имя, лицензия, файлы начертаний. */
const FAMILIES = [
  { id: 'tinos', name: 'Tinos', license: 'OFL 1.1 (Chrome OS metric fonts)' },
  { id: 'manrope', name: 'Manrope', license: 'OFL 1.1 (Mikhail Sharanda)' },
  { id: 'liberation-sans', name: 'Liberation Sans', license: 'SIL OFL 1.1 (Red Hat, Liberation Fonts)' },
  { id: 'rubik', name: 'Rubik', license: 'OFL 1.1 (Hubert & Fischer)' },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', license: 'OFL 1.1 (IBM)' },
  { id: 'cormorant', name: 'Cormorant', license: 'OFL 1.1 (Christian Thalmann)' },
  { id: 'merriweather', name: 'Merriweather', license: 'OFL 1.1 (Sorkin Type)' },
  { id: 'pt-serif', name: 'PT Serif', license: 'OFL 1.1 (ParaType)' },
  { id: 'montserrat', name: 'Montserrat', license: 'OFL 1.1 (Julieta Ulanovsky)' },
  { id: 'raleway', name: 'Raleway', license: 'OFL 1.1 (Matt McInerney)' },
  { id: 'fira-sans', name: 'Fira Sans', license: 'OFL 1.1 (Mozilla, Erik Spiekermann)' },
  { id: 'source-sans-3', name: 'Source Sans 3', license: 'OFL 1.1 (Adobe)' },
  { id: 'ubuntu', name: 'Ubuntu', license: 'Ubuntu Font License 1.0 (Canonical)' },
  { id: 'fira-code', name: 'Fira Code', license: 'OFL 1.1 (Nikita Prokopov)' },
  { id: 'golos-text', name: 'Golos Text', license: 'OFL 1.1 (Paratype)' },
  { id: 'open-sans', name: 'Open Sans', license: 'OFL 1.1 (Google)' },
];

const FACES = [
  { key: '400-normal', weight: 400, style: 'normal', suffix: 'Regular' },
  { key: '700-normal', weight: 700, style: 'normal', suffix: 'Bold' },
  { key: '400-italic', weight: 400, style: 'italic', suffix: 'Italic' },
];

/**
 * Семейства, которые портятся при встраивании подмножеством (часть глифов
 * теряется). Для них PDF-экспорт делает полное встраивание — файл больше, но
 * текст целый. Список получен проверкой `scripts/check-font-subsets.mjs`.
 */
const FULL_EMBED = new Set([
  'inter',
  'noto-sans',
  'pt-mono',
  'tinos',
  'liberation-sans',
  'pt-serif',
  'fira-sans',
  'ubuntu',
  'dejavu-sans',
]);

/** Проверка файла: TrueType, `glyf`, кириллица. */
async function inspect(path) {
  const bytes = new Uint8Array(await readFile(path));
  const isTrueType = bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
  if (!isTrueType) return { ok: false, reason: 'не TrueType' };
  const font = fontkit.create(Buffer.from(bytes));
  const hasGlyf = Boolean(font.directory?.tables?.glyf);
  const cyrillic = [0x0410, 0x0401, 0x0451, 0x0456].every((code) => font.hasGlyphForCodePoint(code));
  const ascii = [0x41, 0x61, 0x30].every((code) => font.hasGlyphForCodePoint(code));
  return {
    ok: hasGlyf && cyrillic && ascii,
    reason: !hasGlyf ? 'нет таблицы glyf (CFF не встраивается)' : !cyrillic ? 'нет кириллицы' : !ascii ? 'нет латиницы' : '',
    size: bytes.length,
    family: font.familyName,
    weight: font['OS/2']?.usWeightClass ?? null,
    glyphs: font.numGlyphs,
  };
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const lines = [];
let added = 0;
let updated = 0;

for (const asset of FAMILIES) {
  const stem = asset.name.replace(/\s+/g, '');
  const faces = {};
  const details = [];

  for (const face of FACES) {
    const file = `${stem}-${face.suffix}.ttf`;
    const path = resolvePath(FONTS_DIR, file);
    if (!existsSync(path)) continue;
    const info = await inspect(path);
    if (!info.ok) {
      console.error(`✗ ${asset.name} ${face.key}: ${info.reason}`);
      continue;
    }
    faces[face.key] = { weight: face.weight, style: face.style, url: file };
    details.push(`${face.key} ${(info.size / 1024).toFixed(0)} КБ / ${info.glyphs} глифов / вес ${info.weight}`);
  }

  if (Object.keys(faces).length === 0) {
    console.error(`✗ ${asset.name}: нет пригодных файлов`);
    continue;
  }

  const index = manifest.fonts.findIndex((item) => item.id === asset.id);
  const entry = {
    id: asset.id,
    name: asset.name,
    family: asset.name,
    source: 'bundled',
    supportsCyrillic: true,
    subsetSafe: !FULL_EMBED.has(asset.id),
    license: asset.license,
    faces,
  };

  if (index >= 0) {
    manifest.fonts[index] = { ...manifest.fonts[index], ...entry };
    updated += 1;
  } else {
    manifest.fonts.push(entry);
    added += 1;
  }
  lines.push(`  ${asset.name}: ${details.join(', ')}`);
}

manifest.note =
  'Встроенные шрифты с поддержкой кириллицы. Файлы лежат в public/fonts и встраиваются в PDF через fontkit. Лицензии: PT Sans/PT Mono/PT Serif/Golos Text — ParaType (OFL 1.1), Roboto — Google (Apache 2.0), Inter — rsms (OFL 1.1), Noto Sans — Google (OFL 1.1), DejaVu — Bitstream Vera, Tinos — Chrome OS metric fonts (OFL 1.1), Liberation Sans — Red Hat (OFL 1.1), Ubuntu — Canonical (UFL 1.0), остальные — Google Fonts (OFL 1.1).';

await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const totalFaces = manifest.fonts.reduce((sum, item) => sum + Object.keys(item.faces).length, 0);
console.log(`\nСемейств добавлено: ${added}, обновлено: ${updated}`);
console.log(`Всего семейств: ${manifest.fonts.length}, начертаний: ${totalFaces}`);
for (const line of lines) console.log(line);
