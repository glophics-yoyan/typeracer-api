import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { BattleRepository } from '../src/battle-repository.js';
import { calculateAccuracy, calculateDamage, calculateWpm, MatchManager, resolveWinner } from '../src/match-manager.js';
import { verifyRoomToken } from '../src/token.js';
import type { AuthoritativeMatch, RoomRecord, RoomTokenClaims, ServerMessage } from '../src/types.js';

const SECRET = 'test-room-token-secret-with-at-least-32-characters';

class MemoryRepository implements BattleRepository {
    room: RoomRecord = {
        id: 'room-id',
        code: 'ABC234',
        host_id: 'player-1',
        difficulty: 2,
        status: 'waiting',
        players: [
            { user_id: 'player-1', username: 'Alpha' },
            { user_id: 'player-2', username: 'Bravo' },
        ],
    };
    live_match: { state: AuthoritativeMatch; checkpointed_at: number } | null = null;
    finalized: AuthoritativeMatch[] = [];
    checkpointed: AuthoritativeMatch[] = [];
    quote_text = 'ab';
    create_count = 0;
    reset_count = 0;

    async getRoom(room_code: string) {
        return room_code === this.room.code ? this.room : null;
    }

    async getLiveMatch() {
        return this.live_match;
    }

    async createMatch() {
        this.create_count += 1;
        return {
            match_id: `match-${this.create_count}`,
            quote: {
                id: `quote-${this.create_count}`,
                text: this.quote_text,
                author: 'Test',
                difficulty: 2,
                char_count: this.quote_text.length,
            },
        };
    }

    async checkpoint(state: AuthoritativeMatch) {
        this.checkpointed.push(structuredClone(state));
    }

    async finalize(state: AuthoritativeMatch) {
        this.finalized.push(structuredClone(state));
    }

    async resetRoom() { this.reset_count += 1; }
    async health() { return true; }
}

test('authoritative inputs advance on mistakes and persist one server result', async () => {
    const repository = new MemoryRepository();
    const events: ServerMessage[] = [];
    const manager = new MatchManager(repository, (_room_code, message) => events.push(message));
    await connectPlayers(manager);
    await manager.ready('ABC234', 'player-1');
    await manager.ready('ABC234', 'player-2');
    await manager.tick(Date.now() + 3100);

    await manager.input('ABC234', 'player-1', input(1, 'x'));
    await assert.rejects(() => manager.input('ABC234', 'player-1', input(1, 'a')), /out of order/);
    await manager.input('ABC234', 'player-1', input(2, 'b'));
    await manager.tick(Date.now() + 5000);

    assert.equal(repository.finalized.length, 1);
    const player = Object.values(repository.finalized[0]!.players).find((candidate) => candidate.user_id === 'player-1');
    assert.equal(player?.position, 2);
    assert.equal(player?.accuracy, 0.5);
    assert.equal(events.some((event) => event.type === 'match_finished'), true);
});

test('combat calculations and exact ties are deterministic', () => {
    assert.equal(calculateDamage(60, 1), 5);
    assert.equal(calculateDamage(60, 0.5), 1.25);
    assert.equal(calculateWpm(25, 60000), 5);
    assert.equal(calculateAccuracy(3, 4), 0.75);
    assert.equal(resolveWinner(player('player-2'), player('player-1')), 'player-1');
    assert.equal(resolveWinner(player('player-1', { position: 2 }), player('player-2')), 'player-1');
});

test('input validation rejects gaps, malformed characters, tampering, and sustained rates', async () => {
    let now = 1000;
    const repository = new MemoryRepository();
    repository.quote_text = 'a'.repeat(40);
    const manager = new MatchManager(repository, () => {}, () => now);
    await connectPlayers(manager);
    await assert.rejects(() => manager.input('ABC234', 'player-1', input(1, 'a')), /not active/);
    await manager.ready('ABC234', 'player-1');
    await manager.ready('ABC234', 'player-2');
    now += 3000;
    await manager.tick();

    await assert.rejects(() => manager.input('ABC234', 'player-1', input(2, 'a')), /out of order/);
    await assert.rejects(() => manager.input('ABC234', 'player-1', input(1, 'aa')), /one character/);
    await manager.input('ABC234', 'player-1', { ...input(1, 'a'), hp: 0 } as ReturnType<typeof input>);
    for (let sequence = 2; sequence <= 30; sequence += 1) {
        await manager.input('ABC234', 'player-1', input(sequence, 'a'));
    }
    await assert.rejects(() => manager.input('ABC234', 'player-1', input(31, 'a')), /rate is too high/);

    const snapshot = await manager.connect(claims('player-1', 'Alpha'));
    const first_player = snapshot.players.find((candidate) => candidate.user_id === 'player-1');
    assert.equal(first_player?.hp, 100);
    assert.equal(first_player?.position, 30);
});

