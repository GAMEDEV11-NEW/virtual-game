// ============================================================================
// Imports
// ============================================================================

const { tryDeclareWinner, isWinnerDeclared } = require('../services/winnerService');
const { REDIS_TTL, REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { safeParseRedisData } = require('../../utils/redis');
const { getCurrentDate } = require('../../utils/dateUtils');
const { isMatchCompleted } = require('../../utils/matchUtils');
const { createSnakesTimerUpdatePayload } = require('../../utils/timerPayloads');
const { buildSocketEmitterAdapter } = require('../../utils/socketRelay');

// ============================================================================
// Module state
// ============================================================================

let snakesMatchmakingService = null;
let redisClientPromise = null;
let socketIOInstance = null;
let snakesTimerIntervalId = null;
const MATCH_TTL_SECONDS = REDIS_TTL.MATCH_SECONDS;

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

function setSnakesMatchmakingService(service) {
  snakesMatchmakingService = service;
}

function startSnakesLaddersUserTimerCron(intervalMs) {
  if (snakesTimerIntervalId) {
    clearInterval(snakesTimerIntervalId);
    snakesTimerIntervalId = null;
  }
  
  processSnakesLaddersUserTimers().catch(() => {});
  
  snakesTimerIntervalId = setInterval(() => {
    processSnakesLaddersUserTimers().catch(() => {});
  }, intervalMs);
  
  return snakesTimerIntervalId;
}

function stopSnakesLaddersUserTimerCron() {
  if (snakesTimerIntervalId) {
    clearInterval(snakesTimerIntervalId);
    snakesTimerIntervalId = null;
  }
}

async function processSnakesLaddersUserTimers() {
  const redis = await getRedisClient();
  if (!redis) return;

  const activeGames = await redis.smembers('snakesladders_active_games');
  if (!activeGames || activeGames.length === 0) return;

  const now = getCurrentDate();
  const { processInParallel } = require('../../utils/parallelUtils');

  await processInParallel(activeGames, async (gameId) => {
    try {
        const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
        const matchData = await redis.get(matchKey);
        if (!matchData) {
          await redis.srem('snakesladders_active_games', gameId);
          return;
        }
        
        const parsedMatch = safeParseRedisData(matchData);
        if (!parsedMatch) {
          await redis.srem('snakesladders_active_games', gameId);
          return;
        }
        
        const user1Id = parsedMatch.user1_id;
        const user2Id = parsedMatch.user2_id;
        const turn = parsedMatch.turn;
        const user1Time = parsedMatch.user1_time;
        const user2Time = parsedMatch.user2_time;
        if (!gameId || !user1Id || !user2Id || !turn) {
          return;
        }
        
        if (isMatchCompleted(parsedMatch)) {
          await redis.srem('snakesladders_active_games', gameId);
          return;
        }
        
        if (await isWinnerDeclared(gameId)) {
          await redis.srem('snakesladders_active_games', gameId);
          return;
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
          await redis.srem('snakesladders_active_games', gameId);
          return;
        }

        const start = parsedMatch.start_time;
        if (start && shouldHandleStart(user1Time, user2Time, start)) {
          await initializeSnakesChances(redis, gameId, user1Id, user2Id);
          const latestMatchData = await redis.get(matchKey);
          const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
          await Promise.all(
            usersToUpdate.map(user => 
              sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => {})
            )
          );
          return;
        }

        const { hasUserWon } = require('../../helpers/snakesladders/gameUtils');
        let gameCompleted = false;
        let completedMatchData = null;
        
        if (hasUserWon(parsedMatch, user1Id)) {
          const contestId = parsedMatch.contest_id || parsedMatch.contest_type || '';
          try {
            await tryDeclareWinner(gameId, async () => {
              await declareSnakesWinner(gameId, user1Id, user2Id, 'all_pieces_home', parsedMatch.league_id || '', contestId, parsedMatch);
            });
          } catch (err) {
          }
          parsedMatch.status = GAME_STATUS.COMPLETED;
          parsedMatch.winner = user1Id;
          parsedMatch.game_end_reason = 'all_pieces_home';
          parsedMatch.completed_at = new Date().toISOString();
          await redis.set(matchKey, JSON.stringify(parsedMatch), MATCH_TTL_SECONDS);
          completedMatchData = parsedMatch;
          await completeSnakesGame(gameId, redis, parsedMatch);
          gameCompleted = true;
        } else if (hasUserWon(parsedMatch, user2Id)) {
          const contestId = parsedMatch.contest_id || parsedMatch.contest_type || '';
          try {
            await tryDeclareWinner(gameId, async () => {
              await declareSnakesWinner(gameId, user2Id, user1Id, 'all_pieces_home', parsedMatch.league_id || '', contestId, parsedMatch);
            });
          } catch (err) {
            if (err.message && err.message.includes('already declared')) {
              await redis.srem('snakesladders_active_games', gameId);
              return;
            }
          }
          parsedMatch.status = GAME_STATUS.COMPLETED;
          parsedMatch.winner = user2Id;
          parsedMatch.game_end_reason = 'all_pieces_home';
          parsedMatch.completed_at = new Date().toISOString();
          await redis.set(matchKey, JSON.stringify(parsedMatch), MATCH_TTL_SECONDS);
          completedMatchData = parsedMatch;
          await completeSnakesGame(gameId, redis, parsedMatch);
          gameCompleted = true;
        } else {
          const activeStateResult = await handleSnakesActive(redis, { gameId, matchData: parsedMatch, turn, user1Id, user2Id, user1Time, user2Time, now });
          
          if (activeStateResult && activeStateResult.completed) {
            completedMatchData = activeStateResult.completedMatchData || parsedMatch;
            gameCompleted = true;
          }
        }
        
        if (gameCompleted) {
          const finalMatchData = await redis.get(matchKey);
          const matchDataForCompletion = finalMatchData ? safeParseRedisData(finalMatchData) : (completedMatchData || parsedMatch);
          
          if (matchDataForCompletion) {
            matchDataForCompletion.status = GAME_STATUS.COMPLETED;
            if (!matchDataForCompletion.winner && completedMatchData && completedMatchData.winner) {
              matchDataForCompletion.winner = completedMatchData.winner;
            }
            if (!matchDataForCompletion.game_end_reason && completedMatchData && completedMatchData.game_end_reason) {
              matchDataForCompletion.game_end_reason = completedMatchData.game_end_reason;
            }
            if (!matchDataForCompletion.completed_at && completedMatchData && completedMatchData.completed_at) {
              matchDataForCompletion.completed_at = completedMatchData.completed_at;
            }
          }
          
          await Promise.all(
            usersToUpdate.map(user => 
              sendTimerUpdateToSockets(gameId, matchDataForCompletion || completedMatchData || parsedMatch, user).catch(() => {})
            )
          );
          
          await redis.srem('snakesladders_active_games', gameId);
          return;
        }
        
        const latestMatchData = await redis.get(matchKey);
        const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
        
        await Promise.all(
          usersToUpdate.map(user => 
            sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => {})
          )
        );
        
    } catch (err) {
      // Intentionally ignore per-game failures to avoid stopping the cron loop.
    }
  }, 5);
}

