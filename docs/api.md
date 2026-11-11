# Контракт API

Базовый путь `/api`. Тела запросов и ответов JSON. Даты (`expiresOn`, `oldExpiresOn`, `newExpiresOn`) строкой `YYYY-MM-DD`, моменты времени (`createdAt` и подобные) строкой ISO 8601 в UTC. Суммы целым числом копеек (`amountMinor`, `priceMinor`), валюта `RUB`.

Маршруты одобрения, отклонения и повтора (`/approve`, `/reject`, `/retry`) появятся позже и здесь пока не описаны.

## Авторизация

Вход ставит cookie `renewals_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, срок 7 дней). Браузер отправляет её сам, на клиенте с ней ничего делать не нужно: в `fetch` достаточно `credentials: 'include'` (или `same-origin`, если интерфейс и API на одном адресе через прокси). Прочитать cookie из JavaScript нельзя, текущего пользователя узнают через `GET /api/auth/me`.

Все маршруты, кроме `POST /api/auth/login` и `GET /api/health`, без действующей сессии отдают 401. Пользователь и его права берутся только из сессии: поля вроде `userId` или `workspaceId` в теле и query сервер не читает.

## Ошибки

Любая ошибка приходит в одном формате:

```json
{ "error": "forbidden", "message": "Нет доступа к этому ресурсу" }
```

`message` написан для человека по-русски, его можно показывать как есть. Ветвиться в коде нужно по `error`.

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `validation_error` | тело запроса неверное (нет полей, битый JSON) |
| 401 | `unauthorized` | нет сессии, сессия истекла, неверный логин или пароль |
| 403 | `forbidden` | чужое пространство или нет нужного права |
| 404 | `not_found` | нет такого ресурса, заявки или маршрута |
| 409 | `active_request_exists` | у ресурса уже есть активная заявка |
| 409 | `conflict` | прочий конфликт состояния |
| 500 | `internal_error` | сбой на сервере, подробности только в логе |

## Модели

### Пользователь и членство

```json
{
  "user": { "id": "usr-universal-alpha", "login": "universal.alpha", "displayName": "Универсальный Alpha" },
  "memberships": [
    { "workspaceId": "ws-alpha", "workspaceName": "Alpha", "canInitiate": true, "canApprove": true }
  ]
}
```

### Ресурс

```json
{
  "id": "res-a-01",
  "workspaceId": "ws-alpha",
  "workspaceName": "Alpha",
  "name": "Хранилище A",
  "expiresOn": "2027-03-01",
  "priceMinor": 128000,
  "currency": "RUB",
  "activeRequest": { "id": "5f0c...", "status": "pending" },
  "canCreateRequest": false
}
```

- `activeRequest`: активная заявка ресурса (`pending`, `processing`, `needs_attention`) или `null`.
- `canCreateRequest`: у пользователя есть право инициатора в пространстве ресурса и нет активной заявки. Показывать кнопку «Продлить» только при `true`.

### Заявка

```json
{
  "id": "5f0c2a7e-3a51-4f0e-9a43-0d8d3c1b2e11",
  "workspaceId": "ws-alpha",
  "resourceId": "res-a-01",
  "resourceName": "Хранилище A",
  "status": "pending",
  "createdBy": { "id": "usr-initiator-alpha", "displayName": "Инициатор Alpha" },
  "decidedBy": null,
  "oldExpiresOn": "2027-03-01",
  "newExpiresOn": "2027-03-31",
  "amountMinor": 128000,
  "currency": "RUB",
  "idempotencyKey": "renewal-5f0c2a7e-3a51-4f0e-9a43-0d8d3c1b2e11",
  "providerOperationId": null,
  "lastErrorCode": null,
  "createdAt": "2026-11-11T09:30:00.000Z",
  "decidedAt": null,
  "completedAt": null,
  "canApprove": false,
  "canReject": false,
  "canRetry": false
}
```

- `status`: `pending` (на согласовании), `rejected` (отклонена), `processing` (выполняется), `completed` (завершена), `needs_attention` (требует внимания).
- `decidedBy`: кто одобрил или отклонил, либо `null`.
- `oldExpiresOn`, `newExpiresOn`, `amountMinor`: снимок на момент создания, дальше не меняются.
- `idempotencyKey`: ключ операции у провайдера, постоянный.
- `canApprove`, `canReject`: у пользователя право согласующего в пространстве, заявка не его, статус `pending`.
- `canRetry`: то же право, заявка не его, статус `needs_attention`.

### Событие истории

```json
{
  "id": 12,
  "actor": { "id": "usr-initiator-alpha", "displayName": "Инициатор Alpha" },
  "fromStatus": null,
  "toStatus": "pending",
  "kind": "created",
  "detail": null,
  "createdAt": "2026-11-11T09:30:00.000Z"
}
```

- `actor`: `null`, если переход сделала система (фоновый обработчик).
- `kind`: вид события. Сейчас пишется `created`; одобрение, отклонение и работа с провайдером добавят свои виды.
- `detail`: короткое пояснение или `null`.

## Маршруты

### POST /api/auth/login

Кто: любой, без сессии.

Тело:

```json
{ "login": "initiator.alpha", "password": "renewals-demo" }
```

Ответ 200: пользователь и членства (как у `GET /api/auth/me`) и заголовок `Set-Cookie` с сессией.

Ошибки: 400 `validation_error` (нет логина или пароля, не строки, длиннее 200 символов, битый JSON); 401 `unauthorized` с текстом «Неверный логин или пароль», одинаковым для неверного пароля и несуществующего логина.

### POST /api/auth/logout

Кто: вошедший пользователь. Тела нет.

Ответ 204 без тела: сессия удалена, cookie сброшен.

Ошибки: 401 без сессии.

### GET /api/auth/me

Кто: вошедший пользователь.

Ответ 200: пользователь и членства (модель выше).

Ошибки: 401.

### GET /api/resources

Кто: вошедший пользователь. Отдаются ресурсы только тех пространств, где у него есть членство.

Ответ 200: массив ресурсов, порядок по имени пространства, затем по `id`.

```json
[
  { "id": "res-a-01", "workspaceId": "ws-alpha", "workspaceName": "Alpha", "name": "Хранилище A", "expiresOn": "2027-03-01", "priceMinor": 128000, "currency": "RUB", "activeRequest": null, "canCreateRequest": true },
  { "id": "res-a-02", "workspaceId": "ws-alpha", "workspaceName": "Alpha", "name": "Сервис B", "expiresOn": "2027-05-20", "priceMinor": 250000, "currency": "RUB", "activeRequest": null, "canCreateRequest": true }
]
```

Ошибки: 401.

### GET /api/resources/:id

Кто: член пространства ресурса.

Ответ 200: ресурс и все его заявки, новые сверху.

```json
{
  "resource": { "id": "res-a-01", "...": "модель ресурса" },
  "requests": [ { "id": "5f0c...", "...": "модель заявки" } ]
}
```

Ошибки: 401; 403 `forbidden` (ресурс чужого пространства); 404 `not_found` (нет такого ресурса).

### POST /api/resources/:id/renewal-requests

Кто: пользователь с правом инициатора (`canInitiate`) в пространстве ресурса. Согласующий без этого права и пользователь чужого пространства получают 403.

Тело не нужно; если оно есть, сервер его игнорирует. Сумма, даты, автор и ключ задаются только сервером: снимок срока и стоимости ресурса, новый срок `expiresOn + 30` календарных дней, статус `pending`, автор из сессии. Срок ресурса при создании не меняется.

Ответ 201: созданная заявка (модель выше).

Ошибки: 401; 403 `forbidden`; 404 `not_found` (нет ресурса); 409 `active_request_exists` (у ресурса уже есть заявка в `pending`, `processing` или `needs_attention`).

### GET /api/renewal-requests

Кто: вошедший пользователь. Отдаются заявки только его пространств.

Ответ 200: массив заявок, новые сверху.

Ошибки: 401.

### GET /api/renewal-requests/:id

Кто: член пространства заявки.

Ответ 200: заявка и её события по порядку (старые сверху).

```json
{
  "request": { "id": "5f0c...", "...": "модель заявки" },
  "events": [ { "id": 12, "...": "модель события" } ]
}
```

Ошибки: 401; 403 `forbidden` (заявка чужого пространства); 404 `not_found` (нет такой заявки или `id` не uuid).

### GET /api/health

Кто: любой, без сессии.

Ответ 200: `{ "status": "ok", "database": "up" }`. Если база не отвечает: 503 `{ "error": "database_unavailable", "message": "База данных недоступна" }`.
