import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText, type RenewalRequest, type ResourceDetails } from './api';
import { CreateRequestAction, LoadError, Skeleton, StatusBadge } from './components';
import { formatDate, formatMoment, formatMoney } from './format';
import { requestHref, usePolling } from './hooks';

type CardState =
  | { state: 'loading' }
  | { state: 'error'; message: string; final: boolean }
  | { state: 'ready'; data: ResourceDetails };

// 403 и 404 повтором не лечатся: ресурс чужой или его нет.
function finalText(error: ApiError): string {
  if (error.status === 403) return 'Нет доступа к этому ресурсу. Он относится к другому рабочему пространству.';
  return 'Такого ресурса нет. Проверьте адрес или вернитесь к списку.';
}

// Экран ресурса по адресу #/resources/<id>: текущий срок, активная заявка, создание заявки и история заявок.
export function ResourceCard({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [card, setCard] = useState<CardState>({ state: 'loading' });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const hasData = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent || !hasData.current) setCard({ state: 'loading' });
      try {
        const data = await api.resource(id);
        hasData.current = true;
        setRefreshError(null);
        setCard({ state: 'ready', data });
      } catch (error) {
        const final = error instanceof ApiError && (error.status === 403 || error.status === 404);
        if (final) setCard({ state: 'error', message: finalText(error), final });
        else if (hasData.current) setRefreshError(errorText(error));
        else setCard({ state: 'error', message: errorText(error), final });
      }
    },
    [id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Фокус на заголовок при открытии экрана, как в карточке заявки.
  const ready = card.state === 'ready';
  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  const refresh = useCallback(async () => {
    await Promise.all([load(true), onChanged()]);
  }, [load, onChanged]);

  const hasProcessing = card.state === 'ready' && card.data.requests.some((request) => request.status === 'processing');
  usePolling(hasProcessing, () => void load(true));

  const title = card.state === 'ready' ? card.data.resource.name : null;
  useEffect(() => {
    document.title = title ? `Ресурс: ${title}` : 'Ресурс';
  }, [title]);

  return (
    <main className="stack">
      <p>
        <a href="#/" className="back-link">
          <span aria-hidden="true">←</span> К списку
        </a>
      </p>

      {card.state === 'loading' && (
        <section className="card">
          <Skeleton rows={5} label="Загружаю ресурс" />
        </section>
      )}

      {card.state === 'error' && (
        <section className="card">
          <h1>Ресурс</h1>
          {card.final ? (
            <p className="feedback feedback-error" role="alert">
              {card.message}
            </p>
          ) : (
            <LoadError message={card.message} onRetry={() => void load(false)} />
          )}
        </section>
      )}

      {card.state === 'ready' && (
        <ResourceView data={card.data} refreshError={refreshError} headingRef={headingRef} onChanged={refresh} />
      )}
    </main>
  );
}

interface ResourceViewProps {
  data: ResourceDetails;
  refreshError: string | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onChanged: () => Promise<void>;
}

function ResourceView({ data, refreshError, headingRef, onChanged }: ResourceViewProps) {
  const { resource, requests } = data;
  const active = resource.activeRequest;
  return (
    <>
      {refreshError && (
        <p className="feedback feedback-error" role="alert">
          Не удалось обновить данные. {refreshError}
        </p>
      )}
      <section className="card" aria-labelledby="resource-title">
        <div className="card-head">
          <h1 id="resource-title" ref={headingRef} tabIndex={-1}>
            Ресурс: {resource.name}
          </h1>
        </div>
        <p className="muted">Рабочее пространство: {resource.workspaceName}</p>

        <p className="expiry">
          <span className="expiry-label">Текущий срок</span>
          <span className="expiry-value">{formatDate(resource.expiresOn)}</span>
        </p>

        <dl className="fields">
          <div>
            <dt>Стоимость продления</dt>
            <dd>{formatMoney(resource.priceMinor, resource.currency)}</dd>
          </div>
          <div className="field-wide">
            <dt>Активная заявка</dt>
            <dd>
              {active ? (
                <>
                  <StatusBadge status={active.status} />
                  <a href={requestHref(active.id)}>Открыть заявку</a>
                </>
              ) : (
                'Нет'
              )}
            </dd>
          </div>
        </dl>

        <div className="resource-actions">
          <CreateRequestAction resource={resource} onChanged={onChanged} />
          {!resource.canCreateRequest && (
            <p className="muted">
              {active
                ? 'Новую заявку создать нельзя, пока активная заявка не завершится.'
                : 'Создать заявку может инициатор этого пространства.'}
            </p>
          )}
          {requests.some((request) => request.status === 'processing') && (
            <p className="muted">Есть заявка в работе, страница обновляется сама.</p>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="resource-history-title">
        <h2 id="resource-history-title">История заявок</h2>
        {requests.length === 0 ? (
          <p className="empty">По этому ресурсу заявок ещё не было.</p>
        ) : (
          <HistoryTable requests={requests} />
        )}
      </section>
    </>
  );
}

function HistoryTable({ requests }: { requests: RenewalRequest[] }) {
  return (
    <table className="grid grid-history">
      <thead>
        <tr>
          <th scope="col">Создана</th>
          <th scope="col">Автор</th>
          <th scope="col">Срок: был, станет</th>
          <th scope="col">Сумма</th>
          <th scope="col">Статус</th>
          <th scope="col">Решение принял</th>
          <th scope="col">Заявка</th>
        </tr>
      </thead>
      <tbody>
        {requests.map((request) => (
          <tr key={request.id}>
            <th scope="row" data-label="Создана" className="cell-title nowrap">
              <time dateTime={request.createdAt}>{formatMoment(request.createdAt)}</time>
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
            </td>
            <td data-label="Решение принял">{request.decidedBy ? request.decidedBy.displayName : 'Нет'}</td>
            <td data-label="Заявка">
              <a href={requestHref(request.id)} aria-label={`Подробнее о заявке от ${formatMoment(request.createdAt)}`}>
                Подробнее
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
