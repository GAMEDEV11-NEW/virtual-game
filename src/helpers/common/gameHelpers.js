// ============================================================================
// DICE UTILITIES
// ============================================================================

// ============================================================================
// Generates a random integer between min and max inclusive
// ============================================================================
function randomIntInclusive(min, max) {
  const minCeil = Math.ceil(min);
  const maxFloor = Math.floor(max);
  return Math.floor(Math.random() * (maxFloor - minCeil + 1)) + minCeil;
}

// ============================================================================
// Generates a standard 6-sided dice roll (1-6)
// ============================================================================
function generateDiceRoll() {
  return randomIntInclusive(1, 6);
}

// ============================================================================
// OPPONENT SOCKET UTILITIES
// ============================================================================

const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { REDIS_KEYS, GAME_TYPES } = require('../../constants');

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  if (!na || !nb) return false;
  return na === nb;
}

// ============================================================================
// Finds the opponent's active socket ID with validation
// ============================================================================
async function findActiveOpponentSocketId(io, gameID, userID, gameType) {
  try {
    let matchKey;
    if (gameType === GAME_TYPES.TIC_TAC_TOE) {
      matchKey = REDIS_KEYS.TICTACTOE_MATCH(gameID);
    } else if (gameType === GAME_TYPES.SNAKES_LADDERS) {
      matchKey = REDIS_KEYS.SNAKES_MATCH(gameID);
    } else if (gameType === GAME_TYPES.WATER_SORT) {
      matchKey = REDIS_KEYS.WATERSORT_MATCH(gameID);
    } else {
      matchKey = REDIS_KEYS.MATCH(gameID);
    }
    const matchData = await redisClient.get(matchKey);

    if (!matchData) {
      return null;
    }

    const match = safeParseRedisData(matchData);
    if (!match) return null;

    let opponentUserID = null;
    if (sameId(match.user1_id, userID)) {
      opponentUserID = match.user2_id;
    } else if (sameId(match.user2_id, userID)) {
      opponentUserID = match.user1_id;
    }

    if (!opponentUserID) {
      return null;
    }

    try {
      const mappedSocketId = await redisClient.get(REDIS_KEYS.USER_TO_SOCKET(opponentUserID));
      if (mappedSocketId) {
        const mapped = io.sockets.sockets.get(mappedSocketId);
        if (mapped && mapped.connected) {
          return mappedSocketId;
        }
      }
    } catch (_) { }

    const allSockets = Array.from(io.sockets.sockets.values());

    const opponentSocket = allSockets.find(socket => {
      const hasUser = socket.user && socket.user.user_id;
      const isOpponent = hasUser && sameId(socket.user.user_id, opponentUserID);
      const isConnected = socket.connected;

      return isOpponent && isConnected;
    });

    if (opponentSocket && opponentSocket.id) {
      return opponentSocket.id;
    }

    try {
      const keys = await redisClient.keys(`${REDIS_KEYS.SOCKET_TO_USER('*')}`);
      for (const key of keys) {
        const mappedUserId = await redisClient.get(key);
        if (sameId(mappedUserId, opponentUserID)) {
          const socketId = key.replace('socket_to_user:', '');
          const socket = io.sockets.sockets.get(socketId);
          if (socket && socket.connected) {
            return socketId;
          }
        }
      }
    } catch (redisError) {
    }

    try {
      const gameRoom = `game_${gameID}`;
      const roomSockets = await io.in(gameRoom).fetchSockets();

      for (const socket of roomSockets) {
        if (socket.user && sameId(socket.user.user_id, opponentUserID)) {
          return socket.id;
        }
      }
    } catch (roomError) {
    }

    return null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  generateDiceRoll,
  findActiveOpponentSocketId
};
