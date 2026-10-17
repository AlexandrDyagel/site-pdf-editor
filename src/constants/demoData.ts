/**
 * Демонстрационные данные: образцы штампов, печатей и подписи.
 * Добавляются в библиотеку один раз, если она пуста — чтобы пользователь
 * сразу увидел, как работают инструменты.
 */

import type { SignatureTemplate, StampTemplate, StrokeData, StrokePoint } from '@/types';
import { createId } from '@/utils/id';
import { createSealTemplate, createStampLine, createStampTemplate } from '@/services/stampRenderService';
import { renderStrokesPreview } from '@/services/imageExportService';

/** Образец прямоугольного штампа «УТВЕРЖДАЮ». */
export function demoApprovalStamp(): StampTemplate {
  return createStampTemplate({
    id: createId('stamp'),
    name: 'УТВЕРЖДАЮ (образец)',
    width: 180,
    height: 72,
    color: '#1d4ed8',
    borderWidth: 2,
    lines: [
      createStampLine('УТВЕРЖДАЮ', { fontSize: 15, bold: true, letterSpacing: 1.6 }),
      createStampLine('Генеральный директор', { fontSize: 10 }),
      createStampLine('___________ / И. И. Иванов', { fontSize: 10 }),
      createStampLine('«___» __________ 20__ г.', { fontSize: 9, italic: true }),
    ],
  });
}

/** Образец штампа «КОПИЯ ВЕРНА». */
export function demoCopyStamp(): StampTemplate {
  return createStampTemplate({
    id: createId('stamp'),
    name: 'КОПИЯ ВЕРНА (образец)',
    width: 190,
    height: 60,
    color: '#15803d',
    borderWidth: 2,
    divider: true,
    lines: [
      createStampLine('КОПИЯ ВЕРНА', { fontSize: 14, bold: true, letterSpacing: 1.4 }),
      createStampLine('Секретарь ______________', { fontSize: 9 }),
    ],
  });
}

/** Образец круглой печати организации. */
export function demoRoundSeal(): StampTemplate {
  const seal = createSealTemplate({
    id: createId('seal'),
    name: 'Печать организации (образец)',
    width: 130,
    height: 130,
    color: '#b91c1c',
    borderWidth: 2.5,
    doubleBorder: true,
    borderGap: 6,
    lines: [
      createStampLine('ООО «РОМАШКА»', { fontSize: 11, bold: true }),
      createStampLine('ОГРН 1234567890123', { fontSize: 8 }),
      createStampLine('ИНН 7701234567', { fontSize: 8 }),
    ],
    circularText: {
      enabled: true,
      text: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
      bottomText: 'г. Москва · ул. Примерная, д. 1',
      fontSize: 8.5,
      radius: 0,
      startAngle: 270,
      direction: 'cw',
      letterSpacing: 1,
      color: null,
      splitBottom: true,
    },
  });
  return seal;
}

/** Рукописная «подпись» из нескольких штрихов (генерируется программно). */
export function demoSignatureStrokes(): StrokeData[] {
  const makeStroke = (
    startX: number,
    amplitude: number,
    length: number,
    seed: number,
  ): StrokeData => {
    const points: StrokePoint[] = [];
    const steps = 60;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = startX + t * length;
      const wave = Math.sin(t * Math.PI * 2.2 + seed) * amplitude * (1 - t * 0.35);
      const y = 95 + wave - t * 12;
      points.push({ x, y, pressure: 0.45 + Math.abs(wave) / (amplitude * 4) });
    }
    return {
      tool: 'brush',
      color: '#111827',
      width: 2.6,
      opacity: 1,
      points,
      smooth: true,
    };
  };

  return [
    makeStroke(40, 22, 300, 0.4),
    makeStroke(58, 12, 250, 1.9),
    {
      tool: 'brush',
      color: '#111827',
      width: 2.2,
      opacity: 1,
      smooth: true,
      points: Array.from({ length: 26 }, (_, index) => {
        const t = index / 25;
        return { x: 90 + t * 230, y: 74 + Math.sin(t * Math.PI * 3) * 3, pressure: 0.5 };
      }),
    },
  ];
}

/** Образец подписи для библиотеки. */
export function demoSignature(): SignatureTemplate {
  const strokes = demoSignatureStrokes();
  const now = new Date().toISOString();
  return {
    id: createId('signature'),
    name: 'Подпись (образец)',
    strokes,
    designWidth: 420,
    designHeight: 160,
    color: '#111827',
    strokeWidth: 2.6,
    svg: null,
    png: renderStrokesPreview(strokes, 420, 160, 2),
    createdAt: now,
    updatedAt: now,
    tags: ['образец'],
    preview: null,
  };
}
