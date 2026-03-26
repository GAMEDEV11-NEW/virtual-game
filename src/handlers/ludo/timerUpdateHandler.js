const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { decryptUserData } = require('../../utils/jwt');
const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS: SHARED_REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { timerEventBus } = require('../../utils/timer');
const { createLudoTimerUpdatePayload } = require('../../utils/timerPayloads');

const TIMER_CONFIG = {
  MAX_TIMER_SECONDS: 15,
  UPDATE_INTERVAL_MS: 1000,
  GAME_FINISHED_DELAY_MS: 2000,
  DISCONNECT_DELAY_MS: 1000,
  GAME_DURATION_SECONDS: 300 
};

const REDIS_KEYS = {
  MATCH: SHARED_REDIS_KEYS.MATCH
};

// ============================================================================
// extractUserData
// ============================================================================
function extractUserData(data) {
  if (data?.user_data && data?.jwt_token) {
    try {
      const decrypted = decryptUserData(data.user_data, data.jwt_token);
      return {
        userId: decrypted.user_id,
        gameId: decrypted.game_id,
        isValid: true
      };
    } catch (err) {
      return {
        isValid: false,
        error: {
          code: 'decryption_error',
          type: 'decryption',
          message: 'Failed to decrypt user_data',
          event: 'timer_update_error'
        }
      };
    }
  }

  if (data?.game_id && data?.user_id) {
    return {
      userId: data.user_id,
      gameId: data.game_id,
      isValid: true
    };
  }

  return {
    isValid: false,
    error: {
      code: 'missing_field',
      type: 'validation',
      message: 'Missing game_id or user_id',
      event: 'timer_update_error'
    }
  };
}

// ============================================================================
// extractScoresFromMatchData
// ============================================================================
function extractScoresFromMatchData(matchData) {
  try {
    let user1Score = 0;
    let user2Score = 0;

    if (matchData.user1_score !== undefined) {
      user1Score = parseInt(matchData.user1_score) || 0;
    }
    if (matchData.user2_score !== undefined) {
      user2Score = parseInt(matchData.user2_score) || 0;
    }

    if (matchData.scores && typeof matchData.scores === 'object') {
      if (matchData.scores[matchData.user1_id] !== undefined) {
        user1Score = parseInt(matchData.scores[matchData.user1_id]) || 0;
      }
      if (matchData.scores[matchData.user2_id] !== undefined) {
        user2Score = parseInt(matchData.scores[matchData.user2_id]) || 0;
      }
    }

    if (matchData.user1_data && matchData.user1_data.score !== undefined) {
      user1Score = parseInt(matchData.user1_data.score) || 0;
    }
    if (matchData.user2_data && matchData.user2_data.score !== undefined) {
      user2Score = parseInt(matchData.user2_data.score) || 0;
    }

    return {
      user1_score: user1Score,
      user2_score: user2Score
    };
  } catch (error) {
    return {
      user1_score: 0,
      user2_score: 0
    };
  }
}

// ============================================================================
// determineGameStatus
// ============================================================================
function determineGameStatus(matchData) {
  if (matchData.status === GAME_STATUS.COMPLETED) {
    return 'completed';
  }
  if (matchData.status === 'quit') {
    return 'quit';
  }
  if (matchData.winner) {
    return 'won';
  }
  if (matchData.game_end_reason) {
    return 'ended';
  }
  return 'active';
}

// ============================================================================
// getGameStatistics
// ============================================================================
function getGameStatistics(matchData) {
  try {
    const stats = {
      user1_pieces_home: 0,
      user2_pieces_home: 0,
      user1_pieces_out: 0,
      user2_pieces_out: 0,
      user1_pieces_finished: 0,
      user2_pieces_finished: 0,
      total_turns: 0,
      game_duration: 0
    };

    if (matchData.user1_pieces && Array.isArray(matchData.user1_pieces)) {
      matchData.user1_pieces.forEach(piece => {
        if (piece.to_pos_last === 'initial') {
          stats.user1_pieces_home++;
        } else if (piece.to_pos_last === 'finished' || piece.to_pos_last === 'goal') {
          stats.user1_pieces_finished++;
        } else {
          stats.user1_pieces_out++;
        }
      });
    }

    if (matchData.user2_pieces && Array.isArray(matchData.user2_pieces)) {
      matchData.user2_pieces.forEach(piece => {
        if (piece.to_pos_last === 'initial') {
          stats.user2_pieces_home++;
        } else if (piece.to_pos_last === 'finished' || piece.to_pos_last === 'goal') {
          stats.user2_pieces_finished++;
        } else {
          stats.user2_pieces_out++;
        }
      });
    }

    if (matchData.created_at && matchData.updated_at) {
      const created = new Date(matchData.created_at);
      const updated = new Date(matchData.updated_at);
      stats.game_duration = Math.floor((updated - created) / 1000);
    }

    if (matchData.turn_count) {
      stats.total_turns = matchData.turn_count;
    }

    return stats;
  } catch (error) {
    return {
      user1_pieces_home: 0,
      user2_pieces_home: 0,
      user1_pieces_out: 0,
      user2_pieces_out: 0,
      user1_pieces_finished: 0,
      user2_pieces_finished: 0,
      total_turns: 0,
      game_duration: 0
    };
  }
}

