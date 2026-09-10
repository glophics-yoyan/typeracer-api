export const V1_GAME_MESSAGE_TYPES = [
    'state',
    'keystroke',
    'ready',
    'start',
    'finish',
    'rematch',
    'signal',
] as const;

export type GameMessageType = (typeof V1_GAME_MESSAGE_TYPES)[number];
export type ProtocolVersion = 1 | 2;

export interface V1JoinMessage {
    type: 'join';
    room_code: string;
    user_id: string;
    username: string;
}

export interface V2JoinMessage {
    type: 'join';
    protocol_version: 2;
    join_token: string;
}

export interface GameMessage {
    type: GameMessageType;
    payload: unknown;
}

export interface ReadyMessage {
    type: 'ready';
    request_id: string;
}

export interface InputMessage {
    type: 'input';
    request_id: string;
    sequence: number;
    character: string;
    client_timestamp: number;
}

export interface RematchMessage {
    type: 'rematch';
    accepted: boolean;
}

export type ClientMessage = V1JoinMessage | V2JoinMessage | GameMessage | ReadyMessage | InputMessage | RematchMessage | { type: 'ping' };

export interface RoomPlayer {
    user_id: string;
    username: string;
}

export interface ConnectedRoomPlayer extends RoomPlayer {
    protocol_version: ProtocolVersion;
}

export interface ServerMessage {
    type: string;
    payload?: unknown;
    from_user_id?: string;
    code?: string;
    message?: string;
}

export type MatchPhase = 'waiting' | 'countdown' | 'active' | 'paused' | 'finished' | 'cancelled';

export interface BattleQuote {
    id: string;
    text: string;
    author: string;
    difficulty: number;
    char_count: number;
}

export interface AuthoritativePlayer extends RoomPlayer {
    hp: number;
    position: number;
    wpm: number;
    accuracy: number;
    is_ready: boolean;
    connected: boolean;
    total_keystrokes: number;
    correct_keystrokes: number;
    last_processed_sequence: number;
    input_window_started_at: number;
    input_window_count: number;
}

export interface AuthoritativeMatch {
    room_id: string;
    room_code: string;
    difficulty: number;
    match_id: string | null;
    phase: MatchPhase;
    quote: BattleQuote | null;
    players: Record<string, AuthoritativePlayer>;
    revision: number;
    countdown_ends_at: number | null;
    reconnect_deadline: number | null;
    paused_at: number | null;
    started_at: number | null;
    finished_at: number | null;
    winner_user_id: string | null;
    finished_reason: string | null;
    last_tick_at: number;
    rematch_votes: Record<string, boolean>;
    rematch_expires_at: number | null;
}

export interface RoomRecord {
    id: string;
    code: string;
    host_id: string;
    difficulty: number;
    status: string;
    players: RoomPlayer[];
}

export interface RoomTokenClaims {
    protocol_version: 2;
    room_code: string;
    user_id: string;
    username: string;
    role: 'host' | 'player';
    issued_at: number;
    expires_at: number;
}
