import type { RestBattleRepository, StoredBattleState } from './rest-battle-repository.js';
import { calculateAccuracy, calculateDamage, calculateWpm, MatchError, resolveWinner } from './match-manager.js';
import type {
    AuthoritativeMatch,
    AuthoritativePlayer,
    InputMessage,
    MatchResult,
    RestBattleData,
    RoomRecord,
    RoomSnapshot,
    RoomTokenClaims,
} from './types.js';

const STARTING_HP = 100;
const COUNTDOWN_DURATION = 3000;
const RECONNECT_GRACE = 30000;
const REMATCH_WINDOW = 60000;
const PRESENCE_TIMEOUT = 4000;
const INPUT_RATE_WINDOW = 1000;
const MAX_INPUTS_PER_WINDOW = 30;
const MAX_MUTATION_ATTEMPTS = 8;
const MAX_DAMAGE_ELAPSED_SECONDS = 1;

type RestCommand =
    | { type: 'snapshot' }
    | { type: 'ready' }
    | { type: 'input'; messages: InputMessage[] }
    | { type: 'rematch'; accepted: boolean }
    | { type: 'leave' };

export class RestMatchManager {
    constructor(
        private repository: RestBattleRepository,
        private clock: () => number = Date.now,
    ) {}

    snapshot(claims: RoomTokenClaims) {
        return this.mutate(claims, { type: 'snapshot' });
    }

    ready(claims: RoomTokenClaims) {
        return this.mutate(claims, { type: 'ready' });
    }

    input(claims: RoomTokenClaims, message: InputMessage) {
        return this.inputs(claims, [message]);
    }

    inputs(claims: RoomTokenClaims, messages: InputMessage[]) {
        if (messages.length === 0 || messages.length > MAX_INPUTS_PER_WINDOW) {
            throw new MatchError('INVALID_REQUEST', 'Input batch must contain 1-30 entries.');
        }
        return this.mutate(claims, { type: 'input', messages });
    }

    rematch(claims: RoomTokenClaims, accepted: boolean) {
        return this.mutate(claims, { type: 'rematch', accepted });
    }

    leave(claims: RoomTokenClaims) {
        return this.mutate(claims, { type: 'leave' });
    }

    private async mutate(claims: RoomTokenClaims, command: RestCommand): Promise<RestBattleData> {
        const room = await this.repository.getRoom(claims.room_code);
        if (!room) throw new MatchError('ROOM_NOT_FOUND', 'Battle not found.');
        if (!room.players.some((player) => player.user_id === claims.user_id)) {
            throw new MatchError('MEMBERSHIP_INVALID', 'Player is not part of this battle.');
        }

        let stored_state = await this.getOrCreateState(room);
        for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
            const now = this.clock();
            const state = structuredClone(stored_state.state);
            this.synchronizePlayers(state, room, now);
            const player = this.requirePlayer(state, claims.user_id);
            player.username = claims.username;
            player.last_seen_at = command.type === 'leave' ? 0 : now;
            player.connected = command.type !== 'leave';

            this.advanceLifecycle(state, now);
            let reset_room = false;

            if (command.type === 'ready') {
                if (state.phase !== 'waiting') {
                    throw new MatchError('NOT_WAITING', 'The battle is not accepting ready commands.');
                }
                player.is_ready = true;
            } else if (command.type === 'input') {
                command.messages.forEach((message) => this.applyInput(state, player, message, now));
            } else if (command.type === 'rematch') {
                reset_room = this.applyRematch(state, player.user_id, command.accepted, now);
            } else if (command.type === 'leave') {
                this.pauseForDisconnect(state, now);
            }

            if (state.phase === 'waiting' && this.allPlayersReady(state)) {
                await this.startMatch(state, room, now);
            }

            if (reset_room) await this.repository.resetRoom(state.room_id);
            state.revision = stored_state.revision + 1;
            if (await this.repository.updateState(state, stored_state.revision)) {
                if ((state.phase === 'finished' || state.phase === 'cancelled') && !state.result_persisted) {
                    await this.repository.finalize(state);
                    const persisted_state = structuredClone(state);
                    persisted_state.result_persisted = true;
                    persisted_state.revision += 1;
                    await this.repository.updateState(persisted_state, state.revision);
                }
                return this.toResponse(state, now);
            }

            const refreshed_state = await this.repository.getState(room.id);
            if (!refreshed_state) throw new MatchError('STATE_UNAVAILABLE', 'Battle state is unavailable.');
            stored_state = refreshed_state;
        }

