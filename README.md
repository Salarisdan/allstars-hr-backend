# AllStars CRM (Railway Ready)

Internal CRM for AllStars based on Google Sheets with referral payout timer logic.

## Stack
- Node.js + Express backend
- React + Vite frontend
- TailwindCSS UI
- Google Sheets API via googleapis + Service Account
- date-fns for referral timer calculations

## Project Structure
- package.json
- railway.json
- nixpacks.toml
- server/index.js
- server/googleSheets.js
- server/referrals.js
- server/data/referralStartDates.json
- client/src/App.jsx
- client/src/components/Tabs.jsx
- client/src/components/ActiveUsers.jsx
- client/src/components/Candidates.jsx
- client/src/components/Referrals.jsx
- client/src/components/Card.jsx
- client/src/utils/date.js
- .env.example

## Environment Variables
Set these variables in local .env and Railway Variables:

- PORT
- GOOGLE_SERVICE_ACCOUNT_JSON
- GOOGLE_SPREADSHEET_ID
- GOOGLE_SPREADSHEET_NAME
- TEAM_SHEET_NAME
- TEAM_SPREADSHEET_ID
- TELEGRAM_BOT_TOKEN

Important:
- Never hardcode tokens or private keys in source code.
- GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON string.
- private_key inside JSON must keep escaped newlines (\\n). Backend converts them safely.

## Google Sheets Access Setup
1. Open Google Cloud Service Account credentials.
2. Copy the service account email from your JSON.
3. Share both spreadsheets with this email (Viewer or Editor access).
4. Put full JSON into GOOGLE_SERVICE_ACCOUNT_JSON.

## Local Run
1. Install dependencies:

npm install

2. Create .env from .env.example and fill values.

3. Run development mode (backend + frontend):

npm run dev

4. Open frontend:

http://localhost:5173

Backend API base URL:

http://localhost:3000

## Build + Start (Production / Railway)
1. Build frontend:

npm run build

2. Start server (Express serves client/dist):

npm start

Railway should use:
- Build command: npm install ; npm run build
- Start command: npm start

This repository already includes Railway-ready config:
- railway.json
- nixpacks.toml

Healthcheck path:
- /api/health

## API Endpoints
- GET /api/health -> { ok: true }
- GET /api/smoke (basic env diagnostics)
- GET /api/smoke?deep=1 (env + real read test from both sheets)
- GET /api/candidates
- GET /api/active
- GET /api/referrals
- GET /api/dashboard

## Referral Timer Persistence Note
Referral timer fallback dates are stored in:

server/data/referralStartDates.json

This works as a simple starter storage.

For production-grade persistence on Railway, use PostgreSQL or Redis because Railway filesystem can reset after redeploy.

## Security Notes
- Backend never logs or exposes GOOGLE_SERVICE_ACCOUNT_JSON or TELEGRAM_BOT_TOKEN.
- Frontend receives only processed API data.
