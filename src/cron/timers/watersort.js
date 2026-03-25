const { tryDeclareWinner, isWinnerDeclared } = require('../services/winnerService');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { safeParseRedisData, saveMatch } = require('../../utils/redis');
const { getCurrentDate, getTimeDifferenceSeconds } = require('../../utils/dateUtils');
const { isMatchCompleted } = require('../../utils/matchUtils');
const { createWatersortTimerUpdatePayload, calculateRemainingTime, getGameStats } = require('../../utils/timerPayloads');
const { deriveGameStatus: baseDeriveGameStatus } = require('../../handlers/common/baseHandlers');
const { buildSocketEmitterAdapter } = require('../../utils/socketRelay');

let matchmakingService = null;
let redisClientPromise = null;
let socketIOInstance = null;
let watersortTimerIntervalId = null;

function setSocketIO(io) {
  socketIOInstance = io || buildSocketEmitterAdapter();
}

async function getRedisClient() {
  if (!redisClientPromise) {
    const { createSimpleRedisClient } = require('../../utils/redis');
    const client = createSimpleRedisClient();
    await new Promise((resolve, reject) => {
      if (client.status === 'ready') {
        resolve();
      } else {
        client.once('ready', resolve);
        client.once('error', reject);
      }
    });
    redisClientPromise = Promise.resolve(client);
  }
  return redisClientPromise;
}

function setMatchmakingService(service) {
  matchmakingService = service;
}

function deriveGameStatus(match) {
  return baseDeriveGameStatus(match, { completedStatus: GAME_STATUS.COMPLETED });
}

// ============================================================================
// Timer Management Functions
// ============================================================================

function startWaterSortUserTimerCron(intervalMs) {
  if (watersortTimerIntervalId) {
    clearInterval(watersortTimerIntervalId);
    watersortTimerIntervalId = null;
  }
  
  processWaterSortUserTimers().catch(() => {});
  
  watersortTimerIntervalId = setInterval(() => {
    processWaterSortUserTimers().catch(() => {});
  }, intervalMs);
  
  return watersortTimerIntervalId;
}

function stopWaterSortUserTimerCron() {
  if (watersortTimerIntervalId) {
    clearInterval(watersortTimerIntervalId);
    watersortTimerIntervalId = null;
  }
}

// ============================================================================
// Main Processing Function
// ============================================================================

