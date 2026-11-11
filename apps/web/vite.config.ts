import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// В dev-режиме запросы /api уходят на API, поэтому cookie сессии остаётся на одном origin.
export default defineConfig(({ mode }) => {
  // Третий аргумент '': читать все переменные из корневого .env и окружения, не только VITE_*.
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget = `http://127.0.0.1:${env.PORT || 3000}`;

  return {
    plugins: [react()],
    server: {
      // Явный IPv4: на Windows localhost может оказаться только ::1.
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
      },
    },
  };
});
