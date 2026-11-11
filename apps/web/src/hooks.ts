import { useCallback, useEffect, useRef, useState } from 'react';

export type Route = { view: 'list' } | { view: 'request'; id: string };

function parseHash(hash: string): Route {
  const match = /^#\/requests\/([^/?#]+)$/.exec(hash);
  if (match) return { view: 'request', id: decodeURIComponent(match[1]) };
  return { view: 'list' };
}

// Адрес экрана в хэше: обновление страницы оставляет пользователя на той же карточке.
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function requestHref(id: string): string {
  return `#/requests/${encodeURIComponent(id)}`;
}

// Опрос раз в intervalMs, пока active и вкладка видима. При возврате на вкладку сразу обновляет.
export function usePolling(active: boolean, callback: () => void, intervalMs = 2500): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const start = () => {
      if (timer === undefined && !document.hidden) {
        timer = window.setInterval(() => saved.current(), intervalMs);
      }
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        saved.current();
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, intervalMs]);
}

// Действие с защитой от двойного клика: пока идёт запрос, повторный вызов игнорируется.
export function useBusyAction() {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await task();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