// ============================================================================
// getUserRoleAndKeys
// ============================================================================
function getUserRoleAndKeys(matchData, userId) {
  const isUser1 = matchData.user1_id === userId;
  const isUser2 = matchData.user2_id === userId;

  if (!isUser1 && !isUser2) {
    return { isValid: false };
  }

  return {
    timeKey: isUser1 ? 'user1_time' : 'user2_time',
    connectionCountKey: isUser1 ? 'user1_connection_count' : 'user2_connection_count',
    isUser1,
    isValid: true
  };
}

// ============================================================================
// updateUserConnectionAndTime
// ============================================================================
async function updateUserConnectionAndTime(matchData, timeKey, connectionCountKey, matchKey) {
  try {
    const latestRaw = await redisClient.get(matchKey);
    let latestMatch;
    if (latestRaw) {
      latestMatch = safeParseRedisData(latestRaw);
    } else {
      latestMatch = matchData || {};
    }

    const currentConnectionCount = latestMatch[connectionCountKey] || 0;

    if (currentConnectionCount === 0) {
      const now = new Date().toISOString();
      latestMatch[timeKey] = now;
      latestMatch[connectionCountKey] = 1;
      if (!latestMatch.start_time) {
        latestMatch.start_time = now;
      }
      latestMatch.updated_at = now;

      await redisClient.set(matchKey, JSON.stringify(latestMatch));
      return true;
    }

    return false;
  } catch (err) {
    throw new Error(`Failed to update user connection: ${err.message}`);
  }
}

// ============================================================================
// calculateRemainingTime
// ============================================================================
function calculateRemainingTime(userTime, currentTime) {
  if (!userTime) return null;

  const lastActivityTime = new Date(userTime).getTime();
  if (isNaN(lastActivityTime)) return null;

  const elapsedSeconds = Math.floor((currentTime - lastActivityTime) / 1000);
  return Math.max(0, TIMER_CONFIG.MAX_TIMER_SECONDS - elapsedSeconds);
}

// ============================================================================
// calculateGameCountdown
// ============================================================================
function calculateGameCountdown(startTime, currentTime) {
  if (!startTime) return TIMER_CONFIG.GAME_DURATION_SECONDS;

  const gameStartTime = new Date(startTime).getTime();
  if (isNaN(gameStartTime)) return TIMER_CONFIG.GAME_DURATION_SECONDS;

  const elapsedSeconds = Math.floor((currentTime - gameStartTime) / 1000);
  const remainingSeconds = TIMER_CONFIG.GAME_DURATION_SECONDS - elapsedSeconds;

  return Math.max(0, remainingSeconds);
}

// ============================================================================
// fetchUserChances
// ============================================================================
async function fetchUserChances(gameId, matchData) {
  try {
    if (!matchData) {
      return { user1Chance: 0, user2Chance: 0 };
    }
    return {
      user1Chance: Number(matchData.user1_chance || 0),
      user2Chance: Number(matchData.user2_chance || 0)
    };
  } catch (err) {
    return { user1Chance: 0, user2Chance: 0 };
  }
}

// ============================================================================
// handleGameFinished
// ============================================================================
function handleGameFinished(socket, gameId, userId, cleanupCallback) {
  socket.emit('timer_update', {
    status: 'game_completed',
    message: 'Game has ended',
    game_id: gameId,
    user_id: userId
  });

  setTimeout(() => {
    socket.disconnect();
  }, TIMER_CONFIG.GAME_FINISHED_DELAY_MS);

  if (cleanupCallback) {
    cleanupCallback();
  }
}

