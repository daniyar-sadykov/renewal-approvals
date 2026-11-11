import { useEffect, useState } from 'react';

type ApiState = 'loading' | 'up' | 'down';

const apiStateText: Record<ApiState, string> = {
  loading: 'проверяю...',
  up: 'отвечает',
  down: 'недоступен',
};

// Заготовка: экраны появятся в следующих фичах. Пока только проверка связи с API через прокси /api.
export function App() {
  const [api, setApi] = useState<ApiState>('loading');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then((response) => setApi(response.ok ? 'up' : 'down'))
      .catch(() => {
        if (!controller.signal.aborted) setApi('down');
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="page">
      <h1>Продления</h1>
      <p role="status">API: {apiStateText[api]}</p>
    </main>
  );
}