        throw new MatchError('STATE_BUSY', 'Battle state changed too quickly. Try again.');
    }

    private async getOrCreateState(room: RoomRecord): Promise<StoredBattleState> {
        const existing_state = await this.repository.getState(room.id);
        if (existing_state) return existing_state;

        const initial_state = createWaitingState(room, this.clock());
        if (await this.repository.insertState(initial_state)) {
            return { revision: initial_state.revision, state: initial_state };
        }

        const concurrent_state = await this.repository.getState(room.id);
        if (!concurrent_state) throw new MatchError('STATE_UNAVAILABLE', 'Battle state is unavailable.');
        return concurrent_state;
    }

    private synchronizePlayers(state: AuthoritativeMatch, room: RoomRecord, now: number) {
        if (state.phase !== 'waiting') return;
        room.players.forEach((room_player) => {
            state.players[room_player.user_id] ??= createPlayer(room_player, now);
            state.players[room_player.user_id]!.username = room_player.username;
        });
    }

    private advanceLifecycle(state: AuthoritativeMatch, now: number) {
        Object.values(state.players).forEach((player) => {
            player.connected = Boolean(player.last_seen_at && now - player.last_seen_at <= PRESENCE_TIMEOUT);
        });

        if (state.rematch_expires_at && now >= state.rematch_expires_at) {
            state.rematch_votes = {};
            state.rematch_expires_at = null;
        }

        if (state.phase === 'paused') {
            if (state.reconnect_deadline && now >= state.reconnect_deadline) {
                this.cancel(state, 'disconnect_timeout', now);
                return;
            }
            if (this.allPlayersConnected(state)) {
                if (state.started_at && state.paused_at) state.started_at += now - state.paused_at;
                state.phase = 'countdown';
                state.countdown_ends_at = now + COUNTDOWN_DURATION;
                state.reconnect_deadline = null;
                state.paused_at = null;
                state.last_tick_at = now;
            }
            return;
        }

        if ((state.phase === 'countdown' || state.phase === 'active') && !this.allPlayersConnected(state)) {
            this.pauseForDisconnect(state, now);
            return;
        }

        if (state.phase === 'countdown' && state.countdown_ends_at && now >= state.countdown_ends_at) {
            state.phase = 'active';
            state.started_at ??= now;
            state.countdown_ends_at = null;
            state.last_tick_at = now;
        }

        if (state.phase !== 'active') return;
        const elapsed_seconds = Math.min(
            MAX_DAMAGE_ELAPSED_SECONDS,
            Math.max(0, now - state.last_tick_at) / 1000,
        );
        state.last_tick_at = now;
        if (elapsed_seconds > 0) this.applyDamage(state, elapsed_seconds, now);
    }

    private applyInput(state: AuthoritativeMatch, player: AuthoritativePlayer, message: InputMessage, now: number) {
        if (state.phase !== 'active' || !state.quote) {
            throw new MatchError('INPUT_NOT_ALLOWED', 'Typing is not active.');
        }
        if (!Number.isInteger(message.sequence) || message.sequence !== player.last_processed_sequence + 1) {
            throw new MatchError('INVALID_SEQUENCE', 'Input sequence is out of order.');
        }
        if (typeof message.character !== 'string' || Array.from(message.character).length !== 1) {
            throw new MatchError('INVALID_CHARACTER', 'Input must contain one character.');
        }
        if (!Number.isFinite(message.client_timestamp)) {
            throw new MatchError('INVALID_TIMESTAMP', 'Input timestamp is invalid.');
        }

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

        if (player.position >= state.quote.text.length) {
            this.finish(state, player.user_id, 'quote_completed', now);
        }
    }

    private applyDamage(state: AuthoritativeMatch, elapsed_seconds: number, now: number) {
        const players = Object.values(state.players);
        const first_player = players[0];
        const second_player = players[1];
        if (!first_player || !second_player) return;

        const first_damage = calculateDamage(first_player.wpm, first_player.accuracy) * elapsed_seconds;
        const second_damage = calculateDamage(second_player.wpm, second_player.accuracy) * elapsed_seconds;
        first_player.hp = Math.max(0, first_player.hp - second_damage);
        second_player.hp = Math.max(0, second_player.hp - first_damage);
        if (first_player.hp > 0 && second_player.hp > 0) return;
        this.finish(state, resolveWinner(first_player, second_player), 'hp_zero', now);
    }

    private applyRematch(state: AuthoritativeMatch, user_id: string, accepted: boolean, now: number) {
        if (state.phase !== 'finished' && state.phase !== 'cancelled') {
            throw new MatchError('REMATCH_NOT_ALLOWED', 'A rematch is available after the battle ends.');
        }
        state.rematch_votes[user_id] = accepted;
        state.rematch_expires_at = now + REMATCH_WINDOW;
        if (!this.allPlayersConnected(state) || !Object.keys(state.players).every((id) => state.rematch_votes[id])) {
            return false;
        }

        resetPlayers(state, now);
        state.match_id = null;
        state.quote = null;
        state.phase = 'waiting';
        state.countdown_ends_at = null;
        state.reconnect_deadline = null;
        state.paused_at = null;
        state.started_at = null;
        state.finished_at = null;
        state.winner_user_id = null;
        state.finished_reason = null;
        state.rematch_votes = {};
        state.rematch_expires_at = null;
        state.result_persisted = false;
        state.last_tick_at = now;
        return true;
    }

    private async startMatch(state: AuthoritativeMatch, room: RoomRecord, now: number) {
        let match: Awaited<ReturnType<RestBattleRepository['createMatch']>> | null = null;
        try {
            match = await this.repository.createMatch(room);
        } catch {
            match = await this.repository.getOpenMatch(room.id);
        }
        if (!match) throw new MatchError('MATCH_START_FAILED', 'Unable to start this battle.');

        resetPlayers(state, now);
        Object.values(state.players).forEach((player) => { player.is_ready = true; });
        state.match_id = match.match_id;
        state.quote = match.quote;
        state.phase = 'countdown';
        state.countdown_ends_at = now + COUNTDOWN_DURATION;
        state.reconnect_deadline = null;
        state.paused_at = null;
        state.started_at = null;
        state.finished_at = null;
        state.winner_user_id = null;
        state.finished_reason = null;
        state.result_persisted = false;
        state.last_tick_at = now;
    }

    private pauseForDisconnect(state: AuthoritativeMatch, now: number) {
        if (state.phase !== 'active' && state.phase !== 'countdown') return;
        state.phase = 'paused';
        state.countdown_ends_at = null;
        state.reconnect_deadline = now + RECONNECT_GRACE;
        state.paused_at = now;
        state.last_tick_at = now;
    }

    private finish(state: AuthoritativeMatch, winner_user_id: string, reason: string, now: number) {
        if (state.phase === 'finished' || state.phase === 'cancelled') return;
        state.phase = 'finished';
        state.winner_user_id = winner_user_id;
        state.finished_reason = reason;
        state.finished_at = now;
    }

    private cancel(state: AuthoritativeMatch, reason: string, now: number) {
        if (state.phase === 'finished' || state.phase === 'cancelled') return;
        state.phase = 'cancelled';
        state.winner_user_id = null;
        state.finished_reason = reason;
        state.finished_at = now;
        state.reconnect_deadline = null;
        state.paused_at = null;
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

    private toResponse(state: AuthoritativeMatch, now: number): RestBattleData {
        const players = Object.values(state.players).map(toPublicPlayer);
        const snapshot: RoomSnapshot = {
            room_code: state.room_code,
            match_id: state.match_id,
            revision: state.revision,
            server_time: now,
            phase: state.phase,
            quote: state.phase === 'waiting' ? null : state.quote,
            countdown_ends_at: state.countdown_ends_at,
            reconnect_deadline: state.reconnect_deadline,
            started_at: state.started_at,
            finished_at: state.finished_at,
            winner_user_id: state.winner_user_id,
            finished_reason: state.finished_reason,
            checkpointed_sequences: Object.fromEntries(players.map((player) => [player.user_id, player.last_processed_sequence])),
            players,
        };
        return {
            snapshot,
            match_result: this.toMatchResult(state, players),
            rematch_status: {
                votes: state.rematch_votes,
                expires_at: state.rematch_expires_at,
            },
        };
    }

    private toMatchResult(state: AuthoritativeMatch, players: RoomSnapshot['players']): MatchResult | null {
        if (!state.match_id || (state.phase !== 'finished' && state.phase !== 'cancelled')) return null;
        return {
            match_id: state.match_id,
            winner_user_id: state.winner_user_id,
            finished_reason: state.finished_reason ?? state.phase,
            duration_ms: Math.max(0, (state.finished_at ?? this.clock()) - (state.started_at ?? state.finished_at ?? this.clock())),
            participants: players,
        };
    }
}

function createWaitingState(room: RoomRecord, now: number): AuthoritativeMatch {
    return {
        room_id: room.id,
        room_code: room.code,
        difficulty: room.difficulty,
        match_id: null,
        phase: room.status === 'finished' || room.status === 'cancelled' ? room.status : 'waiting',
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
        result_persisted: false,
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
        last_seen_at: 0,
    };
}

function resetPlayers(state: AuthoritativeMatch, now: number) {
    Object.values(state.players).forEach((player) => {
        const connected = player.connected;
        const last_seen_at = player.last_seen_at;
        Object.assign(player, createPlayer(player, now), { connected, last_seen_at });
    });
}

function toPublicPlayer(player: AuthoritativePlayer): RoomSnapshot['players'][number] {
    const {
        input_window_started_at: _window_started,
        input_window_count: _window_count,
        last_seen_at: _last_seen,
        ...public_player
    } = player;
    return public_player;
}
