import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express, { type Express } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppConfig } from './config.js';
import { NeonBattleRepository, type BattleRepository } from './battle-repository.js';
import { RoomManager } from './room-manager.js';
import { MatchManager, MatchError } from './match-manager.js';
import { verifyRoomToken } from './token.js';
import { V1_GAME_MESSAGE_TYPES, type ClientMessage, type InputMessage, type ServerMessage, type V1JoinMessage, type V2JoinMessage } from './types.js';

const HEARTBEAT_INTERVAL = 30000;
const MAX_MESSAGE_BYTES = 8 * 1024;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;

interface ClientContext {
    room_code: string;
    user_id: string;
    username: string;
    protocol_version: 1 | 2;
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
    match_manager?: MatchManager;
    close: () => Promise<void>;
}

export interface GameServerOptions {
    app?: Express;
    websocket_path?: string | false;
    repository?: BattleRepository;
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

function isValidV1JoinMessage(message: ClientMessage): message is V1JoinMessage {
    if (message.type !== 'join') return false;

    return (
        !('protocol_version' in message)
        && 'room_code' in message
        && 'user_id' in message
        && 'username' in message
        && typeof message.room_code === 'string'
        && ROOM_CODE_PATTERN.test(message.room_code.trim().toUpperCase())
        && typeof message.user_id === 'string'
        && message.user_id.trim().length > 0
        && message.user_id.length <= 128
        && typeof message.username === 'string'
        && message.username.trim().length >= 2
        && message.username.trim().length <= 32
    );
}

function isValidV2JoinMessage(message: ClientMessage): message is V2JoinMessage {
    return message.type === 'join'
        && 'protocol_version' in message
        && message.protocol_version === 2
        && 'join_token' in message
        && typeof message.join_token === 'string';
}

async function handleJoin(
    socket: ManagedSocket,
    message: ClientMessage,
    room_manager: RoomManager,
    match_manager: MatchManager | undefined,
    room_token_secret: string | undefined,
): Promise<void> {
    if (isValidV2JoinMessage(message)) {
        if (!match_manager || !room_token_secret) {
            sendError(socket, 'V2_UNAVAILABLE', 'Authoritative battles are not configured.');
            return;
        }
        const claims = verifyRoomToken(message.join_token, room_token_secret);
        if (!claims) {
            sendError(socket, 'INVALID_JOIN_TOKEN', 'Battle access token is invalid or expired.');
            return;
        }
        const room_code = claims.room_code.trim().toUpperCase();
        const join_result = room_manager.join(room_code, {
            socket,
            user_id: claims.user_id,
            username: claims.username,
            protocol_version: 2,
        });
        if (!join_result.ok) {
            sendError(socket, join_result.code ?? 'JOIN_FAILED', join_result.message ?? 'Unable to join the room.');
            socket.close(4003, 'Room unavailable');
            return;
        }
        try {
            socket.client_context = {
                room_code,
                user_id: claims.user_id,
                username: claims.username,
                protocol_version: 2,
            };
            const snapshot = await match_manager.connect(claims);
            send(socket, { type: 'room_snapshot', payload: snapshot });
            room_manager.broadcastV2(room_code, {
                type: 'presence_changed',
                payload: { user_id: claims.user_id, connected: true },
            });
        } catch (caught_error) {
            room_manager.leave(room_code, claims.user_id, socket);
            const error = caught_error instanceof MatchError ? caught_error : new MatchError('JOIN_FAILED', 'Unable to load the battle.');
            sendError(socket, error.code, error.message);
            socket.close(4003, 'Room unavailable');
        }
        return;
    }

    if (!isValidV1JoinMessage(message)) {
        sendError(socket, 'INVALID_JOIN', 'Send a valid join message before game messages.');
        return;
    }

    const room_code = message.room_code.trim().toUpperCase();
    const user_id = message.user_id.trim();
    const username = message.username.trim();
    const join_result = room_manager.join(room_code, { socket, user_id, username, protocol_version: 1 });

    if (!join_result.ok) {
        sendError(socket, join_result.code ?? 'JOIN_FAILED', join_result.message ?? 'Unable to join the room.');
        socket.close(4003, 'Room unavailable');
        return;
    }

    socket.client_context = { room_code, user_id, username, protocol_version: 1 };
    send(socket, {
        type: 'room-state',
        payload: { room_code, players: join_result.players },
    });
    room_manager.broadcast(room_code, {
        type: 'opponent-joined',
        payload: { user_id, username },
    }, user_id);
}

async function handleGameMessage(
    socket: ManagedSocket,
    message: ClientMessage,
    room_manager: RoomManager,
    match_manager: MatchManager | undefined,
): Promise<void> {
    const client_context = socket.client_context;
    if (!client_context) {
        sendError(socket, 'JOIN_REQUIRED', 'Join a room before sending game messages.');
        return;
    }

    if (client_context.protocol_version === 2) {
        if (!match_manager) {
            sendError(socket, 'V2_UNAVAILABLE', 'Authoritative battles are not configured.');
            return;
        }
        try {
            if (message.type === 'ready' && 'request_id' in message) {
                await match_manager.ready(client_context.room_code, client_context.user_id);
                return;
            }
            if (message.type === 'input' && 'sequence' in message) {
                await match_manager.input(client_context.room_code, client_context.user_id, message as InputMessage);
                return;
            }
            if (message.type === 'rematch' && 'accepted' in message) {
                await match_manager.rematch(client_context.room_code, client_context.user_id, message.accepted);
                return;
            }
            sendError(socket, 'INVALID_MESSAGE', 'Unsupported protocol v2 message type.');
        } catch (caught_error) {
            const error = caught_error instanceof MatchError ? caught_error : new MatchError('GAME_COMMAND_FAILED', 'Unable to process game command.');
            sendError(socket, error.code, error.message);
        }
        return;
    }

    if (!V1_GAME_MESSAGE_TYPES.includes(message.type as (typeof V1_GAME_MESSAGE_TYPES)[number])) {
        sendError(socket, 'INVALID_MESSAGE', 'Unsupported message type.');
        return;
    }

    const game_message = message as { type: (typeof V1_GAME_MESSAGE_TYPES)[number]; payload: unknown };
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
    const app = options.app ?? express();
    const room_manager = new RoomManager();
    const repository = options.repository ?? (config.database_url ? new NeonBattleRepository(config.database_url) : undefined);
    const match_manager = repository
        ? new MatchManager(repository, (room_code, message) => room_manager.broadcastV2(room_code, message))
        : undefined;
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

    app.get('/health', async (_request, response) => {
        const database_healthy = repository ? await repository.health() : false;
        response.json({
            success: database_healthy || !repository,
            message: database_healthy || !repository ? 'healthy' : 'degraded',
            data: {
                rooms: room_manager.room_count,
                connections: room_manager.connection_count,
                protocol_v1_connections: room_manager.getProtocolCount(1),
                protocol_v2_connections: room_manager.getProtocolCount(2),
                active_matches: match_manager?.active_count ?? 0,
                paused_matches: match_manager?.paused_count ?? 0,
                oldest_checkpoint_age_ms: match_manager?.oldest_checkpoint_age ?? 0,
                database: database_healthy ? 'healthy' : repository ? 'unavailable' : 'not_configured',
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
                void handleJoin(socket, message, room_manager, match_manager, config.room_token_secret);
                return;
            }

            void handleGameMessage(socket, message, room_manager, match_manager);
        });

        socket.on('close', () => {
            const client_context = socket.client_context;
            if (!client_context) return;

            const player_left = room_manager.leave(client_context.room_code, client_context.user_id, socket);
            if (!player_left) return;

            if (client_context.protocol_version === 2) {
                if (match_manager) {
                    void match_manager.disconnect(client_context.room_code, client_context.user_id).catch((caught_error) => {
                        console.error(JSON.stringify({
                            event: 'disconnect_checkpoint_failed',
                            room_code: client_context.room_code,
                            message: caught_error instanceof Error ? caught_error.message : 'Unknown error',
                        }));
                    });
                }
                room_manager.broadcastV2(client_context.room_code, {
                    type: 'presence_changed',
                    payload: { user_id: client_context.user_id, connected: false },
                });
                return;
            }

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

    let match_tick_running = false;
    const match_timer = setInterval(() => {
        if (!match_manager || match_tick_running) return;
        match_tick_running = true;
        void match_manager.tick().catch((error) => {
            console.error(JSON.stringify({ event: 'match_tick_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
        }).finally(() => { match_tick_running = false; });
    }, 50);
    match_timer.unref();

    const close = async (): Promise<void> => {
        clearInterval(heartbeat_timer);
        clearInterval(match_timer);
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

    return { app, http_server, websocket_server, room_manager, match_manager, close };
}
