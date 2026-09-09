import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../src/app.js';

let game_server: GameServer;
let websocket_url = '';

before(async () => {
    game_server = createGameServer({ port: 0, allowed_origins: ['*'] });
    await new Promise<void>((resolve) => game_server.http_server.listen(0, resolve));
    const address = game_server.http_server.address() as AddressInfo;
    websocket_url = `ws://127.0.0.1:${address.port}/ws`;
});

after(async () => {
    await game_server.close();
});

function waitForMessage(socket: WebSocket, expected_type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected_type}`)), 2000);

        function handleMessage(data: WebSocket.RawData): void {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
            if (message.type !== expected_type) return;

            clearTimeout(timeout);
            socket.off('message', handleMessage);
            resolve(message);
        }

        socket.on('message', handleMessage);
    });
}

async function connectPlayer(room_code: string, user_id: string, username: string): Promise<WebSocket> {
    const socket = new WebSocket(websocket_url);
    const connected_message = waitForMessage(socket, 'connected');
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    await connected_message;
    socket.send(JSON.stringify({ type: 'join', room_code, user_id, username }));
    await waitForMessage(socket, 'room-state');
    return socket;
}

test('relays game messages to the opponent', async () => {
    const player_one = await connectPlayer('ABC234', 'player-1', 'Alpha');
    const opponent_joined = waitForMessage(player_one, 'opponent-joined');
    const player_two = await connectPlayer('ABC234', 'player-2', 'Bravo');
    await opponent_joined;

    const ready_message = waitForMessage(player_one, 'ready');
    player_two.send(JSON.stringify({ type: 'ready', payload: { isReady: true } }));

    assert.deepEqual(await ready_message, {
        type: 'ready',
        payload: { isReady: true },
        from_user_id: 'player-2',
    });

    player_one.close();
    player_two.close();
});

test('rejects a third player in the same room', async () => {
    const player_one = await connectPlayer('XYZ789', 'full-player-1', 'Alpha');
    const player_two = await connectPlayer('XYZ789', 'full-player-2', 'Bravo');
    const player_three = new WebSocket(websocket_url);
    const connected_message = waitForMessage(player_three, 'connected');

    await new Promise<void>((resolve, reject) => {
        player_three.once('open', resolve);
        player_three.once('error', reject);
    });
    await connected_message;
    player_three.send(JSON.stringify({
        type: 'join',
        room_code: 'XYZ789',
        user_id: 'full-player-3',
        username: 'Charlie',
    }));

    const error_message = await waitForMessage(player_three, 'error');
    assert.equal(error_message.code, 'ROOM_FULL');

    player_one.close();
    player_two.close();
    player_three.close();
});

test('replaces a stale connection without removing the reconnected player', async () => {
    const first_connection = await connectPlayer('REC234', 'same-player', 'Alpha');
    const opponent = await connectPlayer('REC234', 'opponent', 'Bravo');
    const replacement = await connectPlayer('REC234', 'same-player', 'Alpha');

    await new Promise<void>((resolve) => first_connection.once('close', () => resolve()));
    assert.equal(game_server.room_manager.connection_count, 2);

    replacement.close();
    opponent.close();
});
