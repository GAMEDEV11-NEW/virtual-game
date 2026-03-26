// ============================================================================
// Common socket handlers / shared helper utilities
// ============================================================================

const { redis: redisClient } = require('../../utils/redis');
const sessionService = require('../../utils/sessionService');
const { REDIS_KEYS, GAME_STATUS, GAME_END_REASONS } = require('../../constants');
const { toISOString } = require('../../utils/dateUtils');
const { timerRegistry } = require('../../utils/timer');
const { decryptUserData } = require('../../utils/jwt');
const { safeParseRedisData } = require('../../utils/gameUtils');

// ============================================================================
// Updates user session on disconnect
// ============================================================================
async function updateSessionOnDisconnect(userId, socketId = null) {
  try {
    const session = await sessionService.getSession(userId);
    if (!session) return false;

    if (socketId && session.socket_id && session.socket_id !== socketId) {
      return false;
    }

    session.socket_id = socketId ? '' : session.socket_id;
    session.last_seen = toISOString();
    await sessionService.createSession(session);
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Cleans up Redis socket-to-user and user-to-socket mappings
// ============================================================================
async function cleanupRedisMappings(socketId, userId = null) {
  try {
    const operations = [];
    
    if (socketId) {
      operations.push(redisClient.del(REDIS_KEYS.SOCKET_TO_USER(socketId)));
    }
    
    if (userId) {
      const currentMappedSocketId = await redisClient.get(REDIS_KEYS.USER_TO_SOCKET(userId));
      if (
        !currentMappedSocketId ||
        String(currentMappedSocketId).trim() === String(socketId || '').trim()
      ) {
        operations.push(redisClient.del(REDIS_KEYS.USER_TO_SOCKET(userId)));
      }
    }
    
    if (operations.length > 0) {
      await Promise.all(operations);
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Cleans up timer handlers from socket
// ============================================================================
function cleanupTimerHandlers(socket, timerHandlerKeys = ['timerHandler']) {
  try {
    if (socket && socket.id) {
      timerRegistry.unregisterTimersBySocket(socket.id);
    }
    
    const keys = Array.isArray(timerHandlerKeys) ? timerHandlerKeys : [timerHandlerKeys];
    
    for (const key of keys) {
      if (socket[key] && typeof socket[key].cleanup === 'function') {
        socket[key].cleanup();
      }
    }
  } catch (error) {
  }
}

// ============================================================================
// Gets user ID from socket object or Redis lookup
// ============================================================================
async function getUserIDFromSocket(socket) {
  try {
    let userId = socket.user?.user_id;

    if (!userId && socket.id) {
      const socketUserKey = await redisClient.get(REDIS_KEYS.SOCKET_TO_USER(socket.id));
      if (socketUserKey) {
        userId = socketUserKey;
      }
    }

    return userId;
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Common disconnect processing steps
// ============================================================================
async function processCommonDisconnect(socket, userId, socketId, options = {}) {
  const {
    timerHandlerKeys = ['timerHandler'],
    cleanupUserToSocket = false
  } = options;

  try {
    cleanupTimerHandlers(socket, timerHandlerKeys);

    await updateSessionOnDisconnect(userId, socketId);

    await cleanupRedisMappings(socketId, cleanupUserToSocket ? userId : null);

    return {
      success: true,
      userId,
      socketId
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      userId,
      socketId
    };
  }
}

// ============================================================================
// Extracts user data from request payload (supports both encrypted and legacy formats)
// ============================================================================
function extractUserData(data, options = {}) {
  const { errorEvent = 'timer_update_error' } = options;

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
          event: errorEvent
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
      event: errorEvent
    }
  };
}

// ============================================================================
// Fetches match data from Redis
// ============================================================================
async function fetchMatchData(gameId, gameType = 'ludo') {
  try {
    const { getMatchKey } = require('../../utils/redis');
    const matchKey = getMatchKey(gameId, gameType);
    const raw = await redisClient.get(matchKey);
    
    if (!raw) return null;
    
    return safeParseRedisData(raw);
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Fetches user chances from Redis
// ============================================================================
async function fetchUserChances(gameId, matchData, gameType = 'ludo') {
  try {
    if (!gameId || !matchData) {
      return { user1Chance: 0, user2Chance: 0 };
    }

    if ((gameType || '').toLowerCase() === 'ludo') {
      return {
        user1Chance: Number(matchData.user1_chance || 0),
        user2Chance: Number(matchData.user2_chance || 0),
      };
    }

    const { getUserChanceKey } = require('../../utils/redis');
    const chanceKey = getUserChanceKey(gameId, gameType);
    if (!chanceKey) {
      return { user1Chance: 0, user2Chance: 0 };
    }
    const chanceRaw = await redisClient.get(chanceKey);

    if (!chanceRaw) {
      return { user1Chance: 0, user2Chance: 0 };
    }

    const chances = safeParseRedisData(chanceRaw);
    return {
      user1Chance: chances[matchData.user1_id] || 0,
      user2Chance: chances[matchData.user2_id] || 0,
    };
  } catch (error) {
    return { user1Chance: 0, user2Chance: 0 };
  }
}

// ============================================================================
// Extracts scores from match data
// ============================================================================
function extractScoresFromMatchData(matchData) {
  try {
    let user1Score = 0;
    let user2Score = 0;

    if (matchData && typeof matchData === 'object') {
      if (typeof matchData.user1_score !== 'undefined') {
        user1Score = parseInt(matchData.user1_score) || 0;
      }
      if (typeof matchData.user2_score !== 'undefined') {
        user2Score = parseInt(matchData.user2_score) || 0;
      }
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
// Creates a timer interval manager
// ============================================================================
function createTimerInterval(socket, intervalCallback, intervalMs = 1000) {
  let timerInterval = null;

  const start = () => {
    if (timerInterval) return;
    
    timerInterval = setInterval(() => {
      if (!socket.connected) {
        stop();
        return;
      }
      intervalCallback();
    }, intervalMs);
  };

  const stop = () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };

  const cleanup = () => {
    stop();
  };

  return {
    start,
    stop,
    cleanup,
    isRunning: () => timerInterval !== null
  };
}

// ============================================================================
// Derives game status from match data
// ============================================================================
function deriveGameStatus(match, options = {}) {
  const { completedStatus = 'completed' } = options;

  if (match && typeof match.status === 'string' && match.status.length > 0) {
    return match.status;
  }

  if (match && (match.winner || match.game_end_reason)) {
    if (
      match.game_end_reason === 'player_quit' ||
      match.game_end_reason === 'opponent_quit'
    ) {
      return 'quit';
    }
    return completedStatus;
  }

  return 'active';
}

// ============================================================================
// Gets and validates game match from Redis
// ============================================================================
async function getAndValidateGameMatch(gameId, userId, socket, config) {
  const { getMatchKey, emitError, responseEvent } = config;
  
  try {
    const matchKey = getMatchKey(gameId);
    const matchRaw = await redisClient.get(matchKey);
    
    if (!matchRaw) {
      emitError(socket, {
        code: 'not_found',
        type: 'data',
        field: 'game_id',
        message: 'No active game found',
        event: responseEvent,
      });
      return null;
    }
    
    const match = safeParseRedisData(matchRaw);
    if (!match) {
      emitError(socket, {
        code: 'parse_error',
        type: 'data',
        field: 'game_id',
        message: 'Failed to parse game data',
        event: responseEvent,
      });
      return null;
    }
    
    if (match.user1_id !== userId && match.user2_id !== userId) {
      emitError(socket, {
        code: 'invalid_user',
        type: 'data',
        field: 'user_id',
        message: 'User not part of this game',
        event: responseEvent,
      });
      return null;
    }
    
    if (match.status === GAME_STATUS.COMPLETED || match.game_status === GAME_STATUS.COMPLETED) {
      emitError(socket, {
        code: 'game_already_completed',
        type: 'game',
        field: 'game_status',
        message: 'Game is already completed',
        event: responseEvent,
      });
      return null;
    }
    
    return match;
  } catch (error) {
    emitError(socket, {
      code: 'match_retrieval_error',
      type: 'database',
      field: 'match_data',
      message: 'Failed to retrieve game match',
      event: responseEvent,
    });
    return null;
  }
}

// ============================================================================
// Updates game state in Redis with quit information
// ============================================================================
async function updateGameStateInRedis(match, userId, opponentId, gameId, socket, config) {
  const { getMatchKey, emitError, responseEvent, applyQuitPenalty } = config;
  const now = toISOString();
  
  match.status = GAME_STATUS.COMPLETED;
  match.quit_by = userId;
  match.quit_at = now;
  match.updated_at = now;
  match.winner_id = opponentId;
  match.winner = opponentId;
  match.game_end_reason = GAME_END_REASONS.OPPONENT_QUIT;
  match.completed_at = now;
  
  if (match.user1_timer !== undefined) match.user1_timer = 0;
  if (match.user2_timer !== undefined) match.user2_timer = 0;
  
  if (applyQuitPenalty && typeof applyQuitPenalty === 'function') {
    match = applyQuitPenalty(match, userId);
  }
  
  try {
    const matchKey = getMatchKey(gameId);
    await redisClient.set(matchKey, JSON.stringify(match));
    return true;
  } catch (error) {
    emitError(socket, {
      code: 'redis_error',
      type: 'database',
      field: 'match_state',
      message: 'Failed to update game state',
      event: responseEvent,
    });
    return false;
  }
}

// ============================================================================
// Updates database records for the completed game
// ============================================================================
async function updateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket, config) {
  const { processWinnerDeclaration, emitError, responseEvent, postProcessWinnerDeclaration } = config;
  
  try {
    const winnerScore = (opponentId === match.user1_id) 
      ? (parseInt(match.user1_score) || 0) 
      : (parseInt(match.user2_score) || 0);
    const loserScore = (userId === match.user1_id) 
      ? (parseInt(match.user1_score) || 0) 
      : (parseInt(match.user2_score) || 0);
    
    let result;
    if (config.processWinnerDeclarationSignature === 'withGameDetails') {
      const gameDetails = config.getGameDetails ? config.getGameDetails(match) : {};
      result = await processWinnerDeclaration(
        gameId,
        opponentId,
        userId,
        contestId || 'default',
        'player_quit',
        gameDetails
      );
    } else {
      result = await processWinnerDeclaration(
        gameId,
        opponentId,
        userId,
        contestId,
        GAME_END_REASONS.OPPONENT_QUIT,
        winnerScore,
        loserScore,
        parseInt(match.user1_score) || 0,
        parseInt(match.user2_score) || 0
      );
    }
    
    if (postProcessWinnerDeclaration && typeof postProcessWinnerDeclaration === 'function') {
      await postProcessWinnerDeclaration(gameId, result, match);
    }
    
    if (!result || !result.success) {
      try {
        const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
        await updateMatchPairToCompleted(gameId);
      } catch (err) {
      }
    }
    
    return result && result.success !== false;
  } catch (error) {
    emitError(socket, {
      code: 'db_error',
      type: 'database',
      field: 'database_records',
      message: 'Failed to update database records',
      event: responseEvent,
    });
    return false;
  }
}

// ============================================================================
// Notifies opponent about the game quit
// ============================================================================
function notifyOpponent(io, opponentSocketId, gameData, config) {
  if (!opponentSocketId) return;
  
  const { notificationEvent, formatNotification } = config;
  const opponentSocket = io.sockets.sockets.get(opponentSocketId);
  
  if (opponentSocket) {
    const notification = formatNotification 
      ? formatNotification(gameData)
      : {
          status: 'game_won',
          game_id: gameData.gameId,
          contest_id: gameData.contestId,
          winner_id: gameData.opponentId,
          quit_by: gameData.userId,
          quit_at: gameData.quitAt,
          completed_at: gameData.quitAt,
          game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
          message: 'You won! Your opponent has quit the game'
        };
    
    opponentSocket.emit(notificationEvent, notification);
  }
}

// ============================================================================
// Sends success response to the user who quit
// ============================================================================
function sendQuitResponse(socket, gameData, config) {
  const { responseEvent, formatResponse } = config;
  
  if (!socket.connected) return;
  
  const response = formatResponse
    ? formatResponse(gameData)
    : {
        status: 'game_lost',
        game_id: gameData.gameId,
        contest_id: gameData.contestId,
        user_id: gameData.userId,
        winner_id: gameData.opponentId,
        quit_at: gameData.quitAt,
        completed_at: gameData.quitAt,
        game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
        message: 'Game quit successfully. Your opponent won the game.'
      };
  
  try {
    socket.emit(responseEvent, response);
  } catch (error) {
  }
}

// ============================================================================
// Stops timer updates for both users
// ============================================================================
function stopTimers(io, socket, opponentSocketId, gameId, opponentId, quitAt, config) {
  const { timerStopEvent } = config;
  
  try {
    const timerStopData = {
      status: 'game_completed',
      message: 'Opponent quit - timer updates stopped',
      game_id: gameId,
      game_status: 'completed',
      winner: opponentId,
      completed_at: quitAt,
    };
    
    if (opponentSocketId) {
      io.to(opponentSocketId).emit(timerStopEvent, timerStopData);
    }
    
    socket.emit(timerStopEvent, {
      ...timerStopData,
      message: 'You quit - timer updates stopped',
    });
  } catch (_) {
  }
}

// ============================================================================
// Cleans up Redis keys after game quit
// ============================================================================
async function cleanupRedisKeys(gameId, config) {
  const { cleanupRedisMatchData, getMatchKey, getUserChanceKey, getActiveGamesKey } = config;
  
  try {
    if (cleanupRedisMatchData && typeof cleanupRedisMatchData === 'function') {
      await cleanupRedisMatchData(gameId);
      return;
    }
    
    const operations = [];
    const matchKey = getMatchKey(gameId);
    operations.push(redisClient.del(matchKey));
    
    if (getUserChanceKey) {
      const chanceKey = getUserChanceKey(gameId);
      if (chanceKey) {
        operations.push(redisClient.del(chanceKey));
      }
    }
    
    if (getActiveGamesKey) {
      const activeGamesKey = getActiveGamesKey();
      operations.push(redisClient.srem(activeGamesKey, gameId));
    }
    
    await Promise.all(operations);
  } catch (_) {}
}

module.exports = {
  updateSessionOnDisconnect,
  cleanupRedisMappings,
  cleanupTimerHandlers,
  getUserIDFromSocket,
  processCommonDisconnect,
  extractUserData,
  fetchMatchData,
  fetchUserChances,
  extractScoresFromMatchData,
  createTimerInterval,
  deriveGameStatus,
  getAndValidateGameMatch,
  updateGameStateInRedis,
  updateDatabaseRecords,
  notifyOpponent,
  sendQuitResponse,
  stopTimers,
  cleanupRedisKeys
};
