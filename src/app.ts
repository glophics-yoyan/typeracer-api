import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express, { type Express } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppConfig } from './config.js';
import { RoomManager } from './room-manager.js';
import { GAME_MESSAGE_TYPES, type ClientMessage, type JoinMessage, type ServerMessage } from './types.js';

const HEARTBEAT_INTERVAL = 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;

interface ClientContext {
    room_code: string;
    user_id: string;
    username: string;
}

interface ManagedSocket extends WebSocket {
    is_alive: boolean;
    client_context?: ClientContext;
}

export interface GameServer {
    app: Express;
    http_server: HttpServer;
    websocket_server: WebSocketServer;
    room_manager: RoomManager;
    close: () => Promise<void>;
}

interface GameServerOptions {
    websocket_path?: string | false;
}

function isOriginAllowed(origin: string | undefined, allowed_origins: string[]): boolean {
    if (!origin) return true;
    return allowed_origins.includes('*') || allowed_origins.includes(origin);
}

function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string): void {
    send(socket, { type: 'error', code, message });
}

function parseMessage(data: WebSocket.RawData): ClientMessage | null {
    try {
        const parsed_message = JSON.parse(data.toString()) as unknown;
        if (!parsed_message || typeof parsed_message !== 'object') return null;
        return parsed_message as ClientMessage;
    } catch {
        return null;
    }
}

function isValidJoinMessage(message: ClientMessage): message is JoinMessage {
    if (message.type !== 'join') return false;

    return (
        typeof message.room_code === 'string'
        && ROOM_CODE_PATTERN.test(message.room_code.trim().toUpperCase())
        && typeof message.user_id === 'string'
        && message.user_id.trim().length > 0
        && message.user_id.length <= 128
        && typeof message.username === 'string'
        && message.username.trim().length >= 2
        && message.username.trim().length <= 32
    );
}

function handleJoin(socket: ManagedSocket, message: ClientMessage, room_manager: RoomManager): void {
    if (!isValidJoinMessage(message)) {
        sendError(socket, 'INVALID_JOIN', 'Send a valid join message before game messages.');
        return;
    }

    const room_code = message.room_code.trim().toUpperCase();
    const user_id = message.user_id.trim();
    const username = message.username.trim();
    const join_result = room_manager.join(room_code, { socket, user_id, username });

    if (!join_result.ok) {
        sendError(socket, join_result.code ?? 'JOIN_FAILED', join_result.message ?? 'Unable to join the room.');
        socket.close(4003, 'Room unavailable');
        return;
    }

    socket.client_context = { room_code, user_id, username };
    send(socket, {
        type: 'room-state',
        payload: { room_code, players: join_result.players },
    });
    room_manager.broadcast(room_code, {
        type: 'opponent-joined',
        payload: { user_id, username },
    }, user_id);
}

function handleGameMessage(socket: ManagedSocket, message: ClientMessage, room_manager: RoomManager): void {
    const client_context = socket.client_context;
    if (!client_context) {
        sendError(socket, 'JOIN_REQUIRED', 'Join a room before sending game messages.');
        return;
    }

    if (!GAME_MESSAGE_TYPES.includes(message.type as (typeof GAME_MESSAGE_TYPES)[number])) {
        sendError(socket, 'INVALID_MESSAGE', 'Unsupported message type.');
        return;
    }

    const game_message = message as { type: (typeof GAME_MESSAGE_TYPES)[number]; payload: unknown };
    room_manager.broadcast(client_context.room_code, {
        type: game_message.type,
        payload: game_message.payload,
        from_user_id: client_context.user_id,
    }, client_context.user_id);
}

export function createGameServer(
    config: AppConfig,
    options: GameServerOptions = { websocket_path: '/ws' },
): GameServer {
    const app = express();
    const room_manager = new RoomManager();
    const http_server = createServer(app);
    const verify_client: WebSocket.VerifyClientCallbackSync = ({ origin }) => (
        isOriginAllowed(origin, config.allowed_origins)
    );
    const websocket_server = new WebSocketServer({
        server: http_server,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: verify_client,
        ...(options.websocket_path ? { path: options.websocket_path } : {}),
    });

    app.disable('x-powered-by');
    app.use(cors({
        origin(origin, callback) {
            callback(null, isOriginAllowed(origin, config.allowed_origins));
        },
    }));
    app.use(express.json({ limit: '32kb' }));

    app.get('/', (_request, response) => {
        response.json({
            success: true,
            message: 'TypeRacer realtime API is running.',
            data: null,
            meta: null,
            error: null,
        });
    });

    app.get('/health', (_request, response) => {
        response.json({
            success: true,
            message: 'healthy',
            data: {
                rooms: room_manager.room_count,
                connections: room_manager.connection_count,
            },
            meta: null,
            error: null,
        });
    });

    websocket_server.on('connection', (raw_socket) => {
        const socket = raw_socket as ManagedSocket;
        socket.is_alive = true;

        send(socket, { type: 'connected', payload: { message: 'Send a join message to enter a battle.' } });

        socket.on('pong', () => {
            socket.is_alive = true;
        });

        socket.on('message', (data) => {
            const message = parseMessage(data);
            if (!message) {
                sendError(socket, 'INVALID_JSON', 'Message must be valid JSON.');
                return;
            }

            if (message.type === 'ping') {
                send(socket, { type: 'pong' });
                return;
            }

            if (!socket.client_context) {
                handleJoin(socket, message, room_manager);
                return;
            }

            handleGameMessage(socket, message, room_manager);
        });

        socket.on('close', () => {
            const client_context = socket.client_context;
            if (!client_context) return;

            const player_left = room_manager.leave(client_context.room_code, client_context.user_id, socket);
            if (!player_left) return;

            room_manager.broadcast(client_context.room_code, {
                type: 'opponent-left',
                payload: { user_id: client_context.user_id },
            });
        });

        socket.on('error', (error) => {
            console.error('[WebSocket] Client error:', error);
        });
    });

    const heartbeat_timer = setInterval(() => {
        websocket_server.clients.forEach((raw_socket) => {
            const socket = raw_socket as ManagedSocket;
            if (!socket.is_alive) {
                socket.terminate();
                return;
            }

            socket.is_alive = false;
            socket.ping();
        });
    }, HEARTBEAT_INTERVAL);
    heartbeat_timer.unref();

    const close = async (): Promise<void> => {
        clearInterval(heartbeat_timer);
        websocket_server.clients.forEach((socket) => socket.close(1001, 'Server shutting down'));

        await new Promise<void>((resolve, reject) => {
            websocket_server.close((websocket_error) => {
                if (websocket_error) reject(websocket_error);
                else resolve();
            });
        });

        if (!http_server.listening) return;
        await new Promise<void>((resolve, reject) => {
            http_server.close((http_error) => {
                if (http_error) reject(http_error);
                else resolve();
            });
        });
    };

    return { app, http_server, websocket_server, room_manager, close };
}
