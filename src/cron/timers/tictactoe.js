const { tryDeclareWinner, isWinnerDeclared } = require('../services/winnerService');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { safeParseRedisData, saveMatch } = require('../../utils/redis');
const { getCurrentDate } = require('../../utils/dateUtils');
const { isMatchCompleted } = require('../../utils/matchUtils');
const { createTicTacToeTimerUpdatePayload } = require('../../utils/timerPayloads');
const { buildSocketEmitterAdapter } = require('../../utils/socketRelay');

let tictactoeMatchmakingService = null;
let redisClientPromise = null;
let socketIOInstance = null;
let tictactoeTimerIntervalId = null;

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

function setTicTacToeMatchmakingService(service) {
  tictactoeMatchmakingService = service;
}

// ============================================================================
// Timer Management Functions
// ============================================================================

function startTicTacToeUserTimerCron(intervalMs) {
  if (tictactoeTimerIntervalId) {
    clearInterval(tictactoeTimerIntervalId);
    tictactoeTimerIntervalId = null;
  }
  
  processTicTacToeUserTimers().catch(() => {});
  
  tictactoeTimerIntervalId = setInterval(() => {
    processTicTacToeUserTimers().catch(() => {});
  }, intervalMs);
  
  return tictactoeTimerIntervalId;
}

function stopTicTacToeUserTimerCron() {
  if (tictactoeTimerIntervalId) {
    clearInterval(tictactoeTimerIntervalId);
    tictactoeTimerIntervalId = null;
  }
}

// ============================================================================
// Main Processing Function
// ============================================================================

