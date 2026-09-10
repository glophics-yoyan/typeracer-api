import type { BattleRepository } from './battle-repository.js';
import type {
    AuthoritativeMatch,
    AuthoritativePlayer,
    InputMessage,
    RoomRecord,
    RoomTokenClaims,
    ServerMessage,
} from './types.js';

const STARTING_HP = 100;
const COUNTDOWN_DURATION = 3000;
const RECONNECT_GRACE = 30000;
const REMATCH_WINDOW = 60000;
const RESTORE_MAX_AGE = 5 * 60 * 1000;
const SNAPSHOT_INTERVAL = 100;
const CHECKPOINT_INTERVAL = 1000;
const INPUT_RATE_WINDOW = 1000;
const MAX_INPUTS_PER_WINDOW = 30;

type Broadcast = (room_code: string, message: ServerMessage) => void;

export class MatchManager {
    private matches = new Map<string, AuthoritativeMatch>();
    private room_records = new Map<string, RoomRecord>();
    private loading_rooms = new Map<string, Promise<AuthoritativeMatch>>();
    private dirty_rooms = new Set<string>();
    private persisting_rooms = new Set<string>();
    private starting_rooms = new Set<string>();
    private last_broadcast = new Map<string, number>();
    private last_checkpoint = new Map<string, number>();
    private checkpoint_sequences = new Map<string, Record<string, number>>();
    private pending_end_events = new Map<string, 'match_finished' | 'match_cancelled'>();
    private last_persist_attempt = new Map<string, number>();

    constructor(
        private repository: BattleRepository,
        private broadcast: Broadcast,
        private clock: () => number = Date.now,
    ) {}

    async connect(claims: RoomTokenClaims) {
        const state = await this.ensureRoom(claims.room_code);
        let player = state.players[claims.user_id];
        if (!player) {
            const refreshed_room = await this.repository.getRoom(claims.room_code);
            const refreshed_player = refreshed_room?.players.find((candidate) => candidate.user_id === claims.user_id);
            if (refreshed_room && refreshed_player && state.phase === 'waiting') {
                this.room_records.set(claims.room_code, refreshed_room);
                player = createPlayer(refreshed_player, this.clock());
                state.players[claims.user_id] = player;
            }
        }
        if (!player) throw new MatchError('MEMBERSHIP_INVALID', 'Battle membership is invalid.');
        player.username = claims.username;
        player.connected = true;
        state.revision += 1;
        this.markDirty(state);

        if (state.phase === 'paused' && this.allPlayersConnected(state)) {
            const now = this.clock();
            if (state.started_at && state.paused_at) state.started_at += now - state.paused_at;
            state.phase = 'countdown';
            state.countdown_ends_at = now + COUNTDOWN_DURATION;
            state.reconnect_deadline = null;
            state.paused_at = null;
            state.last_tick_at = now;
            await this.checkpointNow(state);
        }

        this.broadcastSnapshot(state);
        return this.snapshot(state);
    }

    async disconnect(room_code: string, user_id: string) {
        const state = this.matches.get(room_code);
        const player = state?.players[user_id];
        if (!state || !player) return;
        player.connected = false;
        state.revision += 1;
        if (state.phase === 'active' || state.phase === 'countdown') {
            const now = this.clock();
            state.phase = 'paused';
            state.countdown_ends_at = null;
            state.reconnect_deadline = now + RECONNECT_GRACE;
            state.paused_at = now;
            state.last_tick_at = now;
        }
        this.markDirty(state);
        this.broadcastSnapshot(state);
        await this.checkpointNow(state);
    }

