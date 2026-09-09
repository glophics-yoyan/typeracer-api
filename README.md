# TypeRacer Realtime API

Persistent Express + WebSocket service for the TypeRacer Combat frontend. The service relays gameplay through the server, so players do not need a direct WebRTC connection or a TURN server.

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

## Client protocol

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

## Deploy to Vercel

Vercel WebSocket support is currently in Public Beta. This repository includes `api/ws.ts` as the Vercel Function entrypoint and rewrites `/ws` to that function.

```bash
npx vercel
npx vercel --prod
```

Set `ALLOWED_ORIGINS` in the API project's Vercel environment variables:

```env
ALLOWED_ORIGINS=https://typing-combat.vercel.app
```

Then add the deployed API URL to the Next.js project's Vercel environment variables and redeploy the frontend:

```env
NEXT_PUBLIC_WEBSOCKET_URL=wss://your-api-project.vercel.app/ws
```

Vercel pins an established socket to one Function instance for at most the Function duration. New connections are not guaranteed to reach the same instance. The current in-memory room manager is therefore intended for an initial test deployment; add Redis-backed presence and pub/sub before relying on horizontal scaling.

## Other Node.js hosts

The same project can still run on Railway, Render, Fly.io, or a VPS with `npm start`. On those hosts, the WebSocket endpoint is also `/ws`.
