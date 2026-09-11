# TypeRacer Authoritative Battle API

Serverless Express REST API for the TypeRacer Combat frontend. Protocol v2 stores live combat state in Neon and persists authoritative results without relying on process memory or WebSocket affinity.

## Local setup

```bash
npm install
copy .env.example .env
npm run dev
```

The health check is available at `http://localhost:8080/health`.

## Environment variables

| Name | Example | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Local HTTP port. Vercel injects its own runtime configuration. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://typing-combat.vercel.app` | Comma-separated frontend origins allowed to connect. |
| `DATABASE_URL` | `postgresql://...` | Neon database shared with the frontend room APIs. |
| `ROOM_TOKEN_SECRET` | `a-long-random-secret` | At least 32 characters and identical to the frontend secret. |

## REST protocol v2

Every battle request uses the signed room token returned by the frontend room API:

```http
Authorization: Bearer <join_token>
```

The endpoints are:

- `GET /api/v2/battles/{code}/snapshot`
- `POST /api/v2/battles/{code}/ready`
- `POST /api/v2/battles/{code}/input`
- `POST /api/v2/battles/{code}/rematch`
- `POST /api/v2/battles/{code}/leave`

All responses use `{ success, message, data, meta, error }`. The browser polls snapshots and serializes input commands; the API applies revision-checked state changes in Neon so separate Vercel invocations cannot overwrite one another.

## Vercel deployment

Vercel detects `src/server.ts` as an Express entrypoint. Configure `DATABASE_URL`, `ROOM_TOKEN_SECRET`, and `ALLOWED_ORIGINS`, then deploy without a custom build or output directory. `/health` must return `success: true` and `database: "healthy"`.

Set the frontend environment and redeploy it:

```env
NEXT_PUBLIC_GAME_PROTOCOL_VERSION=2
NEXT_PUBLIC_API_URL=https://typeracer-api.vercel.app
```
