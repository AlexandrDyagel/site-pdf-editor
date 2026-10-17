/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          200: '#bcd0ff',
          300: '#8eaeff',
          400: '#5a82fb',
          500: '#355ef0',
          600: '#2140d6',
          700: '#1c33ab',
          800: '#1c2f87',
          900: '#1c2d6b',
        },
        surface: {
          light: '#f7f8fb',
          DEFAULT: '#ffffff',
          dark: '#0f172a',
          darker: '#0b1120',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'PT Sans',
          'Roboto',
          'DejaVu Sans',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['PT Mono', 'DejaVu Sans Mono', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -12px rgba(15, 23, 42, 0.18)',
        floating: '0 12px 32px -8px rgba(15, 23, 42, 0.28)',
      },
      borderRadius: {
        xl2: '1.15rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'scale-in': 'scale-in 140ms ease-out',
      },
    },
  },
  plugins: [],
};
