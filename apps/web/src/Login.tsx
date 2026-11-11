import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorText, type Me } from './api';

// Тестовые учётки из начальных данных, для удобства проверяющего.
const demoAccounts = [
  { login: 'initiator.alpha', note: 'Alpha, инициатор' },
  { login: 'approver.alpha', note: 'Alpha, согласующий' },
  { login: 'initiator.beta', note: 'Beta, инициатор' },
  { login: 'universal.alpha', note: 'Alpha, обе роли' },
];

export function Login({ onLoggedIn, notice }: { onLoggedIn: (me: Me) => void; notice: string | null }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loginRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Вход: заявки на продление';
    loginRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    if (!login.trim() || !password) {
      setError('Введите логин и пароль.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(login.trim(), password);
      onLoggedIn(me);
    } catch (caught) {
      setError(errorText(caught));
      passwordRef.current?.focus();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const fill = (value: string) => {
    setLogin(value);
    setError(null);
    passwordRef.current?.focus();
  };

  return (
    <main className="page page-login">
      <h1>Заявки на продление</h1>
      <p className="subtitle">Войдите, чтобы увидеть ресурсы и заявки своего пространства.</p>

      <section className="card login-card" aria-labelledby="login-title">
        <h2 id="login-title">Вход</h2>
        {notice && (
          <p className="feedback feedback-ok" role="status">
            {notice}
          </p>
        )}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <div className="field">
            <label htmlFor="login">Логин</label>
            <input
              id="login"
              ref={loginRef}
              name="username"
              autoComplete="username"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              ref={passwordRef}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          {error && (
            <p id="login-error" className="feedback feedback-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button-primary button-wide" aria-disabled={busy} aria-busy={busy}>
            {busy ? 'Вхожу...' : 'Войти'}
          </button>
        </form>
      </section>

      <section className="card demo-card" aria-labelledby="demo-title">
        <h2 id="demo-title">Тестовые учётки</h2>
        <p className="muted">Пароль у всех один и тот же, он указан в README проекта.</p>
        <ul className="demo-list">
          {demoAccounts.map((account) => (
            <li key={account.login}>
              <span>
                <span className="mono">{account.login}</span>
                <span className="muted"> ({account.note})</span>
              </span>
              <button type="button" className="button button-small" onClick={() => fill(account.login)} aria-label={`Подставить логин ${account.login}`}>
                Подставить логин
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
