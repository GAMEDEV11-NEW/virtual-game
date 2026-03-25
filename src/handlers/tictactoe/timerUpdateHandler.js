const { redis: redisClient } = require("../../utils/redis");
const { SOCKET_EVENT } = require("./enums");
const emitError = require("../../utils/emitError");
const validateFields = require("../../utils/validateFields");
const { decryptUserData } = require("../../utils/jwt");
const { REDIS_KEYS: SHARED_REDIS_KEYS } = require("../../constants");
const {
  extractUserData: baseExtractUserData,
  fetchMatchData: baseFetchMatchData,
  fetchUserChances: baseFetchUserChances,
  deriveGameStatus: baseDeriveGameStatus
} = require('../common/baseHandlers');
const { timerEventBus } = require('../../utils/timer');
const { createTicTacToeTimerUpdatePayload } = require('../../utils/timerPayloads');

const TIMER_CONFIG = {
  MAX_TIMER_SECONDS: 60,
  GAME_DURATION_SECONDS: 300,
};

const REDIS_KEYS = {
  MATCH: SHARED_REDIS_KEYS.TICTACTOE_MATCH,
  USER_CHANCE: SHARED_REDIS_KEYS.TICTACTOE_USER_CHANCE,
};

function calculateRemainingTime(userTime, currentTime) {
  if (!userTime) {
    return TIMER_CONFIG.MAX_TIMER_SECONDS;
  }

  const lastActivityTime = new Date(userTime).getTime();
  if (isNaN(lastActivityTime)) {
    return TIMER_CONFIG.MAX_TIMER_SECONDS;
  }

  const elapsedSeconds = Math.floor((currentTime - lastActivityTime) / 1000);
  const remaining = Math.max(
    0,
    TIMER_CONFIG.MAX_TIMER_SECONDS - elapsedSeconds
  );
  return remaining;
}

const deriveGameStatus = (match) => baseDeriveGameStatus(match, { completedStatus: 'completed' });

const fetchUserChances = async (gameId, matchData) => {
  return await baseFetchUserChances(gameId, matchData, 'tictactoe');
};

function getTicTacToeGameStats(matchData) {
  try {
    const stats = {
      total_moves: 0,
      user1_moves: 0,
      user2_moves: 0,
      board_filled_positions: 0,
      game_duration: 0,
      moves_per_minute: 0,
    };

    if (matchData.moveHistory && Array.isArray(matchData.moveHistory)) {
      stats.total_moves = matchData.moveHistory.length;

      matchData.moveHistory.forEach((move) => {
        if (move.user_id === matchData.user1_id) {
          stats.user1_moves++;
        } else if (move.user_id === matchData.user2_id) {
          stats.user2_moves++;
        }
      });
    }

    if (matchData.board && Array.isArray(matchData.board)) {
      stats.board_filled_positions = matchData.board.filter(
        (cell) => cell !== null
      ).length;
    }

    if (matchData.created_at && matchData.updated_at) {
      const created = new Date(matchData.created_at);
      const updated = new Date(matchData.updated_at);
      stats.game_duration = Math.floor((updated - created) / 1000);

      if (stats.game_duration > 0) {
        stats.moves_per_minute = Math.round(
          (stats.total_moves / stats.game_duration) * 60
        );
      }
    }

    return stats;
  } catch (error) {
    return {
      total_moves: 0,
      user1_moves: 0,
      user2_moves: 0,
      board_filled_positions: 0,
      game_duration: 0,
      moves_per_minute: 0,
    };
  }
}


function extractUserData(data) {
  const baseResult = baseExtractUserData(data, { errorEvent: 'tictactoe_timer_update_error' });
  if (!baseResult.isValid) return baseResult;
  
  if (data.user_data && data.jwt_token) {
    try {
      const decrypted = decryptUserData(data.user_data, data.jwt_token);

      const gameId = decrypted.game_id;
      if (!gameId) {
        return {
          userId: null,
          gameId: null,
          isValid: false,
          error: {
            code: "missing_game_id",
            type: "validation",
            message: "game_id not found in decrypted user data",
            event: "tictactoe_timer_update_error",
          },
        };
      }

      return {
        userId: decrypted.user_id,
        gameId: gameId,
        isValid: true,
        error: null,
      };
    } catch (err) {
      return {
        userId: null,
        gameId: null,
        isValid: false,
        error: {
          code: "auth_failed",
          type: "authentication",
          message: "Failed to decrypt user data",
          event: "tictactoe_timer_update_error",
        },
      };
    }
  }

  return {
    userId: null,
    gameId: null,
    isValid: false,
    error: {
      code: "missing_auth",
      type: "authentication",
      message: "JWT authentication required - missing user_data and jwt_token",
      event: "tictactoe_timer_update_error",
    },
  };
}

module.exports = function registerTimerUpdateHandlerTicTacToe(io, socket) {
  let currentGameId = null;
  let currentUserId = null;

  socket.on(SOCKET_EVENT.START_TIMER_UPDATE, async (data) => {
    try {
      const userData = extractUserData(data);

      if (!userData.isValid) {
        emitError(socket, userData.error);
        return;
      }

      const { userId, gameId } = userData;

      if (
        !validateFields(
          socket,
          { user_data: data.user_data, jwt_token: data.jwt_token },
          ["user_data", "jwt_token"],
          "tictactoe_timer_update_error"
        )
      ) {
        return;
      }

      currentGameId = gameId;
      currentUserId = userId;

      const match = await baseFetchMatchData(gameId, 'tictactoe');
      if (!match) {
        socket.emit(SOCKET_EVENT.STOP_TIMER_UPDATE, {
          game_id: gameId,
          error: "Game not found in Redis",
          status: "completed",
          timestamp: new Date().toISOString(),
        });
        return;
      }


      await redisClient.sadd('tictactoe_active_games', gameId);
      

      const socketId = socket.id;
      timerEventBus.emitTimerStart('tictactoe', gameId, socketId, userId);


      try {
        const currentTime = Date.now();
        
        if (!match.user1_time) match.user1_time = new Date().toISOString();
        if (!match.user2_time) match.user2_time = new Date().toISOString();
        
        const user1TimeSec = calculateRemainingTime(match.user1_time, currentTime);
        const user2TimeSec = calculateRemainingTime(match.user2_time, currentTime);
        const { user1Chance, user2Chance } = await fetchUserChances(gameId, match);
        const gameStats = getTicTacToeGameStats(match);
        const gameStatus = deriveGameStatus(match);
        
        const timerPayload = createTicTacToeTimerUpdatePayload(
          match,
          user1TimeSec,
          user2TimeSec,
          user1Chance,
          user2Chance,
          gameStats,
          gameStatus
        );
        
        socket.emit(SOCKET_EVENT.TIMER_UPDATE, timerPayload);
      } catch (err) {
      }
    } catch (err) {
      emitError(socket, {
        code: "timer_start_error",
        type: "system",
        message: "Failed to start timer updates: " + err.message,
        event: "tictactoe_timer_update_error",
      });
    }
  });

  function handleStopTimerUpdates() {
    if (currentGameId) {
      redisClient.srem('tictactoe_active_games', currentGameId).catch(() => {});
      timerEventBus.emitTimerStop('tictactoe', currentGameId, socket.id, currentUserId, 'manual_stop');
    }

    cleanupTimerInterval();
  }

  socket.on(SOCKET_EVENT.STOP_TIMER_UPDATE, handleStopTimerUpdates);

  
  function cleanupTimerInterval() {
    currentGameId = null;
    currentUserId = null;
  }

  return {
    cleanup: cleanupTimerInterval,
  };
};