test('rematch votes expire and both votes reset into a fresh match', async () => {
    let now = 1000;
    const repository = new MemoryRepository();
    repository.quote_text = 'a';
    const events: ServerMessage[] = [];
    const manager = new MatchManager(repository, (_room_code, message) => events.push(message), () => now);
    await connectPlayers(manager);
    await manager.ready('ABC234', 'player-1');
    await manager.ready('ABC234', 'player-2');
    now += 3000;
    await manager.tick();
    await manager.input('ABC234', 'player-1', input(1, 'a'));

    await manager.rematch('ABC234', 'player-1', true);
    now += 60000;
    await manager.tick();
    const expired_vote = events.slice().reverse().find((event) => event.type === 'rematch_status');
    assert.deepEqual(expired_vote?.payload, { votes: {}, expires_at: null });

    await manager.rematch('ABC234', 'player-1', true);
    await manager.rematch('ABC234', 'player-2', true);
    assert.equal(repository.reset_count, 1);
    await manager.ready('ABC234', 'player-1');
    await manager.ready('ABC234', 'player-2');
    const latest_snapshot = events.slice().reverse().find((event) => event.type === 'room_snapshot');
    assert.equal(latest_snapshot?.type, 'room_snapshot');
    if (latest_snapshot?.type === 'room_snapshot') {
        const snapshot_payload = latest_snapshot.payload as { phase: string; quote: { id: string } | null };
        assert.equal(snapshot_payload.phase, 'countdown');
        assert.equal(snapshot_payload.quote?.id, 'quote-2');
    }
});

test('disconnect expiry cancels without a winner', async () => {
    const repository = new MemoryRepository();
    const manager = new MatchManager(repository, () => {});
    await connectPlayers(manager);
    await manager.ready('ABC234', 'player-1');
    await manager.ready('ABC234', 'player-2');
    await manager.tick(Date.now() + 3100);
    await manager.disconnect('ABC234', 'player-2');
    await manager.tick(Date.now() + 31000);

    assert.equal(repository.finalized.at(-1)?.phase, 'cancelled');
    assert.equal(repository.finalized.at(-1)?.winner_user_id, null);
    assert.equal(repository.finalized.at(-1)?.finished_reason, 'disconnect_timeout');
});

test('fresh Neon checkpoint restores paused and resumes after both players reconnect', async () => {
    const repository = new MemoryRepository();
    const first_manager = new MatchManager(repository, () => {});
    await connectPlayers(first_manager);
    await first_manager.ready('ABC234', 'player-1');
    await first_manager.ready('ABC234', 'player-2');
    await first_manager.tick(Date.now() + 3100);
    const checkpoint = repository.checkpointed.at(-1);
    assert.ok(checkpoint);
    repository.live_match = { state: checkpoint, checkpointed_at: Date.now() };

    const restored_manager = new MatchManager(repository, () => {});
    const first_snapshot = await restored_manager.connect(claims('player-1', 'Alpha'));
    assert.equal(first_snapshot.phase, 'paused');
    const second_snapshot = await restored_manager.connect(claims('player-2', 'Bravo'));
    assert.equal(second_snapshot.phase, 'countdown');
});

test('room tokens reject tampering and expiration', () => {
    const valid_token = signToken({
        ...claims('player-1', 'Alpha'),
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    assert.equal(verifyRoomToken(valid_token, SECRET)?.user_id, 'player-1');
    assert.equal(verifyRoomToken(valid_token + 'x', SECRET), null);
    const expired_token = signToken({
        ...claims('player-1', 'Alpha'),
        issued_at: 1,
        expires_at: 2,
    });
    assert.equal(verifyRoomToken(expired_token, SECRET), null);
    const unsupported_token = signToken({
        ...claims('player-1', 'Alpha'),
        protocol_version: 1,
    });
    assert.equal(verifyRoomToken(unsupported_token, SECRET), null);
    const missing_expiry_token = signToken({
        ...claims('player-1', 'Alpha'),
        expires_at: undefined,
    });
    assert.equal(verifyRoomToken(missing_expiry_token, SECRET), null);
});

test('a signed token cannot grant membership in another room', async () => {
    const repository = new MemoryRepository();
    const manager = new MatchManager(repository, () => {});
    await assert.rejects(() => manager.connect({ ...claims('player-1', 'Alpha'), room_code: 'ZZZ234' }), /not found/);
});

async function connectPlayers(manager: MatchManager) {
    await manager.connect(claims('player-1', 'Alpha'));
    await manager.connect(claims('player-2', 'Bravo'));
}

function claims(user_id: string, username: string): RoomTokenClaims {
    return {
        protocol_version: 2,
        room_code: 'ABC234',
        user_id,
        username,
        role: user_id === 'player-1' ? 'host' : 'player',
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
    };
}

function input(sequence: number, character: string) {
    return { type: 'input' as const, request_id: String(sequence), sequence, character, client_timestamp: Date.now() };
}

function signToken(payload: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ algorithm: 'HS256', type: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned_token = `${header}.${body}`;
    const signature = createHmac('sha256', SECRET).update(unsigned_token).digest('base64url');
    return `${unsigned_token}.${signature}`;
}

function player(user_id: string, updates: Partial<AuthoritativeMatch['players'][string]> = {}) {
    return {
        user_id,
        username: user_id,
        hp: 0,
        position: 1,
        wpm: 20,
        accuracy: 1,
        is_ready: true,
        connected: true,
        total_keystrokes: 5,
        correct_keystrokes: 5,
        last_processed_sequence: 5,
        input_window_started_at: 0,
        input_window_count: 0,
        ...updates,
    };
}
