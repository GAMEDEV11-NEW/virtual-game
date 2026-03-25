const { redis: redisClient } = require("../../utils/redis");
const withAuth = require("../../middleware/withAuth");
const { emitStandardError, safeParseRedisData } = require("../../utils/gameUtils");
const { findActiveOpponentSocketId } = require("../../helpers/common/gameHelpers");
const { SOCKET_EVENT } = require("./enums");
const {
  GAME_STATUS,
  GAME_END_REASONS,
  REDIS_KEYS: SHARED_REDIS_KEYS
} = require("../../constants");

const {
  getAndValidateGameMatch: baseGetAndValidateGameMatch,
  updateGameStateInRedis: baseUpdateGameStateInRedis,
  updateDatabaseRecords: baseUpdateDatabaseRecords,
  notifyOpponent: baseNotifyOpponent,
  sendQuitResponse: baseSendQuitResponse,
  stopTimers: baseStopTimers,
  cleanupRedisKeys: baseCleanupRedisKeys
} = require('../common/baseHandlers');

const gameConfig = {
  getMatchKey: (gameId) => SHARED_REDIS_KEYS.WATERSORT_MATCH(gameId),
  emitError: emitStandardError,
  responseEvent: SOCKET_EVENT.QUIT_GAME_RESPONSE,
  processWinnerDeclaration: null, // Will be set dynamically
  processWinnerDeclarationSignature: 'withGameDetails', // WaterSort uses different signature
  notificationEvent: 'watersort:opponent:quit',
  timerStopEvent: SOCKET_EVENT.STOP_TIMER_UPDATE,
  getGameDetails: (match) => {
    const now = new Date().toISOString();
    const winnerScore = match.user1_score || 0;
    const loserScore = match.user2_score || 0;
    return {
      winner_score: winnerScore,
      loser_score: loserScore,
      total_moves: match.moveHistory ? match.moveHistory.length : 0,
      game_duration: Math.floor(
        (new Date(now) - new Date(match.start_time || now)) / 1000
      ),
      level_no: match.level_no || 0,
      move_count: match.moveHistory ? match.moveHistory.length : 0,
    };
  },
  formatNotification: (gameData) => ({
    status: "success",
    game_id: gameData.gameId,
    winner: gameData.opponentId,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    timestamp: gameData.quitAt,
    completed_at: gameData.quitAt,
    updated_at: gameData.quitAt,
  }),
  formatResponse: (gameData) => ({
    status: "success",
    game_id: gameData.gameId,
    winner: gameData.opponentId,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    timestamp: gameData.quitAt,
    completed_at: gameData.quitAt,
    updated_at: gameData.quitAt,
    user1_time: gameData.user1_time,
    user2_time: gameData.user2_time,
  }),
  getUserChanceKey: (gameId) => SHARED_REDIS_KEYS.WATERSORT_USER_CHANCE(gameId)
};

async function registerQuitGameHandler(io, socket) {
  socket.on(SOCKET_EVENT.QUIT_GAME, async (event) => {
    try {
      await withAuth(
        socket,
        event,
        SOCKET_EVENT.QUIT_GAME_RESPONSE,
        async (user, data) => {
          const { user_id } = user || {};
          const { game_id } = data || {};

          if (!game_id) {
            emitStandardError(socket, {
              code: "invalid_request",
              type: "validation",
              field: "game_id",
              message: "Missing required field",
              event: SOCKET_EVENT.QUIT_GAME_RESPONSE,
            });
            return;
          }

          const match = await baseGetAndValidateGameMatch(game_id, user_id, socket, gameConfig);
          if (!match) return;

          const now = new Date().toISOString();
          const opponentId = match.user1_id === user_id ? match.user2_id : match.user1_id;

          const { processWinnerDeclaration } = require("../../services/watersort/windeclearService");
          gameConfig.processWinnerDeclaration = processWinnerDeclaration;

          const updateSuccess = await baseUpdateGameStateInRedis(match, user_id, opponentId, game_id, socket, gameConfig);
          if (!updateSuccess) return;

          const dbUpdateSuccess = await baseUpdateDatabaseRecords(game_id, opponentId, user_id, 'default', match, socket, gameConfig);
          if (!dbUpdateSuccess) {
            match.status = GAME_STATUS.COMPLETED;
            match.winner = opponentId;
            match.game_end_reason = GAME_END_REASONS.OPPONENT_QUIT;
            match.updated_at = now;
            match.completed_at = now;
            await redisClient.set(gameConfig.getMatchKey(game_id), JSON.stringify(match));
          }

          const gameData = {
            gameId: game_id,
            contestId: 'default',
            userId: user_id,
            opponentId: opponentId,
            quitAt: match.quit_at || now,
            user1_time: match.user1_time,
            user2_time: match.user2_time,
          };

          const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'watersort');
          baseNotifyOpponent(io, opponentSocketId, gameData, gameConfig);

          baseSendQuitResponse(socket, gameData, gameConfig);

          baseStopTimers(io, socket, opponentSocketId, game_id, opponentId, gameData.quitAt, gameConfig);

          await baseCleanupRedisKeys(game_id, gameConfig);
        }
      );
    } catch (err) {
      emitStandardError(socket, {
        code: "quit_error",
        type: "system",
        message: err.message,
        event: SOCKET_EVENT.QUIT_GAME_RESPONSE,
      });
    }
  });
}

module.exports = { registerQuitGameHandler };
