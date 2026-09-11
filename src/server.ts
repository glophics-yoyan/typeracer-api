import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { getConfig } from './config.js';
import { MatchError } from './match-manager.js';
import { NeonRestBattleRepository } from './rest-battle-repository.js';
import { RestMatchManager } from './rest-match-manager.js';
import { verifyRoomToken } from './token.js';
import type { RestBattleData, RoomTokenClaims } from './types.js';

const config = getConfig();
const app = express();
const repository = config.database_url ? new NeonRestBattleRepository(config.database_url) : null;
const match_manager = repository ? new RestMatchManager(repository) : null;

app.disable('x-powered-by');
app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || config.allowed_origins.includes('*') || config.allowed_origins.includes(origin));
    },
}));
app.use(express.json({ limit: '32kb' }));

app.get('/', (_request, response) => {
    successResponse(response, {
        transport: 'rest',
        protocol_version: 2,
        snapshot_endpoint: '/api/v2/battles/{code}/snapshot',
    }, 'TypeRacer authoritative battle API is running.');
});

app.get('/health', async (_request, response) => {
    const database_healthy = repository ? await repository.health() : false;
    response.status(database_healthy ? 200 : 503).json({
        success: database_healthy,
        message: database_healthy ? 'healthy' : 'degraded',
        data: {
            transport: 'rest',
            protocol_version: 2,
            database: database_healthy ? 'healthy' : repository ? 'unavailable' : 'not_configured',
        },
        meta: null,
        error: database_healthy ? null : { code: 'DATABASE_UNAVAILABLE' },
    });
});

app.get('/api/v2/battles/:code/snapshot', async (request, response) => {
    await handleBattleRequest(request, response, (claims, manager) => manager.snapshot(claims));
});

app.post('/api/v2/battles/:code/ready', async (request, response) => {
    await handleBattleRequest(request, response, (claims, manager) => manager.ready(claims));
});

app.post('/api/v2/battles/:code/input', async (request, response) => {
    await handleBattleRequest(request, response, (claims, manager) => {
        const body = request.body as Record<string, unknown> | null;
        const raw_inputs = Array.isArray(body?.inputs) ? body.inputs : body ? [body] : [];
        const inputs = raw_inputs.map((raw_input) => {
            if (!raw_input || typeof raw_input !== 'object') {
                throw new MatchError('INVALID_REQUEST', 'Input entry is invalid.');
            }
            const input = raw_input as Record<string, unknown>;
            if (typeof input.request_id !== 'string') {
                throw new MatchError('INVALID_REQUEST', 'Input request ID is required.');
            }
            return {
                type: 'input' as const,
                request_id: input.request_id,
                sequence: Number(input.sequence),
                character: input.character as string,
                client_timestamp: Number(input.client_timestamp),
            };
        });
        return manager.inputs(claims, inputs);
    });
});

app.post('/api/v2/battles/:code/rematch', async (request, response) => {
    await handleBattleRequest(request, response, (claims, manager) => {
        const body = request.body as Record<string, unknown> | null;
        if (!body || typeof body.accepted !== 'boolean') {
            throw new MatchError('INVALID_REQUEST', 'Rematch acceptance must be a boolean.');
        }
        return manager.rematch(claims, body.accepted);
    });
});

app.post('/api/v2/battles/:code/leave', async (request, response) => {
    await handleBattleRequest(request, response, (claims, manager) => manager.leave(claims));
});

app.use((_request, response) => {
    failResponse(response, 'Endpoint not found.', 'NOT_FOUND', 404);
});

app.use((caught_error: unknown, _request: Request, response: Response, _next: unknown) => {
    console.error(JSON.stringify({
        event: 'unhandled_api_error',
        message: caught_error instanceof Error ? caught_error.message : 'Unknown error',
    }));
    failResponse(response, 'The battle API encountered an error.', 'INTERNAL_ERROR', 500);
});

async function handleBattleRequest(
    request: Request,
    response: Response,
    operation: (claims: RoomTokenClaims, manager: RestMatchManager) => Promise<RestBattleData>,
) {
    if (!match_manager || !config.room_token_secret) {
        failResponse(response, 'Battle API is not configured.', 'SERVICE_UNAVAILABLE', 503);
        return;
    }

    const claims = authenticate(request, config.room_token_secret);
    if (!claims) {
        failResponse(response, 'Battle session is invalid or expired.', 'INVALID_JOIN_TOKEN', 401);
        return;
    }

    const room_code = String(request.params.code ?? '').trim().toUpperCase();
    if (claims.room_code !== room_code) {
        failResponse(response, 'Battle session does not match this room.', 'WRONG_ROOM', 403);
        return;
    }

    try {
        successResponse(response, await operation(claims, match_manager));
    } catch (caught_error) {
        if (caught_error instanceof MatchError) {
            failResponse(response, caught_error.message, caught_error.code, errorStatus(caught_error.code));
            return;
        }
        console.error(JSON.stringify({
            event: 'battle_request_failed',
            room_code,
            message: caught_error instanceof Error ? caught_error.message : 'Unknown error',
        }));
        failResponse(response, 'Unable to update this battle.', 'BATTLE_REQUEST_FAILED', 500);
    }
}

function authenticate(request: Request, secret: string) {
    const authorization = request.header('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return null;
    return verifyRoomToken(authorization.slice(7), secret);
}

function successResponse<T>(response: Response, data: T, message = '') {
    response.json({ success: true, message, data, meta: null, error: null });
}

function failResponse(response: Response, message: string, code: string, status: number) {
    response.status(status).json({ success: false, message, data: null, meta: null, error: { code } });
}

function errorStatus(code: string) {
    if (code === 'ROOM_NOT_FOUND') return 404;
    if (code === 'MEMBERSHIP_INVALID' || code === 'WRONG_ROOM') return 403;
    if (code === 'INPUT_RATE_LIMITED') return 429;
    if (code.startsWith('INVALID_')) return 400;
    return 409;
}

if (process.env.VERCEL !== '1') {
    app.listen(config.port, () => {
        console.log(`[Server] REST API: http://localhost:${config.port}`);
    });
}

export default app;
