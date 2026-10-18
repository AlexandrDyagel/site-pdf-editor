/**
 * ============================================================================
 *  Курсоры редактора.
 * ============================================================================
 *
 *  В браузере нет штатного курсора «поворот», поэтому рисуем его сами:
 *  дуга окружности с двумя наконечниками (как в графических редакторах).
 *  Картинка собирается в canvas один раз, отдаётся как PNG data:URL —
 *  такой курсор понимают все браузеры, в отличие от SVG-курсоров.
 */

/** Размер курсора в пикселях (совпадает с CSS-размером). */
const SIZE = 24;

/**
 * Собирает курсор поворота: белая обводка-«ореол» + тёмная дуга с двумя
 * наконечниками. Горячая точка — центр картинки.
 */
function buildRotateCursor(): string {
  if (typeof document === 'undefined') return 'crosshair';

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'crosshair';

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const radius = 7;
  // Дуга почти полного круга с разрывом справа.
  const start = Math.PI * 0.8;
  const end = Math.PI * 2.2;

  const dark = '#111827';
  const light = '#ffffff';

  /** Наконечник стрелки в точке дуги, направление — по касательной. */
  const head = (angle: number, clockwise: boolean): void => {
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    // Касательная: при движении по часовой стрелке — (-sin, cos).
    const tx = clockwise ? -Math.sin(angle) : Math.sin(angle);
    const ty = clockwise ? Math.cos(angle) : -Math.cos(angle);
    const length = 5.4;
    const width = 5.2;
    const tipX = x + tx * length;
    const tipY = y + ty * length;
    const baseX = x + tx * 0.6;
    const baseY = y + ty * 0.6;
    const perpX = -ty;
    const perpY = tx;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + (perpX * width) / 2, baseY + (perpY * width) / 2);
    ctx.lineTo(baseX - (perpX * width) / 2, baseY - (perpY * width) / 2);
    ctx.closePath();
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.strokeStyle = light;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  const arc = (): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end, false);
    ctx.stroke();
  };

  // Ореол, чтобы курсор читался на тёмной панели и на белой странице.
  ctx.lineCap = 'round';
  ctx.strokeStyle = light;
  ctx.lineWidth = 5.6;
  arc();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 2.2;
  arc();

  head(end, true);
  head(start, false);

  return `url("${canvas.toDataURL('image/png')}") 12 12, crosshair`;
}

/** Курсор поворота выделенного объекта. */
export const ROTATE_CURSOR = buildRotateCursor();