    async ready(room_code: string, user_id: string) {
        const state = await this.ensureRoom(room_code);
        const player = this.requirePlayer(state, user_id);
        if (state.phase !== 'waiting') throw new MatchError('NOT_WAITING', 'The battle is not accepting ready commands.');
        player.is_ready = true;
        state.revision += 1;
        this.markDirty(state);
        this.broadcastSnapshot(state);
        if (!this.allPlayersReady(state) || this.starting_rooms.has(room_code)) return;

        this.starting_rooms.add(room_code);
        try {
            const room = this.room_records.get(room_code);
            if (!room) throw new MatchError('ROOM_NOT_FOUND', 'Battle not found.');
            const created_match = await this.repository.createMatch(room);
            const now = this.clock();
            resetPlayers(state, now);
            Object.values(state.players).forEach((candidate) => { candidate.is_ready = true; });
            state.match_id = created_match.match_id;
            state.quote = created_match.quote;
            state.phase = 'countdown';
            state.countdown_ends_at = now + COUNTDOWN_DURATION;
            state.started_at = null;
            state.finished_at = null;
            state.winner_user_id = null;
            state.finished_reason = null;
            state.last_tick_at = now;
            state.revision += 1;
            this.markDirty(state);
            await this.checkpointNow(state);
            this.broadcastSnapshot(state);
        } finally {
            this.starting_rooms.delete(room_code);
        }
    }

    async input(room_code: string, user_id: string, message: InputMessage) {
        const state = await this.ensureRoom(room_code);
        const player = this.requirePlayer(state, user_id);
        if (state.phase !== 'active' || !state.quote) throw new MatchError('INPUT_NOT_ALLOWED', 'Typing is not active.');
        if (!Number.isInteger(message.sequence) || message.sequence !== player.last_processed_sequence + 1) {
            throw new MatchError('INVALID_SEQUENCE', 'Input sequence is out of order.');
        }
        if (typeof message.character !== 'string' || message.character.length !== 1) {
            throw new MatchError('INVALID_CHARACTER', 'Input must contain one character.');
        }
        if (!Number.isFinite(message.client_timestamp)) {
            throw new MatchError('INVALID_TIMESTAMP', 'Input timestamp is invalid.');
        }

        const now = this.clock();
        if (now - player.input_window_started_at >= INPUT_RATE_WINDOW) {
            player.input_window_started_at = now;
            player.input_window_count = 0;
        }
        player.input_window_count += 1;
        if (player.input_window_count > MAX_INPUTS_PER_WINDOW) {
            throw new MatchError('INPUT_RATE_LIMITED', 'Typing input rate is too high.');
        }

        const expected_character = state.quote.text[player.position];
        const is_correct = message.character === expected_character;
        player.position = Math.min(player.position + 1, state.quote.text.length);
        player.total_keystrokes += 1;
        player.correct_keystrokes += is_correct ? 1 : 0;
        player.last_processed_sequence = message.sequence;
        player.accuracy = calculateAccuracy(player.correct_keystrokes, player.total_keystrokes);
        player.wpm = calculateWpm(player.total_keystrokes, now - (state.started_at ?? now));
        state.revision += 1;
        this.markDirty(state);

        if (player.position >= state.quote.text.length) {
            await this.finish(state, user_id, 'quote_completed');
        } else {
            this.broadcastSnapshot(state);
        }
    }

    async rematch(room_code: string, user_id: string, accepted: boolean) {
        const state = await this.ensureRoom(room_code);
        this.requirePlayer(state, user_id);
        if (state.phase !== 'finished' && state.phase !== 'cancelled') {
            throw new MatchError('REMATCH_NOT_ALLOWED', 'A rematch is available after the battle ends.');
        }
        if (this.persisting_rooms.has(room_code)) throw new MatchError('RESULT_PENDING', 'The result is still being saved.');
        state.rematch_votes[user_id] = accepted;
        state.rematch_expires_at = this.clock() + REMATCH_WINDOW;
        this.broadcast(room_code, {
            type: 'rematch_status',
            payload: { votes: state.rematch_votes, expires_at: state.rematch_expires_at },
        });
        if (!this.allPlayersConnected(state) || !Object.keys(state.players).every((id) => state.rematch_votes[id])) return;

        await this.repository.resetRoom(state.room_id);
        resetPlayers(state, this.clock());
        state.match_id = null;
        state.quote = null;
        state.phase = 'waiting';
        state.revision += 1;
        state.countdown_ends_at = null;
        state.reconnect_deadline = null;
        state.paused_at = null;
        state.started_at = null;
        state.finished_at = null;
        state.winner_user_id = null;
        state.finished_reason = null;
        state.rematch_votes = {};
        state.rematch_expires_at = null;
        state.last_tick_at = this.clock();
        this.last_checkpoint.delete(room_code);
        this.checkpoint_sequences.delete(room_code);
        this.markDirty(state);
        this.broadcastSnapshot(state);
    }