async function sendTimerUpdateToSockets(gameId, matchData, user) {
  if (!socketIOInstance) {
    return;
  }
  
  try {
    const { socketId } = user;
    
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
        socket.emit('stop:timer_updates_snakesladders', {
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
        socket.emit('snakesladders_timer_stopped', {
          status: 'stopped',
          message: 'Timer updates stopped successfully',
          game_id: gameId,
          reason: 'game_completed',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return;
      }
      
      if (!matchData.user1_pieces || !matchData.user2_pieces) {
        try {
          const { GamePiecesService } = require('../services/piecesService');
          const cassandraClient = require('../../services/cassandra/client');
          const piecesService = new GamePiecesService(cassandraClient);
          
          if (!matchData.user1_pieces) {
            const user1Pieces = await piecesService.getUserPieces(gameId, matchData.user1_id);
            if (user1Pieces && user1Pieces.length > 0) {
              matchData.user1_pieces = user1Pieces;
            }
          }
          
          if (!matchData.user2_pieces) {
            const user2Pieces = await piecesService.getUserPieces(gameId, matchData.user2_id);
            if (user2Pieces && user2Pieces.length > 0) {
              matchData.user2_pieces = user2Pieces;
            }
          }
        } catch (err) {
        }
      }
      
      const userScores = extractScoresFromMatchData(matchData);
      const gameStats = getGameStatistics(matchData);

      const completionPayload = createSnakesTimerUpdatePayload(
        matchData,
        null,
        null,
        0,
        0,
        userScores,
        'completed',
        gameStats
      );
      
      completionPayload.last_dice_roll = matchData.last_dice_roll || null;
      completionPayload.last_dice_user = matchData.last_dice_user || null;
      completionPayload.last_dice_time = matchData.last_dice_time || null;

      completionPayload.status = 'completed';
      completionPayload.message = 'Game completed - timer updates stopped';
      
      if (matchData.winner) {
        completionPayload.winner = matchData.winner;
        completionPayload.game_end_reason = matchData.game_end_reason || 'game_completed';
        completionPayload.completed_at = matchData.completed_at || new Date().toISOString();
      }

      try {
        if (!socket.connected) {
          throw new Error('Socket disconnected before emit');
        }
        socket.emit('snakesladders_timer_update', completionPayload);
        
        if (matchData.winner) {
          const isWinner = timer.userId === matchData.winner;
          const winnerDeclaredMessage = {
            status: isWinner ? 'won' : 'lost',
            game_id: gameId,
            winner_id: matchData.winner,
            game_end_reason: matchData.game_end_reason || 'game_completed',
            completed_at: matchData.completed_at || new Date().toISOString(),
            user1_score: userScores.user1_score || 0,
            user2_score: userScores.user2_score || 0,
            timestamp: new Date().toISOString()
          };
          
          try {
            if (!socket.connected) {
              throw new Error('Socket disconnected before emit');
            }
            socket.emit('game:winner_declared', winnerDeclaredMessage);
          } catch (err1) {
          }
          
          try {
            if (!socket.connected) {
              throw new Error('Socket disconnected before emit');
            }
            if (isWinner) {
              socket.emit('game:won', {
                status: 'won',
                game_id: gameId,
                winner_id: matchData.winner,
                message: '🎉 Congratulations! You won the game!',
                game_end_reason: matchData.game_end_reason || 'game_completed',
                completed_at: matchData.completed_at || new Date().toISOString(),
                user1_score: userScores.user1_score || 0,
                user2_score: userScores.user2_score || 0,
                timestamp: new Date().toISOString()
              });
            } else {
              socket.emit('game:lost', {
                status: 'lost',
                game_id: gameId,
                winner_id: matchData.winner,
                message: '😔 Game Over! Your opponent has won the game.',
                game_end_reason: matchData.game_end_reason || 'game_completed',
                completed_at: matchData.completed_at || new Date().toISOString(),
                user1_score: userScores.user1_score || 0,
                user2_score: userScores.user2_score || 0,
                timestamp: new Date().toISOString()
              });
            }
          } catch (err2) {
          }
          
          try {
            socketIOInstance.to(socketId).emit('game:winner_declared', winnerDeclaredMessage);
          } catch (err3) {
          }
        }
      } catch (err) {
        return;
      }
      
      return;
    }
    
    const currentTime = Date.now();
    let user1TimeSec = calculateRemainingTime(matchData.user1_time, currentTime);
    let user2TimeSec = calculateRemainingTime(matchData.user2_time, currentTime);
    
    const MAX_TIMER_SECONDS = 30;
    if (user1TimeSec === null || user1TimeSec === undefined) {
      user1TimeSec = MAX_TIMER_SECONDS;
    }
    if (user2TimeSec === null || user2TimeSec === undefined) {
      user2TimeSec = MAX_TIMER_SECONDS;
    }
    
    const redis = await getRedisClient();
    const chanceKey = REDIS_KEYS.SNAKES_USER_CHANCE(gameId);
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
    
    if (!matchData.user1_pieces || !matchData.user2_pieces) {
      try {
        const { GamePiecesService } = require('../services/piecesService');
        const cassandraClient = require('../../services/cassandra/client');
        const piecesService = new GamePiecesService(cassandraClient);
        
        if (!matchData.user1_pieces) {
          const user1Pieces = await piecesService.getUserPieces(gameId, matchData.user1_id);
          if (user1Pieces && user1Pieces.length > 0) {
            matchData.user1_pieces = user1Pieces;
          }
        }
        
        if (!matchData.user2_pieces) {
          const user2Pieces = await piecesService.getUserPieces(gameId, matchData.user2_id);
          if (user2Pieces && user2Pieces.length > 0) {
            matchData.user2_pieces = user2Pieces;
          }
        }
        
        if (matchData.user1_pieces || matchData.user2_pieces) {
          const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
          await redis.set(matchKey, JSON.stringify(matchData), MATCH_TTL_SECONDS);
        }
      } catch (err) {
      }
    }
    
    const userScores = extractScoresFromMatchData(matchData);
    const gameStatus = determineGameStatus(matchData);
    const gameStats = getGameStatistics(matchData);
    
    if (!socket.connected) {
      return;
    }
    
    const timerPayload = createSnakesTimerUpdatePayload(
      matchData,
      user1TimeSec,
      user2TimeSec,
      user1Chance,
      user2Chance,
      userScores,
      gameStatus,
      gameStats
    );
    
    timerPayload.last_dice_roll = matchData.last_dice_roll || null;
    timerPayload.last_dice_user = matchData.last_dice_user || null;
    timerPayload.last_dice_time = matchData.last_dice_time || null;
    
    try {
      if (!socket.connected) {
        throw new Error('Socket disconnected before emit');
      }
      socket.emit('snakesladders_timer_update', timerPayload);
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
  if (!userTime) return 30;
  try {
    const timeValue = typeof userTime === 'string' ? new Date(userTime).getTime() : userTime;
    if (isNaN(timeValue)) return 30;
    const elapsed = Math.floor((currentTime - timeValue) / 1000);
    const MAX_TIMER_SECONDS = 30;
    return Math.max(0, MAX_TIMER_SECONDS - elapsed);
  } catch (error) {
    return 30;
  }
}

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

function determineGameStatus(matchData) {
  if (matchData.status === GAME_STATUS.COMPLETED) return 'completed';
  if (matchData.winner) return 'won';
  if (matchData.game_end_reason) return 'ended';
  return 'active';
}

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

function shouldHandleStart(user1Time, user2Time, start) {
  return user1Time && user2Time && start && user1Time === user2Time && user1Time === start;
}

// ============================================================================
// Game State Handlers
// ============================================================================

async function initializeSnakesChances(redis, gameId, user1Id, user2Id) {
  const pipeline = redis.pipeline();
  pipeline.set(REDIS_KEYS.SNAKES_USER_CHANCE(gameId), JSON.stringify({ [user1Id]: 3, [user2Id]: 3 }), 'EX', MATCH_TTL_SECONDS);
  await pipeline.exec();
}

async function handleSnakesActive(redis, { gameId, matchData, turn, user1Id, user2Id, user1Time, user2Time, now }) {
  const userId = turn;
  const ts = new Date(userId === user1Id ? user1Time : user2Time);
  if (now.getTime() - ts.getTime() <= 30 * 1000) {
    return { completed: false };
  }
  const chanceKey = REDIS_KEYS.SNAKES_USER_CHANCE(gameId);
  const chances = (await redis.get(chanceKey)) || { [user1Id]: 3, [user2Id]: 3 };
  const current = Number(chances[userId] || 0);
  if (current > 1) {
    chances[userId] = current - 1;
    matchData[userId === user1Id ? 'user1_chance' : 'user2_chance'] = current - 1;
    matchData.turn = userId === user1Id ? user2Id : user1Id;
    matchData.user1_time = now.toISOString();
    matchData.user2_time = now.toISOString();
    
    const pipeline = redis.pipeline();
    pipeline.set(chanceKey, JSON.stringify(chances), 'EX', MATCH_TTL_SECONDS);
    pipeline.set(REDIS_KEYS.SNAKES_MATCH(gameId), JSON.stringify(matchData), 'EX', MATCH_TTL_SECONDS);
    await pipeline.exec();
    
    return { completed: false };
  } else {
    const opponent = userId === user1Id ? user2Id : user1Id;
    const contestId = matchData.contest_id || matchData.contest_type || '';
    try {
      await tryDeclareWinner(gameId, async () => {
        await declareSnakesWinner(gameId, opponent, userId, 'opponent_timeout', matchData.league_id || '', contestId, matchData);
      });
    } catch (err) {
      if (err.message && err.message.includes('already declared')) {
        return { completed: true, completedMatchData: matchData };
      }
    }
    matchData.status = GAME_STATUS.COMPLETED;
    matchData.winner = opponent;
    matchData.game_end_reason = 'opponent_timeout';
    matchData.completed_at = new Date().toISOString();
    await redis.set(REDIS_KEYS.SNAKES_MATCH(gameId), JSON.stringify(matchData), MATCH_TTL_SECONDS);
    await completeSnakesGame(gameId, redis, matchData);
    return { completed: true, completedMatchData: matchData };
  }
}

// ============================================================================
// Winner Declaration Functions
// ============================================================================

async function declareSnakesWinner(gameId, winnerId, loserId, reason, leagueId, contestId, matchData = null) {
  if (!snakesMatchmakingService) {
    const errorMsg = `Snakes matchmaking service not initialized for game ${gameId}`;
    throw new Error(errorMsg);
  }
  
  const { processWinnerDeclaration } = require('../../services/snakesladders/windeclearService');
  
  let scores = { user1Score: 0, user2Score: 0, winnerScore: 0, loserScore: 0 };
  if (matchData) {
    scores.user1Score = Number(matchData.user1_score || 0);
    scores.user2Score = Number(matchData.user2_score || 0);
    scores.winnerScore = winnerId === matchData.user1_id ? scores.user1Score : scores.user2Score;
    scores.loserScore = loserId === matchData.user1_id ? scores.user1Score : scores.user2Score;
  }
  
  const actualContestId = contestId || (matchData && (matchData.contest_id || matchData.contest_type)) || '';
  const finalContestId = actualContestId || leagueId || '';
  
  const result = await processWinnerDeclaration(
    gameId,
    winnerId,
    loserId,
    finalContestId,
    reason,
    scores.winnerScore,
    scores.loserScore,
    scores.user1Score,
    scores.user2Score
  );

  if (!result) {
    throw new Error(`processWinnerDeclaration returned null/undefined for game ${gameId}`);
  }

  if (!result.success) {
    const errorMsg = result?.error || 'Unknown error in processWinnerDeclaration';
    throw new Error(`Failed to declare winner for game ${gameId}: ${errorMsg}`);
  }

  return result;
}

// ============================================================================
// Game Completion Functions
// ============================================================================

async function completeSnakesGame(gameId, redisInstance, matchData = null) {
  const redis = redisInstance || await getRedisClient();
  await redis.del(REDIS_KEYS.SNAKES_MATCH(gameId));
  await redis.del(REDIS_KEYS.SNAKES_USER_CHANCE(gameId));
  
  // Clear winner declaration key if exists
  try {
    await redis.del(`snakesladders_winner_declared:${gameId}`);
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
      const { updateMatchPairToCompleted } = require('../../services/snakesladders/baseWindeclearService');
      await updateMatchPairToCompleted(gameId);
    } catch (err) {
      if (snakesMatchmakingService) {
        try {
          await snakesMatchmakingService.getCassandraSession().execute('UPDATE match_pairs SET status = ?, updated_at = ? WHERE id = ?', ['completed', new Date(), gameId], { prepare: true });
        } catch (fallbackErr) {}
      }
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  setSnakesMatchmakingService,
  startSnakesLaddersUserTimerCron,
  stopSnakesLaddersUserTimerCron,
  setSocketIO
};
