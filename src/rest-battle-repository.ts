import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { NeonBattleRepository } from './battle-repository.js';
import type { AuthoritativeMatch, BattleQuote, RoomRecord } from './types.js';

export interface StoredBattleState {
    revision: number;
    state: AuthoritativeMatch;
}

export interface RestBattleRepository {
    getRoom(room_code: string): Promise<RoomRecord | null>;
    getState(room_id: string): Promise<StoredBattleState | null>;
    insertState(state: AuthoritativeMatch): Promise<boolean>;
    updateState(state: AuthoritativeMatch, expected_revision: number): Promise<boolean>;
    createMatch(room: RoomRecord): Promise<{ match_id: string; quote: BattleQuote }>;
    getOpenMatch(room_id: string): Promise<{ match_id: string; quote: BattleQuote } | null>;
    finalize(state: AuthoritativeMatch): Promise<void>;
    resetRoom(room_id: string): Promise<void>;
    health(): Promise<boolean>;
}

export class NeonRestBattleRepository implements RestBattleRepository {
    private sql: NeonQueryFunction<false, false>;
    private battle_repository: NeonBattleRepository;

    constructor(database_url: string) {
        this.sql = neon(database_url);
        this.battle_repository = new NeonBattleRepository(database_url);
    }

    getRoom(room_code: string) {
        return this.battle_repository.getRoom(room_code);
    }

    async getState(room_id: string) {
        const rows = await this.sql`
            SELECT revision, state
            FROM room_battle_states
            WHERE room_id = ${room_id}
        `;
        if (!rows[0]) return null;
        return {
            revision: Number(rows[0].revision),
            state: rows[0].state as AuthoritativeMatch,
        };
    }

    async insertState(state: AuthoritativeMatch) {
        const rows = await this.sql`
            INSERT INTO room_battle_states (room_id, match_id, revision, state_version, state, updated_at)
            VALUES (${state.room_id}, ${state.match_id}, ${state.revision}, ${2}, ${JSON.stringify(state)}, NOW())
            ON CONFLICT (room_id) DO NOTHING
            RETURNING room_id
        `;
        return rows.length === 1;
    }

    async updateState(state: AuthoritativeMatch, expected_revision: number) {
        const rows = await this.sql`
            UPDATE room_battle_states
            SET match_id = ${state.match_id}, revision = ${state.revision}, state_version = ${2},
                state = ${JSON.stringify(state)}, updated_at = NOW()
            WHERE room_id = ${state.room_id} AND revision = ${expected_revision}
            RETURNING room_id
        `;
        return rows.length === 1;
    }

    createMatch(room: RoomRecord) {
        return this.battle_repository.createMatch(room);
    }

    async getOpenMatch(room_id: string) {
        const rows = await this.sql`
            SELECT m.id AS match_id, q.id, q.text, q.author, q.difficulty, q.char_count
            FROM matches m
            JOIN quotes q ON q.id = m.quote_id
            WHERE m.room_id = ${room_id} AND m.status IN ('countdown', 'active', 'paused')
            ORDER BY m.played_at DESC
            LIMIT 1
        `;
        if (!rows[0]) return null;
        const row = rows[0];
        return {
            match_id: String(row.match_id),
            quote: {
                id: String(row.id),
                text: String(row.text),
                author: String(row.author ?? ''),
                difficulty: Number(row.difficulty),
                char_count: Number(row.char_count),
            },
        };
    }

    finalize(state: AuthoritativeMatch) {
        return this.battle_repository.finalize(state);
    }

    resetRoom(room_id: string) {
        return this.battle_repository.resetRoom(room_id);
    }

    health() {
        return this.battle_repository.health();
    }
}
