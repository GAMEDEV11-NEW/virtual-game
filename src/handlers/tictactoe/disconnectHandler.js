const { SOCKET_EVENT } = require("./enums");
const { redis: redisClient } = require("../../utils/redis");
const { safeParseRedisData } = require("../../utils/gameUtils");
const { REDIS_KEYS: SHARED_REDIS_KEYS } = require("../../constants");
const { toISOString } = require("../../utils/dateUtils");
const { processCommonDisconnect } = require('../common/baseHandlers');


async function handleDisconnectionForAllGames(io, userId, reason) {
  try {
    const activeGames = await redisClient.smembers("tictactoe_active_games");

    const pipeline = redisClient.pipeline();

    const socketMap = new Map();
    for (const [id, socket] of io.sockets.sockets) {
      if (socket.user?.user_id) {
        socketMap.set(socket.user.user_id, socket);
      }
    }

    const now = toISOString();
    const userGames = [];

    const matchKeys = activeGames.map((gameId) => SHARED_REDIS_KEYS.TICTACTOE_MATCH(gameId));
    const matches = await redisClient.mget(matchKeys);

    for (let i = 0; i < activeGames.length; i++) {
      const gameId = activeGames[i];
      const matchRaw = matches[i];

      if (matchRaw) {
        const match = safeParseRedisData(matchRaw);
        if (!match) continue;
        if (match.user1_id === userId || match.user2_id === userId) {
          const opponentId =
            match.user1_id === userId ? match.user2_id : match.user1_id;

          match.disconnected_user_id = userId;
          match.disconnect_reason = reason || "socket_disconnected";
          match.disconnect_timestamp = now;
          match.updated_at = now;

          const { getMatchKey } = require("../../utils/redis");
          pipeline.set(getMatchKey(gameId, 'tictactoe'), JSON.stringify(match));

          userGames.push({ gameId, opponentId });
        }
      }
    }

    await pipeline.exec();

    for (const { gameId, opponentId } of userGames) {
      const opponentSocket = socketMap.get(opponentId);
      if (opponentSocket) {
        opponentSocket.emit("tictactoe_opponent_disconnected", {
          status: "opponent_disconnected",
          message: "Your opponent has disconnected",
          game_id: gameId,
          opponent_id: userId,
          timestamp: now,
        });
      }
    }
  } catch (error) {
  }
}

function registerDisconnectHandler(io, socket) {
  socket.on(SOCKET_EVENT.DISCONNECT, async (reason) => {
    try {
      const userId = socket.user?.user_id;
      if (userId) {
        await processCommonDisconnect(socket, userId, socket.id, {
          timerHandlerKeys: ['ticTacToeTimerHandler'],
          cleanupUserToSocket: false
        });

        await handleDisconnectionForAllGames(io, userId, reason);
      }
    } catch (error) {
    }
  });
}

module.exports = { registerDisconnectHandler };
