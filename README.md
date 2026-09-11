# TypeRacer Authoritative Realtime API

Persistent Express + WebSocket service for the TypeRacer Combat frontend. Protocol v2 owns live combat state, checkpoints active matches to Neon, and persists authoritative results. The relay protocol remains temporarily available for rollout and rollback.

## Local setup

```bash
npm install
copy .env.example .env
npm run dev
```

The HTTP health check is available at `http://localhost:8080/health` and the WebSocket endpoint is `ws://localhost:8080/ws`.

## Environment variables

| Name | Example | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port. Most hosts inject this automatically. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://typing-combat.vercel.app` | Comma-separated frontend origins allowed to connect. |
| `DATABASE_URL` | `postgresql://...` | Neon database shared with the frontend room APIs. |
| `ROOM_TOKEN_SECRET` | `a-long-random-secret` | At least 32 characters and identical to the frontend secret. |

## Client protocol v2

Join with the token returned by the frontend room API:

```ts
socket.send(JSON.stringify({ type: 'join', protocol_version: 2, join_token }));
```

Client commands are `ready`, `input`, `rematch`, and `ping`. Server events are `room_snapshot`, `presence_changed`, `match_finished`, `match_cancelled`, `rematch_status`, and `error`. All v2 payload keys use snake case. Health, damage, statistics, timers, and results are calculated by this service.

## Legacy protocol v1

Open the socket and join before sending gameplay messages:

```ts
const socket = new WebSocket(process.env.NEXT_PUBLIC_WEBSOCKET_URL!);

socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
        type: 'join',
        room_code,
        user_id,
        username,
    }));
});
```

The server accepts the current game message types without changing their payloads:

- `state`
- `keystroke`
- `ready`
- `start`
- `finish`
- `rematch`
- `signal` (optional, if WebRTC signaling is needed later)

Example:

```ts
socket.send(JSON.stringify({
    type: 'ready',
    payload: player_state,
}));
```

The opponent receives:

```json
{
    "type": "ready",
    "payload": {},
    "from_user_id": "player-id"
}
```

Server lifecycle messages are `connected`, `room-state`, `opponent-joined`, `opponent-left`, `pong`, and `error`.

## Render deployment

Protocol v2 runs on one long-lived Render process because room presence and active match coordination are held in process memory. The root `render.yaml` creates one paid Singapore service and exposes HTTP health checks at `/health` and WebSockets at `/ws`.

1. Apply the frontend database migrations to the shared Neon database.
2. Create a Render Blueprint from this repository.
3. Enter `DATABASE_URL` and `ROOM_TOKEN_SECRET` when prompted. The room-token secret must exactly match the frontend value.
4. Wait for `/health` to report `success: true` and `database: "healthy"`.
5. Set the frontend deployment environment and redeploy it:

```env
NEXT_PUBLIC_GAME_PROTOCOL_VERSION=2
NEXT_PUBLIC_WEBSOCKET_URL=wss://your-render-service.onrender.com/ws
```

Keep the service at exactly one instance until room presence and pub/sub move to shared infrastructure.
