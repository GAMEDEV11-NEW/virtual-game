const { redis: redisClient } = require('../../utils/redis');
const cassandraClient = require('../../services/cassandra/client');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { SOCKET_EVENT } = require('./enums');
const { REDIS_KEYS: SHARED_REDIS_KEYS, GAME_STATUS } = require('../../constants');
const {
  extractUserData: baseExtractUserData,
  fetchMatchData: baseFetchMatchData,
  fetchUserChances: baseFetchUserChances,
  deriveGameStatus: baseDeriveGameStatus
} = require('../common/baseHandlers');
const { timerRegistry, timerEventBus } = require('../../utils/timer');
const { createWatersortTimerUpdatePayload, calculateRemainingTime, getGameStats } = require('../../utils/timerPayloads');

const REDIS_KEYS = {
  MATCH: SHARED_REDIS_KEYS.WATERSORT_MATCH,
  USER_CHANCE: SHARED_REDIS_KEYS.WATERSORT_USER_CHANCE,
};

const deriveGameStatus = (match) => baseDeriveGameStatus(match, { completedStatus: GAME_STATUS.COMPLETED });

async function fetchUserChances(gameId, matchData) {
  try {
    const baseResult = await baseFetchUserChances(gameId, matchData, 'watersort');
    if (baseResult.user1Chance > 0 || baseResult.user2Chance > 0) {
      return baseResult;
    }
    return {
      user1Chance: matchData?.user1_chance || 0,
      user2Chance: matchData?.user2_chance || 0,
    };
  } catch (_) {
    return { user1Chance: matchData?.user1_chance || 0, user2Chance: matchData?.user2_chance || 0 };
  }
}


async function getWaterSortFromMatchPair(gameID) {
  try {
    const query = 'SELECT user1_data, user2_data, status FROM match_pairs WHERE id = ?';
    const result = await cassandraClient.execute(query, [gameID], { prepare: true });
    
    if (result.rowLength > 0) {
      const row = result.rows[0];
      
      if (row.user1_data && row.user2_data && ( row.status === 'complete')) {
        return {
          user1_data: row.user1_data,
          user2_data: row.user2_data,
          status: row.status,
          extra_data: {}
        };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

function extractUserData(data) {
  const baseResult = baseExtractUserData(data, { errorEvent: 'watersort_timer_update_error' });
  if (!baseResult.isValid) return baseResult;
  
  if (!baseResult.gameId) {
    return {
      isValid: false,
      error: {
        code: 'missing_game_id',
        type: 'validation',
        message: 'game_id not found in decrypted user data',
        event: 'watersort_timer_update_error',
      },
    };
  }
  return baseResult;
}



function registerTimerUpdateHandlerWaterSort(io, socket) {
  let currentGameId = null;
  let currentUserId = null;

  const cleanupTimerInterval = (removeFromActiveGames = false) => {
    if (currentGameId && removeFromActiveGames) {
      const { redis: redisClient } = require('../../utils/redis');
      redisClient.srem('watersort_active_games', currentGameId).catch(() => {});
      timerEventBus.emitTimerStop('watersort', currentGameId, socket.id, currentUserId, 'manual_stop');
    } else if (currentGameId) {
      timerEventBus.emitTimerStop('watersort', currentGameId, socket.id, currentUserId, 'socket_disconnected');
    }
    if (socket.currentWaterSortGameId === currentGameId) {
      socket.currentWaterSortGameId = null;
    }
    currentGameId = null;
    currentUserId = null;
  };

  socket.on(SOCKET_EVENT.START_TIMER_UPDATE, async (data) => {
    try {
      const userData = extractUserData(data);
      if (!userData.isValid) {
        emitError(socket, userData.error);
        return;
      }

      const { userId, gameId } = userData;

      if (!validateFields(socket, { user_data: data.user_data, jwt_token: data.jwt_token }, ['user_data', 'jwt_token'], 'watersort_timer_update_error')) {
        return;
      }

      cleanupTimerInterval(true);

      currentGameId = gameId;
      currentUserId = userId;
      
      socket.currentWaterSortGameId = gameId;

      const { redis: redisClient } = require('../../utils/redis');
      await redisClient.sadd('watersort_active_games', gameId);
      
      timerEventBus.emitTimerStart('watersort', gameId, socket.id, userId);

      try {
        let match = await baseFetchMatchData(gameId, 'watersort');
        
        if (!match) {
          const matchPairData = await getWaterSortFromMatchPair(gameId);
          
          if (matchPairData && matchPairData.user1_data && matchPairData.user2_data) {
            const now = new Date().toISOString();
            const wsState = {
              game_id: gameId,
              user1_id: matchPairData.user1_data,
              user2_id: matchPairData.user2_data,
              turn: matchPairData.user1_data,
              status: 'completed',
              winner: '',
              user1_time: now,
              user2_time: now,
              start_time: now,
              last_move_time: now,
              puzzle_state: matchPairData.extra_data?.puzzle_state || {
                levels: [
                  {
                    no: 0,
                    map: [
                      { values: [1, 2, 0, 1] },
                      { values: [1, 1] },
                      { values: [2, 2] },
                      { values: [0, 0, 0, 2] },
                    ],
                  },
                ],
              },
              level_no: matchPairData.extra_data?.level_no || 137,
              move_count: 0,
              move_sequence: [],
              user1_connection_count: 0,
              user2_connection_count: 0,
              user1_chance: 1,
              user2_chance: 1,
              game_type: 'watersort',
              contest_type: 'simple',
              user1_full_name: '',
              user1_profile_data: '',
              user2_full_name: '',
              user2_profile_data: '',
              created_at: now,
              updated_at: now,
              user1_start_time: now,
              user2_start_time: now,
            };
            socket.emit(SOCKET_EVENT.TIMER_UPDATE, wsState);
            cleanupTimerInterval(true);
            return;
          } else {
            socket.emit(SOCKET_EVENT.TIMER_UPDATE, {
              game_id: gameId,
              status: 'not_found',
              error: 'Game not found in Redis or database',
              timestamp: new Date().toISOString(),
            });
            cleanupTimerInterval(true);
            return;
          }
        }

        const nowMs = Date.now();
        const user1TimeSec = calculateRemainingTime(match.user1_start_time, nowMs);
        const user2TimeSec = calculateRemainingTime(match.user2_start_time, nowMs);
        const { user1Chance, user2Chance } = await fetchUserChances(gameId, match);
        const stats = getGameStats(match);
        const gameStatus = deriveGameStatus(match);

        const timerPayload = createWatersortTimerUpdatePayload(
          match,
          user1TimeSec,
          user2TimeSec,
          user1Chance,
          user2Chance,
          stats,
          gameStatus
        );
        
        socket.emit(SOCKET_EVENT.TIMER_UPDATE, timerPayload);
      } catch (err) {
      }
    } catch (err) {
      emitError(socket, {
        code: 'timer_start_error',
        type: 'system',
        message: 'Failed to start timer updates: ' + err.message,
        event: 'watersort_timer_update_error',
      });
    }
  });

  socket.on(SOCKET_EVENT.STOP_TIMER_UPDATE, () => {
    cleanupTimerInterval(true);
  });

  socket.on('disconnect', () => {
    cleanupTimerInterval(false);
  });

  return {
    cleanup: cleanupTimerInterval,
  };
}

module.exports = registerTimerUpdateHandlerWaterSort;
