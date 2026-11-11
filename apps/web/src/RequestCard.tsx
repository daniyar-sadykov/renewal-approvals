import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText, type RequestDetails } from './api';
import { CopyButton, LoadError, RequestActions, Skeleton, StatusBadge } from './components';
import {
  eventDetailText,
  eventKindText,
  formatDate,
  formatMoment,
  formatMoney,
  needsAttentionAdvice,
  problemText,
  problemWithCode,
  statusText,
} from './format';
import { usePolling } from './hooks';

type CardState =
  | { state: 'loading' }
  | { state: 'error'; message: string; final: boolean }
  | { state: 'ready'; data: RequestDetails };

// Карточка заявки по адресу #/requests/<id>: все поля, действия и история событий.
export function RequestCard({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [card, setCard] = useState<CardState>({ state: 'loading' });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const hasData = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent || !hasData.current) setCard({ state: 'loading' });
      try {
        const data = await api.request(id);
        hasData.current = true;
        setRefreshError(null);
        setCard({ state: 'ready', data });
      } catch (error) {
        // 403 и 404 повтором не лечатся: заявки нет или она чужая.
        const final = error instanceof ApiError && (error.status === 403 || error.status === 404);
        if (hasData.current && !final) setRefreshError(errorText(error));
        else setCard({ state: 'error', message: errorText(error), final });
      }
    },
    [id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Фокус на заголовок при открытии карточки, чтобы клавиатура и экранный диктор начинали отсюда.
  const ready = card.state === 'ready';
  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  const refresh = useCallback(async () => {
    await Promise.all([load(true), onChanged()]);
  }, [load, onChanged]);

  const processing = card.state === 'ready' && card.data.request.status === 'processing';
  usePolling(processing, () => void load(true));

  const title = card.state === 'ready' ? card.data.request.resourceName : null;
  useEffect(() => {
    document.title = title ? `Заявка: ${title}` : 'Заявка на продление';
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
          <Skeleton rows={5} label="Загружаю заявку" />
        </section>
      )}

      {card.state === 'error' && (
        <section className="card">
          <h1>Заявка</h1>
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
        <>
          {refreshError && (
            <p className="feedback feedback-error" role="alert">
              Не удалось обновить данные. {refreshError}
            </p>
          )}
          <section className="card" aria-labelledby="request-title">
            <div className="card-head">
              <h1 id="request-title" ref={headingRef} tabIndex={-1}>
                Заявка: {card.data.request.resourceName}
              </h1>
              <StatusBadge status={card.data.request.status} />
            </div>
            {card.data.request.status === 'processing' && (
              <p className="muted">
                Заявка выполняется, страница обновляется сама.
                {card.data.request.lastErrorCode &&
                  ` Последняя попытка: ${problemWithCode(card.data.request.lastErrorCode)}. Обработчик повторит сам с тем же ключом.`}
              </p>
            )}
            {card.data.request.status === 'needs_attention' && (
              <div className="feedback feedback-error attention-note" role="note">
                <p>
                  <strong>Что случилось:</strong>{' '}
                  {card.data.request.lastErrorCode
                    ? problemWithCode(card.data.request.lastErrorCode)
                    : 'подтверждения от провайдера нет'}
                  .
                </p>
                <p>
                  <strong>Что делать:</strong>{' '}
                  {needsAttentionAdvice(card.data.request.lastErrorCode, card.data.request.canRetry)}
                </p>
              </div>
            )}

            <RequestActions request={card.data.request} onChanged={refresh} />

            <RequestFields details={card.data} />
          </section>

          <section className="card" aria-labelledby="history-title">
            <h2 id="history-title">История</h2>
            {card.data.events.length === 0 ? (
              <p className="empty">Событий пока нет.</p>
            ) : (
              <ol className="history">
                {card.data.events.map((event) => {
                  const detail = eventDetailText(event.kind, event.detail);
                  return (
                  <li key={event.id}>
                    <div className="history-head">
                      <span className="history-kind">{eventKindText(event.kind)}</span>
                      <time dateTime={event.createdAt} className="muted">
                        {formatMoment(event.createdAt)}
                      </time>
                    </div>
                    <div className="history-body">
                      <span>
                        {event.fromStatus && event.fromStatus === event.toStatus ? (
                          `${statusText(event.toStatus)}, статус не меняется`
                        ) : (
                          <>
                            {event.fromStatus ? (
                              <>
                                {statusText(event.fromStatus)} <span aria-hidden="true">→</span>
                                <span className="visually-hidden"> в </span>{' '}
                              </>
                            ) : null}
                            {event.toStatus ? statusText(event.toStatus) : 'Без смены статуса'}
                          </>
                        )}
                      </span>
                      <span className="muted">{event.actor ? event.actor.displayName : 'Система'}</span>
                    </div>
                    {detail && <p className="history-detail break">{detail}</p>}
                  </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function RequestFields({ details }: { details: RequestDetails }) {
  const request = details.request;
  return (
    <dl className="fields">
      <div>
        <dt>Прежний срок</dt>
        <dd>{formatDate(request.oldExpiresOn)}</dd>
      </div>
      <div>
        <dt>Новый срок</dt>
        <dd>{formatDate(request.newExpiresOn)}</dd>
      </div>
      <div>
        <dt>Сумма</dt>
        <dd>{formatMoney(request.amountMinor, request.currency)}</dd>
      </div>
      <div>
        <dt>Автор</dt>
        <dd>{request.createdBy.displayName}</dd>
      </div>
      <div>
        <dt>Решение принял</dt>
        <dd>{request.decidedBy ? request.decidedBy.displayName : 'Нет'}</dd>
      </div>
      <div>
        <dt>Создана</dt>
        <dd>{formatMoment(request.createdAt)}</dd>
      </div>
      <div>
        <dt>Решение</dt>
        <dd>{formatMoment(request.decidedAt)}</dd>
      </div>
      <div>
        <dt>Завершена</dt>
        <dd>{formatMoment(request.completedAt)}</dd>
      </div>
      <div className="field-wide">
        <dt>Ключ операции</dt>
        <dd>
          <code className="break">{request.idempotencyKey}</code>{' '}
          <CopyButton value={request.idempotencyKey} label="ключ операции" />
        </dd>
      </div>
      <div className="field-wide">
        <dt>Операция провайдера</dt>
        <dd>
          {request.providerOperationId ? (
            <>
              <code className="break">{request.providerOperationId}</code>{' '}
              <CopyButton value={request.providerOperationId} label="номер операции провайдера" />
            </>
          ) : (
            'Нет'
          )}
        </dd>
      </div>
      <div className="field-wide">
        <dt>Последняя ошибка</dt>
        <dd>
          {request.lastErrorCode ? (
            <>
              {problemText(request.lastErrorCode)}{' '}
              (<code className="break">{request.lastErrorCode}</code>)
            </>
          ) : (
            'Нет'
          )}
        </dd>
      </div>
      <div className="field-wide">
        <dt>Номер заявки</dt>
        <dd>
          <code className="break">{request.id}</code>
        </dd>
      </div>
    </dl>
  );
}
