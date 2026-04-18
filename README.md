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

## Мобильное приложение (без риска для текущего сайта)

Сайт продолжает работать как раньше. Мобильная часть подключается отдельно через Capacitor.

1. Установить зависимости:
   ```bash
   npm install
   ```
2. Добавить мобильную платформу (один раз):
   ```bash
   npm run mobile:add:android
   npm run mobile:add:ios
   ```
3. Скопировать текущий web UI в мобильную оболочку:
   ```bash
   npm run mobile:sync
   ```
4. Открыть проект платформы:
   ```bash
   npm run mobile:open:android
   npm run mobile:open:ios
   ```

Примечание: веб-сборка берется из `public/`, поэтому это самый безопасный старт без изменения серверной логики.

### API для мобильного режима

Веб-режим продолжает использовать относительные пути (`/api/...`) как раньше.

Для мобильной оболочки можно задать отдельный backend URL:

1. Один раз открыть приложение с параметром `apiBase`:
   - пример: `.../login.html?apiBase=https://your-api.example.com`
2. URL сохранится локально и будет использоваться на всех страницах.
3. Сбросить сохраненный URL можно в консоли WebView:
   ```js
   window.AllStarsConfig.clearApiBase()
   ```

### Android: первый билд APK

1. Синхронизировать веб-часть:
   ```bash
   npm run mobile:sync
   ```
2. Собрать debug APK:
   ```bash
   npm run mobile:build:android
   ```
3. Готовый файл:
   `android/app/build/outputs/apk/debug/app-debug.apk`

Если в терминале ошибка `JAVA_HOME is not set`, укажите JDK из Android Studio:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
```
