/**
 * Настройки приложения: тема, привязки, значения по умолчанию.
 * Сохраняются в localStorage и переживают перезагрузку страницы.
 */

import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/constants';
import type { AppSettings, ThemeMode } from '@/types';
import type { ShapeDefaults, StrokeDefaults, TextDefaults } from '@/services/objectFactory';
import { fontService } from '@/services/fontService';
import { useHistoryStore } from '@/stores/history';

/** Разрешение системной темы. */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const useSettingsStore = defineStore('settings', () => {
  const history = useHistoryStore();

  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS });
  const systemDark = ref(systemPrefersDark());
  const loaded = ref(false);

  /** Итоговая тема с учётом системной. */
  const isDark = computed(() => {
    if (settings.value.theme === 'dark') return true;
    if (settings.value.theme === 'light') return false;
    return systemDark.value;
  });

  const themeLabel = computed(() =>
    isDark.value ? 'Тёмная тема' : 'Светлая тема',
  );

  /** Значения по умолчанию для текстовых объектов. */
  const textDefaults = computed<TextDefaults>(() => {
    const font = fontService.get(settings.value.defaultFontId);
    return {
      fontId: font?.id ?? settings.value.defaultFontId,
      fontFamily: font?.family ?? 'PT Sans',
      fontSize: settings.value.defaultTextSize,
      color: settings.value.defaultTextColor,
      lineHeight: 1.25,
      letterSpacing: 0,
    };
  });

  /** Значения по умолчанию для фигур. */
  const shapeDefaults = computed<ShapeDefaults>(() => ({
    stroke: settings.value.defaultStrokeColor,
    strokeWidth: settings.value.defaultStrokeWidth,
    fill: null,
  }));

  /** Значения по умолчанию для рисования. */
  const strokeDefaults = computed<StrokeDefaults>(() => ({
    color: settings.value.defaultStrokeColor,
    width: settings.value.defaultStrokeWidth,
    opacity: 1,
  }));

  /* ======================== Тема ======================== */

  function applyTheme(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', isDark.value);
    root.style.colorScheme = isDark.value ? 'dark' : 'light';
  }

  function setTheme(mode: ThemeMode): void {
    settings.value.theme = mode;
    applyTheme();
    persist();
  }

  function toggleTheme(): void {
    setTheme(isDark.value ? 'light' : 'dark');
  }

  /* ======================== Персистентность ======================== */

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings.value));
    } catch {
      /* хранилище может быть недоступно */
    }
  }

  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.settings);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        settings.value = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch {
      settings.value = { ...DEFAULT_SETTINGS };
    }
    loaded.value = true;
    applyTheme();
    history.setLimit(settings.value.historyLimit);
  }

  function update(patch: Partial<AppSettings>): void {
    settings.value = { ...settings.value, ...patch };
    if (patch.historyLimit !== undefined) history.setLimit(patch.historyLimit);
    persist();
  }

  function reset(): void {
    settings.value = { ...DEFAULT_SETTINGS };
    applyTheme();
    persist();
    history.setLimit(settings.value.historyLimit);
  }

  /* ======================== Реакция на системную тему ======================== */

  if (typeof window !== 'undefined' && window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      systemDark.value = event.matches;
      applyTheme();
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
    }
  }

  watch(isDark, () => applyTheme());

  return {
    settings,
    loaded,
    isDark,
    themeLabel,
    textDefaults,
    shapeDefaults,
    strokeDefaults,
    setTheme,
    toggleTheme,
    applyTheme,
    load,
    update,
    reset,
    persist,
  };
});