async function processWaterSortUserTimers() {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      return;
    }
    
    // Get all active Water Sort games from Redis
    const activeGames = await redis.smembers('watersort_active_games');
    if (!activeGames || activeGames.length === 0) {
      return;
    }
    
    const now = getCurrentDate();
    
    const { processInParallel } = require('../../utils/parallelUtils');
    
    await processInParallel(activeGames, async (gameId) => {
      try {
        const matchKey = REDIS_KEYS.WATERSORT_MATCH(gameId);
        const matchData = await redis.get(matchKey);
        if (!matchData) {
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        const parsedMatch = safeParseRedisData(matchData);
        if (!parsedMatch) {
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        const user1Id = parsedMatch.user1_id;
        const user2Id = parsedMatch.user2_id;
        if (!gameId || !user1Id || !user2Id) {
          return;
        }
        
        if (isMatchCompleted(parsedMatch)) {
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        if (await isWinnerDeclared(gameId)) {
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        // IMPORTANT: Check time expiration BEFORE checking if both players disconnected
        // This ensures games complete after 5 minutes even if both players disconnected
        const startTime = parsedMatch.start_time ? new Date(parsedMatch.start_time) : null;
        if (startTime) {
          const timeDiffSeconds = getTimeDifferenceSeconds(startTime, now);
          if (timeDiffSeconds >= 300) {
            // 5 minutes elapsed - complete game based on scores
            const user1Score = Number(parsedMatch.user1_score || 0);
            const user2Score = Number(parsedMatch.user2_score || 0);
            const winner = user1Score >= user2Score ? user1Id : user2Id;
            const contestId = parsedMatch.contest_id || parsedMatch.contest_type || '';
            
            parsedMatch.status = GAME_STATUS.COMPLETED;
            parsedMatch.winner = winner;
            parsedMatch.game_end_reason = 'time_expired';
            parsedMatch.completed_at = now.toISOString();
            parsedMatch.updated_at = now.toISOString();
            
            await saveMatch(redis, gameId, parsedMatch, 'watersort');
            
            try {
              await tryDeclareWinner(gameId, async () => {
                await declareWaterSortWinner(gameId, winner, parsedMatch.league_id || '', contestId, 'time_expired', parsedMatch);
              });
            } catch (err) {
            }
            
            // Get socket IDs to notify players (if any are connected)
            const user1SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user1Id));
            const user2SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user2Id));
            const usersToUpdate = [];
            if (user1SocketId) {
              usersToUpdate.push({ userId: user1Id, socketId: user1SocketId });
            }
            if (user2SocketId) {
              usersToUpdate.push({ userId: user2Id, socketId: user2SocketId });
            }
            
            // Try to notify connected players (if any)
            await Promise.all(
              usersToUpdate.map(user => 
                sendTimerUpdateToSockets(gameId, parsedMatch, user, redis).catch(err => {
                })
              )
            );
            
            await completeWaterSortGame(gameId, matchKey, redis, parsedMatch);
            
            await redis.srem('watersort_active_games', gameId);
            return;
          }
        }
        
        // Get socket IDs from Redis using userId
        const user1SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user1Id));
        const user2SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user2Id));
        
        // Prepare users to send updates to
        const usersToUpdate = [];
        if (user1SocketId) {
          usersToUpdate.push({ userId: user1Id, socketId: user1SocketId });
        }
        if (user2SocketId) {
          usersToUpdate.push({ userId: user2Id, socketId: user2SocketId });
        }
        
        if (usersToUpdate.length === 0) {
          // If no active sockets found for either user (both disconnected)
          // Keep game in active_games set so time expiration check can complete it
          // The time expiration check above (before this check) will handle completion after 5 minutes
          // Don't remove from active_games - let cron continue checking until time expires
          return;
        }

        const timeoutResult1 = await checkWaterSortTimeout(redis, gameId, user1Id, parsedMatch.user1_time, user2Id, parsedMatch, now);
        if (timeoutResult1 && timeoutResult1.completed) {
          await Promise.all(
            usersToUpdate.map(user => 
              sendTimerUpdateToSockets(gameId, timeoutResult1.completedMatchData || parsedMatch, user, redis).catch(err => {
              })
            )
          );
          await completeWaterSortGame(gameId, matchKey, redis, timeoutResult1.completedMatchData || parsedMatch);
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        const timeoutResult2 = await checkWaterSortTimeout(redis, gameId, user2Id, parsedMatch.user2_time, user1Id, parsedMatch, now);
        if (timeoutResult2 && timeoutResult2.completed) {
          await Promise.all(
            usersToUpdate.map(user => 
              sendTimerUpdateToSockets(gameId, timeoutResult2.completedMatchData || parsedMatch, user, redis).catch(err => {
              })
            )
          );
          await completeWaterSortGame(gameId, matchKey, redis, timeoutResult2.completedMatchData || parsedMatch);
          await redis.srem('watersort_active_games', gameId);
          return;
        }
        
        const latestMatchData = await redis.get(matchKey);
        const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
        
        await Promise.all(
          usersToUpdate.map(user => 
            sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user, redis).catch(err => {
            })
          )
        );
        
      } catch (err) {
      }
    }, 5);
  } catch (err) {
    throw err;
  }
}

// ============================================================================
// Socket Communication Functions
// ============================================================================

