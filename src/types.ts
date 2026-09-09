export const GAME_MESSAGE_TYPES = [
    'state',
    'keystroke',
    'ready',
    'start',
    'finish',
    'rematch',
    'signal',
] as const;

export type GameMessageType = (typeof GAME_MESSAGE_TYPES)[number];

export interface JoinMessage {
    type: 'join';
    room_code: string;
    user_id: string;
    username: string;
}

export interface GameMessage {
    type: GameMessageType;
    payload: unknown;
}

export type ClientMessage = JoinMessage | GameMessage | { type: 'ping' };

export interface RoomPlayer {
    user_id: string;
    username: string;
}

export interface ServerMessage {
    type: string;
    payload?: unknown;
    from_user_id?: string;
    code?: string;
    message?: string;
}
