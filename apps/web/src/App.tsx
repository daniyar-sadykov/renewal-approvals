import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, NETWORK_MESSAGE, setUnauthorizedHandler, type Me } from './api';
import { Login } from './Login';
import { Workspace } from './Workspace';

type Auth = { state: 'checking' } | { state: 'error'; message: string } | { state: 'anonymous' } | { state: 'signed-in'; me: Me };

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);

  const check = useCallback(async () => {
    setAuth({ state: 'checking' });
    try {
      setAuth({ state: 'signed-in', me: await api.me() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuth({ state: 'anonymous' });
      else setAuth({ state: 'error', message: error instanceof ApiError ? error.message : NETWORK_MESSAGE });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setNotice('Сессия закончилась. Войдите снова.');
      setAuth({ state: 'anonymous' });
    });
  }, []);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Сессия уже недействительна или сервер недоступен: на клиенте всё равно выходим.
    }
    // Явный выход сбрасывает адрес карточки: следующий пользователь начинает со списка.
    // При истечении сессии адрес остаётся, чтобы после входа вернуться на то же место.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setNotice('Вы вышли.');
    setAuth({ state: 'anonymous' });
  };

  if (auth.state === 'checking') {
    return (
      <main className="page" aria-busy="true">
        <h1>Заявки на продление</h1>
        <p className="muted" role="status">
          Загрузка...
        </p>
      </main>
    );
  }

  if (auth.state === 'error') {
    return (
      <main className="page">
        <h1>Заявки на продление</h1>
        <div className="card load-error" role="alert">
          <p>{auth.message}</p>
          <button type="button" className="button button-primary" onClick={() => void check()}>
            Повторить
          </button>
        </div>
      </main>
    );
  }

  if (auth.state === 'anonymous') {
    return (
      <Login
        notice={notice}
        onLoggedIn={(me) => {
          setNotice(null);
          setAuth({ state: 'signed-in', me });
        }}
      />
    );
  }

  return <Workspace me={auth.me} onLogout={logout} />;
}
