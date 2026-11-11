import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorText, type RenewalRequest, type RequestAction, type Resource } from './api';
import { statusText } from './format';
import { requestHref, useBusyAction } from './hooks';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{statusText(status)}</span>;
}

interface ActionButtonProps {
  children: ReactNode;
  busyLabel: string;
  busy: boolean;
  // Заблокирована, потому что идёт другой запрос этой же группы.
  locked: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  onClick: () => void;
}

// aria-disabled вместо disabled: кнопка не теряет фокус на время запроса.
export function ActionButton({ children, busyLabel, busy, locked, variant = 'secondary', onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      className={`button button-${variant}`}
      aria-disabled={busy || locked}
      aria-busy={busy}
      onClick={() => {
        if (!busy && !locked) onClick();
      }}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

type Feedback = { kind: 'error' | 'ok'; text: string; link?: string } | null;

// Сообщение рядом с действием. Если кнопка, на которой стоял фокус, исчезла после
// обновления данных, фокус переходит на сообщение, чтобы не упасть на body.
function useFeedback() {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!feedback) return;
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, [feedback]);
  return { feedback, setFeedback, ref };
}

function FeedbackMessage({ feedback, innerRef }: { feedback: Feedback; innerRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={innerRef} tabIndex={-1} className="feedback-slot">
      {feedback && (
        <p className={`feedback feedback-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>
          {feedback.text}
          {feedback.link && (
            <>
              {' '}
              <a href={feedback.link}>Открыть заявку</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function shouldReload(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

const actionText: Record<RequestAction, { label: string; busy: string; done: string; failed: string }> = {
  approve: {
    label: 'Одобрить',
    busy: 'Одобряю...',
    done: 'Заявка одобрена, отправка провайдеру запущена.',
    failed: 'Не удалось одобрить заявку.',
  },
  reject: { label: 'Отклонить', busy: 'Отклоняю...', done: 'Заявка отклонена.', failed: 'Не удалось отклонить заявку.' },
  retry: {
    label: 'Повторить отправку',
    busy: 'Повторяю...',
    done: 'Повторная отправка запущена.',
    failed: 'Не удалось повторить отправку.',
  },
};

// Кнопки согласующего. Показываются строго по флагам сервера canApprove, canReject, canRetry.
export function RequestActions({ request, onChanged }: { request: RenewalRequest; onChanged: () => Promise<void> }) {
  const { busy, run } = useBusyAction();
  const { feedback, setFeedback, ref } = useFeedback();
  const actions: RequestAction[] = [];
  if (request.canApprove) actions.push('approve');
  if (request.canReject) actions.push('reject');
  if (request.canRetry) actions.push('retry');

  const perform = (action: RequestAction) =>
    run(action, async () => {
      setFeedback(null);
      try {
        await api.act(request.id, action);
        await onChanged();
        setFeedback({ kind: 'ok', text: actionText[action].done });
      } catch (error) {
        if (shouldReload(error)) await onChanged().catch(() => undefined);
        setFeedback({ kind: 'error', text: `${actionText[action].failed} ${errorText(error)}` });
      }
    });

  return (
    <div className="actions">
      {actions.length > 0 && (
        <div className="actions-buttons">
          {actions.map((action) => (
            <ActionButton
              key={action}
              variant={action === 'reject' ? 'danger' : 'primary'}
              busy={busy === action}
              locked={busy !== null}
              busyLabel={actionText[action].busy}
              onClick={() => void perform(action)}
            >
              {actionText[action].label}
            </ActionButton>
          ))}
        </div>
      )}
      <FeedbackMessage feedback={feedback} innerRef={ref} />
    </div>
  );
}

export function CreateRequestAction({ resource, onChanged }: { resource: Resource; onChanged: () => Promise<void> }) {
  const { busy, run } = useBusyAction();
  const { feedback, setFeedback, ref } = useFeedback();

  const create = () =>
    run('create', async () => {
      setFeedback(null);
      try {
        const created = await api.createRequest(resource.id);
        await onChanged();
        setFeedback({ kind: 'ok', text: 'Заявка создана.', link: requestHref(created.id) });
      } catch (error) {
        if (shouldReload(error)) await onChanged().catch(() => undefined);
        setFeedback({ kind: 'error', text: `Не удалось создать заявку. ${errorText(error)}` });
      }
    });

  return (
    <div className="actions">
      {resource.canCreateRequest && (
        <div className="actions-buttons">
          <ActionButton variant="primary" busy={busy !== null} locked={false} busyLabel="Создаю..." onClick={() => void create()}>
            Продлить на 30 дней
          </ActionButton>
        </div>
      )}
      <FeedbackMessage feedback={feedback} innerRef={ref} />
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <button type="button" className="button button-small" onClick={() => void copy()} aria-label={`Скопировать ${label}`}>
        Скопировать
      </button>
      <span className="copy-status" role="status">
        {state === 'done' ? 'Скопировано' : state === 'failed' ? 'Не удалось скопировать, выделите текст вручную' : ''}
      </span>
    </>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="load-error" role="alert">
      <p>Не удалось загрузить данные. {message}</p>
      <button type="button" className="button button-primary" onClick={onRetry}>
        Повторить
      </button>
    </div>
  );
}

export function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