    async tick(now = this.clock()) {
        for (const state of this.matches.values()) {
            const pending_end_event = this.pending_end_events.get(state.room_code);
            if (pending_end_event
                && now - (this.last_persist_attempt.get(state.room_code) ?? 0) >= CHECKPOINT_INTERVAL) {
                await this.persistEnd(state, pending_end_event);
            }
            if (state.rematch_expires_at && now >= state.rematch_expires_at) {
                state.rematch_votes = {};
                state.rematch_expires_at = null;
                this.broadcast(state.room_code, { type: 'rematch_status', payload: { votes: {}, expires_at: null } });
            }
            if (state.phase === 'paused' && state.reconnect_deadline && now >= state.reconnect_deadline) {
                await this.cancel(state, 'disconnect_timeout');
                continue;
            }
            if (state.phase === 'countdown' && state.countdown_ends_at && now >= state.countdown_ends_at) {
                state.phase = 'active';
                state.started_at ??= now;
                state.countdown_ends_at = null;
                state.last_tick_at = now;
                state.revision += 1;
                this.markDirty(state);
                await this.checkpointNow(state);
            }
            if (state.phase === 'active') {
                const elapsed_seconds = Math.min(0.25, Math.max(0, now - state.last_tick_at) / 1000);
                state.last_tick_at = now;
                if (elapsed_seconds > 0) await this.applyDamage(state, elapsed_seconds);
            }
            if (this.dirty_rooms.has(state.room_code)
                && now - (this.last_checkpoint.get(state.room_code) ?? 0) >= CHECKPOINT_INTERVAL) {
                await this.checkpointNow(state);
            }
            if (now - (this.last_broadcast.get(state.room_code) ?? 0) >= SNAPSHOT_INTERVAL) {
                this.broadcastSnapshot(state);
            }
        }
    }

    get active_count() {
        return Array.from(this.matches.values()).filter((state) => ['countdown', 'active'].includes(state.phase)).length;
    }

    get paused_count() {
        return Array.from(this.matches.values()).filter((state) => state.phase === 'paused').length;
    }

    get oldest_checkpoint_age() {
        if (this.last_checkpoint.size === 0) return 0;
        return this.clock() - Math.min(...this.last_checkpoint.values());
    }

    private async ensureRoom(room_code: string) {
        const existing = this.matches.get(room_code);
        if (existing) return existing;
        const pending = this.loading_rooms.get(room_code);
        if (pending) return pending;
        const loading = this.loadRoom(room_code);
        this.loading_rooms.set(room_code, loading);
        try {
            return await loading;
        } finally {
            this.loading_rooms.delete(room_code);
        }
    }

    private async loadRoom(room_code: string) {
        const room = await this.repository.getRoom(room_code);
        if (!room) throw new MatchError('ROOM_NOT_FOUND', 'Battle not found.');
        this.room_records.set(room_code, room);
        const live_match = await this.repository.getLiveMatch(room.id);
        let state: AuthoritativeMatch;
        const now = this.clock();
        if (live_match && now - live_match.checkpointed_at <= RESTORE_MAX_AGE) {
            state = live_match.state;
            Object.values(state.players).forEach((player) => { player.connected = false; });
            state.phase = 'paused';
            state.countdown_ends_at = null;
            state.reconnect_deadline = now + RECONNECT_GRACE;
            state.paused_at = now;
            state.last_tick_at = now;
            state.revision += 1;
            this.checkpoint_sequences.set(room_code, Object.fromEntries(
                Object.values(state.players).map((player) => [player.user_id, player.last_processed_sequence]),
            ));
        } else {
            if (live_match) {
                state = live_match.state;
                Object.values(state.players).forEach((player) => { player.connected = false; });
                state.phase = 'cancelled';
                state.finished_at = now;
                state.finished_reason = 'server_restart_timeout';
                await this.repository.finalize(state);
            } else {
                state = createWaitingState(room, now);
                if (room.status === 'finished' || room.status === 'cancelled') state.phase = room.status;
            }
        }
        this.matches.set(room_code, state);
        this.markDirty(state);
        return state;
    }