async function processTicTacToeUserTimers() {
  try {
    const redis = await getRedisClient();
    if (!redis) {
      return;
    }
    
    const activeGames = await redis.smembers('tictactoe_active_games');
    
    if (!activeGames || activeGames.length === 0) {
      return;
    }
    
    const now = getCurrentDate();
    
    const { processInParallel } = require('../../utils/parallelUtils');
    
    await processInParallel(activeGames, async (gameId) => {
      try {
        const matchKey = REDIS_KEYS.TICTACTOE_MATCH(gameId);
        const matchData = await redis.get(matchKey);
        if (!matchData) {
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }
        
        const parsedMatch = safeParseRedisData(matchData);
        if (!parsedMatch) {
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }
        
        const user1Id = parsedMatch.user1_id;
        const user2Id = parsedMatch.user2_id;
        const turn = parsedMatch.turn;
        if (!gameId || !user1Id || !user2Id || !turn) {
          return;
        }
        
        if (isMatchCompleted(parsedMatch)) {
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }
        
        if (await isWinnerDeclared(gameId)) {
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }
        
        const user1SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user1Id));
        const user2SocketId = await redis.get(REDIS_KEYS.USER_TO_SOCKET(user2Id));
        
        const usersToUpdate = [];
        if (user1SocketId) {
          usersToUpdate.push({ userId: user1Id, socketId: user1SocketId });
        }
        if (user2SocketId) {
          usersToUpdate.push({ userId: user2Id, socketId: user2SocketId });
        }
        
        if (usersToUpdate.length === 0) {
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }

        const start = parsedMatch.start_time;
        if (start && parsedMatch.user1_time === parsedMatch.user2_time && parsedMatch.user1_time === start) {
          const startTimeoutResult = await handleStartTimeout(gameId, matchKey, redis, now);
          
          if (startTimeoutResult && startTimeoutResult.completed) {
            const completedMatchData = startTimeoutResult.completedMatchData;
            if (completedMatchData) {
              completedMatchData.status = GAME_STATUS.COMPLETED;
              completedMatchData.game_end_reason = completedMatchData.game_end_reason || 'no_first_move';
              
              await Promise.all(
                usersToUpdate.map(user => {
                  return sendTimerUpdateToSockets(gameId, completedMatchData, user).catch(() => {});
                })
              );
              
              await completeTicTacToeGame(gameId, redis, completedMatchData || parsedMatch);
              await redis.srem('tictactoe_active_games', gameId);
            }
            return;
          }
          
          const latestMatchData = await redis.get(matchKey);
          const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
          await Promise.all(
            usersToUpdate.map(user => {
              return sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => {});
            })
          );
          return;
        }
        
        const turnResult = await handleTurn(redis, { gameId, matchData: parsedMatch, turn, user1Id, user2Id, now });
        
        if (turnResult && turnResult.completed) {
          const completedMatchData = turnResult.completedMatchData || parsedMatch;
          completedMatchData.status = GAME_STATUS.COMPLETED;
          
          await saveMatch(redis, gameId, completedMatchData, 'tictactoe');
          
          await Promise.all(
            usersToUpdate.map(user => {
              return sendTimerUpdateToSockets(gameId, completedMatchData, user).catch(() => {});
            })
          );
          
          await completeTicTacToeGame(gameId, redis, completedMatchData);
          
          await redis.srem('tictactoe_active_games', gameId);
          return;
        }
        
        const latestMatchData = await redis.get(matchKey);
        const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
        
        await Promise.all(
          usersToUpdate.map(user => {
            return sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => {});
          })
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

async function sendTimerUpdateToSockets(gameId, matchData, user) {
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
        socket.emit('stop:timer_updates_tictactoe', {
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
      
      const gameStats = getTicTacToeGameStats(matchData);
      const gameStatus = deriveGameStatus(matchData);

      const completionPayload = createTicTacToeTimerUpdatePayload(
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
        socket.emit('tictactoe_timer_update', completionPayload);
      } catch (err) {
        return;
      }
      
      return;
    }
    
    const currentTime = Date.now();
    
    if (!matchData.user1_time) matchData.user1_time = new Date().toISOString();
    if (!matchData.user2_time) matchData.user2_time = new Date().toISOString();
    
    let user1TimeSec = calculateRemainingTime(matchData.user1_time, currentTime);
    let user2TimeSec = calculateRemainingTime(matchData.user2_time, currentTime);
    
    const MAX_TIMER_SECONDS = 60;
    if (user1TimeSec === null || user1TimeSec === undefined) {
      user1TimeSec = MAX_TIMER_SECONDS;
    }
    if (user2TimeSec === null || user2TimeSec === undefined) {
      user2TimeSec = MAX_TIMER_SECONDS;
    }
    
    const redis = await getRedisClient();
    const chanceKey = REDIS_KEYS.TICTACTOE_USER_CHANCE(gameId);
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
    
    if (isNaN(user1Chance)) user1Chance = 0;
    if (isNaN(user2Chance)) user2Chance = 0;
    
    const gameStats = getTicTacToeGameStats(matchData);
    const gameStatus = deriveGameStatus(matchData);
    
    if (!socket.connected) {
      return;
    }
    
    const timerPayload = createTicTacToeTimerUpdatePayload(
      matchData,
      user1TimeSec,
      user2TimeSec,
      user1Chance,
      user2Chance,
      gameStats,
      gameStatus
    );
    
    const hasClearedPosition = matchData.cleared_position !== undefined && matchData.cleared_position !== null;
    
    try {
      if (!socket.connected) {
        throw new Error('Socket disconnected before emit');
      }
      
      socket.emit('tictactoe_timer_update', timerPayload);
      
      if (hasClearedPosition) {
        try {
          const redis = await getRedisClient();
          const matchKey = REDIS_KEYS.TICTACTOE_MATCH(gameId);
          matchData.cleared_position = null;
          await saveMatch(redis, gameId, matchData, 'tictactoe');
        } catch (saveErr) {
        }
      }
    } catch (err) {
      return;
    }
    
  } catch (err) {
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function calculateRemainingTime(userTime, currentTime) {
  if (!userTime) return 60;
  try {
    const timeValue = typeof userTime === 'string' ? new Date(userTime).getTime() : userTime;
    if (isNaN(timeValue)) return 60;
    const elapsed = Math.floor((currentTime - timeValue) / 1000);
    const MAX_TIMER_SECONDS = 60;
    return Math.max(0, MAX_TIMER_SECONDS - elapsed);
  } catch (error) {
    return 60;
  }
}

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

function deriveGameStatus(match) {
  if (match.status === GAME_STATUS.COMPLETED || match.status === 'completed') return 'completed';
  if (match.winner) return 'won';
  if (match.game_end_reason) return 'ended';
  return 'active';
}

// ============================================================================
// Game State Handlers
// ============================================================================

async function handleStartTimeout(gameId, key, redis, now) {
  const matchRaw = await redis.get(key);
  if (!matchRaw) return { completed: false };
  const match = safeParseRedisData(matchRaw);
  if (!match) return { completed: false };
  
  const hasMoves = match.moveHistory && Array.isArray(match.moveHistory) && match.moveHistory.length > 0;
  const hasBoardMoves = match.board && Array.isArray(match.board) && match.board.some(cell => cell !== null && cell !== 0);
  
  const start = match.start_time || match.created_at;
  if (!start) return { completed: false };
  
  const ts = new Date(start);
  const elapsedMs = now.getTime() - ts.getTime();
  
  if (!hasMoves && !hasBoardMoves) {
    if (elapsedMs > 60 * 1000) {
      const turn = match.turn || match.user1_id; // Default to user1 if turn not set
      const loserId = turn;
      const winnerId = turn === match.user1_id ? match.user2_id : match.user1_id;
      
      match.winner = winnerId;
      match.status = GAME_STATUS.COMPLETED;
      match.game_end_reason = 'no_first_move';
      match.completed_at = new Date().toISOString();
      match.updated_at = new Date().toISOString();
      
      await saveMatch(redis, gameId, match, 'tictactoe');
      
      const contestId = match.contest_id || match.contest_type || 'simple';
      
      try {
        await tryDeclareWinner(gameId, async () => {
          await declareTicTacToeWinner(gameId, winnerId, loserId, contestId, 'no_first_move', match);
        });
      } catch (err) {
      }
      
      return { completed: true, completedMatchData: match };
    }
    return { completed: false };
  }
  
  if (elapsedMs > 5 * 60 * 1000) {
    const matchData = await redis.get(REDIS_KEYS.TICTACTOE_MATCH(gameId));
    const parsedMatch = matchData ? safeParseRedisData(matchData) : null;
    await completeTicTacToeGame(gameId, redis, parsedMatch);
    return { completed: true };
  }
  
  return { completed: false };
}

async function handleTurn(redis, { gameId, matchData, turn, user1Id, user2Id, now }) {
  const currentPlayerTime = turn === user1Id ? matchData.user1_time : matchData.user2_time;
  
  const timeStr = currentPlayerTime || matchData.start_time || matchData.created_at;
  
  if (!timeStr) {
    const live = now.toISOString();
    if (turn === user1Id) {
      matchData.user1_time = live;
    } else {
      matchData.user2_time = live;
    }
    await saveMatch(redis, gameId, matchData, 'tictactoe');
    return { completed: false };
  }
  
  const ts = new Date(timeStr);
  if (isNaN(ts.getTime())) {
    const live = now.toISOString();
    if (turn === user1Id) {
      matchData.user1_time = live;
    } else {
      matchData.user2_time = live;
    }
    await saveMatch(redis, gameId, matchData, 'tictactoe');
    return { completed: false };
  }
  
  const elapsedMs = now.getTime() - ts.getTime();
  if (elapsedMs <= 60 * 1000) {
    return { completed: false };
  }
  
  const opponent = turn === user1Id ? user2Id : user1Id;
  
  matchData.winner = opponent;
  matchData.status = GAME_STATUS.COMPLETED;
  matchData.game_end_reason = 'user_timeout';
  matchData.completed_at = new Date().toISOString();
  matchData.updated_at = new Date().toISOString();
  
  await saveMatch(redis, gameId, matchData, 'tictactoe');
  
  const contestId = matchData.contest_id || matchData.contest_type || 'simple';
  
  try {
    await tryDeclareWinner(gameId, async () => {
      await declareTicTacToeWinner(gameId, opponent, turn, contestId, 'user_timeout', matchData);
    });
  } catch (err) {
    throw err;
  }
  
  return { completed: true, completedMatchData: matchData };
}

// ============================================================================
// Winner Declaration Functions
// ============================================================================

async function declareTicTacToeWinner(gameId, winnerId, loserId, contestId, reason, matchData = null) {
  if (!tictactoeMatchmakingService) {
    const errorMsg = `TicTacToe matchmaking service not initialized for game ${gameId}`;
    throw new Error(errorMsg);
  }
  
  const { processWinnerDeclaration } = require('../../services/tictactoe/windeclearService');
  
  let scores = { user1Score: 0, user2Score: 0, winnerScore: 1.0, loserScore: 0.0 };
  if (matchData) {
    scores.winnerScore = 1.0;
    scores.loserScore = 0.0;
    scores.user1Score = winnerId === matchData.user1_id ? 1.0 : 0.0;
    scores.user2Score = winnerId === matchData.user2_id ? 1.0 : 0.0;
  }
  
  const actualContestId = contestId || (matchData && (matchData.contest_id || matchData.contest_type)) || 'simple';
  
  try {
    const result = await processWinnerDeclaration(
      gameId,
      winnerId,
      loserId,
      actualContestId,
      reason,
      scores.winnerScore,
      scores.loserScore,
      scores.user1Score,
      scores.user2Score
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

async function completeTicTacToeGame(gameId, redisInstance, matchData = null) {
  const redis = redisInstance || await getRedisClient();
  await redis.del(REDIS_KEYS.TICTACTOE_MATCH(gameId));
  await redis.del(REDIS_KEYS.TICTACTOE_USER_CHANCE(gameId));
  
  // Clear winner declaration key if exists
  try {
    await redis.del(`tictactoe_winner_declared:${gameId}`);
  } catch (_) {}
  
  // Clear both users' sessions from Redis when game completes
  if (matchData && matchData.user1_id && matchData.user2_id) {
    try {
      const sessionService = require('../../utils/sessionService');
      await sessionService.clearSessionsForMatch(matchData.user1_id, matchData.user2_id);
    } catch (err) {}
  }
  
  if (gameId != null) {
    try {
      const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
      await updateMatchPairToCompleted(gameId);
    } catch (err) {
      if (tictactoeMatchmakingService) {
        try {
          await tictactoeMatchmakingService.getCassandraSession().execute('UPDATE match_pairs SET status = ?, updated_at = ? WHERE id = ?', ['completed', new Date(), gameId], { prepare: true });
        } catch (fallbackErr) {}
      }
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  setTicTacToeMatchmakingService,
  startTicTacToeUserTimerCron,
  stopTicTacToeUserTimerCron,
  setSocketIO,
  completeTicTacToeGame
};
