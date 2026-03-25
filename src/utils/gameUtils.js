const emitError = require('./emitError');
const validateFields = require('./validateFields');
const { REDIS_KEYS } = require('../constants');
const { safeParseRedisData } = require('./redis');

// ============================================================================
// Fetches match from Redis or emits error if not found
// ============================================================================
async function fetchMatchOrEmitError(socket, gameID, redisClient, eventName) {
  const matchKey = REDIS_KEYS.MATCH(gameID);
  const matchRaw = await redisClient.get(matchKey);
  if (!matchRaw) {
    emitError(socket, {
      code: 'not_found',
      type: 'data',
      field: 'game_id',
      message: 'No match found',
      event: eventName,
    });
    return null;
  }
  return safeParseRedisData(matchRaw);
}

// ============================================================================
// Validates required fields (backward compatibility wrapper)
// ============================================================================
const validateRequiredFields = (socket, data, required, eventName) =>
  validateFields(socket, data, required, eventName);

// ============================================================================
// Emits a standardized error to the client
// ============================================================================
function emitStandardError(socket, errorConfig, eventName) {
  emitError(socket, {
    code: errorConfig.code,
    type: errorConfig.type,
    field: errorConfig.field,
    message: errorConfig.message,
    event: errorConfig.event || eventName,
    status: errorConfig.status,
  });
}

// ============================================================================
// Saves the match state to Redis using atomic read-modify-write to prevent race conditions
// ============================================================================
async function saveMatchState(redisClient, gameID, match, gameType = 'ludo') {
  const { atomicReadModifyWrite, getMatchKey } = require('./redis');
  const { REDIS_TTL } = require('../constants');
  
  const matchKey = getMatchKey(gameID, gameType);
  const ttlSeconds = REDIS_TTL.MATCH_SECONDS;
  
  // Use atomic read-modify-write to prevent race conditions
  const result = await atomicReadModifyWrite(
    redisClient,
    matchKey,
    async (current) => {
      // Merge current state with new state, preserving important fields
      if (current) {
        return {
          ...current,
          ...match,
          // Preserve critical fields that might be updated concurrently
          updated_at: new Date().toISOString(),
          // Preserve pieces if they exist in current but not in match
          user1_pieces: match.user1_pieces || current.user1_pieces,
          user2_pieces: match.user2_pieces || current.user2_pieces,
        };
      }
      return {
        ...match,
        updated_at: new Date().toISOString()
      };
    },
    ttlSeconds,
    3 // maxRetries
  );
  
  if (!result.success) {
    // Fallback to simple save if atomic operation fails
    const { saveMatch } = require('./redis');
    await saveMatch(redisClient, gameID, match, gameType);
  }
  
  return result.success ? result.value : match;
}

// ============================================================================
// Saves only selected fields into the match state (merge with latest Redis value)
// ============================================================================
async function saveMatchFields(redisClient, gameID, partialUpdate, gameType = 'ludo') {
  const { updateMatchFields } = require('./redis');
  return await updateMatchFields(redisClient, gameID, partialUpdate, gameType);
}

// ============================================================================
// Notifies opponent about an event using multiple fallback methods
// ============================================================================
async function notifyOpponent(io, gameID, userID, opponentID, eventName, payload, broadcastFn = null) {
  let notificationSent = false;
  if (typeof broadcastFn === 'function') {
    try {
      const broadcastSuccess = await broadcastFn(io, gameID, userID, payload);
      if (broadcastSuccess) {
        notificationSent = true;
      }
    } catch (broadcastError) {}
  }
  if (!notificationSent) {
    try {
      const opponentSocket = io.sockets.sockets.get(opponentID);
      if (opponentSocket) {
        opponentSocket.emit(eventName, payload);
        notificationSent = true;
      }
    } catch (directError) {}
  }
  if (!notificationSent) {
    try {
      const roomName = `game:${gameID}`;
      io.to(roomName).emit(eventName, payload);
      notificationSent = true;
    } catch (roomError) {}
  }
  return notificationSent;
}

const { getUserPiecesCurrentState } = require('../services/ludo/gameService');
const { GAME_STATUS } = require('../constants');

const HOME_POSITION = 57;

// ============================================================================
// Checks if a player has won the game (all pieces reached home)
// ============================================================================
async function checkForGameWin(gameID, userID, match) {
  try {
    let pieces = [];
    
    const isUser1 = userID === match.user1_id;
    pieces = isUser1 ? (match.user1_pieces || []) : (match.user2_pieces || []);
    
    if (!pieces || pieces.length === 0) {
      pieces = await getUserPiecesCurrentState(gameID, userID);
    }
    
    if (!pieces || pieces.length === 0) {
      return false;
    }
    
    const allPiecesReachedHome = pieces.every(piece => {
      const currentPos = piece.to_pos_last;
      const isHome = currentPos === 'home' || 
                     currentPos === HOME_POSITION || 
                     currentPos === String(HOME_POSITION) ||
                     String(currentPos) === String(HOME_POSITION);
      return isHome;
    });
    
    return allPiecesReachedHome;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Checks if a game is already completed
// ============================================================================
function isGameCompleted(match) {
  return match.status === GAME_STATUS.COMPLETED && match.winner;
}

// ============================================================================
// Gets the winner information from a completed match
// ============================================================================
function getWinnerInfo(match) {
  if (!isGameCompleted(match)) {
    return null;
  }
  
  return {
    winner_id: match.winner,
    completed_at: match.completed_at,
    game_end_reason: match.game_end_reason || 'all_pieces_home'
  };
}

// ============================================================================
// Creates a game completion payload
// ============================================================================
function createGameCompletionPayload(gameID, winnerID, reason = 'all_pieces_home') {
  const now = new Date().toISOString();
  
  const payload = {
    status: GAME_STATUS.COMPLETED,
    winner: winnerID,
    game_id: gameID,
    completed_at: now,
    game_end_reason: reason,
    timestamp: now
  };
  
  return payload;
}

module.exports = {
  fetchMatchOrEmitError,
  validateRequiredFields,
  emitStandardError,
  saveMatchState,
  saveMatchFields,
  notifyOpponent,
  safeParseRedisData,
  checkForGameWin,
  isGameCompleted,
  getWinnerInfo,
  createGameCompletionPayload
};