    private async applyDamage(state: AuthoritativeMatch, elapsed_seconds: number) {
        const players = Object.values(state.players);
        if (players.length !== 2) return;
        const first_player = players[0];
        const second_player = players[1];
        if (!first_player || !second_player) return;
        const first_damage = calculateDamage(first_player.wpm, first_player.accuracy) * elapsed_seconds;
        const second_damage = calculateDamage(second_player.wpm, second_player.accuracy) * elapsed_seconds;
        first_player.hp = Math.max(0, first_player.hp - second_damage);
        second_player.hp = Math.max(0, second_player.hp - first_damage);
        state.revision += 1;
        this.markDirty(state);
        if (first_player.hp > 0 && second_player.hp > 0) return;
        const winner_user_id = resolveWinner(first_player, second_player);
        await this.finish(state, winner_user_id, 'hp_zero');
    }

    private async finish(state: AuthoritativeMatch, winner_user_id: string, reason: string) {
        if (state.phase === 'finished' || state.phase === 'cancelled') return;
        state.phase = 'finished';
        state.winner_user_id = winner_user_id;
        state.finished_reason = reason;
        state.finished_at = this.clock();
        state.revision += 1;
        this.markDirty(state);
        await this.persistEnd(state, 'match_finished');
    }

    private async cancel(state: AuthoritativeMatch, reason: string) {
        if (state.phase === 'finished' || state.phase === 'cancelled') return;
        state.phase = 'cancelled';
        state.winner_user_id = null;
        state.finished_reason = reason;
        state.finished_at = this.clock();
        state.reconnect_deadline = null;
        state.paused_at = null;
        state.revision += 1;
        this.markDirty(state);
        await this.persistEnd(state, 'match_cancelled');
    }

    private async persistEnd(state: AuthoritativeMatch, event_type: 'match_finished' | 'match_cancelled') {
        if (!state.match_id || this.persisting_rooms.has(state.room_code)) return;
        this.pending_end_events.set(state.room_code, event_type);
        this.last_persist_attempt.set(state.room_code, this.clock());
        this.persisting_rooms.add(state.room_code);
        try {
            await this.repository.finalize(state);
            this.pending_end_events.delete(state.room_code);
            this.dirty_rooms.delete(state.room_code);
            this.last_checkpoint.delete(state.room_code);
            const players = Object.values(state.players).map(toPublicPlayer);
            this.broadcast(state.room_code, {
                type: event_type,
                payload: {
                    match_id: state.match_id,
                    winner_user_id: state.winner_user_id,
                    finished_reason: state.finished_reason,
                    duration_ms: Math.max(0, (state.finished_at ?? this.clock()) - (state.started_at ?? this.clock())),
                    participants: players,
                },
            });
            this.broadcastSnapshot(state);
            console.log(JSON.stringify({ event: event_type, room_code: state.room_code, match_id: state.match_id, reason: state.finished_reason }));
        } catch (caught_error) {
            console.error(JSON.stringify({
                event: 'match_persistence_failed',
                room_code: state.room_code,
                match_id: state.match_id,
                message: caught_error instanceof Error ? caught_error.message : 'Unknown error',
            }));
        } finally {
            this.persisting_rooms.delete(state.room_code);
        }
    }

    private requirePlayer(state: AuthoritativeMatch, user_id: string) {
        const player = state.players[user_id];
        if (!player) throw new MatchError('MEMBERSHIP_INVALID', 'Player is not part of this battle.');
        return player;
    }

    private allPlayersReady(state: AuthoritativeMatch) {
        const players = Object.values(state.players);
        return players.length === 2 && players.every((player) => player.is_ready && player.connected);
    }

    private allPlayersConnected(state: AuthoritativeMatch) {
        const players = Object.values(state.players);
        return players.length === 2 && players.every((player) => player.connected);
    }

    private markDirty(state: AuthoritativeMatch) {
        if (state.match_id && !['finished', 'cancelled'].includes(state.phase)) this.dirty_rooms.add(state.room_code);
    }

