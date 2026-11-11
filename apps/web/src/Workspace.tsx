import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, type Me, type RenewalRequest, type Resource } from './api';
import { CreateRequestAction, LoadError, RequestActions, Skeleton, StatusBadge } from './components';
import { formatDate, formatMoney, problemWithCode, rolesText } from './format';
import { requestHref, useHashRoute, usePolling } from './hooks';
import { RequestCard } from './RequestCard';

interface ListData {
  resources: Resource[];
  requests: RenewalRequest[];
}

type ListState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: ListData };

export function Workspace({ me, onLogout }: { me: Me; onLogout: () => Promise<void> }) {
  const route = useHashRoute();
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const hasData = useRef(false);

  // silent: обновление без скелета, данные на экране остаются до прихода новых.
  const load = useCallback(async (silent: boolean) => {
    if (!silent || !hasData.current) setList({ state: 'loading' });
    try {
      const [resources, requests] = await Promise.all([api.resources(), api.requests()]);
      hasData.current = true;
      setRefreshError(null);
      setList({ state: 'ready', data: { resources, requests } });
    } catch (error) {
      if (hasData.current) setRefreshError(errorText(error));
      else setList({ state: 'error', message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  // Возврат из карточки: тихо перечитать список и вернуть фокус на ссылку этой заявки.
  const previousRoute = useRef(route);
  useEffect(() => {
    const previous = previousRoute.current;
    previousRoute.current = route;
    if (previous.view === 'request' && route.view === 'list') {
      void refresh();
      const link = document.querySelector<HTMLElement>(`[data-request-link="${CSS.escape(previous.id)}"]`);
      link?.focus();
    }
  }, [route, refresh]);

  const hasProcessing = list.state === 'ready' && list.data.requests.some((request) => request.status === 'processing');
  usePolling(route.view === 'list' && hasProcessing, () => void refresh());

  const workspaces = me.memberships.map((membership) => membership.workspaceName).join(', ') || 'нет';

  useEffect(() => {
    if (route.view === 'list') document.title = 'Заявки на продление';
  }, [route.view]);

  return (
    <div className="page">
      <header className="top">
        <div>
          {route.view === 'list' ? (
            <h1>Заявки на продление</h1>
          ) : (
            <a className="brand" href="#/">
              Заявки на продление
            </a>
          )}
          <p className="subtitle">Рабочее пространство: {workspaces}</p>
        </div>
        <div className="user">
          <div className="user-text">
            <span className="user-name">{me.user.displayName}</span>
            <span className="muted">
              {me.memberships.map((membership) => `${membership.workspaceName}: ${rolesText(membership)}`).join('; ')}
            </span>
          </div>
          <button
            type="button"
            className="button button-secondary"
            aria-disabled={loggingOut}
            onClick={() => {
              if (loggingOut) return;
              setLoggingOut(true);
              void onLogout();
            }}
          >
            Выйти
          </button>
        </div>
      </header>

      {route.view === 'request' ? (
        <RequestCard key={route.id} id={route.id} onChanged={refresh} />
      ) : (
        <main className="stack">
          {refreshError && (
            <p className="feedback feedback-error" role="alert">
              Не удалось обновить данные. {refreshError}
            </p>
          )}
          {list.state === 'loading' && (
            <section className="card">
              <Skeleton rows={4} label="Загружаю ресурсы и заявки" />
            </section>
          )}
          {list.state === 'error' && (
            <section className="card">
              <LoadError message={list.message} onRetry={() => void load(false)} />
            </section>
          )}
          {list.state === 'ready' && (
            <>
              <ResourcesSection resources={list.data.resources} onChanged={refresh} />
              <RequestsSection requests={list.data.requests} onChanged={refresh} />
            </>
          )}
        </main>
      )}
    </div>
  );
}

function ResourcesSection({ resources, onChanged }: { resources: Resource[]; onChanged: () => Promise<void> }) {
  return (
    <section className="card" aria-labelledby="resources-title">
      <h2 id="resources-title">Ресурсы</h2>
      {resources.length === 0 ? (
        <p className="empty">В ваших пространствах нет ресурсов.</p>
      ) : (
        <table className="grid grid-resources">
          <thead>
            <tr>
              <th scope="col">Ресурс</th>
              <th scope="col">Пространство</th>
              <th scope="col">Срок</th>
              <th scope="col">Стоимость</th>
              <th scope="col">Заявка</th>
              <th scope="col">Действие</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr key={resource.id}>
                <th scope="row" data-label="Ресурс" className="cell-title">
                  {resource.name}
                </th>
                <td data-label="Пространство">{resource.workspaceName}</td>
                <td data-label="Срок">{formatDate(resource.expiresOn)}</td>
                <td data-label="Стоимость" className="nowrap">
                  {formatMoney(resource.priceMinor, resource.currency)}
                </td>
                <td data-label="Заявка">
                  {resource.activeRequest ? (
                    <a href={requestHref(resource.activeRequest.id)} aria-label={`Активная заявка: ${resource.name}`}>
                      <StatusBadge status={resource.activeRequest.status} />
                    </a>
                  ) : (
                    <span className="muted">Нет активной</span>
                  )}
                </td>
                <td data-label="Действие">
                  <div>
                    <CreateRequestAction resource={resource} onChanged={onChanged} />
                    {!resource.canCreateRequest && (
                      <span className="muted">{resource.activeRequest ? 'Заявка уже есть' : 'Нет права'}</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RequestsSection({ requests, onChanged }: { requests: RenewalRequest[]; onChanged: () => Promise<void> }) {
  const count = (status: string) => requests.filter((request) => request.status === status).length;
  const attention = count('needs_attention');
  return (
    <section className="card" aria-labelledby="requests-title">
      <h2 id="requests-title">Заявки</h2>
      <ul className="stats" aria-label="Сводка по заявкам">
        <li>Всего: {requests.length}</li>
        <li className="stat-pending">Ожидают: {count('pending')}</li>
        <li className="stat-processing">Выполняется: {count('processing')}</li>
        {attention > 0 && <li className="stat-needs_attention">Требует внимания: {attention}</li>}
      </ul>
      {requests.length === 0 ? (
        <p className="empty">Заявок пока нет. Создайте заявку на продление у ресурса выше.</p>
      ) : (
        <table className="grid grid-requests">
          <thead>
            <tr>
              <th scope="col">Ресурс</th>
              <th scope="col">Автор</th>
              <th scope="col">Срок: был, станет</th>
              <th scope="col">Сумма</th>
              <th scope="col">Статус</th>
              <th scope="col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <th scope="row" data-label="Ресурс" className="cell-title">
                  <a href={requestHref(request.id)} data-request-link={request.id}>
                    {request.resourceName}
                  </a>
                </th>
                <td data-label="Автор">{request.createdBy.displayName}</td>
                <td data-label="Срок" className="nowrap">
                  <span>
                    {formatDate(request.oldExpiresOn)} <span aria-hidden="true">→</span>
                    <span className="visually-hidden"> на </span> {formatDate(request.newExpiresOn)}
                  </span>
                </td>
                <td data-label="Сумма" className="nowrap">
                  {formatMoney(request.amountMinor, request.currency)}
                </td>
                <td data-label="Статус">
                  <StatusBadge status={request.status} />
                  {request.status === 'needs_attention' && (
                    <div className="muted status-reason">
                      {request.lastErrorCode ? problemWithCode(request.lastErrorCode) : 'Нет подтверждения провайдера'}.{' '}
                      {request.canRetry ? 'Можно повторить отправку.' : 'Повторить может согласующий.'}
                    </div>
                  )}
                </td>
                <td data-label="Действия">
                  <div>
                    <RequestActions request={request} onChanged={onChanged} />
                    <a className="link-more" href={requestHref(request.id)} aria-label={`Подробнее о заявке: ${request.resourceName}`}>
                      Подробнее
                    </a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
