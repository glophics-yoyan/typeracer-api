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

## Deployment

Deploy this service to a host that supports a continuously running Node.js process and WebSocket upgrades, such as Railway, Render, Fly.io, or a VPS. Do not deploy the WebSocket process as a Vercel serverless function.

Run one service instance initially because active socket rooms are held in process memory. Before scaling to multiple instances, add shared room state/pub-sub (for example Redis) or configure sticky sessions.

After deployment, add this to the Next.js project in Vercel and redeploy:

```env
NEXT_PUBLIC_WEBSOCKET_URL=wss://your-api-host.example/ws
```

Also set the API service's `ALLOWED_ORIGINS` to the exact Vercel production URL.
