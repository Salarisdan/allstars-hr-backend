# AllStars HR SaaS — upgraded version

Что внутри:
- PostgreSQL вместо SQLite
- auth (регистрация, логин, JWT)
- multi-tenant структура: agency -> users -> candidates
- роли: owner / teamlead / hr
- аналитика и dashboard
- AI-style инсайты по кандидату (rule-based placeholder, можно позже заменить на OpenAI API)

## Быстрый деплой на Railway

1. Создай PostgreSQL сервис в Railway.
2. В основном сервисе добавь переменные:
   - `DATABASE_URL` = connection string Railway Postgres
   - `JWT_SECRET` = длинный случайный ключ
   - `FRONTEND_ORIGIN` = адрес фронта или `*`
3. Установи зависимости:
   ```bash
   npm install
   ```
4. Запусти:
   ```bash
   npm start
   ```

## Demo вход
После первого запуска автоматически создаётся demo owner:

- email: `owner@allstars.local`
- password: `demo12345`

## Новые эндпоинты

### Auth
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`

### Team
- `GET /users`
- `POST /users`

### Candidates
- `GET /candidates`
- `POST /candidates`
- `PATCH /candidates/:id`
- `DELETE /candidates/:id`
- `GET /candidates/:id/history`

### Analytics
- `GET /analytics/overview`
- `GET /dashboard/feed`

## Что дальше можно докрутить
- invite flow по email
- refresh tokens
- audit logs
- drag-and-drop pipeline
- реальный AI scoring через LLM
- onboarding wizard
