// ============================================================================
// Imports
// ============================================================================

const { tryDeclareWinner, isWinnerDeclared } = require('../services/winnerService');
const { REDIS_TTL, REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { safeParseRedisData } = require('../../utils/redis');
const { toISOString, getCurrentDate } = require('../../utils/dateUtils');
const { isMatchCompleted, getOpponentId } = require('../../utils/matchUtils');
const { toFloat: toNumber } = require('../../utils/dataUtils');
const { createLudoTimerUpdatePayload } = require('../../utils/timerPayloads');
const { buildSocketEmitterAdapter } = require('../../utils/socketRelay');
const { config } = require('../../utils/config');
const { archiveLudoGameState } = require('../../services/ludo/archiveService');

// ============================================================================
// State Variables
// ============================================================================

let ludoMatchmakingService = null;
let redisClientPromise = null;
let socketIOInstance = null;
let ludoTimerIntervalId = null;
const MATCH_TTL_SECONDS = REDIS_TTL.MATCH_SECONDS;
let lastHeartbeatLogAt = 0;
const HEARTBEAT_LOG_INTERVAL_MS = 30000;
const LUDO_TIMER_MATCH_SCAN_COUNT = Number(process.env.LUDO_TIMER_MATCH_SCAN_COUNT || 10000);

async function scanKeysByPattern(redisClient, pattern, count = 100) {
  const scanCount = Math.max(1, Number(count) || 100);
  const scanNode = async (node) => {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
      cursor = nextCursor;
      if (Array.isArray(batch) && batch.length > 0) {
        keys.push(...batch);
      }
    } while (cursor !== '0');
    return keys;
  };

  try {
    if (redisClient && typeof redisClient.nodes === 'function') {
      const masters = redisClient.nodes('master');
      const all = await Promise.all(masters.map((node) => scanNode(node)));
      return [...new Set(all.flat())];
    }
    return await scanNode(redisClient);
  } catch (_) {
    return [];
  }
}

// ============================================================================
// Initialization Functions
// ============================================================================

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

function setLudoMatchmakingService(service) {
  ludoMatchmakingService = service;
}

// ============================================================================
// Timer Management Functions
// ============================================================================

function startLudoUserTimerCron(intervalMs) {
  if (ludoTimerIntervalId) {
    clearInterval(ludoTimerIntervalId);
    ludoTimerIntervalId = null;
  }

  processLudoUserTimers().catch(() => { });

  ludoTimerIntervalId = setInterval(() => {
    processLudoUserTimers().catch(() => { });
  }, intervalMs);

  return ludoTimerIntervalId;
}

function stopLudoUserTimerCron() {
  if (ludoTimerIntervalId) {
    clearInterval(ludoTimerIntervalId);
    ludoTimerIntervalId = null;
  }
}

// ============================================================================
// Main Processing Function
// ============================================================================

