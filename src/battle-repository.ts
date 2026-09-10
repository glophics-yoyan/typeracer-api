import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { AuthoritativeMatch, BattleQuote, RoomRecord } from './types.js';

export interface BattleRepository {
    getRoom(room_code: string): Promise<RoomRecord | null>;
    getLiveMatch(room_id: string): Promise<{ state: AuthoritativeMatch; checkpointed_at: number } | null>;
    createMatch(room: RoomRecord): Promise<{ match_id: string; quote: BattleQuote }>;
    checkpoint(state: AuthoritativeMatch): Promise<void>;
    finalize(state: AuthoritativeMatch): Promise<void>;
    resetRoom(room_id: string): Promise<void>;
    health(): Promise<boolean>;
}

export class NeonBattleRepository implements BattleRepository {
    private sql: NeonQueryFunction<false, false>;

    constructor(database_url: string) {
        this.sql = neon(database_url);
    }

    async getRoom(room_code: string): Promise<RoomRecord | null> {
        const rooms = await this.sql`
            SELECT id, code, host_id, difficulty, status
            FROM rooms WHERE code = ${room_code}
        `;
        if (!rooms[0]) return null;
        const room_id = String(rooms[0].id);
        const players = await this.sql`
            SELECT rp.user_id, u.username
            FROM room_players rp
            JOIN users u ON u.id = rp.user_id
            WHERE rp.room_id = ${room_id}
            ORDER BY rp.joined_at
        `;
        return {
            id: room_id,
            code: String(rooms[0].code),
            host_id: String(rooms[0].host_id),
            difficulty: Number(rooms[0].difficulty ?? 2),
            status: String(rooms[0].status),
            players: players.map((player) => ({ user_id: String(player.user_id), username: String(player.username) })),
        };
    }

    async getLiveMatch(room_id: string) {
        const rows = await this.sql`
            SELECT l.state, l.checkpointed_at
            FROM live_match_states l
            JOIN matches m ON m.id = l.match_id
            WHERE m.room_id = ${room_id} AND m.status IN ('countdown', 'active', 'paused')
            ORDER BY l.checkpointed_at DESC LIMIT 1
        `;
        if (!rows[0]) return null;
        return {
            state: rows[0].state as AuthoritativeMatch,
            checkpointed_at: new Date(String(rows[0].checkpointed_at)).getTime(),
        };
    }

    async createMatch(room: RoomRecord) {
        const sentences = await this.sql`SELECT text FROM quotes ORDER BY RANDOM() LIMIT 20`;
        if (sentences.length === 0) throw new Error('Quote pool is empty');
        const sentence_count = 4 + Math.max(1, Math.min(5, room.difficulty)) * 3;
        const text = Array.from({ length: sentence_count }, (_, index) => (
            String(sentences[index % sentences.length]?.text ?? '')
        )).filter(Boolean).join(' ');
        const rows = await this.sql`
            WITH new_quote AS (
                INSERT INTO quotes (text, author, difficulty)
                VALUES (${text}, ${'Shuffled battle sequence'}, ${room.difficulty})
                RETURNING id, text, author, difficulty, char_count
            ), new_match AS (
                INSERT INTO matches (room_id, quote_id, status, protocol_version)
                SELECT ${room.id}, id, ${'countdown'}, ${2} FROM new_quote
                RETURNING id, quote_id
            ), updated_room AS (
                UPDATE rooms SET status = ${'active'}, quote_id = (SELECT id FROM new_quote),
                    started_at = NULL, finished_at = NULL
                WHERE id = ${room.id}
            )
            SELECT m.id AS match_id, q.id, q.text, q.author, q.difficulty, q.char_count
            FROM new_match m JOIN new_quote q ON q.id = m.quote_id
        `;
        const row = rows[0];
        if (!row) throw new Error('Unable to create match');
        return { match_id: String(row.match_id), quote: toQuote(row) };
    }

    async checkpoint(state: AuthoritativeMatch) {
        if (!state.match_id) return;
        await this.sql`
            INSERT INTO live_match_states (match_id, revision, state_version, state, checkpointed_at)
            VALUES (${state.match_id}, ${state.revision}, ${1}, ${JSON.stringify(state)}, NOW())
            ON CONFLICT (match_id) DO UPDATE SET
                revision = EXCLUDED.revision,
                state_version = EXCLUDED.state_version,
                state = EXCLUDED.state,
                checkpointed_at = NOW()
        `;
        await this.sql`
            UPDATE matches SET status = ${state.phase}, started_at = ${toDate(state.started_at)}
            WHERE id = ${state.match_id} AND status NOT IN ('completed', 'cancelled')
        `;
    }

    async finalize(state: AuthoritativeMatch) {
        if (!state.match_id || !state.finished_at) return;
        const players = Object.values(state.players);
        const winner = players.find((player) => player.user_id === state.winner_user_id) ?? null;
        const loser = state.winner_user_id ? players.find((player) => player.user_id !== state.winner_user_id) ?? null : null;
        const duration_ms = Math.max(0, state.finished_at - (state.started_at ?? state.finished_at));
        const final_status = state.phase === 'cancelled' ? 'cancelled' : 'completed';
        const participant_queries = players.map((player) => this.sql`
            INSERT INTO match_participants (
                match_id, user_id, outcome, wpm, accuracy, total_keystrokes,
                correct_keystrokes, final_position, final_hp
            ) VALUES (
                ${state.match_id}, ${player.user_id},
                ${final_status === 'cancelled' ? 'cancelled' : player.user_id === state.winner_user_id ? 'win' : 'loss'},
                ${player.wpm}, ${player.accuracy}, ${player.total_keystrokes},
                ${player.correct_keystrokes}, ${player.position}, ${player.hp}
            )
            ON CONFLICT (match_id, user_id) DO NOTHING
        `);
        await this.sql.transaction([
            this.sql`
                UPDATE matches SET status = ${final_status}, quote_id = ${state.quote?.id ?? null},
                    winner_id = ${winner?.user_id ?? null}, loser_id = ${loser?.user_id ?? null},
                    winner_wpm = ${winner?.wpm ?? null}, loser_wpm = ${loser?.wpm ?? null},
                    duration_ms = ${duration_ms}, started_at = ${toDate(state.started_at)},
                    finished_at = ${toDate(state.finished_at)}, finished_reason = ${state.finished_reason}, played_at = NOW()
                WHERE id = ${state.match_id} AND status NOT IN ('completed', 'cancelled')
            `,
            ...participant_queries,
            this.sql`
                UPDATE rooms SET status = ${final_status === 'cancelled' ? 'cancelled' : 'finished'}, finished_at = NOW()
                WHERE id = ${state.room_id}
            `,
            this.sql`DELETE FROM live_match_states WHERE match_id = ${state.match_id}`,
        ]);
    }

    async resetRoom(room_id: string) {
        await this.sql`
            UPDATE rooms SET status = ${'waiting'}, quote_id = NULL, started_at = NULL, finished_at = NULL
            WHERE id = ${room_id}
        `;
    }

    async health() {
        try {
            await this.sql`SELECT 1`;
            return true;
        } catch {
            return false;
        }
    }
}

function toQuote(row: Record<string, unknown>): BattleQuote {
    return {
        id: String(row.id),
        text: String(row.text),
        author: String(row.author ?? ''),
        difficulty: Number(row.difficulty),
        char_count: Number(row.char_count),
    };
}

function toDate(timestamp: number | null) {
    return timestamp === null ? null : new Date(timestamp).toISOString();
}