async function sendTimerUpdateToSockets(gameId, matchData, user, redis) {
  if (!socketIOInstance) {
    return;
  }
  
  try {
    const { socketId, userId } = user;
    
    if (!socketId) {
      return;
    }
    
    if (!socketIOInstance.sockets.sockets.has(socketId)) {
      return;
    }
    
    const socket = socketIOInstance.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }
    
    const isGameCompleted = matchData.status === GAME_STATUS.COMPLETED ||
      matchData.status === 'quit' ||
      matchData.winner ||
      matchData.game_end_reason;

    if (isGameCompleted) {
      if (!socket.connected) {
        return;
      }
      
      try {
        if (!socket.connected) {
          throw new Error('Socket disconnected before emit');
        }
        socket.emit('stop:timer_updates_watersort', {
          status: 'game_completed',
          message: 'Game completed - timer updates stopped',
          game_id: gameId,
          game_status: GAME_STATUS.COMPLETED,
          winner: matchData.winner,
          completed_at: matchData.completed_at || matchData.updated_at,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return;
      }
      
      try {
        if (!socket.connected) {
          throw new Error('Socket disconnected before emit');
        }
        socket.emit('timer_stopped', {
          status: 'stopped',
          message: 'Timer updates stopped successfully',
          game_id: gameId,
          reason: 'game_completed',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return;
      }
      
      const gameStats = getGameStats(matchData);
      const gameStatus = 'completed';

      const completionPayload = createWatersortTimerUpdatePayload(
        matchData,
        null,
        null,
        0,
        0,
        gameStats,
        gameStatus
      );

      completionPayload.status = 'completed';
      completionPayload.message = 'Game completed - timer updates stopped';

      try {
        if (!socket.connected) {
          throw new Error('Socket disconnected before emit');
        }
        socket.emit('watersort_timer_update', completionPayload);
      } catch (err) {
        return;
      }
      
      return;
    }
    
    const currentTime = Date.now();
    
    let user1TimeSec = calculateRemainingTime(matchData.user1_start_time, currentTime);
    let user2TimeSec = calculateRemainingTime(matchData.user2_start_time, currentTime);
    
    const chanceKey = REDIS_KEYS.WATERSORT_USER_CHANCE(gameId);
    const chanceRaw = await redis.get(chanceKey);
    
    let user1Chance = 0;
    let user2Chance = 0;
    
    if (chanceRaw) {
      const chances = safeParseRedisData(chanceRaw);
      if (chances && typeof chances === 'object') {
        user1Chance = parseInt(chances[matchData.user1_id] || 0, 10);
        user2Chance = parseInt(chances[matchData.user2_id] || 0, 10);
      }
    }
    
    if (user1Chance === 0 && user2Chance === 0) {
      user1Chance = matchData?.user1_chance || 0;
      user2Chance = matchData?.user2_chance || 0;
    }
    
    if (isNaN(user1Chance)) user1Chance = 0;
    if (isNaN(user2Chance)) user2Chance = 0;
    
    const gameStats = getGameStats(matchData);
    const gameStatus = deriveGameStatus(matchData);
    
    const timerPayload = createWatersortTimerUpdatePayload(
      matchData,
      user1TimeSec,
      user2TimeSec,
      user1Chance,
      user2Chance,
      gameStats,
      gameStatus
    );
    
    if (!socket.connected) {
      return;
    }
    
    try {
      if (!socket.connected) {
        throw new Error('Socket disconnected before emit');
      }
      socket.emit('watersort_timer_update', timerPayload);
    } catch (err) {
      return;
    }
  } catch (err) {
  }
}

// ============================================================================
// Game State Handlers
// ============================================================================

async function checkWaterSortTimeout(redis, gameId, userId, timeStr, opponentId, matchData, now) {
  if (!timeStr) return { completed: false };
  const ts = new Date(timeStr);
  if (now.getTime() - ts.getTime() > 5 * 60 * 1000) {
    matchData.winner = opponentId;
    matchData.status = GAME_STATUS.COMPLETED;
    matchData.game_end_reason = 'opponent_timeout';
    matchData.completed_at = now.toISOString();
    matchData.updated_at = now.toISOString();
    
    await saveMatch(redis, gameId, matchData, 'watersort');
    
    const contestId = matchData.contest_id || matchData.contest_type || '';
    
    try {
      await tryDeclareWinner(gameId, async () => {
        await declareWaterSortWinner(gameId, opponentId, matchData.league_id || '', contestId, 'opponent_timeout', matchData);
      });
    } catch (err) {
    }
    
    return { completed: true, completedMatchData: matchData };
  }
  return { completed: false };
}

// ============================================================================
// Winner Declaration Functions
// ============================================================================

async function declareWaterSortWinner(gameId, winnerId, leagueId, contestId, reason, matchData = null) {
  if (!matchmakingService) {
    const errorMsg = `WaterSort matchmaking service not initialized for game ${gameId}`;
    throw new Error(errorMsg);
  }
  
  const { processWinnerDeclaration } = require('../../services/watersort/windeclearService');
  
  if (!matchData) {
    const redis = await getRedisClient();
    matchData = await redis.get(REDIS_KEYS.WATERSORT_MATCH(gameId));
  }
  const loser = matchData && matchData.user1_id === winnerId ? matchData.user2_id : matchData?.user1_id;
  
  const user1Score = Number(matchData?.user1_score || 0);
  const user2Score = Number(matchData?.user2_score || 0);
  const winnerScore = winnerId === matchData?.user1_id ? user1Score : user2Score;
  const loserScore = loser === matchData?.user1_id ? user1Score : user2Score;
  
  const actualContestId = contestId || (matchData && (matchData.contest_id || matchData.contest_type)) || '';
  const finalContestId = actualContestId || leagueId || '';
  
  try {
    const result = await processWinnerDeclaration(
      gameId,
      winnerId,
      loser,
      finalContestId,
      reason,
      {
        winner_score: winnerScore,
        loser_score: loserScore,
        total_moves: matchData?.total_moves || 0,
        game_duration: matchData?.game_duration || 0,
        level_no: matchData?.level_no || 0,
        move_count: matchData?.move_count || 0
      }
    );
    
    if (!result) {
      const errorMsg = `processWinnerDeclaration returned null/undefined for game ${gameId}`;
      throw new Error(errorMsg);
    }
    
    if (!result.success) {
      const errorMsg = result?.error || 'Unknown error in processWinnerDeclaration';
      const fullError = `Failed to declare winner for game ${gameId}: ${errorMsg}`;
      throw new Error(fullError);
    }
    
    return result;
  } catch (err) {
    throw err;
  }
}

// ============================================================================
// Game Completion Functions
// ============================================================================

async function completeWaterSortGame(gameId, key, redisInstance, matchData = null) {
  const redis = redisInstance || await getRedisClient();
  await redis.del(key);
  await redis.del(REDIS_KEYS.WATERSORT_USER_CHANCE(gameId));
  
  // Clear winner declaration key if exists
  try {
    await redis.del(`watersort_winner_declared:${gameId}`);
  } catch (_) {}
  
  // Clear both users' sessions from Redis when game completes
  if (matchData && matchData.user1_id && matchData.user2_id) {
    try {
      const sessionService = require('../../utils/sessionService');
      await sessionService.clearSessionsForMatch(matchData.user1_id, matchData.user2_id);
    } catch (err) {}
  }
  
  // Always update match_pairs to 'completed' when game ends
  if (gameId != null) {
    try {
      const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
      await updateMatchPairToCompleted(gameId);
    } catch (err) {
      if (matchmakingService) {
        try {
          await matchmakingService.getCassandraSession().execute('UPDATE match_pairs SET status = ?, updated_at = ? WHERE id = ?', ['completed', new Date(), gameId], { prepare: true });
        } catch (fallbackErr) {}
      }
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  setMatchmakingService,
  startWaterSortUserTimerCron,
  stopWaterSortUserTimerCron,
  setSocketIO
};