// ============================================================================
// registerTimerUpdateHandler
// ============================================================================
module.exports = function registerTimerUpdateHandler(io, socket) {
  let currentGameId = null;
  let currentUserId = null;

// ============================================================================
// handleStartTimerUpdates
// ============================================================================
  async function handleStartTimerUpdates(data) {
    try {
      const userData = extractUserData(data);
      if (!userData.isValid) {
        emitError(socket, userData.error);
        return;
      }

      const { userId, gameId } = userData;

      if (!validateFields(socket, { game_id: gameId, user_id: userId }, ['game_id', 'user_id'], 'timer_update_error')) {
        return;
      }

      currentGameId = gameId;
      currentUserId = userId;

      const matchKey = REDIS_KEYS.MATCH(gameId);
      const matchRaw = await redisClient.get(matchKey);
      if (!matchRaw) {
        handleGameFinished(socket, gameId, userId, cleanupTimerInterval);
        return;
      }

      let matchData;
      try {
        
        matchData = safeParseRedisData(matchRaw);
        if (!matchData) {
          handleGameFinished(socket, gameId, userId, cleanupTimerInterval);
          return;
        }
      } catch (parseErr) {
        emitError(socket, {
          code: 'parse_error',
          type: 'data',
          message: 'Failed to parse match data',
          event: 'timer_update_error'
        });
        return;
      }

      if (matchData.status === GAME_STATUS.COMPLETED) {

        const startTimeField = matchData.start_time || matchData.created_at;
        const currentTime = Date.now();
        const countdownSeconds = calculateGameCountdown(startTimeField, currentTime);

        if (!startTimeField) {
          matchData.start_time = new Date().toISOString();
        }

        socket.emit('timer_started', {
          status: 'error',
          message: 'Cannot start timer updates - game is already completed',
          game_id: gameId,
          user_id: userId,
          game_status: 'completed',
          winner: matchData.winner,
          completed_at: matchData.completed_at,
          match_start_time: startTimeField, 
          elapsed_time_seconds: countdownSeconds, 
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userRole = getUserRoleAndKeys(matchData, userId);

      if (!userRole.isValid) {
        emitError(socket, {
          code: 'invalid_user',
          type: 'validation',
          message: 'User is not part of this match',
          event: 'timer_update_error'
        });
        return;
      }

      await updateUserConnectionAndTime(
        matchData,
        userRole.timeKey,
        userRole.connectionCountKey,
        matchKey
      );

      await redisClient.sadd('ludo_active_games', gameId);
      

      const socketId = socket.id;
      timerEventBus.emitTimerStart('ludo', gameId, socketId, userId);

      try {
        const currentTime = Date.now();
        const user1TimeSec = calculateRemainingTime(matchData.user1_time, currentTime);
        const user2TimeSec = calculateRemainingTime(matchData.user2_time, currentTime);
        const { user1Chance, user2Chance } = await fetchUserChances(gameId, matchData);
        const userScores = extractScoresFromMatchData(matchData);
        const gameStatus = determineGameStatus(matchData);
        const gameStats = getGameStatistics(matchData);
        
        const timerPayload = createLudoTimerUpdatePayload(
          matchData,
          user1TimeSec,
          user2TimeSec,
          user1Chance,
          user2Chance,
          userScores,
          gameStatus,
          gameStats
        );
        
        socket.emit('timer_update', timerPayload);
      } catch (err) {}

      const startTimeField = matchData.start_time || matchData.created_at;
      const currentTime = Date.now();
      const countdownSeconds = calculateGameCountdown(startTimeField, currentTime);

      if (!startTimeField) {
        matchData.start_time = new Date().toISOString();
      }

      socket.emit('timer_started', {
        status: 'success',
        message: 'Timer updates started successfully',
        game_id: gameId,
        user_id: userId,
        match_start_time: startTimeField, 
        elapsed_time_seconds: countdownSeconds, 
        timestamp: new Date().toISOString()
      });

    } catch (err) {
      emitError(socket, {
        code: 'handler_error',
        type: 'system',
        message: 'Failed to start timer updates: ' + err.message,
        event: 'timer_update_error'
      });
    }
  }

// ============================================================================
// handleStopTimerUpdates
// ============================================================================
  function handleStopTimerUpdates(data) {

    if (data && data.status === 'game_completed') {
    }

    if (currentGameId) {
      redisClient.srem('ludo_active_games', currentGameId).catch(() => {});
      timerEventBus.emitTimerStop('ludo', currentGameId, socket.id, currentUserId, data?.status || 'manual_stop');
    }

    cleanupTimerInterval();

    socket.emit('timer_stopped', {
      status: 'stopped',
      message: 'Timer updates stopped successfully',
      game_id: currentGameId,
      user_id: currentUserId,
      reason: data?.status || 'manual_stop',
      timestamp: new Date().toISOString()
    });
  }

  socket.on('start:timer_updates', handleStartTimerUpdates);
  socket.on('stop:timer_updates', handleStopTimerUpdates);

  socket.on('timer:updates', async (payload = {}) => {
    const action = (payload.action || '').toLowerCase();
    if (action === 'start') {
      await handleStartTimerUpdates(payload);
    } else if (action === 'stop') {
      handleStopTimerUpdates(payload);
    } else {
      emitError(socket, {
        code: 'invalid_action',
        type: 'validation',
        message: 'timer:updates requires action=start|stop',
        event: 'timer_update_error'
      });
    }
  });

// ============================================================================
// cleanupTimerInterval
// ============================================================================
  function cleanupTimerInterval() {
    currentGameId = null;
    currentUserId = null;
  }

// ============================================================================
// forceStopTimerForGame
// ============================================================================
  function forceStopTimerForGame(gameId, reason = 'external_stop') {
    if (currentGameId === gameId) {
      cleanupTimerInterval();

      socket.emit('timer_force_stopped', {
        status: 'force_stopped',
        message: `Timer force stopped: ${reason}`,
        game_id: gameId,
        user_id: currentUserId,
        reason: reason,
        timestamp: new Date().toISOString()
      });
    }
  }

  return {
    cleanup: cleanupTimerInterval,
    forceStopForGame: forceStopTimerForGame
  };
}; 
