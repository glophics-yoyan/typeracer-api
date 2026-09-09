import { createGameServer } from '../src/app.js';
import { getConfig } from '../src/config.js';

const game_server = createGameServer(getConfig(), { websocket_path: false });

export default game_server.http_server;
