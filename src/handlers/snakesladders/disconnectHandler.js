const { redis: redisClient } = require('../../utils/redis');
const {
  GAME_STATUS,
  REDIS_KEYS: SHARED_REDIS_KEYS
} = require('../../constants');
const { toISOString } = require('../../utils/dateUtils');
const { saveMatch, fetchMatch } = require('../../utils/redis');
const { processCommonDisconnect } = require('../common/baseHandlers');

const REDIS_KEYS = {
  MATCH: SHARED_REDIS_KEYS.SNAKES_MATCH,
  ACTIVE_GAMES: 'snakesladders_active_games'
};

function updateMatchForDisconnect(match, userId, reason) {
  const now = toISOString();
  
  const disconnectKey = match.user1_id === userId ? 'user1_disconnect_count' : 'user2_disconnect_count';
  match[disconnectKey] = (match[disconnectKey] || 0) + 1;
  
  const disconnectTimeKey = match.user1_id === userId ? 'user1_disconnect_time' : 'user2_disconnect_time';
  match[disconnectTimeKey] = now;
  
  match.disconnected_user_id = userId;
  match.disconnect_reason = reason;
  match.disconnect_timestamp = now;
  
  match.updated_at = now;
  
  return match;
}

async function saveDisconnectMatchState(gameId, match) {
  try {
    await saveMatch(redisClient, gameId, match, 'snakesladders');
    
    if (match.status === GAME_STATUS.COMPLETED) {
      await redisClient.srem(REDIS_KEYS.ACTIVE_GAMES, gameId);
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

async function notifyOpponentAboutDisconnect(io, match, disconnectedUserId, reason) {
  try {
    const opponentId = match.user1_id === disconnectedUserId ? match.user2_id : match.user1_id;
    
    const opponentSocket = Array.from(io.sockets.sockets.values())
      .find(s => s.user && s.user.user_id === opponentId);
    
    if (opponentSocket) {
      opponentSocket.emit('snakesladders_opponent_disconnected', {
        status: 'opponent_disconnected',
        message: 'Your opponent has disconnected',
        game_id: match.game_id,
        opponent_id: disconnectedUserId,
        reason: reason,
        match_status: match.status,
        timestamp: toISOString()
      });
    }
  } catch (error) {
  }
}

async function findActiveGamesForUser(userId) {
  try {
    const activeGames = await redisClient.smembers(REDIS_KEYS.ACTIVE_GAMES);
    if (!activeGames || activeGames.length === 0) return [];
    
    const matchPromises = activeGames.map(gameId => 
      fetchMatch(redisClient, gameId, 'snakesladders')
    );
    const matches = await Promise.all(matchPromises);
    
    const userGames = [];
    for (let i = 0; i < activeGames.length; i++) {
      const match = matches[i];
      if (match && (match.user1_id === userId || match.user2_id === userId)) {
        userGames.push({ gameId: activeGames[i], match });
      }
    }
    
    return userGames;
  } catch (error) {
    return [];
  }
}

async function handleDisconnectionForAllGames(io, userId, reason, socketId = null) {
  try {
    const activeGames = await findActiveGamesForUser(userId);
    
    for (const { gameId, match } of activeGames) {
      const updatedMatch = updateMatchForDisconnect(match, userId, reason);
      await saveDisconnectMatchState(gameId, updatedMatch);
      await notifyOpponentAboutDisconnect(io, updatedMatch, userId, reason);
    }
  } catch (error) {
  }
}

function registerDisconnectHandler(io, socket) {
  socket.on('disconnect', async (reason) => {
    try {
      const userId = socket.user?.user_id;
      if (userId) {
        await processCommonDisconnect(socket, userId, socket.id, {
          timerHandlerKeys: ['snakesLaddersTimerHandler'],
          cleanupUserToSocket: false
        });

        await handleDisconnectionForAllGames(io, userId, reason, socket.id);
      }
    } catch (error) {
    }
  });

}

module.exports = { 
  registerDisconnectHandler
};
