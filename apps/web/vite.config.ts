import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// В dev-режиме запросы /api уходят на API, поэтому cookie сессии остаётся на одном origin.
// Порт Vite и цель прокси настраиваются: WEB_PORT (по умолчанию 5173), API_PROXY_TARGET
// (по умолчанию http://127.0.0.1:${PORT}, где PORT это порт API, по умолчанию 3000).
export default defineConfig(({ mode }) => {
  // Третий аргумент '': читать все переменные из корневого .env и окружения, не только VITE_*.
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget = env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || 3000}`;
  const webPort = Number(env.WEB_PORT) || 5173;

  return {
    plugins: [react()],
    server: {
      // Явный IPv4: на Windows localhost может оказаться только ::1.
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
      },
    },
  };
});
