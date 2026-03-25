const { redis: redisClient } = require('../../utils/redis');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { SOCKET_EVENT } = require('./enums');
const {
  GAME_STATUS,
  GAME_END_REASONS,
  REDIS_KEYS: SHARED_REDIS_KEYS
} = require('../../constants');
const { processCommonDisconnect } = require('../common/baseHandlers');

function registerDisconnectHandler(io, socket) {
  socket.on('disconnect', async () => {
    try {
      const userId = socket?.user?.user_id;
      if (userId) {
        await processCommonDisconnect(socket, userId, socket.id, {
          timerHandlerKeys: ['waterSortTimerHandler'],
          cleanupUserToSocket: false
        });
      }

      const gameId = socket?.currentWaterSortGameId;
      if (!gameId) return;
      
      const matchKey = SHARED_REDIS_KEYS.WATERSORT_MATCH(gameId);
      const raw = await redisClient.get(matchKey);
      if (!raw) return;
      
      const match = safeParseRedisData(raw);
      if (!match) return;
      if (match.status === GAME_STATUS.COMPLETED || match.game_status === GAME_STATUS.COMPLETED) return;

      const disconnectedUserId = socket?.user?.user_id;
      const opponentId = (disconnectedUserId && match.user1_id === disconnectedUserId) ? match.user2_id : match.user1_id;
      if (!opponentId) return;

      const now = new Date().toISOString();
      
      match.disconnected_user_id = disconnectedUserId;
      match.disconnect_reason = "socket_disconnected";
      match.disconnect_timestamp = now;
      match.updated_at = now;

      await redisClient.set(matchKey, JSON.stringify(match));

      try {
        const opponentSocketId = await findActiveOpponentSocketId(
          io,
          gameId,
          disconnectedUserId,
          'watersort'
        );

        if (opponentSocketId) {
          io.to(opponentSocketId).emit('watersort:opponent:disconnected', {
            status: 'opponent_disconnected',
            message: 'Your opponent has disconnected',
            game_id: gameId,
            opponent_id: disconnectedUserId,
            timestamp: now,
          });
        }
      } catch (_) {}

    } catch (_) {}
  });
}

module.exports = { registerDisconnectHandler };


