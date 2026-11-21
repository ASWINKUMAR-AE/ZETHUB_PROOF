/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0e0e15',
          900: '#14141d',
          850: '#191924',
          800: '#20202c',
          700: '#292938',
          600: '#353548',
        },
        line: {
          DEFAULT: '#32324d',
          soft: '#26263a',
          strong: '#4b4b74',
        },
        accent: {
          DEFAULT: '#5b5bcf',
          soft: '#b8b4f5',
          deep: '#292a66',
        },
        lavender: {
          DEFAULT: '#C7C3F0',
          200: '#DCD9F7',
          400: '#B0ABE6',
          700: '#7773B8',
        },
        ember: {
          DEFAULT: '#D85A4A',
          soft: '#F08472',
          deep: '#9C3A2F',
        },
        cyan: '#8fb8ff',
        positive: '#4ade9b',
        negative: '#fb8a8a',
        warning: '#f4c66a',
        muted: '#9aa0c0',
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(199,195,240,.16), 0 22px 70px -30px rgba(91,91,207,.55)',
        panel: '0 28px 80px -44px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.045)',
        ember: '0 0 0 1px rgba(216,90,74,.25), 0 18px 50px -24px rgba(216,90,74,.55)',
      },
      backgroundImage: {
        'grid-faint':
          'linear-gradient(rgba(199,195,240,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(199,195,240,.04) 1px, transparent 1px)',
        'accent-sheen': 'linear-gradient(135deg, rgba(91,91,207,.30), rgba(199,195,240,.10) 55%, transparent)',
        'ember-sheen': 'linear-gradient(135deg, rgba(216,90,74,.22), transparent 65%)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
      },
      animation: {
        'fade-in': 'fade-in .22s ease-out',
        'slide-in': 'slide-in .22s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
