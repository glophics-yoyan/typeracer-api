import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RestBattleRepository, StoredBattleState } from '../src/rest-battle-repository.js';
import { RestMatchManager } from '../src/rest-match-manager.js';
import type { AuthoritativeMatch, BattleQuote, RoomRecord, RoomTokenClaims } from '../src/types.js';

class MemoryRestRepository implements RestBattleRepository {
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
    stored_state: StoredBattleState | null = null;
    open_match: { match_id: string; quote: BattleQuote } | null = null;
    finalized: AuthoritativeMatch[] = [];
    update_attempts = 0;
    fail_next_update = false;
    reset_count = 0;

    async getRoom(room_code: string) {
        return room_code === this.room.code ? this.room : null;
    }

    async getState() {
        return this.stored_state ? structuredClone(this.stored_state) : null;
    }

    async insertState(state: AuthoritativeMatch) {
        if (this.stored_state) return false;
        this.stored_state = { revision: state.revision, state: structuredClone(state) };
        return true;
    }

    async updateState(state: AuthoritativeMatch, expected_revision: number) {
        this.update_attempts += 1;
        if (this.fail_next_update) {
            this.fail_next_update = false;
            return false;
        }
        if (!this.stored_state || this.stored_state.revision !== expected_revision) return false;
        this.stored_state = { revision: state.revision, state: structuredClone(state) };
        return true;
    }

    async createMatch() {
        this.open_match = {
            match_id: 'match-1',
            quote: { id: 'quote-1', text: 'ab', author: 'Test', difficulty: 2, char_count: 2 },
        };
        return this.open_match;
    }

    async getOpenMatch() {
        return this.open_match;
    }

    async finalize(state: AuthoritativeMatch) {
        if (!this.finalized.some((entry) => entry.match_id === state.match_id)) {
            this.finalized.push(structuredClone(state));
        }
    }

    async resetRoom() {
        this.reset_count += 1;
    }

    async health() {
        return true;
    }
}

test('REST battle flow persists readiness, countdown, inputs, and one result', async () => {
    let now = 1000;
    const repository = new MemoryRestRepository();
    const manager = new RestMatchManager(repository, () => now);

    await manager.snapshot(claims('player-1', 'Alpha'));
    await manager.snapshot(claims('player-2', 'Bravo'));
    await manager.ready(claims('player-1', 'Alpha'));
    const countdown = await manager.ready(claims('player-2', 'Bravo'));
    assert.equal(countdown.snapshot.phase, 'countdown');
    assert.equal(countdown.snapshot.quote?.text, 'ab');

    now += 3000;
    const active = await manager.snapshot(claims('player-1', 'Alpha'));
    assert.equal(active.snapshot.phase, 'active');
    const finished = await manager.inputs(claims('player-1', 'Alpha'), [
        input(1, 'x', now),
        input(2, 'a', now),
        input(3, 'b', now),
    ]);

    assert.equal(finished.snapshot.phase, 'finished');
    assert.equal(finished.match_result?.winner_user_id, 'player-1');
    assert.equal(finished.match_result?.participants.find((player) => player.user_id === 'player-1')?.accuracy, 2 / 3);
    assert.equal(repository.finalized.length, 1);
    assert.equal(repository.stored_state?.state.result_persisted, true);
});

test('REST battle mutations retry a failed optimistic revision update', async () => {
    const repository = new MemoryRestRepository();
    const manager = new RestMatchManager(repository, () => 1000);
    await manager.snapshot(claims('player-1', 'Alpha'));

    repository.fail_next_update = true;
    const previous_attempts = repository.update_attempts;
    const snapshot = await manager.snapshot(claims('player-1', 'Alpha'));

    assert.equal(snapshot.snapshot.players.find((player) => player.user_id === 'player-1')?.connected, true);
    assert.equal(repository.update_attempts - previous_attempts, 2);
});

test('REST battle cancels after the reconnect deadline without a forfeit winner', async () => {
    let now = 1000;
    const repository = new MemoryRestRepository();
    const manager = new RestMatchManager(repository, () => now);
    await manager.snapshot(claims('player-1', 'Alpha'));
    await manager.snapshot(claims('player-2', 'Bravo'));
    await manager.ready(claims('player-1', 'Alpha'));
    await manager.ready(claims('player-2', 'Bravo'));
    now += 3000;
    await manager.snapshot(claims('player-1', 'Alpha'));
    const paused = await manager.leave(claims('player-2', 'Bravo'));
    assert.equal(paused.snapshot.phase, 'paused');

    now += 30001;
    const cancelled = await manager.snapshot(claims('player-1', 'Alpha'));
    assert.equal(cancelled.snapshot.phase, 'cancelled');
    assert.equal(cancelled.match_result?.winner_user_id, null);
    assert.equal(cancelled.match_result?.finished_reason, 'disconnect_timeout');
});

function claims(user_id: string, username: string): RoomTokenClaims {
    return {
        protocol_version: 2,
        room_code: 'ABC234',
        user_id,
        username,
        role: user_id === 'player-1' ? 'host' : 'player',
        issued_at: 1,
        expires_at: 9999999999,
    };
}

function input(sequence: number, character: string, client_timestamp: number) {
    return { type: 'input' as const, request_id: String(sequence), sequence, character, client_timestamp };
}