async function processLudoUserTimers() {
  const redis = await getRedisClient();
  if (!redis) return;

  const scanCount = Math.max(1, LUDO_TIMER_MATCH_SCAN_COUNT);
  const serverId = String(config.serverId || '1');
  const matchKeys = await scanKeysByPattern(redis, `match_server:*:${serverId}`, scanCount);
  const activeGames = Array.isArray(matchKeys)
    ? matchKeys
      .map((key) => String(key || ''))
      .filter((key) => key.startsWith('match_server:'))
      .map((key) => key.split(':'))
      .filter((parts) => parts.length >= 3)
      .map((parts) => parts[1])
      .filter(Boolean)
      .slice(0, scanCount)
    : [];
  const nowMs = Date.now();
  if (nowMs - lastHeartbeatLogAt >= HEARTBEAT_LOG_INTERVAL_MS) {
    lastHeartbeatLogAt = nowMs;
    console.log(`[Cron][LudoTimer] heartbeat server_id=${serverId} match_keys=${activeGames.length}`);
  }
  if (!activeGames || activeGames.length === 0) return;

  const now = getCurrentDate();
  const { processInParallel } = require('../../utils/parallelUtils');

  await processInParallel(activeGames, async (gameId) => {
    try {
      const matchKey = REDIS_KEYS.MATCH(gameId);
      const matchData = await redis.get(matchKey);
      if (!matchData) {
        return;
      }

      const parsedMatch = safeParseRedisData(matchData);
      if (!parsedMatch) {
        return;
      }

      const user1Id = parsedMatch.user1_id;
      const user2Id = parsedMatch.user2_id;
      const turn = parsedMatch.turn;
      const contestType = (parsedMatch.contest_type || '').toLowerCase();
      if (!gameId || !user1Id || !user2Id || !turn) {
        return;
      }

      if (isMatchCompleted(parsedMatch)) {
        return;
      }

      if (await isWinnerDeclared(gameId)) {
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
        return;
      }

      const user1Time = parsedMatch.user1_time;
      const user2Time = parsedMatch.user2_time;
      const startTime = parsedMatch.start_time;

      if (shouldHandleStart(user1Time, user2Time, startTime)) {
        await handleStartState(gameId, matchKey, parsedMatch, now, redis);
        const latestMatchData = await redis.get(matchKey);
        const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;
        await Promise.all(
          usersToUpdate.map(user =>
            sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => { })
          )
        );
        return;
      }

      let skipDefaultActive = false;
      if (contestType === 'quick') {
        const { completed, completedMatchData } = await handleLudoQuickContest(gameId, matchKey, parsedMatch, now, redis);
        if (completed) {
          const matchDataForCompletion = completedMatchData || parsedMatch;
          matchDataForCompletion.status = GAME_STATUS.COMPLETED;

          await Promise.all(
            usersToUpdate.map(user =>
              sendTimerUpdateToSockets(gameId, matchDataForCompletion, user).catch(() => { })
            )
          );

          return;
        }
      } else if (contestType === 'classic') {
        const { completed, processedActive, completedMatchData } = await handleLudoClassicContest(gameId, matchKey, parsedMatch, now, redis);
        if (completed) {
          const matchDataForCompletion = completedMatchData || parsedMatch;
          matchDataForCompletion.status = GAME_STATUS.COMPLETED;

          await Promise.all(
            usersToUpdate.map(user =>
              sendTimerUpdateToSockets(gameId, matchDataForCompletion, user).catch(() => { })
            )
          );

          return;
        }
        skipDefaultActive = processedActive;
      }

      if (!skipDefaultActive) {
        const activeStateResult = await handleActiveState({ redis, gameId, matchData: parsedMatch, turn, user1Id, user2Id, user1Time, user2Time, now });

        if (activeStateResult && activeStateResult.completed) {
          const matchDataForCompletion = activeStateResult.completedMatchData || parsedMatch;
          matchDataForCompletion.status = GAME_STATUS.COMPLETED;

          await Promise.all(
            usersToUpdate.map(user =>
              sendTimerUpdateToSockets(gameId, matchDataForCompletion, user).catch(() => { })
            )
          );

          return;
        }
      }
      await handleAllPiecesHome(gameId, user1Id, parsedMatch, matchKey, redis, contestType);
      await handleAllPiecesHome(gameId, user2Id, parsedMatch, matchKey, redis, contestType);

      const latestMatchData = await redis.get(matchKey);
      const latestParsedMatch = latestMatchData ? safeParseRedisData(latestMatchData) : parsedMatch;

      await Promise.all(
        usersToUpdate.map(user =>
          sendTimerUpdateToSockets(gameId, latestParsedMatch || parsedMatch, user).catch(() => { })
        )
      );

    } catch (err) {
      // Intentionally ignore per-game failures to avoid stopping the cron loop.
    }
  }, 5);
}

// ============================================================================
// Socket Communication Functions
// ============================================================================

async function sendTimerUpdateToSockets(gameId, matchData, user) {
  // Disabled by requirement: do not emit timer events from cron to socket.
  return;
}

// ============================================================================
// Utility Functions
// ============================================================================

