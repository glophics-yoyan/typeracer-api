import express from 'express';
import { getConfig } from './config.js';
import { createGameServer } from './game-server.js';

const config = getConfig();
const app = express();
const http_server = app.listen(config.port, () => {
    console.log(`[Server] HTTP health check: http://localhost:${config.port}/health`);
    console.log(`[Server] WebSocket endpoint: ws://localhost:${config.port}/ws`);
});
const game_server = createGameServer(config, { app, http_server, websocket_path: '/ws' });

async function shutdown(signal: string): Promise<void> {
    console.log(`[Server] ${signal} received. Shutting down.`);
    await game_server.close();
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export default app;