    private async checkpointNow(state: AuthoritativeMatch) {
        if (!state.match_id || ['finished', 'cancelled'].includes(state.phase)) return;
        await this.repository.checkpoint(state);
        this.last_checkpoint.set(state.room_code, this.clock());
        this.checkpoint_sequences.set(state.room_code, Object.fromEntries(
            Object.values(state.players).map((player) => [player.user_id, player.last_processed_sequence]),
        ));
        this.dirty_rooms.delete(state.room_code);
    }

    private broadcastSnapshot(state: AuthoritativeMatch) {
        this.broadcast(state.room_code, { type: 'room_snapshot', payload: this.snapshot(state) });
        this.last_broadcast.set(state.room_code, this.clock());
    }

    private snapshot(state: AuthoritativeMatch) {
        return {
            room_code: state.room_code,
            match_id: state.match_id,
            revision: state.revision,
            server_time: this.clock(),
            phase: state.phase,
            quote: state.phase === 'waiting' ? null : state.quote,
            countdown_ends_at: state.countdown_ends_at,
            reconnect_deadline: state.reconnect_deadline,
            started_at: state.started_at,
            finished_at: state.finished_at,
            winner_user_id: state.winner_user_id,
            finished_reason: state.finished_reason,
            checkpointed_sequences: this.checkpoint_sequences.get(state.room_code) ?? {},
            players: Object.values(state.players).map(toPublicPlayer),
        };
    }
}

export class MatchError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

export function calculateDamage(wpm: number, accuracy: number) {
    return (wpm / 60) * 5 * accuracy * accuracy;
}

export function calculateWpm(keystrokes: number, time_ms: number) {
    if (time_ms <= 0) return 0;
    return (keystrokes / 5) / (time_ms / 60000);
}

export function calculateAccuracy(correct: number, total: number) {
    return total === 0 ? 1 : Math.max(0, correct / total);
}

export function resolveWinner(first_player: AuthoritativePlayer, second_player: AuthoritativePlayer) {
    if (first_player.hp !== second_player.hp) {
        return first_player.hp > second_player.hp ? first_player.user_id : second_player.user_id;
    }
    if (first_player.position !== second_player.position) {
        return first_player.position > second_player.position ? first_player.user_id : second_player.user_id;
    }
    if (first_player.wpm !== second_player.wpm) {
        return first_player.wpm > second_player.wpm ? first_player.user_id : second_player.user_id;
    }
    if (first_player.accuracy !== second_player.accuracy) {
        return first_player.accuracy > second_player.accuracy ? first_player.user_id : second_player.user_id;
    }
    return first_player.user_id.localeCompare(second_player.user_id) <= 0
        ? first_player.user_id
        : second_player.user_id;
}

function createWaitingState(room: RoomRecord, now: number): AuthoritativeMatch {
    return {
        room_id: room.id,
        room_code: room.code,
        difficulty: room.difficulty,
        match_id: null,
        phase: 'waiting',
        quote: null,
        players: Object.fromEntries(room.players.map((player) => [player.user_id, createPlayer(player, now)])),
        revision: 0,
        countdown_ends_at: null,
        reconnect_deadline: null,
        paused_at: null,
        started_at: null,
        finished_at: null,
        winner_user_id: null,
        finished_reason: null,
        last_tick_at: now,
        rematch_votes: {},
        rematch_expires_at: null,
    };
}

function createPlayer(player: { user_id: string; username: string }, now: number): AuthoritativePlayer {
    return {
        ...player,
        hp: STARTING_HP,
        position: 0,
        wpm: 0,
        accuracy: 1,
        is_ready: false,
        connected: false,
        total_keystrokes: 0,
        correct_keystrokes: 0,
        last_processed_sequence: 0,
        input_window_started_at: now,
        input_window_count: 0,
    };
}

function resetPlayers(state: AuthoritativeMatch, now: number) {
    Object.values(state.players).forEach((player) => {
        const connected = player.connected;
        Object.assign(player, createPlayer(player, now), { connected });
    });
}

function toPublicPlayer(player: AuthoritativePlayer) {
    const { input_window_started_at: _window_started, input_window_count: _window_count, ...public_player } = player;
    return public_player;
}
