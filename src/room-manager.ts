import type WebSocket from 'ws';
import type { ConnectedRoomPlayer, ProtocolVersion, RoomPlayer, ServerMessage } from './types.js';

export interface ConnectedPlayer extends ConnectedRoomPlayer {
    socket: WebSocket;
}

interface JoinResult {
    ok: boolean;
    players?: RoomPlayer[];
    code?: 'ROOM_FULL' | 'PROTOCOL_MISMATCH';
    message?: string;
}

const MAX_PLAYERS = 2;

export class RoomManager {
    private rooms = new Map<string, Map<string, ConnectedPlayer>>();

    join(room_code: string, player: ConnectedPlayer): JoinResult {
        const room = this.rooms.get(room_code) ?? new Map<string, ConnectedPlayer>();
        const existing_player = room.get(player.user_id);

        const existing_protocol = room.values().next().value?.protocol_version as ProtocolVersion | undefined;
        if (existing_protocol && existing_protocol !== player.protocol_version) {
            return {
                ok: false,
                code: 'PROTOCOL_MISMATCH',
                message: 'Players in a battle must use the same game protocol.',
            };
        }

        if (!existing_player && room.size >= MAX_PLAYERS) {
            return {
                ok: false,
                code: 'ROOM_FULL',
                message: 'This battle already has two connected players.',
            };
        }

        if (existing_player && existing_player.socket !== player.socket) {
            existing_player.socket.close(4001, 'Reconnected from another session');
        }

        room.set(player.user_id, player);
        this.rooms.set(room_code, room);

        return {
            ok: true,
            players: this.getPlayers(room_code),
        };
    }

    leave(room_code: string, user_id: string, socket: WebSocket): boolean {
        const room = this.rooms.get(room_code);
        const player = room?.get(user_id);

        if (!room || !player || player.socket !== socket) return false;

        room.delete(user_id);
        if (room.size === 0) this.rooms.delete(room_code);
        return true;
    }

    broadcast(room_code: string, message: ServerMessage, except_user_id?: string): void {
        const encoded_message = JSON.stringify(message);

        this.rooms.get(room_code)?.forEach((player) => {
            if (player.user_id === except_user_id || player.socket.readyState !== player.socket.OPEN) return;
            player.socket.send(encoded_message);
        });
    }

    broadcastV2(room_code: string, message: ServerMessage): void {
        const encoded_message = JSON.stringify(message);
        this.rooms.get(room_code)?.forEach((player) => {
            if (player.protocol_version !== 2 || player.socket.readyState !== player.socket.OPEN) return;
            player.socket.send(encoded_message);
        });
    }

    getPlayers(room_code: string): RoomPlayer[] {
        return Array.from(this.rooms.get(room_code)?.values() ?? []).map(({ user_id, username }) => ({
            user_id,
            username,
        }));
    }

    getProtocolCount(protocol_version: ProtocolVersion): number {
        let count = 0;
        this.rooms.forEach((room) => room.forEach((player) => {
            if (player.protocol_version === protocol_version) count += 1;
        }));
        return count;
    }

    get room_count(): number {
        return this.rooms.size;
    }

    get connection_count(): number {
        let connection_count = 0;
        this.rooms.forEach((room) => {
            connection_count += room.size;
        });
        return connection_count;
    }
}