function calculateRemainingTime(userTime, currentTime) {
  if (!userTime) return 15;
  try {
    const timeValue = typeof userTime === 'string' ? new Date(userTime).getTime() : userTime;
    if (isNaN(timeValue)) return 15;
    const elapsed = Math.floor((currentTime - timeValue) / 1000);
    const MAX_TIMER_SECONDS = 15;
    return Math.max(0, MAX_TIMER_SECONDS - elapsed);
  } catch (error) {
    return 15;
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

function determineGameStatus(matchData) {
  if (matchData.status === GAME_STATUS.COMPLETED) return 'completed';
  if (matchData.winner) return 'finished';
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

function checkAllPiecesHome(matchData, userId) {
  const key = userId === matchData.user1_id ? 'user1_pieces_home' : 'user2_pieces_home';
  const value = matchData[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value === 'true' || value === '1';
  }
  return false;
}

function determineWinnerByScore(matchData) {
  const user1Id = matchData.user1_id;
  const user2Id = matchData.user2_id;
  const user1Score = toNumber(matchData.user1_score);
  const user2Score = toNumber(matchData.user2_score);
  if (user1Score > user2Score) return user1Id;
  if (user2Score > user1Score) return user2Id;
  return '';
}

function getUserTurnCount(matchData, userId) {
  const turnCounts = matchData.turnCount;
  if (turnCounts && typeof turnCounts === 'object') {
    const raw = turnCounts[userId];
    if (raw !== undefined) return toNumber(raw);
  }

  const piecesKey = userId === matchData.user1_id ? 'user1_pieces' : 'user2_pieces';
  const pieces = matchData[piecesKey];
  if (!Array.isArray(pieces)) return 0;
  return pieces.reduce((sum, piece) => {
    if (piece && typeof piece === 'object') {
      return sum + toNumber(piece.move_number);
    }
    return sum;
  }, 0);
}

// ============================================================================
// Game State Handlers
// ============================================================================

async function handleStartState(gameId, matchKey, matchData, now, redis) {
  const live = now.toISOString();
  matchData.user1_chance = Number(matchData.user1_chance ?? 3);
  matchData.user2_chance = Number(matchData.user2_chance ?? 3);
  matchData.user1_time = live;
  matchData.user2_time = live;
  matchData.last_move_time = live;
  await redis.set(matchKey, JSON.stringify(matchData), MATCH_TTL_SECONDS);
}

async function initializeChances(redis, gameId, user1Id, user2Id) {
  return;
}

async function handleActiveState({ redis, gameId, matchData, turn, user1Id, user2Id, user1Time, user2Time, now }) {
  const userId = turn;
  const timeStr = userId === user1Id ? user1Time : user2Time;
  if (!timeStr) return;
  const ts = new Date(timeStr);
  if (now.getTime() - ts.getTime() <= 15 * 1000) return;

  const currentUserChance = userId === user1Id
    ? Number(matchData.user1_chance ?? 3)
    : Number(matchData.user2_chance ?? 3);
  const chances = Number.isNaN(currentUserChance) ? 0 : currentUserChance;

  if (chances > 0) {
    const decrementResult = await handleChanceDecrement({
      redis,
      gameId,
      matchData,
      userId,
      user1Id,
      user2Id,
      now
    });

    // If game ended after chance decrement (chances reached 0), return completed
    if (decrementResult && decrementResult.completed) {
      return decrementResult;
    }
  } else {
    const opponentId = userId === user1Id ? user2Id : user1Id;

    matchData.status = GAME_STATUS.COMPLETED;
    matchData.completed_at = toISOString();
    matchData.winner = opponentId;
    matchData.game_end_reason = 'opponent_timeout';

    const matchKey = REDIS_KEYS.MATCH(gameId);
    await redis.set(matchKey, JSON.stringify(matchData), MATCH_TTL_SECONDS);

    await declareWinnerAtomic(gameId, opponentId, userId, matchData.league_id || '', 'opponent_timeout', matchData);

    await completeLudoGame(gameId, matchData, redis);

    return { completed: true, completedMatchData: matchData };
  }

  return { completed: false };
}

async function handleChanceDecrement({ redis, gameId, matchData, userId, user1Id, user2Id, now }) {
  const currentChance = userId === user1Id
    ? Number(matchData.user1_chance ?? 3)
    : Number(matchData.user2_chance ?? 3);
  const newChance = Math.max(0, currentChance - 1);
  if (userId === user1Id) {
    matchData.user1_chance = newChance;
    matchData.user2_chance = Number(matchData.user2_chance ?? 3);
  } else {
    matchData.user2_chance = newChance;
    matchData.user1_chance = Number(matchData.user1_chance ?? 3);
  }

  // If chances reached 0 after decrement, end the game immediately
  if (newChance === 0) {
    const opponentId = userId === user1Id ? user2Id : user1Id;

    matchData.status = GAME_STATUS.COMPLETED;
    matchData.completed_at = toISOString();
    matchData.winner = opponentId;
    matchData.game_end_reason = 'opponent_timeout';

    const matchKey = REDIS_KEYS.MATCH(gameId);
    const pipeline = redis.pipeline();
    pipeline.set(matchKey, JSON.stringify(matchData), 'EX', MATCH_TTL_SECONDS);
    await pipeline.exec();

    await declareWinnerAtomic(gameId, opponentId, userId, matchData.league_id || '', 'opponent_timeout', matchData);
    await completeLudoGame(gameId, matchData, redis);

    return { completed: true, completedMatchData: matchData };
  }

  // If chances still > 0, continue game and switch turn
  const opponentId = userId === user1Id ? user2Id : user1Id;
  const live = now.toISOString();
  matchData.user1_time = live;
  matchData.user2_time = live;
  matchData.last_move_time = live;
  matchData.turn = opponentId;

  const pipeline = redis.pipeline();
  pipeline.set(REDIS_KEYS.MATCH(gameId), JSON.stringify(matchData), 'EX', MATCH_TTL_SECONDS);
  await pipeline.exec();

  return { completed: false };
}

async function handleAllPiecesHome(gameId, userId, matchData, key, redis, contestType) {
  if (!checkAllPiecesHome(matchData, userId)) return;

  const opponentId = userId === matchData.user1_id ? matchData.user2_id : matchData.user1_id;
  const leagueId = matchData.league_id || '';
  const reason = `all_pieces_home_${contestType || 'simple'}`;

  await tryDeclareWinner(gameId, async () => {
    await declareWinner(gameId, userId, opponentId, leagueId, reason, matchData);
  }).catch(() => { });

  await completeLudoGame(gameId, matchData, redis);
}

// ============================================================================
// Contest Type Handlers
// ============================================================================

async function handleLudoQuickContest(gameId, key, matchData, now, redis) {
  const start = matchData.start_time ? new Date(matchData.start_time) : null;
  if (!start) {
    return { completed: false };
  }

  const elapsed = now.getTime() - start.getTime();
  const fiveMinutes = 5 * 60 * 1000;

  if (elapsed >= fiveMinutes) {
    const winnerId = determineWinnerByScore(matchData);
    const loserId = winnerId ? getOpponentId(matchData, winnerId) : null;

    if (winnerId && loserId) {
      try {
        await declareWinnerAtomic(gameId, winnerId, loserId, matchData.league_id || '', 'time_up_highest_score', matchData);
      } catch (err) {
      }
    } else {
      const user1Id = matchData.user1_id;
      const user2Id = matchData.user2_id;
      try {
        await declareWinnerAtomic(gameId, user1Id, user2Id, matchData.league_id || '', 'time_up_tie', matchData);
      } catch (err) {
      }
    }

    matchData.status = GAME_STATUS.COMPLETED;
    matchData.completed_at = toISOString();
    if (!matchData.winner) {
      matchData.winner = winnerId || matchData.user1_id;
    }
    if (!matchData.game_end_reason) {
      matchData.game_end_reason = 'time_up_highest_score';
    }

    const matchKey = REDIS_KEYS.MATCH(gameId);
    await redis.set(matchKey, JSON.stringify(matchData), MATCH_TTL_SECONDS);

    return { completed: true, completedMatchData: matchData };
  }

  return { completed: false };
}

async function handleLudoClassicContest(gameId, key, matchData, now, redis) {
  const user1Turns = getUserTurnCount(matchData, matchData.user1_id);
  const user2Turns = getUserTurnCount(matchData, matchData.user2_id);
  const minTurnsRequired = 15;

  if (user1Turns < minTurnsRequired || user2Turns < minTurnsRequired) {
    const turn = matchData.turn;
    await handleActiveState({
      redis,
      gameId,
      matchData,
      turn,
      user1Id: matchData.user1_id,
      user2Id: matchData.user2_id,
      user1Time: matchData.user1_time,
      user2Time: matchData.user2_time,
      now
    });
    return { completed: false, processedActive: true };
  }

  const winnerId = determineWinnerByScore(matchData);
  const loserId = winnerId ? getOpponentId(matchData, winnerId) : null;

  if (!winnerId || !loserId) {
    const user1Id = matchData.user1_id;
    const user2Id = matchData.user2_id;
    await declareWinnerAtomic(gameId, user1Id, user2Id, matchData.league_id || '', 'turns_completed_tie', matchData);
  } else {
    await declareWinnerAtomic(gameId, winnerId, loserId, matchData.league_id || '', 'turns_completed_highest_score', matchData);
  }

  const finalWinnerId = winnerId || matchData.user1_id;

  matchData.status = GAME_STATUS.COMPLETED;
  matchData.completed_at = toISOString();
  matchData.winner = finalWinnerId;
  matchData.game_end_reason = winnerId ? 'turns_completed_highest_score' : 'turns_completed_tie';

  const matchKey = REDIS_KEYS.MATCH(gameId);
  await redis.set(matchKey, JSON.stringify(matchData), MATCH_TTL_SECONDS);

  await completeLudoGame(gameId, matchData, redis);

  return { completed: true, completedMatchData: matchData };
}

// ============================================================================
// Winner Declaration Functions
// ============================================================================

async function declareWinnerAtomic(gameId, winnerId, loserId, leagueId, reason, matchData = null) {
  try {
    await tryDeclareWinner(gameId, async () => {
      const result = await declareWinner(gameId, winnerId, loserId, leagueId, reason, matchData);
      if (result && !result.success && !result.already_processed) {
        const errorMsg = result.error || 'Unknown error in processWinnerDeclaration';
        throw new Error(errorMsg);
      }
      return result;
    });
  } catch (err) {
  }
}

async function declareWinner(gameId, winnerId, loserId, leagueId, reason, matchData = null) {
  if (!ludoMatchmakingService) {
    const errorMsg = `Ludo matchmaking service not initialized for game ${gameId}`;
    throw new Error(errorMsg);
  }

  const { processWinnerDeclaration } = require('../../services/ludo/windeclearService');

  let scores = { user1Score: 0, user2Score: 0, winnerScore: 0, loserScore: 0 };
  let contestId = '';

  if (matchData) {
    scores.user1Score = toNumber(matchData.user1_score || 0);
    scores.user2Score = toNumber(matchData.user2_score || 0);
    scores.winnerScore = winnerId === matchData.user1_id ? scores.user1Score : scores.user2Score;
    scores.loserScore = loserId === matchData.user1_id ? scores.user1Score : scores.user2Score;
    contestId = matchData.contest_id || matchData.contest_type || '';
  } else {
    const redis = await getRedisClient();
    const match = await redis.get(`match:${gameId}`);
    if (match) {
      scores.user1Score = toNumber(match.user1_score || 0);
      scores.user2Score = toNumber(match.user2_score || 0);
      scores.winnerScore = winnerId === match.user1_id ? scores.user1Score : scores.user2Score;
      scores.loserScore = loserId === match.user1_id ? scores.user1Score : scores.user2Score;
      contestId = match.contest_id || match.contest_type || '';
    }
  }

  const finalContestId = contestId || leagueId || '';

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
    const errorMsg = `processWinnerDeclaration returned null/undefined for game ${gameId}`;
    throw new Error(errorMsg);
  }

  if (result.already_processed) {
    return result;
  }

  if (!result.success) {
    const errorParts = [];
    if (result?.error) errorParts.push(result.error);
    if (result?.errorStack) errorParts.push(`Stack: ${result.errorStack}`);
    if (!errorParts.length) {
      errorParts.push('No error details provided');
    }
    const errorMsg = errorParts.join(' | ') || 'Unknown error in processWinnerDeclaration';
    const fullError = `Failed to declare winner for game ${gameId}: ${errorMsg}`;
    if (result.errorStack) {
    }
    return { success: false, error: fullError };
  }

  return result;
}

// ============================================================================
// Game Completion Functions
// ============================================================================

async function completeLudoGame(gameId, matchData, redisInstance) {
  const redis = redisInstance || await getRedisClient();
  const matchKey = REDIS_KEYS.MATCH(gameId);

  try {
    await archiveLudoGameState(gameId, matchData, 'timer_completion');
  } catch (_) {
  }

  await redis.del(matchKey);
  try {
    const matchServerKeys = await scanKeysByPattern(redis, `match_server:${String(gameId)}:*`, 100);
    if (Array.isArray(matchServerKeys) && matchServerKeys.length > 0) {
      for (const key of matchServerKeys) {
        try {
          await redis.del(key);
        } catch (_) {
        }
      }
    }
  } catch (_) {
  }

  // Clear winner declaration key if exists
  try {
    await redis.del(`ludo_winner_declared:${gameId}`);
  } catch (_) { }

  // Clear both users' sessions from Redis when game completes
  if (matchData && matchData.user1_id && matchData.user2_id) {
    try {
      const sessionService = require('../../utils/sessionService');
      await sessionService.clearSessionsForMatch(matchData.user1_id, matchData.user2_id);
    } catch (err) { }
  }

  // Always update match_pairs to 'completed' when game ends
  if (gameId != null) {
    try {
      const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
      const { updateMatchPairStatus } = require('../../services/ludo/gameService');
      await updateMatchPairToCompleted(gameId, updateMatchPairStatus);
    } catch (err) {
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  setLudoMatchmakingService,
  startLudoUserTimerCron,
  stopLudoUserTimerCron,
  setSocketIO
};
